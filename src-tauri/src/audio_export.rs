use aifc::{
    AifcWriteInfo, AifcWriter, FileFormat as AifcFileFormat, SampleFormat as AifcSampleFormat,
};
use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};
use hound::{SampleFormat, WavSpec, WavWriter};
use libflac_rs::{Encoder as FlacEncoder, EncoderConfig as FlacEncoderConfig};
use serde::{Deserialize, Serialize};
use shine_rs::{Mp3Encoder, Mp3EncoderConfig, StereoMode};
use std::{
    collections::{HashMap, VecDeque},
    fs::{self, File},
    io::{BufWriter, Cursor, Write},
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
        io::{MediaSource, MediaSourceStream},
        meta::MetadataOptions,
    },
    default::{get_codecs, get_probe},
};
use vorbis_rs::{VorbisBitrateManagementStrategy, VorbisEncoderBuilder};

const TICK_SECONDS: f64 = 0.05;
const MAX_GATE_TICKS: u64 = 10_000_000;
const MIN_MARKER_PITCH: f64 = 1.0 / 512.0;
const MAX_MARKER_PITCH: f64 = 256.0;
const MIN_VARIANT_PITCH: f64 = 0.01;
const MAX_VARIANT_PITCH: f64 = 100.0;
/** Maximum interleaved f32 PCM held by one mix or stem render (256 MiB). */
const MAX_RENDERED_PCM_BYTES: usize = 256 * 1024 * 1024;
const MAX_CUSTOM_AUDIO_BYTES: usize = 32 * 1024 * 1024;
const MAX_CUSTOM_AUDIO_TOTAL_BYTES: usize = 96 * 1024 * 1024;
const MAX_REFERENCE_AUDIO_TOTAL_BYTES: usize = 64 * 1024 * 1024;
const MAX_DECODED_AUDIO_BYTES: u64 = 256 * 1024 * 1024;
const MIN_EXPORT_SAMPLE_RATE: u32 = 8_000;
const MAX_EXPORT_SAMPLE_RATE: u32 = 384_000;
const MAX_OGG_SAMPLE_RATE: u32 = 200_000;

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
#[serde(rename_all = "camelCase")]
pub struct SoundVariant {
    pub hash: String,
    pub pitch: f64,
    #[serde(default)]
    pub path: Option<String>,
    #[serde(default)]
    pub data_base64: Option<String>,
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
    #[serde(default)]
    pub reference_audio: Vec<ReferenceAudioTrack>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReferenceAudioTrack {
    pub id: String,
    pub name: String,
    pub mime_type: String,
    pub byte_length: usize,
    pub data_base64: String,
    pub offset_ticks: u64,
    pub gain_db: f64,
    pub pan: f64,
    pub muted: bool,
    pub solo: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    #[serde(rename = "loop")]
    pub loop_: Option<LoopRange>,
    #[serde(default)]
    pub pan_law: PanLaw,
}

#[derive(Debug, Clone, Copy, Default, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum PanLaw {
    #[default]
    Cascade,
    NbsAverage,
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
    #[serde(default)]
    pub pan: f64,
    #[serde(default)]
    pub gate_ticks: Option<u64>,
    #[serde(default)]
    pub action: Option<MarkerAction>,
    pub duration: Option<u64>,
    pub retrigger_interval: Option<u64>,
    pub volume_curve: Option<Curve>,
    pub pitch_curve: Option<Curve>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MarkerAction {
    #[serde(rename = "type")]
    pub kind: String,
    pub scope: String,
    pub start_track: Option<u32>,
    pub end_track: Option<u32>,
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

#[derive(Clone, Debug)]
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
    pan: f64,
    gate_ticks: Option<u64>,
    track_index: usize,
    marker_index: usize,
}

#[derive(Debug, Clone)]
struct StopEvent {
    tick: u64,
    track_index: usize,
    marker_index: usize,
    scope: String,
    start_track: Option<u32>,
    end_track: Option<u32>,
}

struct RenderedAudio {
    channels: u16,
    sample_rate: u32,
    samples: Vec<f32>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum StemTarget {
    NoteTrack(String),
    ReferenceAudio(String),
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
        "aiff" => Ok("aiff"),
        "flac" => Ok("flac"),
        "ogg" => Ok("ogg"),
        "mp3" => Ok("mp3"),
        _ => Err(format!("Unsupported export format: {format}")),
    }
}

pub fn planned_outputs(
    selected_path: &Path,
    path_is_directory: bool,
    request: &AudioExportRequest,
) -> Result<Vec<(PathBuf, Option<StemTarget>)>, String> {
    let ext = extension(&request.options.format)?;
    let mut outputs = Vec::new();
    if request.options.targets.iter().any(|target| target == "mix") {
        let path = if path_is_directory {
            selected_path.join(format!("{}.{}", sanitize_name(&request.default_name), ext))
        } else {
            let mut path = selected_path.to_path_buf();
            if !path
                .extension()
                .and_then(|value| value.to_str())
                .is_some_and(|value| value.eq_ignore_ascii_case(ext))
            {
                path.set_extension(ext);
            }
            path
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
                Some(StemTarget::NoteTrack(track.id.clone())),
            ));
        }
        let first_reference_index = request.project.tracks.len();
        for (index, track) in request.project.reference_audio.iter().enumerate() {
            if track.muted && !request.options.include_muted_tracks {
                continue;
            }
            outputs.push((
                directory.join(format!(
                    "{:02}_Reference_{}.{}",
                    first_reference_index + index + 1,
                    sanitize_name(&track.name),
                    ext
                )),
                Some(StemTarget::ReferenceAudio(track.id.clone())),
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
    validate_custom_audio_budget(&request)?;
    validate_sound_stoppers(&request.project)?;
    validate_pitch_domain(&request)?;
    let outputs = planned_outputs(selected_path, path_is_directory, &request)?;
    let mut decoded = HashMap::<String, DecodedAudio>::new();
    let events = build_events(&request.project);
    let stop_events = build_stop_events(&request.project);
    let total = outputs.len().max(1);
    let mut completed_paths = Vec::new();

    for (index, (destination, track_id)) in outputs.into_iter().enumerate() {
        check_canceled(&canceled)?;
        let label = track_id.as_ref().and_then(|target| match target {
            StemTarget::NoteTrack(id) => request
                .project
                .tracks
                .iter()
                .find(|track| &track.id == id)
                .map(|track| track.name.clone()),
            StemTarget::ReferenceAudio(id) => request
                .project
                .reference_audio
                .iter()
                .find(|track| &track.id == id)
                .map(|track| track.name.clone()),
        });
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
            &stop_events,
            track_id.as_ref(),
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

pub fn validate_options(options: &ExportOptions) -> Result<(), String> {
    extension(&options.format)?;
    if !(MIN_EXPORT_SAMPLE_RATE..=MAX_EXPORT_SAMPLE_RATE).contains(&options.sample_rate) {
        return Err(format!(
            "Sample rate must be between {MIN_EXPORT_SAMPLE_RATE} and {MAX_EXPORT_SAMPLE_RATE} Hz"
        ));
    }
    if ![1, 2].contains(&options.channels) {
        return Err("Unsupported channel count".to_string());
    }
    if ![16, 24, 32].contains(&options.wav_bit_depth) {
        return Err("Lossless bit depth must be 16, 24, or 32".to_string());
    }
    if options.targets.is_empty()
        || options
            .targets
            .iter()
            .any(|target| !matches!(target.as_str(), "mix" | "stems"))
    {
        return Err("Export target must contain mix and/or stems".to_string());
    }
    if !matches!(options.range.as_str(), "project" | "loop") {
        return Err("Export range must be project or loop".to_string());
    }
    if !options.ogg_quality.is_finite() || !(0.0..=10.0).contains(&options.ogg_quality) {
        return Err("Ogg quality must be between 0 and 10".to_string());
    }
    match options.format.as_str() {
        "ogg" if options.sample_rate > MAX_OGG_SAMPLE_RATE => Err(format!(
            "Ogg Vorbis sample rate must not exceed {MAX_OGG_SAMPLE_RATE} Hz"
        )),
        "mp3" => mp3_encoder_config(options.sample_rate, options.mp3_bitrate, options.channels)
            .validate()
            .map_err(|error| error.to_string()),
        _ => Ok(()),
    }
}

fn mp3_encoder_config(sample_rate: u32, bitrate: u32, channels: u16) -> Mp3EncoderConfig {
    Mp3EncoderConfig::new()
        .sample_rate(sample_rate)
        .bitrate(bitrate)
        .channels(channels as u8)
        .stereo_mode(if channels == 1 {
            StereoMode::Mono
        } else {
            StereoMode::Stereo
        })
}

fn validate_sound_stoppers(project: &Project) -> Result<(), String> {
    const MAX_SOUND_STOP_TRACK: u32 = 0x7fff;
    let track_ids = project
        .tracks
        .iter()
        .map(|track| track.id.as_str())
        .collect::<std::collections::HashSet<_>>();
    for marker in &project.markers {
        if marker.gate_ticks.is_some_and(|gate| gate > MAX_GATE_TICKS) {
            return Err(format!(
                "Marker gateTicks must be between 0 and {MAX_GATE_TICKS}"
            ));
        }
        let Some(action) = marker.action.as_ref() else {
            continue;
        };
        if marker.gate_ticks.is_some() {
            return Err("Sound Stopper markers cannot have gateTicks".to_string());
        }
        if action.kind != "sound-stop" {
            return Err(format!("Unsupported marker action: {}", action.kind));
        }
        if !track_ids.contains(marker.track_id.as_str()) {
            return Err("Sound Stopper marker references an unknown track".to_string());
        }
        match action.scope.as_str() {
            "all" => {}
            "track-range" => {
                let (Some(start), Some(end)) = (action.start_track, action.end_track) else {
                    return Err("Sound Stopper track range is incomplete".to_string());
                };
                if start == 0 || start > end || end > MAX_SOUND_STOP_TRACK {
                    return Err(format!(
                        "Sound Stopper tracks must be an ordered 1–{MAX_SOUND_STOP_TRACK} range"
                    ));
                }
            }
            _ => return Err(format!("Unsupported Sound Stopper scope: {}", action.scope)),
        }
    }
    Ok(())
}

fn validate_pitch_domain(request: &AudioExportRequest) -> Result<(), String> {
    for marker in request
        .project
        .markers
        .iter()
        .filter(|marker| marker.action.is_none())
    {
        if !marker.pitch.is_finite()
            || !(MIN_MARKER_PITCH..=MAX_MARKER_PITCH).contains(&marker.pitch)
        {
            return Err(format!(
                "Marker {} pitch must be between {MIN_MARKER_PITCH} and {MAX_MARKER_PITCH}",
                marker.id
            ));
        }
        let Some(curve) = marker.pitch_curve.as_ref() else {
            continue;
        };
        for (index, keyframe) in curve.keyframes.iter().enumerate() {
            if !keyframe.value.is_finite()
                || !(MIN_MARKER_PITCH..=MAX_MARKER_PITCH).contains(&keyframe.value)
            {
                return Err(format!(
                    "Marker {} pitchCurve keyframe {index} is outside the safe pitch range",
                    marker.id
                ));
            }
            for handle in [keyframe.handle_l.as_ref(), keyframe.handle_r.as_ref()]
                .into_iter()
                .flatten()
            {
                let control_value = keyframe.value + handle.dv;
                if !control_value.is_finite()
                    || !(MIN_MARKER_PITCH..=MAX_MARKER_PITCH).contains(&control_value)
                {
                    return Err(format!(
                        "Marker {} pitchCurve keyframe {index} control value is outside the safe pitch range",
                        marker.id
                    ));
                }
            }
        }
    }
    for (sound_id, variants) in &request.sound_manifest {
        for variant in variants {
            if !variant.pitch.is_finite()
                || !(MIN_VARIANT_PITCH..=MAX_VARIANT_PITCH).contains(&variant.pitch)
            {
                return Err(format!(
                    "Sound {sound_id} variant pitch must be between {MIN_VARIANT_PITCH} and {MAX_VARIANT_PITCH}"
                ));
            }
        }
    }
    Ok(())
}

fn validate_custom_audio_budget(request: &AudioExportRequest) -> Result<(), String> {
    let mut encoded_by_key = HashMap::<&str, &str>::new();
    let mut estimated_total = 0_usize;
    for variant in request.sound_manifest.values().flatten() {
        let Some(encoded) = variant.data_base64.as_deref() else {
            continue;
        };
        if let Some(previous) = encoded_by_key.insert(&variant.hash, encoded) {
            if previous != encoded {
                return Err(format!(
                    "Conflicting custom audio bytes for asset key {}",
                    variant.hash
                ));
            }
            continue;
        }
        let padding = usize::from(encoded.ends_with('=')) + usize::from(encoded.ends_with("=="));
        let estimated = encoded
            .len()
            .checked_div(4)
            .and_then(|value| value.checked_mul(3))
            .and_then(|value| value.checked_sub(padding))
            .ok_or_else(|| "Invalid custom audio size".to_string())?;
        if estimated > MAX_CUSTOM_AUDIO_BYTES {
            return Err("Custom audio asset exceeds the safe size limit".to_string());
        }
        estimated_total = estimated_total
            .checked_add(estimated)
            .ok_or_else(|| "Invalid custom audio size".to_string())?;
        if estimated_total > MAX_CUSTOM_AUDIO_TOTAL_BYTES {
            return Err("Custom audio assets exceed the project size limit".to_string());
        }
    }
    if request.project.reference_audio.len() > 16 {
        return Err("Reference audio exceeds the 16-track limit".to_string());
    }
    let mut ids = request
        .project
        .tracks
        .iter()
        .map(|track| track.id.as_str())
        .collect::<std::collections::HashSet<_>>();
    let mut reference_total = 0_usize;
    for track in &request.project.reference_audio {
        if track.id.is_empty() || track.id.len() > 128 || !ids.insert(track.id.as_str()) {
            return Err("Reference audio contains an invalid or duplicate track ID".to_string());
        }
        if track.name.is_empty() || track.name.len() > 512 {
            return Err("Reference audio contains an invalid track name".to_string());
        }
        if track.mime_type != "audio/wav" && track.mime_type != "audio/ogg" {
            return Err("Reference audio contains an unsupported media type".to_string());
        }
        if track.byte_length == 0 || track.byte_length > MAX_CUSTOM_AUDIO_BYTES {
            return Err("Reference audio exceeds the safe per-track size limit".to_string());
        }
        let encoded_length = track
            .byte_length
            .checked_add(2)
            .and_then(|value| value.checked_div(3))
            .and_then(|value| value.checked_mul(4))
            .ok_or_else(|| "Invalid reference audio size".to_string())?;
        if track.data_base64.len() != encoded_length {
            return Err("Reference audio encoded size does not match byteLength".to_string());
        }
        if request.project.length_ticks == 0 || track.offset_ticks >= request.project.length_ticks {
            return Err("Reference audio offset is outside the project".to_string());
        }
        if !track.gain_db.is_finite() || !(-60.0..=12.0).contains(&track.gain_db) {
            return Err("Reference audio gain is invalid".to_string());
        }
        if !track.pan.is_finite() || !(-1.0..=1.0).contains(&track.pan) {
            return Err("Reference audio pan is invalid".to_string());
        }
        estimated_total = estimated_total
            .checked_add(track.byte_length)
            .ok_or_else(|| "Invalid reference audio size".to_string())?;
        reference_total = reference_total
            .checked_add(track.byte_length)
            .ok_or_else(|| "Invalid reference audio size".to_string())?;
        if reference_total > MAX_REFERENCE_AUDIO_TOTAL_BYTES {
            return Err("Reference audio exceeds the project size limit".to_string());
        }
        if estimated_total > MAX_CUSTOM_AUDIO_TOTAL_BYTES {
            return Err("Embedded audio exceeds the export request size limit".to_string());
        }
    }
    Ok(())
}

fn build_events(project: &Project) -> Vec<Event> {
    let mut events = Vec::new();
    let track_indices = project
        .tracks
        .iter()
        .enumerate()
        .map(|(index, track)| (track.id.as_str(), index))
        .collect::<HashMap<_, _>>();
    for (marker_index, marker) in project.markers.iter().enumerate() {
        if marker.action.is_some() {
            continue;
        }
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
                tick: marker.tick.saturating_add(offset),
                sound_id: marker.sound_id.clone(),
                variant_index: marker.variant_index,
                volume: sample_curve(marker.volume_curve.as_ref(), offset as f64, marker.volume),
                pitch: sample_curve(marker.pitch_curve.as_ref(), offset as f64, marker.pitch),
                pan: marker.pan.clamp(-1.0, 1.0),
                gate_ticks: marker.gate_ticks.filter(|gate| *gate > 0),
                track_index: track_indices
                    .get(marker.track_id.as_str())
                    .copied()
                    .unwrap_or(usize::MAX),
                marker_index,
            });
        }
    }
    events.sort_by_key(|event| {
        (
            event.tick,
            event.track_index,
            event.marker_index,
            event.firing_index,
        )
    });
    events
}

fn build_stop_events(project: &Project) -> Vec<StopEvent> {
    let track_indices = project
        .tracks
        .iter()
        .enumerate()
        .map(|(index, track)| (track.id.as_str(), index))
        .collect::<HashMap<_, _>>();
    let mut stops = project
        .markers
        .iter()
        .enumerate()
        .filter_map(|(marker_index, marker)| {
            let action = marker.action.as_ref()?;
            Some(StopEvent {
                tick: marker.tick,
                track_index: track_indices
                    .get(marker.track_id.as_str())
                    .copied()
                    .unwrap_or(usize::MAX),
                marker_index,
                scope: action.scope.clone(),
                start_track: action.start_track,
                end_track: action.end_track,
            })
        })
        .collect::<Vec<_>>();
    stops.sort_by_key(|stop| (stop.tick, stop.track_index, stop.marker_index));
    stops
}

fn stop_matches_track(stop: &StopEvent, track_index: usize) -> bool {
    match stop.scope.as_str() {
        "all" => true,
        "track-range" => {
            let one_based = u32::try_from(track_index.saturating_add(1)).unwrap_or(u32::MAX);
            stop.start_track
                .zip(stop.end_track)
                .is_some_and(|(start, end)| one_based >= start && one_based <= end)
        }
        _ => false,
    }
}

fn first_stop_frame(
    event: &Event,
    stops: &[&StopEvent],
    start_tick: u64,
    sample_rate: u32,
) -> Option<usize> {
    stops
        .iter()
        .copied()
        .find(|stop| {
            (stop.tick > event.tick
                || (stop.tick == event.tick && stop.track_index >= event.track_index))
                && stop_matches_track(stop, event.track_index)
        })
        .map(|stop| {
            (((stop.tick - start_tick) as f64 * TICK_SECONDS) * sample_rate as f64).round() as usize
        })
}

fn gate_stop_frame(event: &Event, start_tick: u64, sample_rate: u32) -> Option<usize> {
    let gate_ticks = event.gate_ticks.filter(|gate| *gate > 0)?;
    let start_frame =
        (((event.tick - start_tick) as f64 * TICK_SECONDS) * sample_rate as f64).round() as usize;
    let gate_frames = ((gate_ticks as f64 * TICK_SECONDS) * sample_rate as f64).ceil() as usize;
    Some(start_frame.saturating_add(gate_frames))
}

fn earliest_voice_stop_frame(
    event: &Event,
    stops: &[&StopEvent],
    start_tick: u64,
    sample_rate: u32,
) -> Option<usize> {
    match (
        gate_stop_frame(event, start_tick, sample_rate),
        first_stop_frame(event, stops, start_tick, sample_rate),
    ) {
        (Some(gate), Some(stopper)) => Some(gate.min(stopper)),
        (gate, stopper) => gate.or(stopper),
    }
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

fn checked_frame_count(value: f64, context: &str) -> Result<usize, String> {
    if !value.is_finite() || value < 0.0 || value > usize::MAX as f64 {
        return Err(format!("{context} frame count is invalid"));
    }
    Ok(value.ceil() as usize)
}

fn checked_render_sample_count(frame_count: usize, channels: usize) -> Result<usize, String> {
    let sample_count = frame_count
        .checked_mul(channels)
        .ok_or_else(|| "Rendered audio sample count overflowed".to_string())?;
    let byte_count = sample_count
        .checked_mul(std::mem::size_of::<f32>())
        .ok_or_else(|| "Rendered audio byte count overflowed".to_string())?;
    if byte_count > MAX_RENDERED_PCM_BYTES {
        return Err(format!(
            "Rendered PCM exceeds the {} MiB per-mix/stem safety limit",
            MAX_RENDERED_PCM_BYTES / (1024 * 1024)
        ));
    }
    Ok(sample_count)
}

fn combined_playback_rate(event: &Event, variant: &SoundVariant) -> Result<f64, String> {
    if !event.pitch.is_finite() || !(MIN_MARKER_PITCH..=MAX_MARKER_PITCH).contains(&event.pitch) {
        return Err(format!(
            "Marker {} produced an unsafe pitch",
            event.marker_id
        ));
    }
    if !variant.pitch.is_finite()
        || !(MIN_VARIANT_PITCH..=MAX_VARIANT_PITCH).contains(&variant.pitch)
    {
        return Err(format!(
            "Sound variant for marker {} has an unsafe base pitch",
            event.marker_id
        ));
    }
    let playback_rate = event.pitch * variant.pitch;
    if !playback_rate.is_finite() || playback_rate <= 0.0 {
        return Err(format!(
            "Marker {} produced an invalid playback rate",
            event.marker_id
        ));
    }
    Ok(playback_rate)
}

fn render_audio(
    minecraft_root: &Path,
    request: &AudioExportRequest,
    events: &[Event],
    stop_events: &[StopEvent],
    stem_target: Option<&StemTarget>,
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
    if end_tick < start_tick {
        return Err("Loop range end must not precede its start".to_string());
    }
    let has_solo = project.tracks.iter().any(|track| track.solo)
        || project.reference_audio.iter().any(|track| track.solo);
    let tracks = project
        .tracks
        .iter()
        .filter(|track| match stem_target {
            Some(StemTarget::NoteTrack(id)) => &track.id == id,
            Some(StemTarget::ReferenceAudio(_)) => false,
            None => !track.muted && (!has_solo || track.solo),
        })
        .map(|track| (track.id.as_str(), track))
        .collect::<HashMap<_, _>>();
    let reference_audio = project
        .reference_audio
        .iter()
        .filter(|track| match stem_target {
            Some(StemTarget::ReferenceAudio(id)) => &track.id == id,
            Some(StemTarget::NoteTrack(_)) => false,
            None => !track.muted && (!has_solo || track.solo),
        })
        .collect::<Vec<_>>();
    let selected_events = events
        .iter()
        .filter(|event| {
            event.tick >= start_tick
                && event.tick < end_tick
                && tracks.contains_key(event.track_id.as_str())
        })
        .collect::<Vec<_>>();
    let selected_stops = stop_events
        .iter()
        .filter(|stop| stop.tick >= start_tick && stop.tick < end_tick)
        .collect::<Vec<_>>();

    for event in &selected_events {
        let variant = resolve_variant(request, event)?;
        if !decoded.contains_key(&variant.hash) {
            let audio = decode_sound_variant(minecraft_root, variant)?;
            decoded.insert(variant.hash.clone(), audio);
        }
    }
    for track in &reference_audio {
        let cache_key = format!("@reference:{}", track.id);
        if decoded.contains_key(&cache_key) {
            continue;
        }
        let bytes = BASE64_STANDARD
            .decode(&track.data_base64)
            .map_err(|error| format!("Invalid reference audio base64: {error}"))?;
        if bytes.len() != track.byte_length || bytes.len() > MAX_CUSTOM_AUDIO_BYTES {
            return Err("Reference audio decoded size does not match byteLength".to_string());
        }
        let extension = if track.mime_type == "audio/wav" {
            "wav"
        } else {
            "ogg"
        };
        decoded.insert(cache_key, decode_audio_bytes(&bytes, extension)?);
    }

    let channel_count = options.channels as usize;
    let base_frames = checked_frame_count(
        (end_tick - start_tick) as f64 * TICK_SECONDS * options.sample_rate as f64,
        "Project",
    )?;
    let mut frame_count = base_frames.max(1);
    checked_render_sample_count(frame_count, channel_count)?;
    if options.include_tails {
        for event in &selected_events {
            let variant = resolve_variant(request, event)?;
            let source = decoded
                .get(&variant.hash)
                .ok_or_else(|| "Decoded audio missing".to_string())?;
            let pitch = combined_playback_rate(event, variant)?;
            let start = checked_frame_count(
                ((event.tick - start_tick) as f64 * TICK_SECONDS * options.sample_rate as f64)
                    .round(),
                "Voice start",
            )?;
            let duration =
                (source.samples.len() / source.channels) as f64 / source.sample_rate as f64 / pitch;
            let natural_end = start as f64 + duration * options.sample_rate as f64;
            let audible_end =
                earliest_voice_stop_frame(event, &selected_stops, start_tick, options.sample_rate)
                    .map_or(natural_end, |stop| natural_end.min(stop as f64));
            let audible_end = checked_frame_count(audible_end, "Voice tail")?;
            frame_count = frame_count.max(audible_end);
            checked_render_sample_count(frame_count, channel_count)?;
        }
    }

    let sample_count = checked_render_sample_count(frame_count, channel_count)?;
    let mut output = Vec::new();
    output
        .try_reserve_exact(sample_count)
        .map_err(|_| "Not enough memory to render audio".to_string())?;
    output.resize(sample_count, 0.0_f32);
    for event in selected_events {
        check_canceled(canceled)?;
        let track = tracks[event.track_id.as_str()];
        let variant = resolve_variant(request, event)?;
        let source = decoded
            .get(&variant.hash)
            .ok_or_else(|| "Decoded audio missing".to_string())?;
        let pitch = combined_playback_rate(event, variant)?;
        let start_frame = checked_frame_count(
            ((event.tick - start_tick) as f64 * TICK_SECONDS * options.sample_rate as f64).round(),
            "Voice start",
        )?;
        let source_frames = source.samples.len() / source.channels;
        let stop_frame =
            earliest_voice_stop_frame(event, &selected_stops, start_tick, options.sample_rate);
        let available_frames = frame_count.saturating_sub(start_frame);
        let audible_frames = stop_frame
            .map(|stop| stop.saturating_sub(start_frame))
            .unwrap_or(available_frames)
            .min(available_frames);
        let natural_frames =
            source_frames as f64 * options.sample_rate as f64 / source.sample_rate as f64 / pitch;
        let output_duration =
            checked_frame_count(natural_frames.min(audible_frames as f64), "Voice duration")?;
        let track_gain = db_to_gain(track.gain_db) * event.volume;

        for offset in 0..output_duration {
            let destination_frame = start_frame
                .checked_add(offset)
                .ok_or_else(|| "Voice destination frame overflowed".to_string())?;
            if destination_frame >= frame_count
                || stop_frame.is_some_and(|stop| destination_frame >= stop)
            {
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
                let (left, right) = apply_project_pan(
                    source_left,
                    source_right,
                    source.channels,
                    event.pan,
                    track.pan,
                    request.project.settings.pan_law,
                );
                output[destination_frame * 2] += (left * track_gain) as f32;
                output[destination_frame * 2 + 1] += (right * track_gain) as f32;
            }
        }
    }

    for track in reference_audio {
        check_canceled(canceled)?;
        let cache_key = format!("@reference:{}", track.id);
        let source = decoded
            .get(&cache_key)
            .ok_or_else(|| "Decoded reference audio missing".to_string())?;
        mix_reference_audio(
            &mut output,
            channel_count,
            options.sample_rate,
            source,
            track,
            start_tick,
            end_tick,
            canceled,
        )?;
    }

    if stem_target.is_none() {
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

#[allow(clippy::too_many_arguments)]
fn mix_reference_audio(
    output: &mut [f32],
    output_channels: usize,
    output_sample_rate: u32,
    source: &DecodedAudio,
    track: &ReferenceAudioTrack,
    range_start_tick: u64,
    range_end_tick: u64,
    canceled: &Arc<AtomicBool>,
) -> Result<(), String> {
    let source_frames = source.samples.len() / source.channels;
    if source_frames < 2 || output_channels == 0 {
        return Ok(());
    }
    let output_frames = output.len() / output_channels;
    checked_render_sample_count(output_frames, output_channels)?;
    let source_duration_ticks = source_frames as f64 / source.sample_rate as f64 / TICK_SECONDS;
    let track_start_tick = track.offset_ticks as f64;
    let track_end_tick = track_start_tick + source_duration_ticks;
    let overlap_start_tick = (range_start_tick as f64).max(track_start_tick);
    let overlap_end_tick = (range_end_tick as f64).min(track_end_tick);
    if overlap_end_tick <= overlap_start_tick {
        return Ok(());
    }
    let destination_start = checked_frame_count(
        ((overlap_start_tick - range_start_tick as f64) * TICK_SECONDS * output_sample_rate as f64)
            .round(),
        "Reference audio start",
    )?;
    let requested_duration = checked_frame_count(
        (overlap_end_tick - overlap_start_tick) * TICK_SECONDS * output_sample_rate as f64,
        "Reference audio duration",
    )?;
    let output_duration = requested_duration.min(output_frames.saturating_sub(destination_start));
    let source_start =
        (overlap_start_tick - track_start_tick) * TICK_SECONDS * source.sample_rate as f64;
    let source_step = source.sample_rate as f64 / output_sample_rate as f64;
    let gain = db_to_gain(track.gain_db);

    for offset in 0..output_duration {
        if offset % 262_144 == 0 {
            check_canceled(canceled)?;
        }
        let destination_frame = destination_start
            .checked_add(offset)
            .ok_or_else(|| "Reference audio destination frame overflowed".to_string())?;
        if destination_frame >= output_frames {
            break;
        }
        let source_position = source_start + offset as f64 * source_step;
        if source_position >= source_frames.saturating_sub(1) as f64 {
            break;
        }
        let (source_left, source_right) = interpolate_frame(source, source_position);
        if output_channels == 1 {
            output[destination_frame] += ((source_left + source_right) * 0.5 * gain) as f32;
        } else {
            let (left, right) = apply_pan(source_left, source_right, source.channels, track.pan);
            output[destination_frame * 2] += (left * gain) as f32;
            output[destination_frame * 2 + 1] += (right * gain) as f32;
        }
    }
    Ok(())
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

fn decode_sound_variant(root: &Path, variant: &SoundVariant) -> Result<DecodedAudio, String> {
    if let Some(encoded) = variant.data_base64.as_deref() {
        let bytes = BASE64_STANDARD
            .decode(encoded)
            .map_err(|error| format!("Invalid custom audio base64: {error}"))?;
        if bytes.is_empty() || bytes.len() > MAX_CUSTOM_AUDIO_BYTES {
            return Err("Invalid custom audio asset size".to_string());
        }
        let extension = variant
            .path
            .as_deref()
            .and_then(|path| Path::new(path).extension())
            .and_then(|extension| extension.to_str())
            .unwrap_or("ogg");
        decode_audio_bytes(&bytes, extension)
    } else {
        decode_audio(&object_path(root, &variant.hash)?)
    }
}

fn decode_audio(path: &Path) -> Result<DecodedAudio, String> {
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("ogg");
    if extension.eq_ignore_ascii_case("flac") {
        return decode_flac_bytes(&fs::read(path).map_err(|error| error.to_string())?);
    }
    let source = Box::new(File::open(path).map_err(|error| error.to_string())?);
    decode_audio_source(source, extension)
}

fn decode_audio_bytes(bytes: &[u8], extension: &str) -> Result<DecodedAudio, String> {
    if bytes.is_empty() || bytes.len() > MAX_CUSTOM_AUDIO_BYTES {
        return Err("Invalid custom audio asset size".to_string());
    }
    if extension.eq_ignore_ascii_case("flac") {
        return decode_flac_bytes(bytes);
    }
    decode_audio_source(Box::new(Cursor::new(bytes.to_vec())), extension)
}

/**
 * Validate the exact codec accepted by Java Edition resource packs. A renamed
 * WAV/MP3/Opus container is rejected, and decoding is bounded by the same
 * memory ceiling as offline export.
 */
pub(crate) fn validate_minecraft_resource_ogg(bytes: &[u8]) -> Result<(), String> {
    if !bytes.starts_with(b"OggS") {
        return Err("missing Ogg capture pattern".to_string());
    }
    let decoded = decode_audio_bytes(bytes, "ogg")?;
    if decoded.channels == 0 || decoded.channels > 2 {
        return Err("Java Edition resource-pack audio must be mono or stereo".to_string());
    }
    if decoded.sample_rate == 0 || decoded.sample_rate > MAX_OGG_SAMPLE_RATE {
        return Err("Ogg Vorbis sample rate is outside the supported range".to_string());
    }
    Ok(())
}

fn decode_flac_bytes(bytes: &[u8]) -> Result<DecodedAudio, String> {
    let (expected_sample_rate, expected_channels, expected_bits, total_samples) =
        read_flac_stream_info(bytes)?;
    let expected_interleaved = total_samples
        .checked_mul(u64::from(expected_channels))
        .ok_or_else(|| "FLAC decoded size is invalid".to_string())?;
    let decoded_bytes = expected_interleaved
        .checked_mul(std::mem::size_of::<i32>() as u64)
        .ok_or_else(|| "FLAC decoded size is invalid".to_string())?;
    if total_samples == 0 || decoded_bytes > MAX_DECODED_AUDIO_BYTES {
        return Err("FLAC decoded audio exceeds the safe size limit".to_string());
    }
    let decoded = std::panic::catch_unwind(|| libflac_rs::decode(bytes))
        .map_err(|_| "FLAC decoder rejected the audio stream".to_string())?
        .ok_or_else(|| "Invalid FLAC audio".to_string())?;
    if decoded.sample_rate != expected_sample_rate
        || decoded.channels != expected_channels
        || decoded.bits_per_sample != expected_bits
        || decoded.interleaved.len() as u64 != expected_interleaved
    {
        return Err("FLAC decoded audio does not match STREAMINFO".to_string());
    }
    let scale = (1_u64
        .checked_shl(decoded.bits_per_sample.saturating_sub(1))
        .ok_or_else(|| "FLAC bit depth is unsupported".to_string())?) as f64;
    let channels = usize::try_from(decoded.channels)
        .map_err(|_| "FLAC channel count is unsupported".to_string())?;
    Ok(DecodedAudio {
        sample_rate: decoded.sample_rate,
        channels,
        samples: decoded
            .interleaved
            .into_iter()
            .map(|sample| (sample as f64 / scale).clamp(-1.0, 1.0) as f32)
            .collect(),
    })
}

fn read_flac_stream_info(bytes: &[u8]) -> Result<(u32, u32, u32, u64), String> {
    if bytes.len() < 42 || &bytes[..4] != b"fLaC" {
        return Err("Invalid FLAC signature".to_string());
    }
    let header = bytes[4];
    let block_type = header & 0x7f;
    let block_length = ((bytes[5] as usize) << 16) | ((bytes[6] as usize) << 8) | bytes[7] as usize;
    if block_type != 0 || block_length != 34 || bytes.len() < 8 + block_length {
        return Err("FLAC STREAMINFO is missing or invalid".to_string());
    }
    let packed = u64::from_be_bytes(
        bytes[18..26]
            .try_into()
            .map_err(|_| "FLAC STREAMINFO is truncated".to_string())?,
    );
    let sample_rate = ((packed >> 44) & 0x0f_ffff) as u32;
    let channels = ((packed >> 41) & 0x07) as u32 + 1;
    let bits_per_sample = ((packed >> 36) & 0x1f) as u32 + 1;
    let total_samples = packed & 0x0f_ffff_ffff;
    if sample_rate == 0 || channels == 0 || !(1..=32).contains(&bits_per_sample) {
        return Err("FLAC STREAMINFO has invalid audio parameters".to_string());
    }
    Ok((sample_rate, channels, bits_per_sample, total_samples))
}

fn decode_audio_source(
    source: Box<dyn MediaSource>,
    extension: &str,
) -> Result<DecodedAudio, String> {
    let stream = MediaSourceStream::new(source, Default::default());
    let mut hint = Hint::new();
    hint.with_extension(extension);
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
                let end = start
                    .checked_add(audio.samples_interleaved())
                    .ok_or_else(|| "Decoded audio exceeds the safe size limit".to_string())?;
                let decoded_bytes = end
                    .checked_mul(std::mem::size_of::<f32>())
                    .ok_or_else(|| "Decoded audio exceeds the safe size limit".to_string())?;
                if decoded_bytes as u64 > MAX_DECODED_AUDIO_BYTES {
                    return Err("Decoded audio exceeds the safe size limit".to_string());
                }
                samples.resize(end, 0.0);
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

fn apply_marker_and_track_pan(
    left: f64,
    right: f64,
    source_channels: usize,
    marker_pan: f64,
    track_pan: f64,
) -> (f64, f64) {
    let (left, right) = apply_pan(left, right, source_channels, marker_pan);
    apply_pan(left, right, 2, track_pan)
}

fn nbs_average_pan(marker_pan: f64, track_pan: f64) -> f64 {
    let marker_pan = marker_pan.clamp(-1.0, 1.0);
    let track_pan = track_pan.clamp(-1.0, 1.0);
    if track_pan == 0.0 {
        marker_pan
    } else {
        ((marker_pan + track_pan) * 0.5).clamp(-1.0, 1.0)
    }
}

fn apply_project_pan(
    left: f64,
    right: f64,
    source_channels: usize,
    marker_pan: f64,
    track_pan: f64,
    pan_law: PanLaw,
) -> (f64, f64) {
    match pan_law {
        PanLaw::Cascade => {
            apply_marker_and_track_pan(left, right, source_channels, marker_pan, track_pan)
        }
        PanLaw::NbsAverage => apply_pan(
            left,
            right,
            source_channels,
            nbs_average_pan(marker_pan, track_pan),
        ),
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
        "aiff" => encode_aiff(&temporary, options, audio, canceled),
        "flac" => encode_flac(&temporary, options, audio, canceled),
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

fn encode_aiff(
    path: &Path,
    options: &ExportOptions,
    audio: &RenderedAudio,
    canceled: &Arc<AtomicBool>,
) -> Result<(), String> {
    let bytes_per_sample = usize::from(options.wav_bit_depth / 8);
    let encoded_bytes = audio
        .samples
        .len()
        .checked_mul(bytes_per_sample)
        .and_then(|bytes| bytes.checked_add(128))
        .ok_or_else(|| "AIFF output is too large".to_string())?;
    if encoded_bytes > u32::MAX as usize {
        return Err("AIFF output exceeds the classic 4 GiB container limit".to_string());
    }

    let sample_format = match options.wav_bit_depth {
        16 => AifcSampleFormat::I16,
        24 => AifcSampleFormat::I24,
        32 => AifcSampleFormat::I32,
        _ => return Err("Unsupported AIFF bit depth".to_string()),
    };
    let info = AifcWriteInfo {
        file_format: AifcFileFormat::Aiff,
        channels: audio.channels as i16,
        sample_rate: audio.sample_rate as f64,
        sample_format,
    };
    let mut file = BufWriter::new(File::create(path).map_err(|error| error.to_string())?);
    {
        let mut writer = AifcWriter::new(&mut file, &info).map_err(|error| format!("{error:?}"))?;
        for chunk in audio.samples.chunks(65_536) {
            check_canceled(canceled)?;
            match options.wav_bit_depth {
                16 => {
                    let pcm = chunk
                        .iter()
                        .map(|sample| (sample.clamp(-1.0, 1.0) * i16::MAX as f32).round() as i16)
                        .collect::<Vec<_>>();
                    writer
                        .write_samples_i16(&pcm)
                        .map_err(|error| format!("{error:?}"))?;
                }
                24 => {
                    let pcm = chunk
                        .iter()
                        .map(|sample| (sample.clamp(-1.0, 1.0) * 8_388_607.0).round() as i32)
                        .collect::<Vec<_>>();
                    writer
                        .write_samples_i24(&pcm)
                        .map_err(|error| format!("{error:?}"))?;
                }
                32 => {
                    let pcm = chunk
                        .iter()
                        .map(|sample| {
                            (sample.clamp(-1.0, 1.0) as f64 * i32::MAX as f64).round() as i32
                        })
                        .collect::<Vec<_>>();
                    writer
                        .write_samples_i32(&pcm)
                        .map_err(|error| format!("{error:?}"))?;
                }
                _ => return Err("Unsupported AIFF bit depth".to_string()),
            }
        }
        writer.finalize().map_err(|error| format!("{error:?}"))?;
    }
    file.flush().map_err(|error| error.to_string())
}

fn encode_flac(
    path: &Path,
    options: &ExportOptions,
    audio: &RenderedAudio,
    canceled: &Arc<AtomicBool>,
) -> Result<(), String> {
    let bits = u32::from(options.wav_bit_depth);
    let multiplier = match bits {
        16 => i16::MAX as f64,
        24 => 8_388_607.0,
        32 => i32::MAX as f64,
        _ => return Err("Unsupported FLAC bit depth".to_string()),
    };
    let mut pcm = Vec::new();
    pcm.try_reserve_exact(audio.samples.len())
        .map_err(|_| "Not enough memory to encode FLAC".to_string())?;
    for (index, sample) in audio.samples.iter().enumerate() {
        if index % 262_144 == 0 {
            check_canceled(canceled)?;
        }
        pcm.push((sample.clamp(-1.0, 1.0) as f64 * multiplier).round() as i32);
    }
    check_canceled(canceled)?;

    // libflac-rs is a one-shot encoder. All invariants that its API asserts are
    // validated before entering it; catch an unexpected codec panic so a malformed
    // request cannot bring down the Tauri process.
    let config = FlacEncoderConfig::new(audio.channels.into(), bits, audio.sample_rate);
    let encoded = std::panic::catch_unwind(|| FlacEncoder::new(config).encode(&pcm))
        .map_err(|_| "FLAC encoder rejected the audio stream".to_string())?;
    check_canceled(canceled)?;

    let mut file = BufWriter::new(File::create(path).map_err(|error| error.to_string())?);
    for chunk in encoded.chunks(262_144) {
        check_canceled(canceled)?;
        file.write_all(chunk).map_err(|error| error.to_string())?;
    }
    file.flush().map_err(|error| error.to_string())
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
    let config = mp3_encoder_config(audio.sample_rate, options.mp3_bitrate, audio.channels);
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

    fn export_options(format: &str, sample_rate: u32, channels: u16) -> ExportOptions {
        ExportOptions {
            format: format.to_string(),
            targets: vec!["mix".to_string()],
            sample_rate,
            channels,
            wav_bit_depth: 24,
            ogg_quality: 5.0,
            mp3_bitrate: 192,
            range: "project".to_string(),
            include_tails: true,
            include_muted_tracks: false,
        }
    }

    fn extended_pitch_request(include_tails: bool) -> AudioExportRequest {
        serde_json::from_value(serde_json::json!({
            "defaultName": "extended-pitch",
            "options": {
                "format": "wav", "targets": ["mix", "stems"], "sampleRate": 8000,
                "channels": 1, "wavBitDepth": 24, "oggQuality": 5.0,
                "mp3Bitrate": 192, "range": "project", "includeTails": include_tails,
                "includeMutedTracks": false
            },
            "project": {
                "randomSeed": 1, "lengthTicks": 4, "settings": { "loop": null },
                "master": { "gainDb": 0.0, "limiterEnabled": false, "limiterCeilingDb": -1.0 },
                "tracks": [
                    { "id": "low", "name": "Low", "gainDb": 0.0, "pan": 0.0, "muted": false, "solo": false },
                    { "id": "high", "name": "High", "gainDb": 0.0, "pan": 0.0, "muted": false, "solo": false }
                ],
                "markers": [
                    { "id": "low-note", "trackId": "low", "tick": 0, "soundId": "tone", "variantIndex": -1,
                      "volume": 1.0, "pitch": MIN_MARKER_PITCH },
                    { "id": "high-note", "trackId": "high", "tick": 0, "soundId": "tone", "variantIndex": -1,
                      "volume": 1.0, "pitch": MAX_MARKER_PITCH }
                ]
            },
            "soundManifest": { "tone": [{ "hash": "tone-hash", "pitch": 1.0 }] }
        }))
        .unwrap()
    }

    fn temporary_directory(label: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "knead-{label}-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ))
    }

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
    fn marker_pan_defaults_to_center_for_older_projects() {
        let marker: Marker = serde_json::from_value(serde_json::json!({
            "id": "marker",
            "trackId": "track",
            "tick": 0,
            "soundId": "test",
            "variantIndex": -1,
            "volume": 1.0,
            "pitch": 1.0
        }))
        .unwrap();
        assert_eq!(marker.pan, 0.0);
    }

    #[test]
    fn marker_pan_is_applied_before_track_pan() {
        let (left, right) = apply_marker_and_track_pan(1.0, 1.0, 1, -0.5, 0.5);
        assert!((left - 0.461_939_766).abs() < 0.000_01);
        assert!((right - 0.382_683_432).abs() < 0.000_01);
    }

    #[test]
    fn pan_law_defaults_to_cascade_for_older_projects() {
        let settings: Settings =
            serde_json::from_value(serde_json::json!({ "loop": null })).unwrap();
        assert_eq!(settings.pan_law, PanLaw::Cascade);
    }

    #[test]
    fn nbs_pan_law_uses_note_pan_at_center_and_averages_layer_pan() {
        assert_eq!(nbs_average_pan(0.8, 0.0), 0.8);
        assert!((nbs_average_pan(0.8, -0.4) - 0.2).abs() < 0.000_01);

        let expected = apply_pan(1.0, 1.0, 1, 0.2);
        let actual = apply_project_pan(1.0, 1.0, 1, 0.8, -0.4, PanLaw::NbsAverage);
        assert!((actual.0 - expected.0).abs() < 0.000_01);
        assert!((actual.1 - expected.1).abs() < 0.000_01);
    }

    #[test]
    fn cancellation_is_observed() {
        let canceled = Arc::new(AtomicBool::new(true));
        assert_eq!(check_canceled(&canceled), Err("canceled".to_string()));
    }

    #[test]
    fn export_validation_covers_boundaries_and_codec_limits() {
        for format in ["wav", "aiff", "flac"] {
            validate_options(&export_options(format, 8_000, 1)).unwrap();
            validate_options(&export_options(format, 384_000, 2)).unwrap();
        }
        assert!(validate_options(&export_options("wav", 7_999, 2)).is_err());
        assert!(validate_options(&export_options("wav", 384_001, 2)).is_err());
        validate_options(&export_options("ogg", 200_000, 2)).unwrap();
        assert!(validate_options(&export_options("ogg", 200_001, 2)).is_err());

        let mut low_rate_mp3 = export_options("mp3", 8_000, 1);
        low_rate_mp3.mp3_bitrate = 64;
        validate_options(&low_rate_mp3).unwrap();
        low_rate_mp3.mp3_bitrate = 128;
        assert!(validate_options(&low_rate_mp3).is_err());
        assert!(validate_options(&export_options("unknown", 48_000, 2)).is_err());
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
    fn reference_audio_offset_and_seek_use_the_correct_source_position() {
        let source = DecodedAudio {
            sample_rate: 20,
            channels: 1,
            samples: (0..202).map(|index| index as f32 / 202.0).collect(),
        };
        let track = ReferenceAudioTrack {
            id: "reference".to_string(),
            name: "Guide".to_string(),
            mime_type: "audio/wav".to_string(),
            byte_length: 12,
            data_base64: "UklGRgAAAABXQVZF".to_string(),
            offset_ticks: 20,
            gain_db: 0.0,
            pan: 0.0,
            muted: false,
            solo: false,
        };
        let canceled = Arc::new(AtomicBool::new(false));

        let mut from_start = vec![0.0_f32; 80 * 2];
        mix_reference_audio(&mut from_start, 2, 20, &source, &track, 0, 80, &canceled).unwrap();
        assert!(from_start[..40].iter().all(|sample| *sample == 0.0));
        assert!(from_start[42] > 0.0);

        let mut after_seek = vec![0.0_f32; 40 * 2];
        mix_reference_audio(&mut after_seek, 2, 20, &source, &track, 40, 80, &canceled).unwrap();
        let expected_source = source.samples[20] as f64 * std::f64::consts::FRAC_1_SQRT_2;
        assert!((after_seek[0] as f64 - expected_source).abs() < 0.000_01);
        assert!((after_seek[1] as f64 - expected_source).abs() < 0.000_01);
    }

    #[test]
    fn reference_audio_is_planned_as_an_independent_stem() {
        let request: AudioExportRequest = serde_json::from_value(serde_json::json!({
            "defaultName": "mix",
            "options": {
                "format": "wav",
                "targets": ["stems"],
                "sampleRate": 48000,
                "channels": 2,
                "wavBitDepth": 24,
                "oggQuality": 5.0,
                "mp3Bitrate": 192,
                "range": "project",
                "includeTails": false,
                "includeMutedTracks": false
            },
            "project": {
                "randomSeed": 1,
                "lengthTicks": 200,
                "settings": { "loop": null },
                "master": { "gainDb": 0.0, "limiterEnabled": true, "limiterCeilingDb": -1.0 },
                "tracks": [],
                "markers": [],
                "referenceAudio": [{
                    "id": "guide",
                    "name": "Guide Mix",
                    "mimeType": "audio/wav",
                    "byteLength": 12,
                    "dataBase64": "UklGRgAAAABXQVZF",
                    "offsetTicks": 0,
                    "gainDb": 0.0,
                    "pan": 0.0,
                    "muted": false,
                    "solo": false
                }]
            },
            "soundManifest": {}
        }))
        .unwrap();
        let outputs = planned_outputs(Path::new("exports"), true, &request).unwrap();
        assert_eq!(outputs.len(), 1);
        assert_eq!(
            outputs[0].1,
            Some(StemTarget::ReferenceAudio("guide".to_string()))
        );
        assert!(outputs[0]
            .0
            .file_name()
            .unwrap()
            .to_string_lossy()
            .contains("Reference_Guide Mix"));
    }

    #[test]
    fn all_supported_outputs_have_valid_magic_and_can_be_decoded() {
        let root = temporary_directory("export-codecs");
        fs::create_dir_all(&root).unwrap();
        let sample_rate = 44_100;
        let frames = 4_096;
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
        for format in ["wav", "aiff", "flac", "ogg", "mp3"] {
            let options = export_options(format, sample_rate, 2);
            let path = root.join(format!("test.{format}"));
            encode_atomic(&path, &options, &audio, &canceled).unwrap();
            assert!(path.metadata().unwrap().len() > 64);
            let bytes = fs::read(&path).unwrap();
            match format {
                "wav" => {
                    assert_eq!(&bytes[..4], b"RIFF");
                    assert_eq!(&bytes[8..12], b"WAVE");
                }
                "aiff" => {
                    assert_eq!(&bytes[..4], b"FORM");
                    assert_eq!(&bytes[8..12], b"AIFF");
                }
                "flac" => assert_eq!(&bytes[..4], b"fLaC"),
                "ogg" => {
                    assert_eq!(&bytes[..4], b"OggS");
                    validate_minecraft_resource_ogg(&bytes)
                        .expect("encoded Ogg Vorbis should be accepted for a resource pack");
                }
                "mp3" => {
                    assert_eq!(bytes[0], 0xff);
                    assert_eq!(bytes[1] & 0xe0, 0xe0);
                }
                _ => unreachable!(),
            }
            let decoded = decode_audio(&path).unwrap();
            assert_eq!(decoded.sample_rate, sample_rate);
            assert_eq!(decoded.channels, 2);
            assert!(decoded.samples.iter().any(|sample| sample.abs() > 0.001));
            let memory_decoded = decode_audio_bytes(&bytes, format).unwrap();
            assert_eq!(memory_decoded.sample_rate, sample_rate);
            assert_eq!(memory_decoded.channels, 2);
            assert!(memory_decoded
                .samples
                .iter()
                .any(|sample| sample.abs() > 0.001));
            let variant = SoundVariant {
                hash: format!("knead-custom-{format}"),
                pitch: 1.0,
                path: Some(format!("sample.{format}")),
                data_base64: Some(BASE64_STANDARD.encode(&bytes)),
            };
            let variant_decoded = decode_sound_variant(&root, &variant).unwrap();
            assert_eq!(variant_decoded.sample_rate, sample_rate);
            assert_eq!(variant_decoded.channels, 2);
        }
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn resource_pack_ogg_validation_rejects_renamed_or_truncated_audio() {
        assert!(validate_minecraft_resource_ogg(b"RIFF....WAVE").is_err());
        assert!(validate_minecraft_resource_ogg(b"OggS").is_err());
    }

    #[test]
    fn lossy_codec_boundaries_match_their_strict_validation() {
        let root = temporary_directory("export-lossy-boundaries");
        fs::create_dir_all(&root).unwrap();
        let canceled = Arc::new(AtomicBool::new(false));
        for (format, sample_rate, channels, bitrate) in
            [("ogg", 200_000, 2_u16, 192), ("mp3", 8_000, 1_u16, 64)]
        {
            let frames = 2_304;
            let audio = RenderedAudio {
                channels,
                sample_rate,
                samples: (0..frames * usize::from(channels))
                    .map(|index| (index as f32 * 0.11).sin() * 0.2)
                    .collect(),
            };
            let mut options = export_options(format, sample_rate, channels);
            options.mp3_bitrate = bitrate;
            validate_options(&options).unwrap();
            let path = root.join(format!("boundary.{format}"));
            encode_atomic(&path, &options, &audio, &canceled).unwrap();
            let bytes = fs::read(&path).unwrap();
            if format == "ogg" {
                let decoded = decode_audio(&path).unwrap();
                assert_eq!(decoded.sample_rate, sample_rate);
                assert_eq!(decoded.channels, usize::from(channels));
                assert!(!decoded.samples.is_empty());
            } else {
                assert_eq!(bytes[0], 0xff);
                assert_eq!(bytes[1] & 0xe0, 0xe0);
                let header = u32::from_be_bytes(bytes[..4].try_into().unwrap());
                assert_eq!((header >> 19) & 0x3, 0, "expected MPEG-2.5");
                assert_eq!((header >> 10) & 0x3, 2, "expected 8 kHz index");
                assert_eq!((header >> 6) & 0x3, 3, "expected mono channel mode");
            }
        }
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn aiff_and_flac_round_trip_mono_and_stereo_at_boundary_sample_rates() {
        let root = temporary_directory("export-boundaries");
        fs::create_dir_all(&root).unwrap();
        let canceled = Arc::new(AtomicBool::new(false));
        for (sample_rate, channels) in [(8_000, 1_u16), (384_000, 2_u16)] {
            let samples = (0..257 * usize::from(channels))
                .map(|index| ((index as f32 * 0.17).sin() * 0.4).clamp(-1.0, 1.0))
                .collect::<Vec<_>>();
            let audio = RenderedAudio {
                channels,
                sample_rate,
                samples,
            };
            for bits in [16, 24, 32] {
                for format in ["aiff", "flac"] {
                    let mut options = export_options(format, sample_rate, channels);
                    options.wav_bit_depth = bits;
                    let path = root.join(format!("{sample_rate}-{channels}-{bits}.{format}"));
                    encode_atomic(&path, &options, &audio, &canceled).unwrap();
                    let bytes = fs::read(&path).unwrap();
                    let decoded = decode_audio_bytes(&bytes, format).unwrap();
                    assert_eq!(decoded.sample_rate, sample_rate);
                    assert_eq!(decoded.channels, usize::from(channels));
                    assert_eq!(decoded.samples.len(), audio.samples.len());
                    assert!(decoded.samples.iter().any(|sample| sample.abs() > 0.01));
                    if format == "flac" {
                        let lossless = libflac_rs::decode(&bytes).unwrap();
                        assert!(lossless.md5_ok);
                        assert_eq!(lossless.sample_rate, sample_rate);
                        assert_eq!(lossless.channels, u32::from(channels));
                        assert_eq!(lossless.bits_per_sample, u32::from(bits));
                        if bits <= 24 {
                            let independent =
                                decode_audio_source(Box::new(Cursor::new(bytes.clone())), "flac")
                                    .unwrap();
                            assert_eq!(independent.sample_rate, sample_rate);
                            assert_eq!(independent.channels, usize::from(channels));
                            assert_eq!(independent.samples.len(), audio.samples.len());
                        }
                    }
                }
            }
        }
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn canceled_lossless_exports_leave_no_destination_or_temporary_file() {
        let root = temporary_directory("export-cancel");
        fs::create_dir_all(&root).unwrap();
        let audio = RenderedAudio {
            channels: 2,
            sample_rate: 48_000,
            samples: vec![0.25; 1_024],
        };
        let canceled = Arc::new(AtomicBool::new(true));
        for format in ["aiff", "flac"] {
            let destination = root.join(format!("canceled.{format}"));
            let temporary = destination.with_extension(format!("{format}.knead-tmp"));
            assert_eq!(
                encode_atomic(
                    &destination,
                    &export_options(format, 48_000, 2),
                    &audio,
                    &canceled,
                ),
                Err("canceled".to_string())
            );
            assert!(!destination.exists());
            assert!(!temporary.exists());
        }
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn flac_decoder_rejects_oversized_streaminfo_before_allocating_pcm() {
        let mut bytes =
            FlacEncoder::new(FlacEncoderConfig::new(2, 24, 48_000)).encode(&[0, 0, 1, -1]);
        let packed = u64::from_be_bytes(bytes[18..26].try_into().unwrap());
        bytes[18..26].copy_from_slice(&((packed & !0x0f_ffff_ffff) | 0x0f_ffff_ffff).to_be_bytes());
        assert_eq!(
            decode_flac_bytes(&bytes).unwrap_err(),
            "FLAC decoded audio exceeds the safe size limit"
        );
    }

    #[test]
    fn selected_file_extension_is_forced_to_the_valid_codec_extension() {
        let request: AudioExportRequest = serde_json::from_value(serde_json::json!({
            "defaultName": "show",
            "options": {
                "format": "flac",
                "targets": ["mix"],
                "sampleRate": 384000,
                "channels": 2,
                "wavBitDepth": 24,
                "oggQuality": 5.0,
                "mp3Bitrate": 192,
                "range": "project",
                "includeTails": true,
                "includeMutedTracks": false
            },
            "project": {
                "randomSeed": 1,
                "lengthTicks": 1,
                "settings": { "loop": null },
                "master": { "gainDb": 0.0, "limiterEnabled": false, "limiterCeilingDb": -1.0 },
                "tracks": [],
                "markers": []
            },
            "soundManifest": {}
        }))
        .unwrap();
        let outputs = planned_outputs(Path::new("show.exe"), false, &request).unwrap();
        assert_eq!(outputs[0].0, Path::new("show.flac"));
    }

    #[test]
    fn sound_stopper_cuts_existing_voices_in_mix_and_stems_by_tick_track_order() {
        let request: AudioExportRequest = serde_json::from_value(serde_json::json!({
            "defaultName": "stop-test",
            "options": {
                "format": "wav",
                "targets": ["mix", "stems"],
                "sampleRate": 8000,
                "channels": 2,
                "wavBitDepth": 24,
                "oggQuality": 5.0,
                "mp3Bitrate": 192,
                "range": "project",
                "includeTails": true,
                "includeMutedTracks": false
            },
            "project": {
                "randomSeed": 1,
                "lengthTicks": 10,
                "settings": { "loop": null },
                "master": { "gainDb": 0.0, "limiterEnabled": false, "limiterCeilingDb": -1.0 },
                "tracks": [
                    { "id": "low", "name": "Low", "gainDb": 0.0, "pan": 0.0, "muted": false, "solo": false },
                    { "id": "stop", "name": "Stop", "gainDb": 0.0, "pan": 0.0, "muted": false, "solo": false },
                    { "id": "high", "name": "High", "gainDb": 0.0, "pan": 0.0, "muted": false, "solo": false }
                ],
                "markers": [
                    { "id": "old", "trackId": "low", "tick": 0, "soundId": "tone", "variantIndex": -1, "volume": 1.0, "pitch": 1.0 },
                    { "id": "same-low", "trackId": "low", "tick": 1, "soundId": "tone", "variantIndex": -1, "volume": 1.0, "pitch": 1.0 },
                    { "id": "stopper", "trackId": "stop", "tick": 1, "soundId": "", "variantIndex": -1, "volume": 1.0, "pitch": 1.0,
                      "action": { "type": "sound-stop", "scope": "all" } },
                    { "id": "same-high", "trackId": "high", "tick": 1, "soundId": "tone", "variantIndex": -1, "volume": 1.0, "pitch": 1.0 }
                ]
            },
            "soundManifest": {
                "tone": [{ "hash": "tone-hash", "pitch": 1.0 }]
            }
        }))
        .unwrap();
        validate_sound_stoppers(&request.project).unwrap();
        let events = build_events(&request.project);
        let stops = build_stop_events(&request.project);
        assert_eq!(events.len(), 3);
        assert_eq!(stops.len(), 1);

        let source = DecodedAudio {
            sample_rate: 8_000,
            channels: 1,
            samples: vec![0.5; 8_000],
        };
        let canceled = Arc::new(AtomicBool::new(false));
        let render = |stem_target: Option<&StemTarget>| {
            let mut decoded = HashMap::from([("tone-hash".to_string(), source.clone())]);
            render_audio(
                Path::new("."),
                &request,
                &events,
                &stops,
                stem_target,
                &mut decoded,
                &canceled,
            )
            .unwrap()
        };

        let stop_frame = 400;
        let expected_one_voice = 0.5_f32 * std::f32::consts::FRAC_1_SQRT_2;
        let mix = render(None);
        assert!((mix.samples[0] - expected_one_voice).abs() < 0.000_01);
        assert!((mix.samples[stop_frame * 2] - expected_one_voice).abs() < 0.000_01);

        let low_stem = render(Some(&StemTarget::NoteTrack("low".to_string())));
        assert!((low_stem.samples[0] - expected_one_voice).abs() < 0.000_01);
        assert_eq!(low_stem.samples[stop_frame * 2], 0.0);

        let high_stem = render(Some(&StemTarget::NoteTrack("high".to_string())));
        assert_eq!(high_stem.samples[0], 0.0);
        assert!((high_stem.samples[stop_frame * 2] - expected_one_voice).abs() < 0.000_01);
    }

    #[test]
    fn invalid_sound_stopper_ranges_are_rejected() {
        let project: Project = serde_json::from_value(serde_json::json!({
            "randomSeed": 1,
            "lengthTicks": 10,
            "settings": { "loop": null },
            "master": { "gainDb": 0.0, "limiterEnabled": false, "limiterCeilingDb": -1.0 },
            "tracks": [{ "id": "track", "name": "Track", "gainDb": 0.0, "pan": 0.0, "muted": false, "solo": false }],
            "markers": [{
                "id": "bad", "trackId": "track", "tick": 1, "soundId": "", "variantIndex": -1,
                "volume": 1.0, "pitch": 1.0,
                "action": { "type": "sound-stop", "scope": "track-range", "startTrack": 3, "endTrack": 2 }
            }]
        }))
        .unwrap();
        assert!(validate_sound_stoppers(&project).is_err());
    }

    #[test]
    fn gate_is_a_wall_clock_cutoff_and_stopper_keeps_the_earliest_end() {
        let event = Event {
            marker_id: "gate".to_string(),
            firing_index: 0,
            track_id: "track".to_string(),
            tick: 0,
            sound_id: "tone".to_string(),
            variant_index: -1,
            volume: 1.0,
            pitch: 2.0,
            pan: 0.0,
            gate_ticks: Some(4),
            track_index: 0,
            marker_index: 0,
        };
        assert_eq!(gate_stop_frame(&event, 0, 8_000), Some(1_600));
        let stopper = StopEvent {
            tick: 2,
            track_index: 0,
            marker_index: 1,
            scope: "all".to_string(),
            start_track: None,
            end_track: None,
        };
        assert_eq!(
            earliest_voice_stop_frame(&event, &[&stopper], 0, 8_000),
            Some(800)
        );

        let mut natural = event.clone();
        natural.gate_ticks = None;
        assert_eq!(gate_stop_frame(&natural, 0, 8_000), None);
        natural.gate_ticks = Some(0);
        assert_eq!(gate_stop_frame(&natural, 0, 8_000), None);
    }

    #[test]
    fn gated_retriggers_truncate_mix_and_locked_track_stem() {
        let request: AudioExportRequest = serde_json::from_value(serde_json::json!({
            "defaultName": "gate-test",
            "options": {
                "format": "wav", "targets": ["mix", "stems"], "sampleRate": 8000,
                "channels": 1, "wavBitDepth": 24, "oggQuality": 5.0,
                "mp3Bitrate": 192, "range": "project", "includeTails": true,
                "includeMutedTracks": false
            },
            "project": {
                "randomSeed": 1, "lengthTicks": 3, "settings": { "loop": null },
                "master": { "gainDb": 0.0, "limiterEnabled": false, "limiterCeilingDb": -1.0 },
                "tracks": [{
                    "id": "locked", "name": "Locked", "gainDb": 0.0, "pan": 0.0,
                    "muted": false, "solo": false, "locked": true
                }],
                "markers": [{
                    "id": "retrigger", "trackId": "locked", "tick": 0,
                    "soundId": "tone", "variantIndex": -1, "volume": 1.0,
                    "pitch": 2.0, "gateTicks": 2, "duration": 2, "retriggerInterval": 2
                }]
            },
            "soundManifest": { "tone": [{ "hash": "tone-hash", "pitch": 1.0 }] }
        }))
        .unwrap();
        validate_sound_stoppers(&request.project).unwrap();
        let events = build_events(&request.project);
        assert_eq!(events.len(), 2);
        assert!(events.iter().all(|event| event.gate_ticks == Some(2)));
        let source = DecodedAudio {
            sample_rate: 8_000,
            channels: 1,
            samples: vec![0.5; 8_000],
        };
        let canceled = Arc::new(AtomicBool::new(false));
        let render = |stem_target: Option<&StemTarget>| {
            let mut decoded = HashMap::from([("tone-hash".to_string(), source.clone())]);
            render_audio(
                Path::new("."),
                &request,
                &events,
                &[],
                stem_target,
                &mut decoded,
                &canceled,
            )
            .unwrap()
        };
        let mix = render(None);
        let stem = render(Some(&StemTarget::NoteTrack("locked".to_string())));
        assert_eq!(mix.samples.len(), 1_600);
        assert_eq!(stem.samples.len(), 1_600);
        assert!(mix.samples[799] > 0.0);
        assert!(mix.samples[800] > 0.0);
        assert_eq!(mix.samples, stem.samples);
    }

    #[test]
    fn extended_pitch_resampling_is_exact_in_mix_and_stems() {
        let request = extended_pitch_request(false);
        validate_pitch_domain(&request).unwrap();
        let events = build_events(&request.project);
        let source = DecodedAudio {
            sample_rate: 8_000,
            channels: 1,
            samples: (0..2_048).map(|index| index as f32 / 2_048.0).collect(),
        };
        let canceled = Arc::new(AtomicBool::new(false));
        let render = |target: Option<&StemTarget>| {
            let mut decoded = HashMap::from([("tone-hash".to_string(), source.clone())]);
            render_audio(
                Path::new("."),
                &request,
                &events,
                &[],
                target,
                &mut decoded,
                &canceled,
            )
            .unwrap()
        };
        let low = render(Some(&StemTarget::NoteTrack("low".to_string())));
        let high = render(Some(&StemTarget::NoteTrack("high".to_string())));
        let mix = render(None);
        assert_eq!(low.samples.len(), 1_600);
        assert_eq!(high.samples.len(), 1_600);
        assert!((low.samples[512] - 1.0 / 2_048.0).abs() < 0.000_001);
        assert!((high.samples[1] - 256.0 / 2_048.0).abs() < 0.000_001);
        assert!((mix.samples[1] - (low.samples[1] + high.samples[1])).abs() < 0.000_001);
    }

    #[test]
    fn pitch_validation_and_pcm_budget_reject_unsafe_offline_renders_before_allocation() {
        let request = extended_pitch_request(true);
        validate_pitch_domain(&request).unwrap();

        let mut invalid_marker = request.clone();
        invalid_marker.project.markers[0].pitch = MIN_MARKER_PITCH / 2.0;
        assert!(validate_pitch_domain(&invalid_marker)
            .unwrap_err()
            .contains("Marker low-note pitch"));

        let mut invalid_variant = request.clone();
        invalid_variant.sound_manifest.get_mut("tone").unwrap()[0].pitch = 0.0;
        assert!(validate_pitch_domain(&invalid_variant)
            .unwrap_err()
            .contains("variant pitch"));

        let events = build_events(&request.project);
        let canceled = Arc::new(AtomicBool::new(false));
        let mut decoded = HashMap::from([(
            "tone-hash".to_string(),
            DecodedAudio {
                sample_rate: 8_000,
                channels: 1,
                samples: vec![0.5; 200_000],
            },
        )]);
        let error = match render_audio(
            Path::new("."),
            &request,
            &events,
            &[],
            Some(&StemTarget::NoteTrack("low".to_string())),
            &mut decoded,
            &canceled,
        ) {
            Ok(_) => panic!("oversized low-pitch tail unexpectedly rendered"),
            Err(error) => error,
        };
        assert!(error.contains("256 MiB per-mix/stem safety limit"));
    }

    #[test]
    fn gate_safety_limit_and_sound_stopper_gate_are_rejected() {
        let project = |gate_ticks: u64, action: serde_json::Value| -> Project {
            serde_json::from_value(serde_json::json!({
                "randomSeed": 1, "lengthTicks": 2, "settings": { "loop": null },
                "master": { "gainDb": 0.0, "limiterEnabled": false, "limiterCeilingDb": -1.0 },
                "tracks": [{ "id": "track", "name": "Track", "gainDb": 0.0, "pan": 0.0, "muted": false, "solo": false }],
                "markers": [{
                    "id": "gate", "trackId": "track", "tick": 0, "soundId": "tone",
                    "variantIndex": -1, "volume": 1.0, "pitch": 1.0,
                    "gateTicks": gate_ticks, "action": action
                }]
            }))
            .unwrap()
        };
        assert!(
            validate_sound_stoppers(&project(MAX_GATE_TICKS + 1, serde_json::Value::Null)).is_err()
        );
        assert!(validate_sound_stoppers(&project(
            1,
            serde_json::json!({ "type": "sound-stop", "scope": "all" }),
        ))
        .is_err());
    }
}
