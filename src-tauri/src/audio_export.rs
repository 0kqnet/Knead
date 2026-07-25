use hound::{SampleFormat, WavSpec, WavWriter};
use serde::{Deserialize, Serialize};
use shine_rs::{Mp3Encoder, Mp3EncoderConfig, StereoMode};
use std::{
    collections::{HashMap, VecDeque},
    fs::{self, File},
    io::{BufWriter, Write},
    num::{NonZeroU32, NonZeroU8},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
};
use symphonia::{
    core::{
        codecs::audio::AudioDecoderOptions,
        errors::Error as SymphoniaError,
        formats::{probe::Hint, FormatOptions, TrackType},
        io::MediaSourceStream,
        meta::MetadataOptions,
    },
    default::{get_codecs, get_probe},
};
use vorbis_rs::{VorbisBitrateManagementStrategy, VorbisEncoderBuilder};

const TICK_SECONDS: f64 = 0.05;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AudioExportRequest {
    pub default_name: String,
    pub options: ExportOptions,
    pub project: Project,
    pub sound_manifest: HashMap<String, Vec<SoundVariant>>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportOptions {
    pub format: String,
    pub targets: Vec<String>,
    pub sample_rate: u32,
    pub channels: u16,
    pub wav_bit_depth: u16,
    pub ogg_quality: f32,
    pub mp3_bitrate: u32,
    pub range: String,
    pub include_tails: bool,
    pub include_muted_tracks: bool,
}

#[derive(Debug, Clone, Deserialize)]
pub struct SoundVariant {
    pub hash: String,
    pub pitch: f64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub random_seed: u32,
    pub length_ticks: u64,
    pub settings: Settings,
    pub master: MasterBus,
    pub tracks: Vec<Track>,
    pub markers: Vec<Marker>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    #[serde(rename = "loop")]
    pub loop_: Option<LoopRange>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoopRange {
    pub start_tick: u64,
    pub end_tick: u64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MasterBus {
    pub gain_db: f64,
    pub limiter_enabled: bool,
    pub limiter_ceiling_db: f64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Track {
    pub id: String,
    pub name: String,
    pub gain_db: f64,
    pub pan: f64,
    pub muted: bool,
    pub solo: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Marker {
    pub id: String,
    pub track_id: String,
    pub tick: u64,
    pub sound_id: String,
    pub variant_index: i32,
    pub volume: f64,
    pub pitch: f64,
    pub duration: Option<u64>,
    pub retrigger_interval: Option<u64>,
    pub volume_curve: Option<Curve>,
    pub pitch_curve: Option<Curve>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Curve {
    pub keyframes: Vec<Keyframe>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Keyframe {
    pub tick: f64,
    pub value: f64,
    pub interpolation: String,
    pub handle_l: Option<Handle>,
    pub handle_r: Option<Handle>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct Handle {
    pub dt: f64,
    pub dv: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportProgress {
    pub job_id: String,
    pub progress: f64,
    pub stage: String,
    pub current_track: Option<String>,
    pub done: bool,
    pub canceled: bool,
    pub error: Option<String>,
    pub output_paths: Option<Vec<String>>,
}

impl ExportProgress {
    pub fn running(
        job_id: &str,
        progress: f64,
        stage: impl Into<String>,
        track: Option<String>,
    ) -> Self {
        Self {
            job_id: job_id.to_string(),
            progress,
            stage: stage.into(),
            current_track: track,
            done: false,
            canceled: false,
            error: None,
            output_paths: None,
        }
    }
}

#[derive(Clone)]
struct DecodedAudio {
    sample_rate: u32,
    channels: usize,
    samples: Vec<f32>,
}

#[derive(Clone)]
struct Event {
    marker_id: String,
    firing_index: usize,
    track_id: String,
    tick: u64,
    sound_id: String,
    variant_index: i32,
    volume: f64,
    pitch: f64,
}

struct RenderedAudio {
    channels: u16,
    sample_rate: u32,
    samples: Vec<f32>,
}

pub fn sanitize_name(value: &str) -> String {
    let sanitized = value
        .chars()
        .map(|character| {
            if character.is_control() || "<>:\"/\\|?*".contains(character) {
                '_'
            } else {
                character
            }
        })
        .collect::<String>()
        .trim_matches([' ', '.'])
        .to_string();
    if sanitized.is_empty() {
        "Track".to_string()
    } else {
        sanitized.chars().take(80).collect()
    }
}

fn extension(format: &str) -> Result<&'static str, String> {
    match format {
        "wav" => Ok("wav"),
        "ogg" => Ok("ogg"),
        "mp3" => Ok("mp3"),
        _ => Err(format!("Unsupported export format: {format}")),
    }
}

pub fn planned_outputs(
    selected_path: &Path,
    path_is_directory: bool,
    request: &AudioExportRequest,
) -> Result<Vec<(PathBuf, Option<String>)>, String> {
    let ext = extension(&request.options.format)?;
    let mut outputs = Vec::new();
    if request.options.targets.iter().any(|target| target == "mix") {
        let path = if path_is_directory {
            selected_path.join(format!("{}.{}", sanitize_name(&request.default_name), ext))
        } else {
            selected_path.to_path_buf()
        };
        outputs.push((path, None));
    }
    if request
        .options
        .targets
        .iter()
        .any(|target| target == "stems")
    {
        let directory = if path_is_directory {
            selected_path
        } else {
            selected_path.parent().unwrap_or_else(|| Path::new("."))
        };
        for (index, track) in request.project.tracks.iter().enumerate() {
            if track.muted && !request.options.include_muted_tracks {
                continue;
            }
            outputs.push((
                directory.join(format!(
                    "{:02}_{}.{}",
                    index + 1,
                    sanitize_name(&track.name),
                    ext
                )),
                Some(track.id.clone()),
            ));
        }
    }
    if outputs.is_empty() {
        return Err("No export target selected".to_string());
    }
    Ok(outputs)
}

pub fn run_export(
    job_id: &str,
    minecraft_root: &Path,
    selected_path: &Path,
    path_is_directory: bool,
    request: AudioExportRequest,
    canceled: Arc<AtomicBool>,
    mut on_progress: impl FnMut(ExportProgress),
) -> Result<Vec<String>, String> {
    validate_options(&request.options)?;
    let outputs = planned_outputs(selected_path, path_is_directory, &request)?;
    let mut decoded = HashMap::<String, DecodedAudio>::new();
    let events = build_events(&request.project);
    let total = outputs.len().max(1);
    let mut completed_paths = Vec::new();

    for (index, (destination, track_id)) in outputs.into_iter().enumerate() {
        check_canceled(&canceled)?;
        let label = track_id
            .as_ref()
            .and_then(|id| request.project.tracks.iter().find(|track| &track.id == id))
            .map(|track| track.name.clone());
        on_progress(ExportProgress::running(
            job_id,
            index as f64 / total as f64,
            "レンダリング中",
            label.clone(),
        ));
        let rendered = render_audio(
            minecraft_root,
            &request,
            &events,
            track_id.as_deref(),
            &mut decoded,
            &canceled,
        )?;
        check_canceled(&canceled)?;
        on_progress(ExportProgress::running(
            job_id,
            (index as f64 + 0.7) / total as f64,
            "エンコード中",
            label,
        ));
        encode_atomic(&destination, &request.options, &rendered, &canceled)?;
        completed_paths.push(destination.to_string_lossy().into_owned());
        on_progress(ExportProgress::running(
            job_id,
            (index + 1) as f64 / total as f64,
            "書き出し中",
            None,
        ));
    }
    Ok(completed_paths)
}

fn validate_options(options: &ExportOptions) -> Result<(), String> {
    if ![44_100, 48_000, 96_000].contains(&options.sample_rate) {
        return Err("Unsupported sample rate".to_string());
    }
    if ![1, 2].contains(&options.channels) {
        return Err("Unsupported channel count".to_string());
    }
    if options.format == "mp3" && options.sample_rate == 96_000 {
        return Err("MP3 does not support 96 kHz".to_string());
    }
    if ![16, 24, 32].contains(&options.wav_bit_depth) {
        return Err("Unsupported WAV bit depth".to_string());
    }
    if ![128, 192, 256, 320].contains(&options.mp3_bitrate) {
        return Err("Unsupported MP3 bitrate".to_string());
    }
    Ok(())
}

fn build_events(project: &Project) -> Vec<Event> {
    let mut events = Vec::new();
    for marker in &project.markers {
        let duration = marker.duration.unwrap_or(0);
        let interval = marker.retrigger_interval.unwrap_or(1).max(1);
        let count = if duration > 0 {
            duration / interval + 1
        } else {
            1
        };
        for firing_index in 0..count {
            let offset = if duration > 0 {
                firing_index * interval
            } else {
                0
            };
            events.push(Event {
                marker_id: marker.id.clone(),
                firing_index: firing_index as usize,
                track_id: marker.track_id.clone(),
                tick: marker.tick + offset,
                sound_id: marker.sound_id.clone(),
                variant_index: marker.variant_index,
                volume: sample_curve(marker.volume_curve.as_ref(), offset as f64, marker.volume),
                pitch: sample_curve(marker.pitch_curve.as_ref(), offset as f64, marker.pitch),
            });
        }
    }
    events.sort_by_key(|event| event.tick);
    events
}

fn sample_curve(curve: Option<&Curve>, tick: f64, fallback: f64) -> f64 {
    let Some(curve) = curve.filter(|curve| !curve.keyframes.is_empty()) else {
        return fallback;
    };
    if tick <= curve.keyframes[0].tick {
        return curve.keyframes[0].value;
    }
    if tick >= curve.keyframes.last().map(|key| key.tick).unwrap_or(0.0) {
        return curve
            .keyframes
            .last()
            .map(|key| key.value)
            .unwrap_or(fallback);
    }
    for pair in curve.keyframes.windows(2) {
        let left = &pair[0];
        let right = &pair[1];
        if tick < left.tick || tick > right.tick {
            continue;
        }
        if left.interpolation != "bezier" {
            let ratio = (tick - left.tick) / (right.tick - left.tick);
            return left.value + (right.value - left.value) * ratio;
        }
        let p0 = (left.tick, left.value);
        let p1 = left
            .handle_r
            .as_ref()
            .map(|handle| (left.tick + handle.dt, left.value + handle.dv))
            .unwrap_or(p0);
        let p3 = (right.tick, right.value);
        let p2 = right
            .handle_l
            .as_ref()
            .map(|handle| (right.tick + handle.dt, right.value + handle.dv))
            .unwrap_or(p3);
        let mut low = 0.0;
        let mut high = 1.0;
        for _ in 0..24 {
            let mid = (low + high) * 0.5;
            if cubic(p0.0, p1.0, p2.0, p3.0, mid) < tick {
                low = mid;
            } else {
                high = mid;
            }
        }
        return cubic(p0.1, p1.1, p2.1, p3.1, (low + high) * 0.5);
    }
    fallback
}

fn cubic(a: f64, b: f64, c: f64, d: f64, t: f64) -> f64 {
    let inverse = 1.0 - t;
    inverse.powi(3) * a
        + 3.0 * inverse.powi(2) * t * b
        + 3.0 * inverse * t.powi(2) * c
        + t.powi(3) * d
}

fn render_audio(
    minecraft_root: &Path,
    request: &AudioExportRequest,
    events: &[Event],
    stem_track_id: Option<&str>,
    decoded: &mut HashMap<String, DecodedAudio>,
    canceled: &Arc<AtomicBool>,
) -> Result<RenderedAudio, String> {
    let options = &request.options;
    let project = &request.project;
    let (start_tick, end_tick) = if options.range == "loop" {
        let range = project
            .settings
            .loop_
            .as_ref()
            .ok_or_else(|| "Loop range is missing".to_string())?;
        (range.start_tick, range.end_tick)
    } else {
        (0, project.length_ticks)
    };
    let has_solo = project.tracks.iter().any(|track| track.solo);
    let tracks = project
        .tracks
        .iter()
        .filter(|track| match stem_track_id {
            Some(id) => track.id == id,
            None => !track.muted && (!has_solo || track.solo),
        })
        .map(|track| (track.id.as_str(), track))
        .collect::<HashMap<_, _>>();
    let selected_events = events
        .iter()
        .filter(|event| {
            event.tick >= start_tick
                && event.tick < end_tick
                && tracks.contains_key(event.track_id.as_str())
        })
        .collect::<Vec<_>>();

    for event in &selected_events {
        let variant = resolve_variant(request, event)?;
        if !decoded.contains_key(&variant.hash) {
            let path = object_path(minecraft_root, &variant.hash)?;
            decoded.insert(variant.hash.clone(), decode_audio(&path)?);
        }
    }

    let base_frames = (((end_tick - start_tick) as f64 * TICK_SECONDS) * options.sample_rate as f64)
        .ceil() as usize;
    let mut frame_count = base_frames.max(1);
    if options.include_tails {
        for event in &selected_events {
            let variant = resolve_variant(request, event)?;
            let source = decoded
                .get(&variant.hash)
                .ok_or_else(|| "Decoded audio missing".to_string())?;
            let pitch = (event.pitch * variant.pitch).max(0.01);
            let start = (((event.tick - start_tick) as f64 * TICK_SECONDS)
                * options.sample_rate as f64) as usize;
            let duration =
                (source.samples.len() / source.channels) as f64 / source.sample_rate as f64 / pitch;
            frame_count =
                frame_count.max(start + (duration * options.sample_rate as f64).ceil() as usize);
        }
    }

    let channel_count = options.channels as usize;
    let mut output = vec![0.0_f32; frame_count * channel_count];
    for event in selected_events {
        check_canceled(canceled)?;
        let track = tracks[event.track_id.as_str()];
        let variant = resolve_variant(request, event)?;
        let source = decoded
            .get(&variant.hash)
            .ok_or_else(|| "Decoded audio missing".to_string())?;
        let pitch = (event.pitch * variant.pitch).max(0.01);
        let start_frame = (((event.tick - start_tick) as f64 * TICK_SECONDS)
            * options.sample_rate as f64)
            .round() as usize;
        let source_frames = source.samples.len() / source.channels;
        let output_duration =
            (source_frames as f64 * options.sample_rate as f64 / source.sample_rate as f64 / pitch)
                .ceil() as usize;
        let track_gain = db_to_gain(track.gain_db) * event.volume;

        for offset in 0..output_duration {
            let destination_frame = start_frame + offset;
            if destination_frame >= frame_count {
                break;
            }
            let source_position =
                offset as f64 * source.sample_rate as f64 * pitch / options.sample_rate as f64;
            if source_position >= source_frames.saturating_sub(1) as f64 {
                break;
            }
            let (source_left, source_right) = interpolate_frame(source, source_position);
            if channel_count == 1 {
                output[destination_frame] +=
                    ((source_left + source_right) * 0.5 * track_gain) as f32;
            } else {
                let (left, right) =
                    apply_pan(source_left, source_right, source.channels, track.pan);
                output[destination_frame * 2] += (left * track_gain) as f32;
                output[destination_frame * 2 + 1] += (right * track_gain) as f32;
            }
        }
    }

    if stem_track_id.is_none() {
        let master_gain = db_to_gain(project.master.gain_db) as f32;
        for sample in &mut output {
            *sample *= master_gain;
        }
        if project.master.limiter_enabled {
            apply_limiter(
                &mut output,
                channel_count,
                options.sample_rate,
                db_to_gain(project.master.limiter_ceiling_db) as f32,
            );
        }
    }
    Ok(RenderedAudio {
        channels: options.channels,
        sample_rate: options.sample_rate,
        samples: output,
    })
}

fn resolve_variant<'a>(
    request: &'a AudioExportRequest,
    event: &Event,
) -> Result<&'a SoundVariant, String> {
    let variants = request
        .sound_manifest
        .get(&event.sound_id)
        .filter(|variants| !variants.is_empty())
        .ok_or_else(|| format!("Missing sound: {}", event.sound_id))?;
    let index = if event.variant_index >= 0 {
        event.variant_index as usize
    } else {
        stable_hash(&format!(
            "{}:{}:{}",
            request.project.random_seed, event.marker_id, event.firing_index
        )) as usize
            % variants.len()
    };
    variants
        .get(index)
        .filter(|variant| !variant.hash.is_empty())
        .ok_or_else(|| format!("Missing variant {} for {}", index, event.sound_id))
}

fn stable_hash(value: &str) -> u32 {
    value.bytes().fold(2_166_136_261_u32, |hash, byte| {
        (hash ^ byte as u32).wrapping_mul(16_777_619)
    })
}

fn object_path(root: &Path, hash: &str) -> Result<PathBuf, String> {
    if hash.len() != 40 || !hash.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err("Invalid Minecraft asset hash".to_string());
    }
    let path = root
        .join("assets")
        .join("objects")
        .join(&hash[..2])
        .join(hash);
    if !path.is_file() {
        return Err(format!("Minecraft asset not found: {hash}"));
    }
    Ok(path)
}

fn decode_audio(path: &Path) -> Result<DecodedAudio, String> {
    let source = Box::new(File::open(path).map_err(|error| error.to_string())?);
    let stream = MediaSourceStream::new(source, Default::default());
    let mut hint = Hint::new();
    hint.with_extension(
        path.extension()
            .and_then(|value| value.to_str())
            .unwrap_or("ogg"),
    );
    let mut format = get_probe()
        .probe(
            &hint,
            stream,
            FormatOptions::default(),
            MetadataOptions::default(),
        )
        .map_err(|error| error.to_string())?;
    let track = format
        .default_track(TrackType::Audio)
        .ok_or_else(|| "No audio track in Minecraft asset".to_string())?;
    let parameters = track
        .codec_params
        .as_ref()
        .and_then(|params| params.audio())
        .ok_or_else(|| "Audio codec parameters are missing".to_string())?;
    let sample_rate = parameters
        .sample_rate
        .ok_or_else(|| "Sample rate is missing".to_string())?;
    let mut decoder = get_codecs()
        .make_audio_decoder(parameters, &AudioDecoderOptions::default())
        .map_err(|error| error.to_string())?;
    let track_id = track.id;
    let mut samples = Vec::<f32>::new();
    let mut channels = 0;
    loop {
        let packet = match format.next_packet() {
            Ok(Some(packet)) => packet,
            Ok(None) => break,
            Err(error) => return Err(error.to_string()),
        };
        if packet.track_id != track_id {
            continue;
        }
        match decoder.decode(&packet) {
            Ok(audio) => {
                channels = audio.spec().channels().count();
                let start = samples.len();
                samples.resize(start + audio.samples_interleaved(), 0.0);
                audio.copy_to_slice_interleaved(&mut samples[start..]);
            }
            Err(SymphoniaError::DecodeError(_)) | Err(SymphoniaError::IoError(_)) => continue,
            Err(error) => return Err(error.to_string()),
        }
    }
    if channels == 0 || samples.is_empty() {
        return Err("Minecraft audio asset decoded to no samples".to_string());
    }
    Ok(DecodedAudio {
        sample_rate,
        channels,
        samples,
    })
}

fn interpolate_frame(source: &DecodedAudio, position: f64) -> (f64, f64) {
    let frame = position.floor() as usize;
    let fraction = (position - frame as f64) as f32;
    let sample = |channel: usize| {
        let channel = channel.min(source.channels - 1);
        let a = source.samples[frame * source.channels + channel];
        let b = source.samples[(frame + 1) * source.channels + channel];
        (a + (b - a) * fraction) as f64
    };
    if source.channels == 1 {
        let mono = sample(0);
        (mono, mono)
    } else {
        (sample(0), sample(1))
    }
}

fn apply_pan(left: f64, right: f64, source_channels: usize, pan: f64) -> (f64, f64) {
    let pan = pan.clamp(-1.0, 1.0);
    if source_channels == 1 {
        let angle = (pan + 1.0) * std::f64::consts::FRAC_PI_4;
        (left * angle.cos(), right * angle.sin())
    } else if pan < 0.0 {
        (left, right * (pan + 1.0))
    } else {
        (left * (1.0 - pan), right)
    }
}

fn db_to_gain(db: f64) -> f64 {
    if db <= -60.0 {
        0.0
    } else {
        10_f64.powf(db / 20.0)
    }
}

fn apply_limiter(samples: &mut [f32], channels: usize, sample_rate: u32, ceiling: f32) {
    let frames = samples.len() / channels;
    let lookahead = ((sample_rate as f64 * 0.005).round() as usize).max(1);
    let release = (-1.0_f32 / (sample_rate as f32 * 0.05)).exp();
    let mut peaks = Vec::with_capacity(frames);
    for frame in 0..frames {
        let mut peak = 0.0_f32;
        for channel in 0..channels {
            peak = peak.max(samples[frame * channels + channel].abs());
        }
        peaks.push(peak);
    }
    let mut queue: VecDeque<(usize, f32)> = VecDeque::new();
    let push_peak = |queue: &mut VecDeque<(usize, f32)>, index: usize| {
        while queue
            .back()
            .is_some_and(|(_, value)| *value <= peaks[index])
        {
            queue.pop_back();
        }
        queue.push_back((index, peaks[index]));
    };
    for index in 0..frames.min(lookahead + 1) {
        push_peak(&mut queue, index);
    }
    let mut gain = 1.0_f32;
    for frame in 0..frames {
        while queue.front().is_some_and(|(index, _)| *index < frame) {
            queue.pop_front();
        }
        let peak = queue.front().map(|(_, value)| *value).unwrap_or(0.0);
        let target = if peak > ceiling { ceiling / peak } else { 1.0 };
        gain = if target < gain {
            target
        } else {
            target + (gain - target) * release
        };
        for channel in 0..channels {
            samples[frame * channels + channel] *= gain;
        }
        let next = frame + lookahead + 1;
        if next < frames {
            push_peak(&mut queue, next);
        }
    }
}

fn encode_atomic(
    destination: &Path,
    options: &ExportOptions,
    audio: &RenderedAudio,
    canceled: &Arc<AtomicBool>,
) -> Result<(), String> {
    if let Some(parent) = destination.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let temporary = destination.with_extension(format!(
        "{}.knead-tmp",
        destination
            .extension()
            .and_then(|value| value.to_str())
            .unwrap_or("audio")
    ));
    let result = match options.format.as_str() {
        "wav" => encode_wav(&temporary, options, audio, canceled),
        "ogg" => encode_ogg(&temporary, options, audio, canceled),
        "mp3" => encode_mp3(&temporary, options, audio, canceled),
        _ => Err("Unsupported export format".to_string()),
    };
    if let Err(error) = result {
        let _ = fs::remove_file(&temporary);
        return Err(error);
    }
    check_canceled(canceled).inspect_err(|_| {
        let _ = fs::remove_file(&temporary);
    })?;
    if destination.exists() {
        fs::remove_file(destination).map_err(|error| error.to_string())?;
    }
    fs::rename(&temporary, destination).map_err(|error| error.to_string())
}

fn encode_wav(
    path: &Path,
    options: &ExportOptions,
    audio: &RenderedAudio,
    canceled: &Arc<AtomicBool>,
) -> Result<(), String> {
    let float = options.wav_bit_depth == 32;
    let spec = WavSpec {
        channels: audio.channels,
        sample_rate: audio.sample_rate,
        bits_per_sample: options.wav_bit_depth,
        sample_format: if float {
            SampleFormat::Float
        } else {
            SampleFormat::Int
        },
    };
    let mut writer = WavWriter::create(path, spec).map_err(|error| error.to_string())?;
    for (index, sample) in audio.samples.iter().enumerate() {
        if index % 262_144 == 0 {
            check_canceled(canceled)?;
        }
        let clamped = sample.clamp(-1.0, 1.0);
        match options.wav_bit_depth {
            16 => writer.write_sample((clamped * i16::MAX as f32).round() as i16),
            24 => writer.write_sample((clamped * 8_388_607.0).round() as i32),
            32 => writer.write_sample(clamped),
            _ => return Err("Unsupported WAV bit depth".to_string()),
        }
        .map_err(|error| error.to_string())?;
    }
    writer.finalize().map_err(|error| error.to_string())
}

fn encode_ogg(
    path: &Path,
    options: &ExportOptions,
    audio: &RenderedAudio,
    canceled: &Arc<AtomicBool>,
) -> Result<(), String> {
    let file = BufWriter::new(File::create(path).map_err(|error| error.to_string())?);
    let mut builder = VorbisEncoderBuilder::new(
        NonZeroU32::new(audio.sample_rate).ok_or_else(|| "Invalid sample rate".to_string())?,
        NonZeroU8::new(audio.channels as u8).ok_or_else(|| "Invalid channels".to_string())?,
        file,
    )
    .map_err(|error| error.to_string())?;
    builder.bitrate_management_strategy(VorbisBitrateManagementStrategy::QualityVbr {
        target_quality: (options.ogg_quality / 10.0).clamp(0.0, 1.0),
    });
    let mut encoder = builder.build().map_err(|error| error.to_string())?;
    let channels = audio.channels as usize;
    let frames = audio.samples.len() / channels;
    for start in (0..frames).step_by(1024) {
        check_canceled(canceled)?;
        let end = (start + 1024).min(frames);
        if channels == 1 {
            let mono = audio.samples[start..end].to_vec();
            encoder
                .encode_audio_block([mono])
                .map_err(|error| error.to_string())?;
        } else {
            let mut left = Vec::with_capacity(end - start);
            let mut right = Vec::with_capacity(end - start);
            for frame in start..end {
                left.push(audio.samples[frame * 2]);
                right.push(audio.samples[frame * 2 + 1]);
            }
            encoder
                .encode_audio_block([left, right])
                .map_err(|error| error.to_string())?;
        }
    }
    let mut file = encoder.finish().map_err(|error| error.to_string())?;
    file.flush().map_err(|error| error.to_string())
}

fn encode_mp3(
    path: &Path,
    options: &ExportOptions,
    audio: &RenderedAudio,
    canceled: &Arc<AtomicBool>,
) -> Result<(), String> {
    let config = Mp3EncoderConfig::new()
        .sample_rate(audio.sample_rate)
        .bitrate(options.mp3_bitrate)
        .channels(audio.channels as u8)
        .stereo_mode(if audio.channels == 1 {
            StereoMode::Mono
        } else {
            StereoMode::Stereo
        });
    let mut encoder = Mp3Encoder::new(config).map_err(|error| error.to_string())?;
    let mut file = BufWriter::new(File::create(path).map_err(|error| error.to_string())?);
    let frame_size = encoder.samples_per_frame();
    let pcm = audio
        .samples
        .iter()
        .map(|sample| (sample.clamp(-1.0, 1.0) * i16::MAX as f32).round() as i16)
        .collect::<Vec<_>>();
    for chunk in pcm.chunks(frame_size * 8) {
        check_canceled(canceled)?;
        for frame in encoder
            .encode_interleaved(chunk)
            .map_err(|error| error.to_string())?
        {
            file.write_all(&frame).map_err(|error| error.to_string())?;
        }
    }
    file.write_all(&encoder.finish().map_err(|error| error.to_string())?)
        .map_err(|error| error.to_string())?;
    file.flush().map_err(|error| error.to_string())
}

fn check_canceled(canceled: &Arc<AtomicBool>) -> Result<(), String> {
    if canceled.load(Ordering::Relaxed) {
        Err("canceled".to_string())
    } else {
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn names_are_safe_for_stem_files() {
        assert_eq!(sanitize_name("Kick/Lead:*?"), "Kick_Lead___");
        assert_eq!(sanitize_name("..."), "Track");
    }

    #[test]
    fn limiter_keeps_samples_below_ceiling() {
        let mut samples = vec![0.0_f32; 5000 * 2];
        samples[2000] = 2.0;
        samples[2001] = -2.0;
        let ceiling = db_to_gain(-1.0) as f32;
        apply_limiter(&mut samples, 2, 48_000, ceiling);
        assert!(samples.iter().all(|sample| sample.abs() <= ceiling + 1e-6));
    }

    #[test]
    fn gain_and_pan_follow_audio_rules() {
        assert!((db_to_gain(6.0) - 1.995_262).abs() < 0.000_01);
        assert_eq!(db_to_gain(-60.0), 0.0);
        let (left, right) = apply_pan(1.0, 1.0, 1, 0.0);
        assert!((left - std::f64::consts::FRAC_1_SQRT_2).abs() < 0.000_01);
        assert!((right - std::f64::consts::FRAC_1_SQRT_2).abs() < 0.000_01);
    }

    #[test]
    fn cancellation_is_observed() {
        let canceled = Arc::new(AtomicBool::new(true));
        assert_eq!(check_canceled(&canceled), Err("canceled".to_string()));
    }

    #[test]
    fn asset_hash_cannot_traverse_directories() {
        assert!(object_path(Path::new("."), "../sounds/example.ogg").is_err());
    }

    #[test]
    fn deterministic_hash_matches_frontend_fnv1a() {
        assert_eq!(stable_hash("123:marker:0"), 1_139_040_179);
    }

    #[test]
    fn wav_ogg_and_mp3_outputs_can_be_decoded() {
        let root = std::env::temp_dir().join(format!(
            "knead-export-test-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&root).unwrap();
        let sample_rate = 44_100;
        let frames = sample_rate / 5;
        let mut samples = Vec::with_capacity(frames as usize * 2);
        for frame in 0..frames {
            let sample =
                ((frame as f32 / sample_rate as f32) * 440.0 * std::f32::consts::TAU).sin() * 0.25;
            samples.extend([sample, sample]);
        }
        let audio = RenderedAudio {
            channels: 2,
            sample_rate,
            samples,
        };
        let canceled = Arc::new(AtomicBool::new(false));
        for format in ["wav", "ogg", "mp3"] {
            let options = ExportOptions {
                format: format.to_string(),
                targets: vec!["mix".to_string()],
                sample_rate,
                channels: 2,
                wav_bit_depth: 24,
                ogg_quality: 5.0,
                mp3_bitrate: 192,
                range: "project".to_string(),
                include_tails: true,
                include_muted_tracks: false,
            };
            let path = root.join(format!("test.{format}"));
            encode_atomic(&path, &options, &audio, &canceled).unwrap();
            assert!(path.metadata().unwrap().len() > 64);
            let decoded = decode_audio(&path).unwrap();
            assert_eq!(decoded.sample_rate, sample_rate);
            assert_eq!(decoded.channels, 2);
            assert!(decoded.samples.iter().any(|sample| sample.abs() > 0.001));
        }
        fs::remove_dir_all(root).unwrap();
    }
}
