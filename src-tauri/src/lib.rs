mod audio_export;

use base64::{engine::general_purpose::STANDARD as BASE64_STANDARD, Engine as _};
use flate2::read::MultiGzDecoder;
use futures_util::{stream, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use sha1::{Digest, Sha1};
#[cfg(not(debug_assertions))]
use std::process::Command;
use std::{
    collections::{HashMap, HashSet, VecDeque},
    env, fs,
    io::{Cursor, Read, Write},
    path::{Component, Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::{Duration, SystemTime},
};
#[cfg(not(debug_assertions))]
use tauri::window::{ProgressBarState, ProgressBarStatus};
use tauri::{AppHandle, Emitter, Manager, State, WebviewWindow};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_dialog::{MessageDialogButtons, MessageDialogKind};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Sound {
    id: String,
    sounds: Vec<SoundName>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct SoundName {
    path: String,
    hash: String,
    pitch: f64,
}

#[derive(Debug, Deserialize)]
#[serde(untagged)]
enum SoundEntry {
    Name(String),
    Detail(SoundDetail),
}

#[derive(Debug, Deserialize)]
struct SoundDetail {
    name: String,
    pitch: Option<f64>,
    #[serde(rename = "type")]
    kind: Option<String>,
}

#[derive(Debug, Deserialize)]
struct SoundEvent {
    sounds: Vec<SoundEntry>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
struct VersionManifest {
    versions: Vec<ManifestVersion>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
struct ManifestVersion {
    id: String,
    url: String,
    sha1: String,
    #[serde(rename = "type")]
    kind: String,
}

#[derive(Debug, Clone, Deserialize)]
struct AssetIndexReference {
    id: String,
    url: String,
    sha1: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct VersionMetadata {
    asset_index: AssetIndexReference,
    downloads: Option<VersionDownloads>,
}

#[derive(Debug, Clone, Deserialize)]
struct VersionDownloads {
    client: DownloadArtifact,
}

#[derive(Debug, Clone, Deserialize)]
struct DownloadArtifact {
    url: String,
    sha1: String,
    size: u64,
}

#[derive(Debug, Clone, Deserialize)]
struct AssetIndex {
    objects: HashMap<String, AssetObject>,
}

#[derive(Debug, Clone, Deserialize)]
struct AssetObject {
    hash: String,
    size: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct AssetDownloadResult {
    version: String,
    asset_index: String,
    downloaded_assets: usize,
    reused_assets: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AssetDownloadProgress {
    version: String,
    completed_assets: usize,
    total_assets: usize,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct MinecraftVersion {
    id: String,
    downloaded: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum MarkerVisualKind {
    Block,
    Entity,
    Item,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct MarkerVisualSubject {
    kind: MarkerVisualKind,
    id: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct MarkerVisualIcon {
    data_url: String,
    kind: String,
    crop_x: u32,
    crop_y: u32,
    crop_width: u32,
    crop_height: u32,
    image_width: u32,
    image_height: u32,
}

const VERSION_MANIFEST_URL: &str =
    "https://piston-meta.mojang.com/mc/game/version_manifest_v2.json";
const ASSET_OBJECT_BASE_URL: &str = "https://resources.download.minecraft.net";
const ASSET_DOWNLOAD_CONCURRENCY: usize = 12;
const VERSION_MANIFEST_CACHE_MAX_AGE: Duration = Duration::from_secs(6 * 60 * 60);
static DOWNLOAD_TEMP_COUNTER: AtomicU64 = AtomicU64::new(0);
static EXPORT_JOB_COUNTER: AtomicU64 = AtomicU64::new(0);

#[derive(Default)]
struct AppState {
    settings_lock: Mutex<()>,
    selected_sound: Mutex<String>,
    current_sounds: Mutex<Vec<Sound>>,
    timeline_paths: Mutex<HashMap<(String, String), PathBuf>>,
    pending_timeline_paths: Mutex<VecDeque<PathBuf>>,
    timeline_ready_windows: Mutex<HashSet<String>>,
    export_jobs: Mutex<HashMap<String, Arc<AtomicBool>>>,
}

const TIMELINE_OPEN_REQUESTED_EVENT: &str = "timeline-open-requested";
const TIMELINE_CLOSE_REQUESTED_EVENT: &str = "timeline-close-requested";
const MAX_PENDING_TIMELINE_PATHS: usize = 32;
const MAX_TIMELINE_DOCUMENT_ID_BYTES: usize = 128;
const MAX_PLAIN_NBS_CUSTOM_AUDIO_FILES: usize = 240;
const MAX_PLAIN_NBS_CUSTOM_AUDIO_NAME_BYTES: usize = 1024;
const MAX_PLAIN_NBS_CUSTOM_AUDIO_SEGMENTS: usize = 16;
const MAX_PLAIN_NBS_CUSTOM_AUDIO_BYTES: u64 = 32 * 1024 * 1024;
const MAX_PLAIN_NBS_CUSTOM_AUDIO_TOTAL_BYTES: u64 = 96 * 1024 * 1024;

#[cfg(not(debug_assertions))]
#[derive(Debug, Deserialize)]
struct ReleaseAsset {
    name: String,
    browser_download_url: String,
}

#[cfg(not(debug_assertions))]
#[derive(Debug, Deserialize)]
struct ReleaseInfo {
    tag_name: String,
    assets: Vec<ReleaseAsset>,
}

#[cfg(not(debug_assertions))]
struct UpdaterText {
    title: &'static str,
    message: &'static str,
    update: &'static str,
    later: &'static str,
    downloading: &'static str,
    launching: &'static str,
    error: &'static str,
    missing: &'static str,
}

#[cfg(not(debug_assertions))]
fn updater_text(language: &str) -> UpdaterText {
    if language == "ja" {
        UpdaterText {
            title: "アップデートが利用可能です",
            message: "新しいバージョン ({latest}) が見つかりました。アップデートしますか？\n現在のバージョン: {current}",
            update: "アップデート",
            later: "後で",
            downloading: "アップデートファイルをダウンロードしています...",
            launching: "アップデーターを起動しています...",
            error: "アップデートエラー",
            missing: "アップデーターが見つかりません",
        }
    } else {
        UpdaterText {
            title: "Update Available",
            message: "New version ({latest}) is available. Would you like to update?\nCurrent version: {current}",
            update: "Update",
            later: "Later",
            downloading: "Downloading update files...",
            launching: "Launching updater...",
            error: "Update Error",
            missing: "Updater not found",
        }
    }
}

fn is_portable(app: &AppHandle) -> bool {
    app.config().identifier == "com.neac.knead.portable"
}

fn minecraft_dir(app: &AppHandle) -> Result<PathBuf, String> {
    if is_portable(app) {
        return app
            .path()
            .app_data_dir()
            .map(|dir| dir.join(".minecraft"))
            .map_err(|error| error.to_string());
    }
    #[cfg(target_os = "windows")]
    {
        env::var_os("APPDATA")
            .map(PathBuf::from)
            .map(|path| path.join(".minecraft"))
            .ok_or_else(|| "APPDATA is not set".to_string())
    }
    #[cfg(target_os = "macos")]
    {
        env::var_os("HOME")
            .map(PathBuf::from)
            .map(|path| path.join("Library/Application Support/minecraft"))
            .ok_or_else(|| "HOME is not set".to_string())
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        env::var_os("HOME")
            .map(PathBuf::from)
            .map(|path| path.join(".minecraft"))
            .ok_or_else(|| "HOME is not set".to_string())
    }
}

fn validate_version(version: &str) -> Result<(), String> {
    if version.is_empty()
        || version.contains(['/', '\\'])
        || version == "."
        || version == ".."
        || version.chars().any(char::is_control)
    {
        return Err("Invalid Minecraft version".to_string());
    }
    Ok(())
}

fn version_json_path(root: &Path, version: &str) -> PathBuf {
    root.join("versions")
        .join(version)
        .join(format!("{version}.json"))
}

fn asset_index_path(root: &Path, asset_index: &str) -> PathBuf {
    root.join("assets/indexes")
        .join(format!("{asset_index}.json"))
}

fn sha1_hex(bytes: &[u8]) -> String {
    format!("{:x}", Sha1::digest(bytes))
}

fn verify_download(bytes: &[u8], expected_sha1: &str, label: &str) -> Result<(), String> {
    if sha1_hex(bytes) != expected_sha1.to_ascii_lowercase() {
        return Err(format!("SHA-1 verification failed for {label}"));
    }
    Ok(())
}

fn write_download(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| format!("Invalid download path: {}", path.display()))?;
    fs::create_dir_all(parent).map_err(|error| format!("{}: {error}", parent.display()))?;
    let file_name = path
        .file_name()
        .ok_or_else(|| format!("Invalid download path: {}", path.display()))?
        .to_string_lossy();
    let temporary = parent.join(format!(
        "{file_name}.{}.{}.part",
        std::process::id(),
        DOWNLOAD_TEMP_COUNTER.fetch_add(1, Ordering::Relaxed)
    ));
    fs::write(&temporary, bytes).map_err(|error| format!("{}: {error}", temporary.display()))?;
    if let Err(error) = fs::rename(&temporary, path) {
        // Another request may have completed the same content-addressed download.
        if path.is_file() {
            let _ = fs::remove_file(&temporary);
            return Ok(());
        }
        let _ = fs::remove_file(&temporary);
        return Err(format!("{}: {error}", path.display()));
    }
    Ok(())
}

fn write_user_file_safely(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| format!("Invalid save path: {}", path.display()))?;
    let file_name = path
        .file_name()
        .ok_or_else(|| format!("Invalid save path: {}", path.display()))?
        .to_string_lossy();
    let temporary = parent.join(format!(
        ".{file_name}.{}.{}.tmp",
        std::process::id(),
        DOWNLOAD_TEMP_COUNTER.fetch_add(1, Ordering::Relaxed)
    ));
    let backup = parent.join(format!(
        ".{file_name}.{}.{}.bak",
        std::process::id(),
        DOWNLOAD_TEMP_COUNTER.fetch_add(1, Ordering::Relaxed)
    ));
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temporary)
        .map_err(|error| format!("{}: {error}", temporary.display()))?;
    if let Err(error) = file.write_all(bytes).and_then(|_| file.sync_all()) {
        let _ = fs::remove_file(&temporary);
        return Err(format!("{}: {error}", temporary.display()));
    }
    drop(file);

    match fs::rename(&temporary, path) {
        Ok(()) => Ok(()),
        Err(_first_error) if path.is_file() => {
            fs::rename(path, &backup).map_err(|error| {
                let _ = fs::remove_file(&temporary);
                format!("{}: {error}", path.display())
            })?;
            if let Err(error) = fs::rename(&temporary, path) {
                let _ = fs::rename(&backup, path);
                let _ = fs::remove_file(&temporary);
                return Err(format!("{}: {error}", path.display()));
            }
            let _ = fs::remove_file(&backup);
            Ok(())
        }
        Err(error) => {
            let _ = fs::remove_file(&temporary);
            Err(format!("{}: {error}", path.display()))
        }
    }
}

async fn download_bytes(
    client: &reqwest::Client,
    url: &str,
    label: &str,
) -> Result<Vec<u8>, String> {
    let response = client
        .get(url)
        .send()
        .await
        .map_err(|error| format!("Failed to download {label}: {error}"))?
        .error_for_status()
        .map_err(|error| format!("Failed to download {label}: {error}"))?;
    Ok(response
        .bytes()
        .await
        .map_err(|error| format!("Failed to read {label}: {error}"))?
        .to_vec())
}

async fn fetch_version_manifest(client: &reqwest::Client) -> Result<VersionManifest, String> {
    client
        .get(VERSION_MANIFEST_URL)
        .send()
        .await
        .map_err(|error| format!("Failed to download the Minecraft version list: {error}"))?
        .error_for_status()
        .map_err(|error| format!("Failed to download the Minecraft version list: {error}"))?
        .json::<VersionManifest>()
        .await
        .map_err(|error| format!("Invalid Minecraft version list: {error}"))
}

fn read_json<T: for<'de> Deserialize<'de>>(path: &Path) -> Result<T, String> {
    let raw = fs::read(path).map_err(|error| format!("{}: {error}", path.display()))?;
    serde_json::from_slice(&raw).map_err(|error| format!("{}: {error}", path.display()))
}

fn manifest_cache_path(root: &Path) -> PathBuf {
    root.join("assets/knead/version_manifest_v2.json")
}

async fn version_manifest(
    client: &reqwest::Client,
    root: &Path,
) -> Result<VersionManifest, String> {
    let cache_path = manifest_cache_path(root);
    let cached = read_json::<VersionManifest>(&cache_path).ok();
    let cache_is_fresh = cache_path
        .metadata()
        .and_then(|metadata| metadata.modified())
        .ok()
        .and_then(|modified| SystemTime::now().duration_since(modified).ok())
        .map(|age| age <= VERSION_MANIFEST_CACHE_MAX_AGE)
        .unwrap_or(false);
    if cache_is_fresh {
        if let Some(manifest) = cached.clone() {
            return Ok(manifest);
        }
    }

    match fetch_version_manifest(client).await {
        Ok(manifest) => {
            if let Ok(bytes) = serde_json::to_vec(&manifest) {
                let _ = write_download(&cache_path, &bytes);
            }
            Ok(manifest)
        }
        Err(_) if cached.is_some() => Ok(cached.expect("cached manifest should exist")),
        Err(error) => Err(error),
    }
}

fn download_marker_path(root: &Path, version: &str) -> PathBuf {
    root.join("assets/knead/downloaded")
        .join(format!("{}.complete", sha1_hex(version.as_bytes())))
}

fn mark_version_downloaded(root: &Path, version: &str) -> Result<(), String> {
    write_download(&download_marker_path(root, version), b"complete\n")
}

fn local_versions(root: &Path) -> Result<Vec<String>, String> {
    let versions = root.join("versions");
    if !versions.is_dir() {
        return Ok(Vec::new());
    }
    let mut result = Vec::new();
    for entry in
        fs::read_dir(&versions).map_err(|error| format!("{}: {error}", versions.display()))?
    {
        let entry = entry.map_err(|error| error.to_string())?;
        let version = entry.file_name().to_string_lossy().into_owned();
        if entry.path().is_dir() && version_json_path(root, &version).is_file() {
            result.push(version);
        }
    }
    Ok(result)
}

fn is_version_downloaded(root: &Path, version: &str) -> bool {
    if download_marker_path(root, version).is_file() {
        return true;
    }

    // Compatibility for versions installed before completion markers existed.
    // Checking one required object keeps startup fast; selecting the version still
    // verifies and repairs every sound asset before marking it complete.
    let metadata = match read_json::<VersionMetadata>(&version_json_path(root, version)) {
        Ok(metadata) => metadata,
        Err(_) => return false,
    };
    let index = match read_json::<AssetIndex>(&asset_index_path(root, &metadata.asset_index.id)) {
        Ok(index) => index,
        Err(_) => return false,
    };
    let object = match index
        .objects
        .iter()
        .find(|(name, _)| name.ends_with("sounds.json"))
        .map(|(_, object)| object)
    {
        Some(object)
            if object.hash.len() == 40
                && object.hash.chars().all(|value| value.is_ascii_hexdigit()) =>
        {
            object
        }
        _ => return false,
    };
    root.join("assets/objects")
        .join(&object.hash[..2])
        .join(&object.hash)
        .metadata()
        .map(|metadata| metadata.is_file() && metadata.len() == object.size)
        .unwrap_or(false)
}

fn sound_asset_objects(index: &AssetIndex) -> Result<Vec<AssetObject>, String> {
    let mut hashes = HashSet::new();
    let mut result = Vec::new();
    for (name, object) in &index.objects {
        if !(name.ends_with("sounds.json") || name.ends_with(".ogg")) {
            continue;
        }
        if object.hash.len() != 40 || !object.hash.chars().all(|value| value.is_ascii_hexdigit()) {
            return Err(format!("Invalid asset hash for {name}"));
        }
        if hashes.insert(object.hash.clone()) {
            result.push(object.clone());
        }
    }
    if !index
        .objects
        .keys()
        .any(|name| name.ends_with("sounds.json"))
    {
        return Err("sounds.json is missing from the asset index".to_string());
    }
    Ok(result)
}

async fn ensure_version_metadata(
    client: &reqwest::Client,
    root: &Path,
    version: &str,
) -> Result<VersionMetadata, String> {
    let path = version_json_path(root, version);
    if path.is_file() {
        return read_json(&path);
    }

    let manifest = version_manifest(client, root).await?;
    let entry = manifest
        .versions
        .into_iter()
        .find(|entry| entry.id == version)
        .ok_or_else(|| format!("Minecraft version {version} was not found"))?;
    let bytes =
        download_bytes(client, &entry.url, &format!("Minecraft {version} metadata")).await?;
    verify_download(
        &bytes,
        &entry.sha1,
        &format!("Minecraft {version} metadata"),
    )?;
    let metadata = serde_json::from_slice::<VersionMetadata>(&bytes)
        .map_err(|error| format!("Invalid Minecraft {version} metadata: {error}"))?;
    write_download(&path, &bytes)?;
    Ok(metadata)
}

async fn ensure_asset_index(
    client: &reqwest::Client,
    root: &Path,
    reference: &AssetIndexReference,
) -> Result<AssetIndex, String> {
    let path = asset_index_path(root, &reference.id);
    if path.is_file() {
        return read_json(&path);
    }

    let bytes = download_bytes(
        client,
        &reference.url,
        &format!("asset index {}", reference.id),
    )
    .await?;
    verify_download(
        &bytes,
        &reference.sha1,
        &format!("asset index {}", reference.id),
    )?;
    let index = serde_json::from_slice::<AssetIndex>(&bytes)
        .map_err(|error| format!("Invalid asset index {}: {error}", reference.id))?;
    write_download(&path, &bytes)?;
    Ok(index)
}

async fn download_sound_object(
    client: reqwest::Client,
    root: PathBuf,
    object: AssetObject,
) -> Result<bool, String> {
    let path = root
        .join("assets/objects")
        .join(&object.hash[..2])
        .join(&object.hash);
    if path
        .metadata()
        .map(|metadata| metadata.len() == object.size)
        .unwrap_or(false)
    {
        return Ok(false);
    }
    if path.exists() {
        fs::remove_file(&path).map_err(|error| format!("{}: {error}", path.display()))?;
    }
    let url = format!(
        "{ASSET_OBJECT_BASE_URL}/{}/{}",
        &object.hash[..2],
        object.hash
    );
    let bytes = download_bytes(&client, &url, &format!("asset {}", object.hash)).await?;
    if bytes.len() as u64 != object.size {
        return Err(format!(
            "Size verification failed for asset {}",
            object.hash
        ));
    }
    verify_download(&bytes, &object.hash, &format!("asset {}", object.hash))?;
    write_download(&path, &bytes)?;
    Ok(true)
}

fn marker_visual_subject(sound_id: &str) -> Option<MarkerVisualSubject> {
    let id = sound_id.rsplit(':').next().unwrap_or(sound_id);
    let mut parts = id.split('.');
    let kind = match parts.next()? {
        "block" => MarkerVisualKind::Block,
        "entity" => MarkerVisualKind::Entity,
        "item" => MarkerVisualKind::Item,
        _ => return None,
    };
    let subject = parts.next()?.trim();
    let event = parts.next();
    if subject.is_empty()
        || (kind != MarkerVisualKind::Item && event.is_none())
        || event.is_some_and(str::is_empty)
    {
        return None;
    }
    if matches!(
        subject,
        "generic" | "hostile" | "neutral" | "friendly" | "aquatic" | "weather" | "item"
    ) {
        return None;
    }
    let id = if kind == MarkerVisualKind::Item && subject == "armor" {
        let material = event.unwrap_or_default();
        match material
            .strip_prefix("equip_")
            .or_else(|| material.strip_prefix("unequip_"))
            .unwrap_or(material)
        {
            "chain" => "chainmail_chestplate",
            "copper" => "copper_chestplate",
            "diamond" => "diamond_chestplate",
            "elytra" => "elytra",
            "gold" => "golden_chestplate",
            "leather" => "leather_chestplate",
            "nautilus" => "iron_nautilus_armor",
            "netherite" => "netherite_chestplate",
            "turtle" => "turtle_helmet",
            "wolf" => "wolf_armor",
            _ => "iron_chestplate",
        }
        .to_string()
    } else {
        subject.to_string()
    };
    Some(MarkerVisualSubject { kind, id })
}

fn block_texture_alias(subject: &str) -> &str {
    match subject {
        "ancient_debris" => "ancient_debris_side",
        "bamboo_wood" => "bamboo_planks",
        "basalt" => "basalt_side",
        "cave_vines" => "cave_vines_plant",
        "cherry_wood" => "cherry_planks",
        "crop" => "wheat_stage7",
        "fungus" => "warped_fungus",
        "grass" => "grass_block_top",
        "hanging_roots" => "hanging_roots",
        "ladder" => "ladder",
        "metal" => "iron_block",
        "moss" => "moss_block",
        "nether_wood" => "crimson_planks",
        "nylium" => "warped_nylium",
        "roots" => "rooted_dirt",
        "sculk_sensor" => "sculk_sensor_top",
        "stem" => "warped_stem_top",
        "vine" => "vine",
        "wet_grass" => "grass_block_top",
        "wood" => "oak_planks",
        "wool" => "white_wool",
        other => other,
    }
}

fn entity_texture_alias(subject: &str) -> &str {
    match subject {
        "ender_dragon" => "enderdragon",
        "mooshroom" => "cow",
        "snow_golem" => "snow_golem",
        "zombie_villager" => "zombie_villager",
        other => other,
    }
}

fn item_texture_alias(subject: &str) -> &str {
    match subject {
        "axe" => "iron_axe",
        "bottle" => "glass_bottle",
        "crop" => "wheat_seeds",
        "crossbow" => "crossbow_standby",
        "dye" => "white_dye",
        "firecharge" => "fire_charge",
        "flintandsteel" => "flint_and_steel",
        "hoe" => "iron_hoe",
        "horse_armor" => "iron_horse_armor",
        "lodestone_compass" => "compass_00",
        "nautilus_saddle_equip" | "nautilus_saddle_underwater_equip" => "nautilus_saddle",
        "shield" => "shield",
        "shovel" => "iron_shovel",
        "spear" | "spear_wood" => "wooden_spear",
        "totem" => "totem_of_undying",
        other => other,
    }
}

fn marker_texture_path(names: &[String], subject: &MarkerVisualSubject) -> Option<String> {
    match subject.kind {
        MarkerVisualKind::Block => {
            let texture = block_texture_alias(&subject.id);
            let exact = format!("assets/minecraft/textures/block/{texture}.png");
            names.iter().any(|name| name == &exact).then_some(exact)
        }
        MarkerVisualKind::Entity => {
            let entity = entity_texture_alias(&subject.id);
            let exact_candidates = [
                format!("assets/minecraft/textures/entity/{entity}/{entity}.png"),
                format!("assets/minecraft/textures/entity/{entity}.png"),
                format!("assets/minecraft/textures/entity/{entity}/temperate_{entity}.png"),
                format!("assets/minecraft/textures/entity/{entity}/wide/{entity}.png"),
            ];
            if let Some(exact) = exact_candidates
                .iter()
                .find(|candidate| names.iter().any(|name| name == *candidate))
            {
                return Some(exact.clone());
            }

            let prefix = format!("assets/minecraft/textures/entity/{entity}/");
            let mut candidates = names
                .iter()
                .filter(|name| name.starts_with(&prefix) && name.ends_with(".png"))
                .filter(|name| {
                    ![
                        "armor", "eyes", "emissive", "overlay", "saddle", "collar", "angry",
                        "tame", "baby",
                    ]
                    .iter()
                    .any(|excluded| name.contains(excluded))
                })
                .cloned()
                .collect::<Vec<_>>();
            candidates.sort_by_key(|name| {
                let file_name = name.rsplit('/').next().unwrap_or(name);
                (
                    !file_name.contains(entity),
                    !file_name.starts_with("temperate_"),
                    name.len(),
                    name.clone(),
                )
            });
            candidates.into_iter().next()
        }
        MarkerVisualKind::Item => {
            let item = item_texture_alias(&subject.id);
            let exact_candidates = match item {
                "shield" => vec![
                    "assets/minecraft/textures/entity/shield/shield_base_nopattern.png".to_string(),
                    "assets/minecraft/textures/entity/shield/shield_base.png".to_string(),
                ],
                "llama_carpet" => {
                    vec!["assets/minecraft/textures/block/white_wool.png".to_string()]
                }
                "golden_dandelion" => {
                    vec!["assets/minecraft/textures/block/golden_dandelion.png".to_string()]
                }
                "nautilus_saddle" => vec![
                    "assets/minecraft/textures/entity/equipment/nautilus_saddle/saddle.png"
                        .to_string(),
                ],
                _ => vec![format!("assets/minecraft/textures/item/{item}.png")],
            };
            exact_candidates
                .into_iter()
                .find(|candidate| names.iter().any(|name| name == candidate))
        }
    }
}

fn png_dimensions(bytes: &[u8]) -> Option<(u32, u32)> {
    if bytes.len() < 24 || &bytes[..8] != b"\x89PNG\r\n\x1a\n" {
        return None;
    }
    Some((
        u32::from_be_bytes(bytes[16..20].try_into().ok()?),
        u32::from_be_bytes(bytes[20..24].try_into().ok()?),
    ))
}

fn entity_head_crop(subject: &str, width: u32, height: u32) -> Option<(u32, u32, u32, u32)> {
    let (x, y, size) = match subject {
        "ender_dragon" => (8, 8, 8),
        "ghast" => (16, 16, 16),
        "guardian" | "elder_guardian" => (16, 16, 12),
        _ => (8, 8, 8),
    };
    let scale = (width / 64).max(1);
    let crop = (x * scale, y * scale, size * scale, size * scale);
    (crop.0 + crop.2 <= width && crop.1 + crop.3 <= height).then_some(crop)
}

fn load_marker_icons(
    jar_path: &Path,
    sound_ids: &[String],
) -> Result<HashMap<String, MarkerVisualIcon>, String> {
    let file =
        fs::File::open(jar_path).map_err(|error| format!("{}: {error}", jar_path.display()))?;
    let mut archive = zip::ZipArchive::new(file).map_err(|error| error.to_string())?;
    let names = archive.file_names().map(str::to_string).collect::<Vec<_>>();
    let mut icons = HashMap::new();

    for sound_id in sound_ids {
        let Some(subject) = marker_visual_subject(sound_id) else {
            continue;
        };
        let Some(path) = marker_texture_path(&names, &subject) else {
            continue;
        };
        let mut entry = archive.by_name(&path).map_err(|error| error.to_string())?;
        let mut bytes = Vec::with_capacity(entry.size() as usize);
        entry
            .read_to_end(&mut bytes)
            .map_err(|error| error.to_string())?;
        let Some((image_width, image_height)) = png_dimensions(&bytes) else {
            continue;
        };
        let crop = match subject.kind {
            MarkerVisualKind::Block => {
                let size = image_width.min(image_height);
                Some((0, 0, size, size))
            }
            MarkerVisualKind::Entity => entity_head_crop(&subject.id, image_width, image_height),
            MarkerVisualKind::Item => Some((0, 0, image_width, image_height)),
        };
        let Some((crop_x, crop_y, crop_width, crop_height)) = crop else {
            continue;
        };
        icons.insert(
            sound_id.clone(),
            MarkerVisualIcon {
                data_url: format!("data:image/png;base64,{}", BASE64_STANDARD.encode(bytes)),
                kind: match subject.kind {
                    MarkerVisualKind::Block => "block",
                    MarkerVisualKind::Entity => "entity",
                    MarkerVisualKind::Item => "item",
                }
                .to_string(),
                crop_x,
                crop_y,
                crop_width,
                crop_height,
                image_width,
                image_height,
            },
        );
    }
    Ok(icons)
}

async fn ensure_client_jar(app: &AppHandle, version: &str) -> Result<PathBuf, String> {
    validate_version(version)?;
    let root = minecraft_dir(app)?;
    let client = reqwest::Client::new();
    let metadata = ensure_version_metadata(&client, &root, version).await?;
    let artifact = metadata
        .downloads
        .ok_or_else(|| format!("Minecraft {version} metadata has no client download"))?
        .client;
    if artifact.sha1.len() != 40
        || !artifact
            .sha1
            .chars()
            .all(|character| character.is_ascii_hexdigit())
    {
        return Err("Client download has an invalid hash".to_string());
    }
    let installed_path = root
        .join("versions")
        .join(version)
        .join(format!("{version}.jar"));
    if installed_path
        .metadata()
        .map(|metadata| metadata.is_file() && metadata.len() == artifact.size)
        .unwrap_or(false)
    {
        return Ok(installed_path);
    }
    let path = root
        .join("assets/knead/clients")
        .join(format!("{version}.jar"));
    if path
        .metadata()
        .map(|metadata| metadata.is_file() && metadata.len() == artifact.size)
        .unwrap_or(false)
    {
        return Ok(path);
    }
    let bytes = download_bytes(
        &client,
        &artifact.url,
        &format!("Minecraft {version} client"),
    )
    .await?;
    if bytes.len() as u64 != artifact.size {
        return Err(format!(
            "Minecraft {version} client size verification failed"
        ));
    }
    verify_download(
        &bytes,
        &artifact.sha1,
        &format!("Minecraft {version} client"),
    )?;
    write_download(&path, &bytes)?;
    Ok(path)
}

fn app_data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let target = app
        .path()
        .app_config_dir()
        .map_err(|error| error.to_string())?;
    fs::create_dir_all(&target).map_err(|error| error.to_string())?;

    if is_portable(app) {
        return Ok(target);
    }

    // Electron stored data under %APPDATA%/knead (or the platform equivalent).
    // Copy the two user files once so the desktop migration is lossless.
    if let Ok(config_root) = app.path().config_dir() {
        let legacy = config_root.join("knead");
        for name in ["settings.json", "ratingStar.json"] {
            let from = legacy.join(name);
            let to = target.join(name);
            if !to.exists() && from.is_file() {
                let _ = fs::copy(from, to);
            }
        }
    }
    Ok(target)
}

fn default_settings() -> Value {
    json!({
        "volume": 0.5,
        "language": "en",
        "theme": "system",
        "selectedVersion": null,
        "studioMarkerIcons": false,
        "playbackCategory": "player",
        "holdSoundsSort": false,
        "holdRatingFilter": false,
        "lastSoundsSort": { "id": "ascending", "rating": "none" },
        "lastRatingFilter": []
    })
}

fn load_json(path: &Path, fallback: Value) -> Value {
    match fs::read_to_string(path)
        .ok()
        .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
    {
        Some(value) => value,
        None => {
            let _ = fs::write(
                path,
                serde_json::to_string_pretty(&fallback).unwrap_or_default(),
            );
            fallback
        }
    }
}

fn settings_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app_data_dir(app)?.join("settings.json"))
}

fn rating_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(app_data_dir(app)?.join("ratingStar.json"))
}

fn merged_settings(app: &AppHandle) -> Result<Value, String> {
    let state = app.state::<AppState>();
    let _guard = state.settings_lock.lock().map_err(|err| err.to_string())?;
    read_settings(app)
}

fn read_settings(app: &AppHandle) -> Result<Value, String> {
    let defaults = default_settings();
    let stored = load_json(&settings_path(app)?, defaults.clone());
    let mut merged = defaults.as_object().cloned().unwrap_or_default();
    if let Some(values) = stored.as_object() {
        merged.extend(values.clone());
    }
    Ok(Value::Object(merged))
}

fn write_json(path: &Path, value: &Value) -> Result<(), String> {
    let contents = serde_json::to_string_pretty(value).map_err(|error| error.to_string())?;
    fs::write(path, contents).map_err(|error| error.to_string())
}

fn hash_for(objects: &Map<String, Value>, name: &str) -> String {
    [
        format!("minecraft/sounds/{name}.ogg"),
        format!("sounds/{name}.ogg"),
        format!("sound/{name}.ogg"),
    ]
    .iter()
    .find_map(|key| objects.get(key)?.get("hash")?.as_str())
    .unwrap_or_default()
    .to_string()
}

fn append_entry(
    output: &mut Vec<SoundName>,
    entry: &SoundEntry,
    inherited_pitch: f64,
    events: &HashMap<String, SoundEvent>,
    objects: &Map<String, Value>,
    depth: usize,
) {
    if depth > 32 {
        return;
    }
    match entry {
        SoundEntry::Name(name) => output.push(SoundName {
            path: name.clone(),
            hash: hash_for(objects, name),
            pitch: inherited_pitch.clamp(0.5, 2.0),
        }),
        SoundEntry::Detail(detail) if detail.kind.as_deref() == Some("event") => {
            if let Some(event) = events.get(&detail.name) {
                let pitch = inherited_pitch * detail.pitch.unwrap_or(1.0);
                for nested in &event.sounds {
                    append_entry(output, nested, pitch, events, objects, depth + 1);
                }
            }
        }
        SoundEntry::Detail(detail) => output.push(SoundName {
            path: detail.name.clone(),
            hash: hash_for(objects, &detail.name),
            pitch: (inherited_pitch * detail.pitch.unwrap_or(1.0)).clamp(0.5, 2.0),
        }),
    }
}

#[tauri::command]
async fn get_versions(app: AppHandle) -> Result<Vec<MinecraftVersion>, String> {
    let root = minecraft_dir(&app)?;
    let local = local_versions(&root)?;
    let mut versions = local
        .iter()
        .map(|version| (version.clone(), is_version_downloaded(&root, version)))
        .collect::<HashMap<_, _>>();
    let client = reqwest::Client::new();
    match version_manifest(&client, &root).await {
        Ok(manifest) => {
            for entry in manifest
                .versions
                .into_iter()
                .filter(|entry| entry.kind == "release" || entry.kind == "snapshot")
            {
                versions.entry(entry.id).or_insert(false);
            }
        }
        Err(error) if versions.is_empty() => return Err(error),
        Err(_) => {}
    }
    let mut result = versions
        .into_iter()
        .map(|(id, downloaded)| MinecraftVersion { id, downloaded })
        .collect::<Vec<_>>();
    result.sort_by(|a, b| a.id.cmp(&b.id));
    Ok(result)
}

#[tauri::command]
async fn download_version_assets(
    app: AppHandle,
    version: String,
) -> Result<AssetDownloadResult, String> {
    validate_version(&version)?;
    let root = minecraft_dir(&app)?;
    let client = reqwest::Client::new();
    let metadata = ensure_version_metadata(&client, &root, &version).await?;
    let index = ensure_asset_index(&client, &root, &metadata.asset_index).await?;
    let objects = sound_asset_objects(&index)?;
    let total = objects.len();
    app.emit(
        "asset-download-progress",
        AssetDownloadProgress {
            version: version.clone(),
            completed_assets: 0,
            total_assets: total,
        },
    )
    .map_err(|error| error.to_string())?;

    let mut downloads = stream::iter(
        objects
            .into_iter()
            .map(|object| download_sound_object(client.clone(), root.clone(), object)),
    )
    .buffer_unordered(ASSET_DOWNLOAD_CONCURRENCY);

    let mut downloaded_assets = 0;
    let mut completed_assets = 0;
    while let Some(download) = downloads.next().await {
        if download? {
            downloaded_assets += 1;
        }
        completed_assets += 1;
        if completed_assets % 25 == 0 || completed_assets == total {
            app.emit(
                "asset-download-progress",
                AssetDownloadProgress {
                    version: version.clone(),
                    completed_assets,
                    total_assets: total,
                },
            )
            .map_err(|error| error.to_string())?;
        }
    }
    mark_version_downloaded(&root, &version)?;
    Ok(AssetDownloadResult {
        version,
        asset_index: metadata.asset_index.id,
        downloaded_assets,
        reused_assets: total - downloaded_assets,
    })
}

#[tauri::command]
fn get_mc_sounds(
    version: String,
    window: tauri::Window,
    state: State<'_, AppState>,
) -> Result<Vec<Sound>, String> {
    validate_version(&version)?;
    let root = minecraft_dir(window.app_handle())?;
    let version_json = root
        .join("versions")
        .join(&version)
        .join(format!("{version}.json"));
    let version_value: Value = serde_json::from_str(
        &fs::read_to_string(&version_json)
            .map_err(|error| format!("{}: {error}", version_json.display()))?,
    )
    .map_err(|error| error.to_string())?;
    let asset_index = version_value
        .pointer("/assetIndex/id")
        .and_then(Value::as_str)
        .ok_or_else(|| "assetIndex.id is missing".to_string())?;
    let index_path = root
        .join("assets/indexes")
        .join(format!("{asset_index}.json"));
    let index: Value = serde_json::from_str(
        &fs::read_to_string(&index_path)
            .map_err(|error| format!("{}: {error}", index_path.display()))?,
    )
    .map_err(|error| error.to_string())?;
    let objects = index
        .get("objects")
        .and_then(Value::as_object)
        .ok_or_else(|| "Asset index objects are missing".to_string())?;
    let sounds_hash = objects
        .iter()
        .find(|(key, _)| key.ends_with("sounds.json"))
        .and_then(|(_, value)| value.get("hash"))
        .and_then(Value::as_str)
        .ok_or_else(|| "sounds.json is missing from the asset index".to_string())?;
    if sounds_hash.len() < 2
        || !sounds_hash
            .chars()
            .all(|character| character.is_ascii_hexdigit())
    {
        return Err("sounds.json has an invalid asset hash".to_string());
    }
    let sounds_path = root
        .join("assets/objects")
        .join(&sounds_hash[..2])
        .join(sounds_hash);
    let events: HashMap<String, SoundEvent> = serde_json::from_str(
        &fs::read_to_string(&sounds_path)
            .map_err(|error| format!("{}: {error}", sounds_path.display()))?,
    )
    .map_err(|error| error.to_string())?;

    let mut result = Vec::with_capacity(events.len());
    for (id, event) in &events {
        let mut sounds = Vec::new();
        for entry in &event.sounds {
            append_entry(&mut sounds, entry, 1.0, &events, objects, 0);
        }
        result.push(Sound {
            id: id.clone(),
            sounds,
        });
    }
    result.sort_by(|a, b| a.id.cmp(&b.id));
    if window.label() == "main" {
        *state
            .current_sounds
            .lock()
            .map_err(|error| error.to_string())? = result.clone();
    }
    Ok(result)
}

#[tauri::command]
fn get_mc_sound_hash(app: AppHandle, hash: String) -> Result<String, String> {
    if hash.is_empty() {
        return Ok(String::new());
    }
    if hash.len() < 2 || !hash.chars().all(|character| character.is_ascii_hexdigit()) {
        return Err("Invalid sound hash".to_string());
    }
    Ok(minecraft_dir(&app)?
        .join("assets/objects")
        .join(&hash[..2])
        .join(hash)
        .to_string_lossy()
        .into_owned())
}

#[tauri::command]
fn get_mc_sound_data(app: AppHandle, hash: String) -> Result<tauri::ipc::Response, String> {
    if hash.len() < 2 || !hash.chars().all(|character| character.is_ascii_hexdigit()) {
        return Err("Invalid sound hash".to_string());
    }
    let path = minecraft_dir(&app)?
        .join("assets/objects")
        .join(&hash[..2])
        .join(hash);
    let bytes = fs::read(&path).map_err(|error| format!("{}: {error}", path.display()))?;
    Ok(tauri::ipc::Response::new(bytes))
}

#[tauri::command]
async fn get_mc_marker_icons(
    app: AppHandle,
    version: String,
    sound_ids: Vec<String>,
) -> Result<HashMap<String, MarkerVisualIcon>, String> {
    let jar_path = ensure_client_jar(&app, &version).await?;
    tauri::async_runtime::spawn_blocking(move || load_marker_icons(&jar_path, &sound_ids))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
fn load_settings(app: AppHandle) -> Result<Value, String> {
    merged_settings(&app)
}

#[tauri::command]
fn update_settings(app: AppHandle, partial: Value) -> Result<(), String> {
    let state = app.state::<AppState>();
    let _guard = state.settings_lock.lock().map_err(|err| err.to_string())?;
    let mut settings = read_settings(&app)?;
    let target = settings
        .as_object_mut()
        .ok_or_else(|| "Invalid settings".to_string())?;
    let values = partial
        .as_object()
        .ok_or_else(|| "Settings update must be an object".to_string())?;
    target.extend(values.clone());
    write_json(&settings_path(&app)?, &settings)?;
    let shared: serde_json::Map<_, _> = values
        .iter()
        .filter(|(key, _)| matches!(key.as_str(), "theme" | "language" | "selectedVersion"))
        .map(|(key, value)| (key.clone(), value.clone()))
        .collect();
    if !shared.is_empty() {
        app.emit("settings-changed", &shared)
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn get_setting(app: AppHandle, key: String) -> Result<Value, String> {
    Ok(merged_settings(&app)?
        .get(&key)
        .cloned()
        .unwrap_or(Value::Null))
}

#[tauri::command]
fn set_setting(app: AppHandle, key: String, value: Value) -> Result<(), String> {
    update_settings(app, json!({ (key): value }))
}

#[tauri::command]
fn load_rating_star(app: AppHandle) -> Result<Value, String> {
    Ok(load_json(&rating_path(&app)?, json!({})))
}

#[tauri::command]
fn save_rating_star(app: AppHandle, data: String) -> Result<(), String> {
    save_rating_star_as_string(app, data)
}

#[tauri::command]
fn save_rating_star_as_string(app: AppHandle, data: String) -> Result<(), String> {
    let value: Value = serde_json::from_str(&data).map_err(|error| error.to_string())?;
    write_json(&rating_path(&app)?, &value)
}

#[tauri::command]
fn update_rating_star(app: AppHandle, key: String, value: f64) -> Result<(), String> {
    let mut ratings = load_json(&rating_path(&app)?, json!({}));
    ratings
        .as_object_mut()
        .ok_or_else(|| "Invalid rating data".to_string())?
        .insert(key, json!(value));
    write_json(&rating_path(&app)?, &ratings)
}

#[tauri::command]
fn set_selected_sound(id: String, state: State<'_, AppState>) -> Result<(), String> {
    *state
        .selected_sound
        .lock()
        .map_err(|error| error.to_string())? = id;
    Ok(())
}

#[tauri::command]
fn get_main_selected_sound(state: State<'_, AppState>) -> Result<String, String> {
    Ok(state
        .selected_sound
        .lock()
        .map_err(|error| error.to_string())?
        .clone())
}

#[tauri::command]
fn get_current_sounds(state: State<'_, AppState>) -> Result<Vec<Sound>, String> {
    Ok(state
        .current_sounds
        .lock()
        .map_err(|error| error.to_string())?
        .clone())
}

#[tauri::command]
fn make_sub_window(app: AppHandle) -> Result<(), String> {
    let window = app
        .get_webview_window("sub")
        .ok_or_else(|| "Timeline window is not initialized".to_string())?;
    window.show().map_err(|error| error.to_string())?;
    window.set_focus().map_err(|error| error.to_string())?;
    Ok(())
}

fn ok_path(path: &Path) -> Value {
    json!({ "ok": true, "path": path.to_string_lossy() })
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CommandExportRequest {
    default_name: String,
    #[serde(default)]
    kind: CommandExportKind,
    files: HashMap<String, CommandExportFilePayload>,
}

#[derive(Debug, Clone, Copy, Default, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
enum CommandExportKind {
    #[default]
    DataPack,
    ResourcePack,
}

#[derive(Debug, Deserialize)]
#[serde(untagged)]
enum CommandExportFilePayload {
    Text(String),
    Encoded(CommandExportEncodedFile),
}

#[derive(Debug, Deserialize)]
struct CommandExportEncodedFile {
    encoding: String,
    data: String,
}

const MAX_COMMAND_EXPORT_FILES: usize = 20_000;
const MAX_COMMAND_EXPORT_FILE_BYTES: usize = 32 * 1024 * 1024;
const MAX_COMMAND_DATA_PACK_TOTAL_BYTES: usize = 16 * 1024 * 1024;
const MAX_COMMAND_RESOURCE_PACK_TOTAL_BYTES: usize = 128 * 1024 * 1024;

fn valid_zip_entry(path: &str) -> bool {
    !path.is_empty()
        && path.len() <= 512
        && !path.contains('\\')
        && !path.starts_with('/')
        && !path.ends_with('/')
        && !path.contains("//")
        && !path.chars().any(char::is_control)
        && path
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'/' | b'_' | b'.' | b'-'))
        && Path::new(path)
            .components()
            .all(|component| matches!(component, Component::Normal(_)))
}

fn decode_command_export_files_with_limits(
    files: HashMap<String, CommandExportFilePayload>,
    max_file_bytes: usize,
    max_total_bytes: usize,
) -> Result<Vec<(String, Vec<u8>)>, String> {
    if files.is_empty() || files.len() > MAX_COMMAND_EXPORT_FILES {
        return Err("Invalid export file count".to_string());
    }
    let mut decoded = Vec::with_capacity(files.len());
    let mut total_bytes = 0_usize;
    let mut payloads: Vec<_> = files.into_iter().collect();
    payloads.sort_by(|left, right| left.0.cmp(&right.0));
    for (path, payload) in payloads {
        if !valid_zip_entry(&path) {
            return Err(format!("Unsafe ZIP entry: {path}"));
        }
        let bytes = match payload {
            CommandExportFilePayload::Text(value) => value.into_bytes(),
            CommandExportFilePayload::Encoded(encoded) => {
                if encoded.encoding != "base64" {
                    return Err(format!("Unsupported file encoding for {path}"));
                }
                let maximum_encoded = max_file_bytes
                    .checked_add(2)
                    .and_then(|value| value.checked_div(3))
                    .and_then(|value| value.checked_mul(4))
                    .ok_or_else(|| "Invalid export size budget".to_string())?;
                if encoded.data.len() > maximum_encoded {
                    return Err(format!("Export file exceeds the per-file budget: {path}"));
                }
                BASE64_STANDARD
                    .decode(encoded.data.as_bytes())
                    .map_err(|error| format!("Invalid base64 file {path}: {error}"))?
            }
        };
        if bytes.len() > max_file_bytes {
            return Err(format!("Export file exceeds the per-file budget: {path}"));
        }
        total_bytes = total_bytes
            .checked_add(bytes.len())
            .ok_or_else(|| "Export contents exceed the total budget".to_string())?;
        if total_bytes > max_total_bytes {
            return Err("Export contents exceed the total budget".to_string());
        }
        if path.to_ascii_lowercase().ends_with(".ogg") {
            audio_export::validate_minecraft_resource_ogg(&bytes)
                .map_err(|error| format!("Invalid Minecraft Ogg Vorbis asset {path}: {error}"))?;
        }
        decoded.push((path, bytes));
    }
    Ok(decoded)
}

fn build_command_export_zip(entries: Vec<(String, Vec<u8>)>) -> Result<Vec<u8>, String> {
    let cursor = Cursor::new(Vec::new());
    let mut archive = zip::ZipWriter::new(cursor);
    let zip_options = zip::write::SimpleFileOptions::default()
        .compression_method(zip::CompressionMethod::Deflated);
    for (entry_path, contents) in entries {
        archive
            .start_file(entry_path, zip_options)
            .and_then(|_| archive.write_all(&contents).map_err(Into::into))
            .map_err(|error| error.to_string())?;
    }
    archive
        .finish()
        .map(|cursor| cursor.into_inner())
        .map_err(|error| error.to_string())
}

#[tauri::command]
async fn command_export_save(
    app: AppHandle,
    window: WebviewWindow,
    request: CommandExportRequest,
) -> Result<Value, String> {
    let max_total_bytes = match request.kind {
        CommandExportKind::DataPack => MAX_COMMAND_DATA_PACK_TOTAL_BYTES,
        CommandExportKind::ResourcePack => MAX_COMMAND_RESOURCE_PACK_TOTAL_BYTES,
    };
    let entries = match decode_command_export_files_with_limits(
        request.files,
        MAX_COMMAND_EXPORT_FILE_BYTES,
        max_total_bytes,
    ) {
        Ok(entries) => entries,
        Err(error) => return Ok(json!({ "ok": false, "error": error })),
    };
    let archive_bytes = match build_command_export_zip(entries) {
        Ok(bytes) => bytes,
        Err(error) => return Ok(json!({ "ok": false, "error": error })),
    };
    let default_name = Path::new(&request.default_name)
        .file_name()
        .and_then(|name| name.to_str())
        .filter(|name| !name.is_empty())
        .unwrap_or(match request.kind {
            CommandExportKind::DataPack => "knead-show.zip",
            CommandExportKind::ResourcePack => "knead-show-resources.zip",
        });
    let (title, filter_name) = match request.kind {
        CommandExportKind::DataPack => ("Minecraft データパックを書き出し", "Data Pack"),
        CommandExportKind::ResourcePack => ("Minecraft リソースパックを書き出し", "Resource Pack"),
    };
    let Some(file) = app
        .dialog()
        .file()
        .set_parent(&window)
        .set_title(title)
        .add_filter(filter_name, &["zip"])
        .set_file_name(default_name)
        .blocking_save_file()
    else {
        return Ok(json!({ "ok": false, "canceled": true }));
    };
    let mut path = match file.into_path() {
        Ok(path) => path,
        Err(error) => return Ok(json!({ "ok": false, "error": error.to_string() })),
    };
    if path.extension().is_none() {
        path.set_extension("zip");
    }
    if let Err(error) = write_user_file_safely(&path, &archive_bytes) {
        return Ok(json!({ "ok": false, "error": error }));
    }
    Ok(ok_path(&path))
}

#[tauri::command]
async fn nbs_open_dialog(app: AppHandle, window: WebviewWindow) -> Result<Value, String> {
    let Some(file) = app
        .dialog()
        .file()
        .set_parent(&window)
        .set_title("Note Block Studio ファイルを読み込み")
        .add_filter("Note Block Song", &["nbs"])
        .blocking_pick_file()
    else {
        return Ok(json!({ "ok": false, "canceled": true }));
    };
    let path = match file.into_path() {
        Ok(path) => path,
        Err(error) => return Ok(json!({ "ok": false, "error": error.to_string() })),
    };
    if !path
        .extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case("nbs"))
    {
        return Ok(json!({ "ok": false, "error": "Select an .nbs file" }));
    }
    let size = match fs::metadata(&path) {
        Ok(metadata) => metadata.len(),
        Err(error) => return Ok(json!({ "ok": false, "error": error.to_string() })),
    };
    if size == 0 || size > 16 * 1024 * 1024 {
        return Ok(json!({ "ok": false, "error": "Invalid NBS data size" }));
    }
    Ok(match fs::read(&path) {
        Ok(data) if !data.is_empty() && data.len() <= 16 * 1024 * 1024 => json!({
            "ok": true,
            "path": path.to_string_lossy(),
            "dataBase64": BASE64_STANDARD.encode(data),
        }),
        Ok(_) => json!({ "ok": false, "error": "Invalid NBS data size" }),
        Err(error) => json!({ "ok": false, "error": error.to_string() }),
    })
}

const MAX_NBS_BUNDLE_BYTES: usize = 64 * 1024 * 1024;
const MAX_RESOURCE_PACK_BYTES: usize = 64 * 1024 * 1024;

#[tauri::command]
async fn nbs_bundle_open_dialog(app: AppHandle, window: WebviewWindow) -> Result<Value, String> {
    let Some(file) = app
        .dialog()
        .file()
        .set_parent(&window)
        .set_title("Note Block Studio 音源同梱ZIPを読み込み")
        .add_filter("OpenNBS Zipped Song", &["zip"])
        .blocking_pick_file()
    else {
        return Ok(json!({ "ok": false, "canceled": true }));
    };
    let path = match file.into_path() {
        Ok(path) => path,
        Err(error) => return Ok(json!({ "ok": false, "error": error.to_string() })),
    };
    if !path
        .extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case("zip"))
    {
        return Ok(json!({ "ok": false, "error": "Select an OpenNBS .zip bundle" }));
    }
    let size = match fs::metadata(&path) {
        Ok(metadata) => metadata.len(),
        Err(error) => return Ok(json!({ "ok": false, "error": error.to_string() })),
    };
    if size == 0 || size > MAX_NBS_BUNDLE_BYTES as u64 {
        return Ok(json!({ "ok": false, "error": "Invalid NBS bundle size" }));
    }
    Ok(match fs::read(&path) {
        Ok(data) if !data.is_empty() && data.len() <= MAX_NBS_BUNDLE_BYTES => json!({
            "ok": true,
            "path": path.to_string_lossy(),
            "dataBase64": BASE64_STANDARD.encode(data),
        }),
        Ok(_) => json!({ "ok": false, "error": "Invalid NBS bundle size" }),
        Err(error) => json!({ "ok": false, "error": error.to_string() }),
    })
}

#[tauri::command]
async fn resource_pack_open_dialog(app: AppHandle, window: WebviewWindow) -> Result<Value, String> {
    let Some(file) = app
        .dialog()
        .file()
        .set_parent(&window)
        .set_title("Minecraft Java リソースパックを追加")
        .add_filter("Minecraft Java Resource Pack", &["zip"])
        .blocking_pick_file()
    else {
        return Ok(json!({ "ok": false, "canceled": true }));
    };
    let path = match file.into_path() {
        Ok(path) => path,
        Err(error) => return Ok(json!({ "ok": false, "error": error.to_string() })),
    };
    if !path
        .extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case("zip"))
    {
        return Ok(json!({ "ok": false, "error": "Select a .zip resource pack" }));
    }
    let size = match fs::metadata(&path) {
        Ok(metadata) => metadata.len(),
        Err(error) => return Ok(json!({ "ok": false, "error": error.to_string() })),
    };
    if size == 0 || size > MAX_RESOURCE_PACK_BYTES as u64 {
        return Ok(json!({
            "ok": false,
            "error": "Resource-pack ZIP must be between 1 byte and 64 MiB"
        }));
    }
    Ok(match fs::read(&path) {
        Ok(data)
            if !data.is_empty()
                && data.len() <= MAX_RESOURCE_PACK_BYTES
                && data.len() as u64 == size
                && data.starts_with(b"PK\x03\x04") =>
        {
            json!({
                "ok": true,
                "path": path.to_string_lossy(),
                "dataBase64": BASE64_STANDARD.encode(data),
            })
        }
        Ok(_) => json!({
            "ok": false,
            "error": "Resource-pack ZIP changed while being read or has an invalid signature"
        }),
        Err(error) => json!({ "ok": false, "error": error.to_string() }),
    })
}

const MAX_MIDI_DATA_BYTES: u64 = 16 * 1024 * 1024;

fn valid_midi_data_size(size: u64) -> bool {
    size > 0 && size <= MAX_MIDI_DATA_BYTES
}

fn read_midi_bytes_with_limit<R: Read>(reader: R, max_bytes: u64) -> Result<Vec<u8>, String> {
    let mut data = Vec::new();
    reader
        .take(max_bytes + 1)
        .read_to_end(&mut data)
        .map_err(|error| error.to_string())?;
    Ok(data)
}

#[tauri::command]
async fn midi_open_dialog(app: AppHandle, window: WebviewWindow) -> Result<Value, String> {
    let Some(file) = app
        .dialog()
        .file()
        .set_parent(&window)
        .set_title("MIDI ファイルを読み込み")
        .add_filter("Standard MIDI File", &["mid", "midi"])
        .blocking_pick_file()
    else {
        return Ok(json!({ "ok": false, "canceled": true }));
    };
    let path = match file.into_path() {
        Ok(path) => path,
        Err(error) => return Ok(json!({ "ok": false, "error": error.to_string() })),
    };
    if !path
        .extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| {
            extension.eq_ignore_ascii_case("mid") || extension.eq_ignore_ascii_case("midi")
        })
    {
        return Ok(json!({ "ok": false, "error": "Select a .mid or .midi file" }));
    }
    let size = match fs::metadata(&path) {
        Ok(metadata) => metadata.len(),
        Err(error) => return Ok(json!({ "ok": false, "error": error.to_string() })),
    };
    if !valid_midi_data_size(size) {
        return Ok(json!({ "ok": false, "error": "Invalid MIDI data size" }));
    }
    Ok(
        match fs::File::open(&path)
            .map_err(|error| error.to_string())
            .and_then(|file| read_midi_bytes_with_limit(file, MAX_MIDI_DATA_BYTES))
        {
            Ok(data) if valid_midi_data_size(data.len() as u64) => json!({
                "ok": true,
                "path": path.to_string_lossy(),
                "dataBase64": BASE64_STANDARD.encode(data),
            }),
            Ok(_) => json!({ "ok": false, "error": "Invalid MIDI data size" }),
            Err(error) => json!({ "ok": false, "error": error.to_string() }),
        },
    )
}

const MAX_NBP_BYTES: usize = 8 * 1024 * 1024;
const MAX_NOTE_BLOCK_BUILD_BYTES: usize = 72 * 1024 * 1024;
const MAX_NOTE_BLOCK_BUILD_NBT_BYTES: usize = 64 * 1024 * 1024;
const MAX_NOTE_BLOCK_BUILD_NBT_DEPTH: usize = 64;
const MAX_NOTE_BLOCK_BUILD_NBT_ITEMS: usize = 1_000_000;

fn note_block_build_extension(format: &str) -> Option<&'static str> {
    match format {
        "structure-block-nbt" | "litematica-compatible-nbt" => Some("nbt"),
        "schematic-1.11-1.12" | "schematic-pre-1.11" => Some("schematic"),
        _ => None,
    }
}

struct NoteBlockNbtCursor<'a> {
    data: &'a [u8],
    offset: usize,
}

impl<'a> NoteBlockNbtCursor<'a> {
    fn take(&mut self, count: usize) -> Result<&'a [u8], String> {
        let end = self
            .offset
            .checked_add(count)
            .filter(|end| *end <= self.data.len())
            .ok_or_else(|| "Truncated note-block build NBT".to_string())?;
        let value = &self.data[self.offset..end];
        self.offset = end;
        Ok(value)
    }

    fn byte(&mut self) -> Result<u8, String> {
        Ok(self.take(1)?[0])
    }

    fn int(&mut self) -> Result<i32, String> {
        let bytes: [u8; 4] = self
            .take(4)?
            .try_into()
            .map_err(|_| "Truncated note-block build NBT".to_string())?;
        Ok(i32::from_be_bytes(bytes))
    }

    fn string(&mut self) -> Result<&'a str, String> {
        let length_bytes: [u8; 2] = self
            .take(2)?
            .try_into()
            .map_err(|_| "Truncated note-block build NBT".to_string())?;
        let length = u16::from_be_bytes(length_bytes) as usize;
        std::str::from_utf8(self.take(length)?)
            .map_err(|_| "Note-block build NBT contains invalid UTF-8".to_string())
    }

    fn collection_length(&mut self) -> Result<usize, String> {
        let length = self.int()?;
        if length < 0 || length as usize > MAX_NOTE_BLOCK_BUILD_NBT_ITEMS {
            return Err("Note-block build NBT collection exceeds its item budget".to_string());
        }
        Ok(length as usize)
    }

    fn array_length(&mut self) -> Result<usize, String> {
        let length = self.int()?;
        if length < 0 || length as usize > MAX_NOTE_BLOCK_BUILD_NBT_BYTES {
            return Err("Note-block build NBT array exceeds its byte budget".to_string());
        }
        Ok(length as usize)
    }

    fn skip_payload(&mut self, tag: u8, depth: usize) -> Result<(), String> {
        if depth > MAX_NOTE_BLOCK_BUILD_NBT_DEPTH {
            return Err("Note-block build NBT nesting is too deep".to_string());
        }
        match tag {
            1 => {
                self.take(1)?;
            }
            2 => {
                self.take(2)?;
            }
            3 | 5 => {
                self.take(4)?;
            }
            4 | 6 => {
                self.take(8)?;
            }
            7 => {
                let length = self.array_length()?;
                self.take(length)?;
            }
            8 => {
                self.string()?;
            }
            9 => {
                let element_tag = self.byte()?;
                let length = self.collection_length()?;
                if element_tag == 0 && length != 0 {
                    return Err("Invalid TAG_End list in note-block build NBT".to_string());
                }
                for _ in 0..length {
                    self.skip_payload(element_tag, depth + 1)?;
                }
            }
            10 => loop {
                let child_tag = self.byte()?;
                if child_tag == 0 {
                    break;
                }
                self.string()?;
                self.skip_payload(child_tag, depth + 1)?;
            },
            11 => {
                let length = self.array_length()?;
                self.take(
                    length
                        .checked_mul(4)
                        .ok_or_else(|| "Note-block build NBT int array is too large".to_string())?,
                )?;
            }
            12 => {
                let length = self.array_length()?;
                self.take(
                    length.checked_mul(8).ok_or_else(|| {
                        "Note-block build NBT long array is too large".to_string()
                    })?,
                )?;
            }
            _ => return Err(format!("Unsupported note-block build NBT tag {tag}")),
        }
        Ok(())
    }
}

fn validate_note_block_build_nbt(format: &str, nbt: &[u8]) -> Result<(), String> {
    let modern = matches!(format, "structure-block-nbt" | "litematica-compatible-nbt");
    let required: &[(&str, u8)] = if modern {
        &[
            ("DataVersion", 3),
            ("size", 9),
            ("palette", 9),
            ("blocks", 9),
            ("entities", 9),
        ]
    } else {
        &[
            ("Height", 2),
            ("Length", 2),
            ("Width", 2),
            ("Entities", 9),
            ("TileEntities", 9),
            ("Materials", 8),
            ("Blocks", 7),
            ("Data", 7),
            ("Version", 10),
        ]
    };
    let mut cursor = NoteBlockNbtCursor {
        data: nbt,
        offset: 0,
    };
    if cursor.byte()? != 10 {
        return Err("Note-block build NBT root must be a compound".to_string());
    }
    let root_name = cursor.string()?;
    if (modern && !root_name.is_empty()) || (!modern && root_name != "Schematic") {
        return Err("Note-block build NBT root does not match the selected format".to_string());
    }
    let mut found = HashSet::new();
    loop {
        let tag = cursor.byte()?;
        if tag == 0 {
            break;
        }
        let name = cursor.string()?;
        if !found.insert(name) {
            return Err(format!(
                "Duplicate top-level note-block build NBT tag: {name}"
            ));
        }
        if let Some((_, expected_tag)) = required
            .iter()
            .find(|(required_name, _)| *required_name == name)
        {
            if tag != *expected_tag {
                return Err(format!("Invalid NBT type for required tag {name}"));
            }
        }
        cursor.skip_payload(tag, 1)?;
    }
    if cursor.offset != nbt.len() {
        return Err("Trailing bytes after note-block build NBT root".to_string());
    }
    for (name, _) in required {
        if !found.contains(name) {
            return Err(format!("Missing required note-block build NBT tag: {name}"));
        }
    }
    Ok(())
}

fn validate_note_block_build_data(format: &str, data: &[u8]) -> Result<&'static str, String> {
    let extension = note_block_build_extension(format)
        .ok_or_else(|| "Unsupported note-block build format".to_string())?;
    if data.len() < 18 || data.len() > MAX_NOTE_BLOCK_BUILD_BYTES {
        return Err("Invalid note-block build data size".to_string());
    }
    if data[..3] != [0x1f, 0x8b, 0x08] || data[3] & 0xe0 != 0 {
        return Err("Note-block build must be a valid GZIP container".to_string());
    }
    let mut nbt = Vec::new();
    MultiGzDecoder::new(data)
        .take((MAX_NOTE_BLOCK_BUILD_NBT_BYTES + 1) as u64)
        .read_to_end(&mut nbt)
        .map_err(|_| "Note-block build GZIP payload or CRC is invalid".to_string())?;
    if nbt.len() > MAX_NOTE_BLOCK_BUILD_NBT_BYTES {
        return Err("Note-block build NBT exceeds its decoded byte budget".to_string());
    }
    validate_note_block_build_nbt(format, &nbt)?;
    Ok(extension)
}

#[tauri::command]
async fn nbp_open_dialog(app: AppHandle, window: WebviewWindow) -> Result<Value, String> {
    let Some(file) = app
        .dialog()
        .file()
        .set_parent(&window)
        .set_title("Note Block Studio パターンを読み込み")
        .add_filter("Note Block Pattern", &["nbp"])
        .blocking_pick_file()
    else {
        return Ok(json!({ "ok": false, "canceled": true }));
    };
    let path = match file.into_path() {
        Ok(path) => path,
        Err(error) => return Ok(json!({ "ok": false, "error": error.to_string() })),
    };
    if !path
        .extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case("nbp"))
    {
        return Ok(json!({ "ok": false, "error": "Select an .nbp file" }));
    }
    let size = match fs::metadata(&path) {
        Ok(metadata) => metadata.len(),
        Err(error) => return Ok(json!({ "ok": false, "error": error.to_string() })),
    };
    if size == 0 || size > MAX_NBP_BYTES as u64 {
        return Ok(json!({ "ok": false, "error": "Invalid NBP data size" }));
    }
    Ok(match fs::read(&path) {
        Ok(data)
            if !data.is_empty() && data.len() <= MAX_NBP_BYTES && data.len() as u64 == size =>
        {
            json!({
                "ok": true,
                "path": path.to_string_lossy(),
                "dataBase64": BASE64_STANDARD.encode(data),
            })
        }
        Ok(_) => json!({ "ok": false, "error": "NBP file changed while it was being read" }),
        Err(error) => json!({ "ok": false, "error": error.to_string() }),
    })
}

const MAX_REFERENCE_AUDIO_BYTES: u64 = 32 * 1024 * 1024;

fn reference_audio_mime(path: &Path, data: &[u8]) -> Option<&'static str> {
    let extension = path.extension()?.to_str()?;
    if extension.eq_ignore_ascii_case("ogg") && data.starts_with(b"OggS") {
        Some("audio/ogg")
    } else if extension.eq_ignore_ascii_case("wav")
        && data.len() >= 12
        && &data[..4] == b"RIFF"
        && &data[8..12] == b"WAVE"
    {
        Some("audio/wav")
    } else {
        None
    }
}

#[tauri::command]
async fn reference_audio_open_dialog(
    app: AppHandle,
    window: WebviewWindow,
) -> Result<Value, String> {
    let Some(file) = app
        .dialog()
        .file()
        .set_parent(&window)
        .set_title("参照オーディオを追加")
        .add_filter("Reference Audio", &["wav", "ogg"])
        .blocking_pick_file()
    else {
        return Ok(json!({ "ok": false, "canceled": true }));
    };
    let path = match file.into_path() {
        Ok(path) => path,
        Err(error) => return Ok(json!({ "ok": false, "error": error.to_string() })),
    };
    let size = match fs::metadata(&path) {
        Ok(metadata) => metadata.len(),
        Err(error) => return Ok(json!({ "ok": false, "error": error.to_string() })),
    };
    if size == 0 || size > MAX_REFERENCE_AUDIO_BYTES {
        return Ok(json!({
            "ok": false,
            "error": "Reference audio must be between 1 byte and 32 MiB; use Ogg for long guides"
        }));
    }
    let data = match fs::read(&path) {
        Ok(data)
            if !data.is_empty()
                && data.len() as u64 <= MAX_REFERENCE_AUDIO_BYTES
                && data.len() as u64 == size =>
        {
            data
        }
        Ok(_) => {
            return Ok(json!({
                "ok": false,
                "error": "Reference audio changed while it was being read"
            }))
        }
        Err(error) => return Ok(json!({ "ok": false, "error": error.to_string() })),
    };
    let Some(mime_type) = reference_audio_mime(&path, &data) else {
        return Ok(json!({
            "ok": false,
            "error": "Select a valid RIFF/WAVE .wav or Ogg .ogg file"
        }));
    };
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("reference-audio")
        .to_string();
    Ok(json!({
        "ok": true,
        "path": path.to_string_lossy(),
        "fileName": file_name,
        "mimeType": mime_type,
        "byteLength": data.len(),
        "dataBase64": BASE64_STANDARD.encode(data),
    }))
}

#[tauri::command]
async fn nbs_save_dialog(
    app: AppHandle,
    window: WebviewWindow,
    default_name: String,
    data_base64: String,
) -> Result<Value, String> {
    if data_base64.len() > (16 * 1024 * 1024 * 4 / 3) + 4 {
        return Ok(json!({ "ok": false, "error": "Invalid NBS data size" }));
    }
    let data = match BASE64_STANDARD.decode(data_base64) {
        Ok(data) => data,
        Err(error) => {
            return Ok(json!({ "ok": false, "error": format!("Invalid NBS data: {error}") }))
        }
    };
    if data.is_empty() || data.len() > 16 * 1024 * 1024 {
        return Ok(json!({ "ok": false, "error": "Invalid NBS data size" }));
    }
    let default_name = Path::new(&default_name)
        .file_name()
        .and_then(|name| name.to_str())
        .filter(|name| !name.is_empty())
        .unwrap_or("knead-song.nbs");
    let Some(file) = app
        .dialog()
        .file()
        .set_parent(&window)
        .set_title("Note Block Studio ファイルを書き出し")
        .add_filter("Note Block Song", &["nbs"])
        .set_file_name(default_name)
        .blocking_save_file()
    else {
        return Ok(json!({ "ok": false, "canceled": true }));
    };
    let mut path = match file.into_path() {
        Ok(path) => path,
        Err(error) => return Ok(json!({ "ok": false, "error": error.to_string() })),
    };
    if !path
        .extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case("nbs"))
    {
        path.set_extension("nbs");
    }
    Ok(match write_user_file_safely(&path, &data) {
        Ok(()) => ok_path(&path),
        Err(error) => json!({ "ok": false, "error": error.to_string() }),
    })
}

#[tauri::command]
async fn nbs_bundle_save_dialog(
    app: AppHandle,
    window: WebviewWindow,
    default_name: String,
    data_base64: String,
) -> Result<Value, String> {
    if data_base64.len() > (MAX_NBS_BUNDLE_BYTES * 4 / 3) + 4 {
        return Ok(json!({ "ok": false, "error": "Invalid NBS bundle size" }));
    }
    let data = match BASE64_STANDARD.decode(data_base64) {
        Ok(data) => data,
        Err(error) => {
            return Ok(json!({
                "ok": false,
                "error": format!("Invalid NBS bundle data: {error}")
            }))
        }
    };
    if data.is_empty() || data.len() > MAX_NBS_BUNDLE_BYTES {
        return Ok(json!({ "ok": false, "error": "Invalid NBS bundle size" }));
    }
    let default_name = Path::new(&default_name)
        .file_name()
        .and_then(|name| name.to_str())
        .filter(|name| !name.is_empty())
        .unwrap_or("knead-song.zip");
    let Some(file) = app
        .dialog()
        .file()
        .set_parent(&window)
        .set_title("Note Block Studio 音源同梱ZIPを書き出し")
        .add_filter("OpenNBS Zipped Song", &["zip"])
        .set_file_name(default_name)
        .blocking_save_file()
    else {
        return Ok(json!({ "ok": false, "canceled": true }));
    };
    let mut path = match file.into_path() {
        Ok(path) => path,
        Err(error) => return Ok(json!({ "ok": false, "error": error.to_string() })),
    };
    if !path
        .extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case("zip"))
    {
        path.set_extension("zip");
    }
    Ok(match write_user_file_safely(&path, &data) {
        Ok(()) => ok_path(&path),
        Err(error) => json!({ "ok": false, "error": error.to_string() }),
    })
}

#[tauri::command]
async fn nbp_save_dialog(
    app: AppHandle,
    window: WebviewWindow,
    default_name: String,
    data_base64: String,
) -> Result<Value, String> {
    if data_base64.len() > (MAX_NBP_BYTES * 4 / 3) + 4 {
        return Ok(json!({ "ok": false, "error": "Invalid NBP data size" }));
    }
    let data = match BASE64_STANDARD.decode(data_base64) {
        Ok(data) => data,
        Err(error) => {
            return Ok(json!({
                "ok": false,
                "error": format!("Invalid NBP data: {error}")
            }))
        }
    };
    if data.is_empty() || data.len() > MAX_NBP_BYTES {
        return Ok(json!({ "ok": false, "error": "Invalid NBP data size" }));
    }
    let default_name = Path::new(&default_name)
        .file_name()
        .and_then(|name| name.to_str())
        .filter(|name| !name.is_empty())
        .unwrap_or("knead-pattern.nbp");
    let Some(file) = app
        .dialog()
        .file()
        .set_parent(&window)
        .set_title("Note Block Studio パターンを書き出し")
        .add_filter("Note Block Pattern", &["nbp"])
        .set_file_name(default_name)
        .blocking_save_file()
    else {
        return Ok(json!({ "ok": false, "canceled": true }));
    };
    let mut path = match file.into_path() {
        Ok(path) => path,
        Err(error) => return Ok(json!({ "ok": false, "error": error.to_string() })),
    };
    if !path
        .extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case("nbp"))
    {
        path.set_extension("nbp");
    }
    Ok(match write_user_file_safely(&path, &data) {
        Ok(()) => ok_path(&path),
        Err(error) => json!({ "ok": false, "error": error.to_string() }),
    })
}

#[tauri::command]
async fn note_block_build_save_dialog(
    app: AppHandle,
    window: WebviewWindow,
    default_name: String,
    format: String,
    data_base64: String,
) -> Result<Value, String> {
    if note_block_build_extension(&format).is_none() {
        return Ok(json!({ "ok": false, "error": "Unsupported note-block build format" }));
    }
    if data_base64.len() > (MAX_NOTE_BLOCK_BUILD_BYTES * 4 / 3) + 4 {
        return Ok(json!({ "ok": false, "error": "Invalid note-block build data size" }));
    }
    let data = match BASE64_STANDARD.decode(data_base64) {
        Ok(data) => data,
        Err(error) => {
            return Ok(json!({
                "ok": false,
                "error": format!("Invalid note-block build data: {error}")
            }))
        }
    };
    let extension = match validate_note_block_build_data(&format, &data) {
        Ok(extension) => extension,
        Err(error) => return Ok(json!({ "ok": false, "error": error })),
    };
    let fallback_name = format!("knead-note-block-build.{extension}");
    let default_name = Path::new(&default_name)
        .file_name()
        .and_then(|name| name.to_str())
        .filter(|name| !name.is_empty())
        .unwrap_or(&fallback_name);
    let title = if extension == "nbt" {
        "Minecraft Structure NBTを書き出し"
    } else {
        "Minecraft Schematicを書き出し"
    };
    let filter_name = if extension == "nbt" {
        "Minecraft Structure NBT"
    } else {
        "Minecraft Schematic"
    };
    let Some(file) = app
        .dialog()
        .file()
        .set_parent(&window)
        .set_title(title)
        .add_filter(filter_name, &[extension])
        .set_file_name(default_name)
        .blocking_save_file()
    else {
        return Ok(json!({ "ok": false, "canceled": true }));
    };
    let mut path = match file.into_path() {
        Ok(path) => path,
        Err(error) => return Ok(json!({ "ok": false, "error": error.to_string() })),
    };
    if !path
        .extension()
        .and_then(|value| value.to_str())
        .is_some_and(|value| value.eq_ignore_ascii_case(extension))
    {
        path.set_extension(extension);
    }
    Ok(match write_user_file_safely(&path, &data) {
        Ok(()) => ok_path(&path),
        Err(error) => json!({ "ok": false, "error": error.to_string() }),
    })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum StudioSongFileKind {
    Kp,
    Nbs,
}

impl StudioSongFileKind {
    fn from_path(path: &Path) -> Option<Self> {
        match path.extension().and_then(|extension| extension.to_str()) {
            Some(extension) if extension.eq_ignore_ascii_case("kp") => Some(Self::Kp),
            Some(extension) if extension.eq_ignore_ascii_case("nbs") => Some(Self::Nbs),
            _ => None,
        }
    }

    fn parse(value: &str) -> Result<Self, String> {
        match value {
            "kp" => Ok(Self::Kp),
            "nbs" => Ok(Self::Nbs),
            _ => Err("Unsupported studio song file kind".to_string()),
        }
    }

    fn extension(self) -> &'static str {
        match self {
            Self::Kp => "kp",
            Self::Nbs => "nbs",
        }
    }

    fn display_name(self) -> &'static str {
        match self {
            Self::Kp => "Knead Project",
            Self::Nbs => "Note Block Studio Song",
        }
    }

    fn max_bytes(self) -> u64 {
        match self {
            Self::Kp => MAX_TIMELINE_PROJECT_BYTES,
            Self::Nbs => MAX_STUDIO_NBS_BYTES,
        }
    }
}

fn is_studio_song_path(path: &Path) -> bool {
    StudioSongFileKind::from_path(path).is_some()
}

// Embedded audio is capped at 96 MiB decoded across custom and reference assets.
// Canonical Base64 needs 128 MiB; the remaining headroom covers project JSON.
const MAX_TIMELINE_PROJECT_BYTES: u64 = 144 * 1024 * 1024;
const MAX_STUDIO_NBS_BYTES: u64 = 16 * 1024 * 1024;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TimelineWritePayload {
    kind: String,
    data: Option<String>,
    data_base64: Option<String>,
}

fn decode_timeline_write_payload(
    payload: TimelineWritePayload,
) -> Result<(StudioSongFileKind, Vec<u8>), String> {
    decode_timeline_write_payload_with_limits(
        payload,
        MAX_TIMELINE_PROJECT_BYTES,
        MAX_STUDIO_NBS_BYTES,
    )
}

fn decode_timeline_write_payload_with_limits(
    payload: TimelineWritePayload,
    max_kp_bytes: u64,
    max_nbs_bytes: u64,
) -> Result<(StudioSongFileKind, Vec<u8>), String> {
    let kind = StudioSongFileKind::parse(&payload.kind)?;
    let bytes = match kind {
        StudioSongFileKind::Kp => {
            if payload.data_base64.is_some() {
                return Err("Knead Project payload must not contain binary data".to_string());
            }
            let data = payload
                .data
                .ok_or_else(|| "Knead Project payload is missing data".to_string())?;
            let bytes = data.into_bytes();
            if bytes.is_empty() || bytes.len() as u64 > max_kp_bytes {
                return Err("Knead project must be between 1 byte and 144 MiB".to_string());
            }
            bytes
        }
        StudioSongFileKind::Nbs => {
            if payload.data.is_some() {
                return Err("NBS payload must not contain text data".to_string());
            }
            let encoded = payload
                .data_base64
                .ok_or_else(|| "NBS payload is missing dataBase64".to_string())?;
            let max_encoded_bytes = (max_nbs_bytes as usize).div_ceil(3) * 4;
            if encoded.is_empty() || encoded.len() > max_encoded_bytes {
                return Err("NBS base64 payload exceeds the 16 MiB decoded limit".to_string());
            }
            let bytes = BASE64_STANDARD
                .decode(encoded)
                .map_err(|_| "NBS payload contains invalid base64 data".to_string())?;
            if bytes.is_empty() || bytes.len() as u64 > max_nbs_bytes {
                return Err("NBS song must be between 1 byte and 16 MiB".to_string());
            }
            bytes
        }
    };
    Ok((kind, bytes))
}

const RECOVERY_FORMAT: &str = "knead-recovery";
const RECOVERY_VERSION: u8 = 1;
const MAX_RECOVERY_PROJECT_BYTES: u64 = 32 * 1024 * 1024;
const MAX_RECOVERY_HEADER_BYTES: usize = 64 * 1024;
const MAX_RECOVERY_FILE_BYTES: u64 = MAX_RECOVERY_PROJECT_BYTES + MAX_RECOVERY_HEADER_BYTES as u64;
const MAX_RECOVERY_SNAPSHOTS: usize = 8;
const RECOVERY_TTL_MS: u64 = 30 * 24 * 60 * 60 * 1_000;
const RECOVERY_FUTURE_CLOCK_SKEW_MS: u64 = 5 * 60 * 1_000;
const RECOVERY_FILE_SUFFIX: &str = ".recovery";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct TimelineRecoveryMetadata {
    id: String,
    project_id: String,
    file_path: Option<String>,
    updated_at: u64,
    fingerprint: String,
    byte_length: u64,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TimelineRecoveryFileHeader {
    format: String,
    version: u8,
    #[serde(flatten)]
    metadata: TimelineRecoveryMetadata,
}

fn recovery_now_ms() -> u64 {
    SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(u128::from(u64::MAX)) as u64
}

fn validate_recovery_project_id(project_id: &str) -> Result<(), String> {
    if project_id.is_empty() || project_id.len() > 128 {
        return Err("Recovery project ID must be between 1 and 128 bytes".to_string());
    }
    Ok(())
}

fn recovery_snapshot_id(project_id: &str) -> Result<String, String> {
    validate_recovery_project_id(project_id)?;
    Ok(sha1_hex(project_id.as_bytes()))
}

fn is_recovery_snapshot_id(id: &str) -> bool {
    id.len() == 40
        && id
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn recovery_snapshot_path(directory: &Path, id: &str) -> Result<PathBuf, String> {
    if !is_recovery_snapshot_id(id) {
        return Err("Invalid recovery snapshot ID".to_string());
    }
    Ok(directory.join(format!("{id}{RECOVERY_FILE_SUFFIX}")))
}

fn recovery_directory(app: &AppHandle) -> Result<PathBuf, String> {
    let directory = app_data_dir(app)?.join("timeline-recovery");
    fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    Ok(directory)
}

fn valid_recovery_timestamp(updated_at: u64, now: u64) -> bool {
    updated_at > 0
        && updated_at <= now.saturating_add(RECOVERY_FUTURE_CLOCK_SKEW_MS)
        && now.saturating_sub(updated_at) <= RECOVERY_TTL_MS
}

fn validate_recovery_project_json(project_id: &str, contents: &str) -> Result<(), String> {
    let project: Value = serde_json::from_str(contents)
        .map_err(|error| format!("Recovery project JSON is invalid: {error}"))?;
    if project.get("format").and_then(Value::as_str) != Some("knead-project") {
        return Err("Recovery data is not a Knead project".to_string());
    }
    if project.get("projectId").and_then(Value::as_str) != Some(project_id) {
        return Err("Recovery project ID does not match its project data".to_string());
    }
    Ok(())
}

fn read_recovery_snapshot_file(
    path: &Path,
    now: u64,
) -> Result<(TimelineRecoveryMetadata, String), String> {
    let initial = fs::symlink_metadata(path).map_err(|error| error.to_string())?;
    if !initial.file_type().is_file()
        || initial.len() == 0
        || initial.len() > MAX_RECOVERY_FILE_BYTES
    {
        return Err("Recovery snapshot is empty, oversized, or not a regular file".to_string());
    }
    let bytes = fs::read(path).map_err(|error| error.to_string())?;
    if bytes.len() as u64 != initial.len() || bytes.len() as u64 > MAX_RECOVERY_FILE_BYTES {
        return Err("Recovery snapshot changed while it was being read".to_string());
    }
    let separator = bytes
        .iter()
        .take(MAX_RECOVERY_HEADER_BYTES + 1)
        .position(|byte| *byte == b'\n')
        .ok_or_else(|| "Recovery snapshot header is missing or oversized".to_string())?;
    if separator == 0 || separator > MAX_RECOVERY_HEADER_BYTES {
        return Err("Recovery snapshot header is invalid".to_string());
    }
    let header: TimelineRecoveryFileHeader = serde_json::from_slice(&bytes[..separator])
        .map_err(|error| format!("Recovery snapshot metadata is corrupt: {error}"))?;
    if header.format != RECOVERY_FORMAT || header.version != RECOVERY_VERSION {
        return Err("Recovery snapshot format is unsupported".to_string());
    }
    let metadata = header.metadata;
    validate_recovery_project_id(&metadata.project_id)?;
    if !is_recovery_snapshot_id(&metadata.id)
        || recovery_snapshot_id(&metadata.project_id)? != metadata.id
    {
        return Err("Recovery snapshot ID is invalid".to_string());
    }
    let expected_name = format!("{}{RECOVERY_FILE_SUFFIX}", metadata.id);
    if path.file_name().and_then(|name| name.to_str()) != Some(expected_name.as_str()) {
        return Err("Recovery snapshot filename does not match its ID".to_string());
    }
    if metadata
        .file_path
        .as_ref()
        .is_some_and(|file_path| file_path.len() > 32_768)
    {
        return Err("Recovery source path is too long".to_string());
    }
    if !valid_recovery_timestamp(metadata.updated_at, now) {
        return Err("Recovery snapshot is expired or has an invalid timestamp".to_string());
    }
    let project_bytes = &bytes[separator + 1..];
    if project_bytes.is_empty()
        || project_bytes.len() as u64 > MAX_RECOVERY_PROJECT_BYTES
        || project_bytes.len() as u64 != metadata.byte_length
    {
        return Err("Recovery project exceeds its size limit or metadata".to_string());
    }
    if sha1_hex(project_bytes) != metadata.fingerprint {
        return Err("Recovery project fingerprint does not match".to_string());
    }
    let contents = String::from_utf8(project_bytes.to_vec())
        .map_err(|_| "Recovery project is not valid UTF-8".to_string())?;
    validate_recovery_project_json(&metadata.project_id, &contents)?;
    Ok((metadata, contents))
}

fn list_recovery_snapshots_in_directory(
    directory: &Path,
    now: u64,
) -> Result<Vec<TimelineRecoveryMetadata>, String> {
    fs::create_dir_all(directory).map_err(|error| error.to_string())?;
    let mut snapshots = Vec::new();
    for entry in fs::read_dir(directory).map_err(|error| error.to_string())? {
        let Ok(entry) = entry else { continue };
        let name = entry.file_name();
        let Some(name) = name.to_str() else { continue };
        let Some(id) = name.strip_suffix(RECOVERY_FILE_SUFFIX) else {
            continue;
        };
        if !is_recovery_snapshot_id(id) {
            continue;
        }
        match read_recovery_snapshot_file(&entry.path(), now) {
            Ok((metadata, _)) => snapshots.push(metadata),
            Err(_) => {
                let _ = fs::remove_file(entry.path());
            }
        }
    }
    snapshots.sort_by(|left, right| {
        right
            .updated_at
            .cmp(&left.updated_at)
            .then_with(|| left.id.cmp(&right.id))
    });
    for snapshot in snapshots.iter().skip(MAX_RECOVERY_SNAPSHOTS) {
        if let Ok(path) = recovery_snapshot_path(directory, &snapshot.id) {
            let _ = fs::remove_file(path);
        }
    }
    snapshots.truncate(MAX_RECOVERY_SNAPSHOTS);
    Ok(snapshots)
}

fn write_recovery_snapshot_in_directory(
    directory: &Path,
    project_id: &str,
    file_path: Option<String>,
    updated_at: u64,
    contents: &str,
    now: u64,
) -> Result<TimelineRecoveryMetadata, String> {
    validate_recovery_project_id(project_id)?;
    if file_path.as_ref().is_some_and(|path| path.len() > 32_768) {
        return Err("Recovery source path is too long".to_string());
    }
    if !valid_recovery_timestamp(updated_at, now) {
        return Err("Recovery timestamp is invalid".to_string());
    }
    if contents.is_empty() || contents.len() as u64 > MAX_RECOVERY_PROJECT_BYTES {
        return Err("Recovery project exceeds the 32 MiB limit".to_string());
    }
    validate_recovery_project_json(project_id, contents)?;
    fs::create_dir_all(directory).map_err(|error| error.to_string())?;
    let id = recovery_snapshot_id(project_id)?;
    let path = recovery_snapshot_path(directory, &id)?;
    if path.is_file() {
        if let Ok((existing, _)) = read_recovery_snapshot_file(&path, now) {
            if existing.updated_at > updated_at {
                return Ok(existing);
            }
        }
    }
    let metadata = TimelineRecoveryMetadata {
        id,
        project_id: project_id.to_string(),
        file_path,
        updated_at,
        fingerprint: sha1_hex(contents.as_bytes()),
        byte_length: contents.len() as u64,
    };
    let header = TimelineRecoveryFileHeader {
        format: RECOVERY_FORMAT.to_string(),
        version: RECOVERY_VERSION,
        metadata: metadata.clone(),
    };
    let header_bytes = serde_json::to_vec(&header).map_err(|error| error.to_string())?;
    if header_bytes.is_empty() || header_bytes.len() > MAX_RECOVERY_HEADER_BYTES {
        return Err("Recovery snapshot metadata is oversized".to_string());
    }
    let mut snapshot = Vec::with_capacity(header_bytes.len() + 1 + contents.len());
    snapshot.extend_from_slice(&header_bytes);
    snapshot.push(b'\n');
    snapshot.extend_from_slice(contents.as_bytes());
    if snapshot.len() as u64 > MAX_RECOVERY_FILE_BYTES {
        return Err("Recovery snapshot exceeds its file size limit".to_string());
    }
    write_user_file_safely(&path, &snapshot)?;
    list_recovery_snapshots_in_directory(directory, now)?;
    Ok(metadata)
}

fn discard_recovery_snapshot_in_directory(directory: &Path, id: &str) -> Result<(), String> {
    let path = recovery_snapshot_path(directory, id)?;
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.to_string()),
    }
}

#[tauri::command]
fn timeline_recovery_save(
    app: AppHandle,
    project_id: String,
    file_path: Option<String>,
    updated_at: u64,
    json: String,
) -> Value {
    let result = recovery_directory(&app).and_then(|directory| {
        write_recovery_snapshot_in_directory(
            &directory,
            &project_id,
            file_path,
            updated_at,
            &json,
            recovery_now_ms(),
        )
    });
    match result {
        Ok(snapshot) => json!({ "ok": true, "snapshot": snapshot }),
        Err(error) => json!({ "ok": false, "error": error }),
    }
}

#[tauri::command]
fn timeline_recovery_list(app: AppHandle) -> Value {
    let result = recovery_directory(&app)
        .and_then(|directory| list_recovery_snapshots_in_directory(&directory, recovery_now_ms()));
    match result {
        Ok(snapshots) => json!({ "ok": true, "snapshots": snapshots }),
        Err(error) => json!({ "ok": false, "error": error }),
    }
}

#[tauri::command]
fn timeline_recovery_restore(app: AppHandle, id: String) -> Value {
    let result = recovery_directory(&app).and_then(|directory| {
        let path = recovery_snapshot_path(&directory, &id)?;
        match read_recovery_snapshot_file(&path, recovery_now_ms()) {
            Ok((snapshot, json)) => Ok((snapshot, json)),
            Err(error) => {
                let _ = fs::remove_file(path);
                Err(error)
            }
        }
    });
    match result {
        Ok((snapshot, project_json)) => {
            json!({ "ok": true, "snapshot": snapshot, "json": project_json })
        }
        Err(error) => json!({ "ok": false, "error": error }),
    }
}

#[tauri::command]
fn timeline_recovery_discard(app: AppHandle, id: String) -> Value {
    let result = recovery_directory(&app)
        .and_then(|directory| discard_recovery_snapshot_in_directory(&directory, &id));
    match result {
        Ok(()) => json!({ "ok": true }),
        Err(error) => json!({ "ok": false, "error": error }),
    }
}

#[tauri::command]
fn timeline_recovery_clear_project(app: AppHandle, project_id: String) -> Value {
    let result = recovery_snapshot_id(&project_id).and_then(|id| {
        recovery_directory(&app)
            .and_then(|directory| discard_recovery_snapshot_in_directory(&directory, &id))
    });
    match result {
        Ok(()) => json!({ "ok": true }),
        Err(error) => json!({ "ok": false, "error": error }),
    }
}

fn validate_timeline_path(path: PathBuf) -> Result<PathBuf, String> {
    if !is_studio_song_path(&path) {
        return Err("Knead Project (.kp) または NBS Song (.nbs) を選択してください".to_string());
    }
    let path = if path.is_absolute() {
        path
    } else {
        env::current_dir()
            .map_err(|error| error.to_string())?
            .join(path)
    };
    if !path.is_file() {
        return Err(format!(
            "プロジェクトファイルが見つかりません: {}",
            path.display()
        ));
    }
    path.canonicalize().map_err(|error| error.to_string())
}

fn canonical_timeline_save_path(
    mut path: PathBuf,
    kind: StudioSongFileKind,
) -> Result<PathBuf, String> {
    match path.extension().and_then(|extension| extension.to_str()) {
        None => {
            path.set_extension(kind.extension());
        }
        Some(extension) if extension.eq_ignore_ascii_case(kind.extension()) => {}
        Some(_) => {
            return Err(format!(
                "保存形式と拡張子が一致しません: .{} を選択してください",
                kind.extension()
            ))
        }
    }
    let path = if path.is_absolute() {
        path
    } else {
        env::current_dir()
            .map_err(|error| error.to_string())?
            .join(path)
    };
    if path.exists() {
        if !path.is_file() {
            return Err(format!(
                "保存先がファイルではありません: {}",
                path.display()
            ));
        }
        return path.canonicalize().map_err(|error| error.to_string());
    }
    let file_name = path
        .file_name()
        .ok_or_else(|| format!("Invalid save path: {}", path.display()))?;
    let parent = path
        .parent()
        .ok_or_else(|| format!("Invalid save path: {}", path.display()))?
        .canonicalize()
        .map_err(|error| error.to_string())?;
    if !parent.is_dir() {
        return Err(format!(
            "保存先フォルダーが見つかりません: {}",
            parent.display()
        ));
    }
    Ok(parent.join(file_name))
}

fn validate_timeline_document_id(document_id: &str) -> Result<(), String> {
    if document_id.is_empty()
        || document_id.len() > MAX_TIMELINE_DOCUMENT_ID_BYTES
        || !document_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return Err("Invalid timeline document ID".to_string());
    }
    Ok(())
}

fn timeline_document_key(
    window_label: &str,
    document_id: &str,
) -> Result<(String, String), String> {
    validate_timeline_document_id(document_id)?;
    Ok((window_label.to_string(), document_id.to_string()))
}

fn ensure_timeline_path_available(
    paths: &HashMap<(String, String), PathBuf>,
    window_label: &str,
    document_id: &str,
    path: &Path,
) -> Result<(), String> {
    if paths
        .iter()
        .any(|((owner_window, owner_document), owner_path)| {
            (owner_window != window_label || owner_document != document_id) && owner_path == path
        })
    {
        return Err("This project is already open in another tab or window.".to_string());
    }
    Ok(())
}

fn bind_timeline_path(
    paths: &mut HashMap<(String, String), PathBuf>,
    window_label: &str,
    document_id: &str,
    path: PathBuf,
) -> Result<(), String> {
    let key = timeline_document_key(window_label, document_id)?;
    ensure_timeline_path_available(paths, window_label, document_id, &path)?;
    paths.insert(key, path);
    Ok(())
}

fn release_timeline_path(
    paths: &mut HashMap<(String, String), PathBuf>,
    window_label: &str,
    document_id: &str,
) -> Result<(), String> {
    let key = timeline_document_key(window_label, document_id)?;
    paths.remove(&key);
    Ok(())
}

fn bound_timeline_nbs_path(
    paths: &HashMap<(String, String), PathBuf>,
    window_label: &str,
    document_id: &str,
) -> Result<PathBuf, String> {
    let key = timeline_document_key(window_label, document_id)?;
    let path = paths
        .get(&key)
        .ok_or_else(|| "The document has no bound NBS path".to_string())?;
    if StudioSongFileKind::from_path(path) != Some(StudioSongFileKind::Nbs) {
        return Err("The document is not bound to an NBS file".to_string());
    }
    Ok(path.clone())
}

fn project_paths_from_args(args: &[String], cwd: &Path) -> Vec<PathBuf> {
    let mut projects = Vec::new();
    let mut seen = HashSet::new();
    for argument in args.iter().skip(1) {
        let path = PathBuf::from(argument);
        let path = if path.is_absolute() {
            path
        } else {
            cwd.join(path)
        };
        let Ok(path) = validate_timeline_path(path) else {
            continue;
        };
        if seen.insert(path.clone()) {
            projects.push(path);
            if projects.len() == MAX_PENDING_TIMELINE_PATHS {
                break;
            }
        }
    }
    projects
}

#[cfg(test)]
fn project_path_from_args(args: &[String], cwd: &Path) -> Option<PathBuf> {
    project_paths_from_args(args, cwd).into_iter().next()
}

fn enqueue_timeline_paths(
    pending: &mut VecDeque<PathBuf>,
    paths: impl IntoIterator<Item = PathBuf>,
) -> usize {
    let mut added = 0;
    for path in paths {
        if pending.len() == MAX_PENDING_TIMELINE_PATHS {
            break;
        }
        if pending.contains(&path) {
            continue;
        }
        pending.push_back(path);
        added += 1;
    }
    added
}

fn queue_timeline_opens(app: &AppHandle, paths: impl IntoIterator<Item = PathBuf>) -> usize {
    let mut validated = Vec::new();
    let mut seen = HashSet::new();
    for path in paths {
        let Ok(path) = validate_timeline_path(path) else {
            continue;
        };
        if seen.insert(path.clone()) {
            validated.push(path);
            if validated.len() == MAX_PENDING_TIMELINE_PATHS {
                break;
            }
        }
    }
    if validated.is_empty() {
        return 0;
    }
    let Some(state) = app.try_state::<AppState>() else {
        return 0;
    };
    let Ok(mut pending) = state.pending_timeline_paths.lock() else {
        return 0;
    };
    let added = enqueue_timeline_paths(&mut pending, validated);
    drop(pending);

    if added > 0 {
        let Some(window) = app.get_webview_window("sub") else {
            return added;
        };
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
        let _ = window.emit(TIMELINE_OPEN_REQUESTED_EVENT, ());
    }
    added
}

fn read_timeline_path(path: PathBuf) -> Value {
    let path = match validate_timeline_path(path) {
        Ok(path) => path,
        Err(error) => return json!({ "ok": false, "error": error }),
    };
    let Some(kind) = StudioSongFileKind::from_path(&path) else {
        return json!({ "ok": false, "error": "Unsupported studio song file kind" });
    };
    let size = match fs::metadata(&path) {
        Ok(metadata) => metadata.len(),
        Err(error) => return json!({ "ok": false, "error": error.to_string() }),
    };
    if size == 0 || size > kind.max_bytes() {
        let error = match kind {
            StudioSongFileKind::Kp => "Knead project must be between 1 byte and 144 MiB",
            StudioSongFileKind::Nbs => "NBS song must be between 1 byte and 16 MiB",
        };
        return json!({ "ok": false, "error": error });
    }
    let contents = match fs::read(&path) {
        Ok(contents) if !contents.is_empty() && contents.len() as u64 <= kind.max_bytes() => {
            contents
        }
        Ok(_) => {
            return json!({ "ok": false, "error": "Studio song changed while it was being read" })
        }
        Err(error) => return json!({ "ok": false, "error": error.to_string() }),
    };
    match kind {
        StudioSongFileKind::Kp => match String::from_utf8(contents) {
            Ok(json) => json!({
                "ok": true,
                "path": path.to_string_lossy(),
                "kind": "kp",
                "json": json,
            }),
            Err(_) => json!({ "ok": false, "error": "Knead project is not valid UTF-8" }),
        },
        StudioSongFileKind::Nbs => json!({
            "ok": true,
            "path": path.to_string_lossy(),
            "kind": "nbs",
            "dataBase64": BASE64_STANDARD.encode(contents),
        }),
    }
}

#[tauri::command]
fn timeline_save(
    window: WebviewWindow,
    document_id: String,
    payload: TimelineWritePayload,
    state: State<'_, AppState>,
) -> Value {
    let (kind, bytes) = match decode_timeline_write_payload(payload) {
        Ok(decoded) => decoded,
        Err(error) => return json!({ "ok": false, "error": error }),
    };
    let key = match timeline_document_key(window.label(), &document_id) {
        Ok(key) => key,
        Err(error) => return json!({ "ok": false, "error": error }),
    };
    let paths = match state.timeline_paths.lock() {
        Ok(paths) => paths,
        Err(error) => return json!({ "ok": false, "error": error.to_string() }),
    };
    match paths.get(&key) {
        Some(path) if StudioSongFileKind::from_path(path) != Some(kind) => {
            json!({ "ok": false, "error": "Bound path extension does not match the save format" })
        }
        Some(path) => match write_user_file_safely(path, &bytes) {
            Ok(()) => ok_path(path),
            Err(error) => json!({ "ok": false, "error": error.to_string() }),
        },
        None => json!({ "ok": false, "error": "上書き先が未選択です" }),
    }
}

#[tauri::command]
async fn timeline_save_dialog(
    app: AppHandle,
    window: WebviewWindow,
    document_id: String,
    default_path: Option<String>,
    payload: TimelineWritePayload,
    state: State<'_, AppState>,
) -> Result<Value, String> {
    let (kind, bytes) = match decode_timeline_write_payload(payload) {
        Ok(decoded) => decoded,
        Err(error) => return Ok(json!({ "ok": false, "error": error })),
    };
    if let Err(error) = validate_timeline_document_id(&document_id) {
        return Ok(json!({ "ok": false, "error": error }));
    }
    let mut dialog = app
        .dialog()
        .file()
        .set_parent(&window)
        .set_title(format!("{} を保存", kind.display_name()))
        .add_filter(kind.display_name(), &[kind.extension()])
        .set_file_name(
            default_path
                .as_deref()
                .unwrap_or(if kind == StudioSongFileKind::Kp {
                    "untitled.kp"
                } else {
                    "untitled.nbs"
                }),
        );
    if let Some(parent) = default_path
        .as_deref()
        .map(Path::new)
        .and_then(Path::parent)
    {
        if parent.is_dir() {
            dialog = dialog.set_directory(parent);
        }
    }
    let Some(file) = dialog.blocking_save_file() else {
        return Ok(json!({ "ok": false, "canceled": true }));
    };
    let path = match file
        .into_path()
        .map_err(|error| error.to_string())
        .and_then(|path| canonical_timeline_save_path(path, kind))
    {
        Ok(path) => path,
        Err(error) => return Ok(json!({ "ok": false, "error": error })),
    };
    let mut paths = match state.timeline_paths.lock() {
        Ok(paths) => paths,
        Err(error) => return Ok(json!({ "ok": false, "error": error.to_string() })),
    };
    if let Err(error) = ensure_timeline_path_available(&paths, window.label(), &document_id, &path)
    {
        return Ok(json!({ "ok": false, "error": error }));
    }
    Ok(match write_user_file_safely(&path, &bytes) {
        Ok(()) => {
            match bind_timeline_path(&mut paths, window.label(), &document_id, path.clone()) {
                Ok(()) => ok_path(&path),
                Err(error) => json!({ "ok": false, "error": error }),
            }
        }
        Err(error) => json!({ "ok": false, "error": error.to_string() }),
    })
}

#[tauri::command]
async fn timeline_open_dialog(app: AppHandle, window: WebviewWindow) -> Result<Value, String> {
    let file = app
        .dialog()
        .file()
        .set_parent(&window)
        .set_title("Knead Project / NBS Song を開く")
        .add_filter("Studio Songs", &["kp", "nbs"])
        .blocking_pick_file();
    let Some(file) = file else {
        return Ok(json!({ "ok": false, "canceled": true }));
    };
    let path = match file.into_path() {
        Ok(path) => path,
        Err(error) => return Ok(json!({ "ok": false, "error": error.to_string() })),
    };
    Ok(read_timeline_path(path))
}

#[tauri::command]
fn timeline_open_path(path: String) -> Value {
    read_timeline_path(PathBuf::from(path))
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct PlainNbsCustomAudioAsset {
    file_name: String,
    mime_type: &'static str,
    byte_length: usize,
    data_base64: String,
}

#[derive(Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct PlainNbsCustomAudioResolution {
    assets: Vec<PlainNbsCustomAudioAsset>,
    warnings: Vec<String>,
}

fn unsafe_nbs_audio_segment(segment: &str) -> bool {
    segment.is_empty()
        || matches!(segment, "." | "..")
        || segment.len() > 255
        || segment.ends_with('.')
        || segment.ends_with(' ')
        || segment
            .chars()
            .any(|character| character.is_control() || r#"<>:"|?*"#.contains(character))
        || matches!(
            segment
                .split('.')
                .next()
                .unwrap_or_default()
                .to_ascii_uppercase()
                .as_str(),
            "CON"
                | "PRN"
                | "AUX"
                | "NUL"
                | "COM1"
                | "COM2"
                | "COM3"
                | "COM4"
                | "COM5"
                | "COM6"
                | "COM7"
                | "COM8"
                | "COM9"
                | "LPT1"
                | "LPT2"
                | "LPT3"
                | "LPT4"
                | "LPT5"
                | "LPT6"
                | "LPT7"
                | "LPT8"
                | "LPT9"
        )
}

fn normalize_plain_nbs_audio_name(file_name: &str) -> Result<(PathBuf, String), String> {
    if file_name.is_empty() || file_name.len() > MAX_PLAIN_NBS_CUSTOM_AUDIO_NAME_BYTES {
        return Err("the name must be between 1 and 1024 UTF-8 bytes".to_string());
    }
    if file_name.starts_with('/') || file_name.starts_with('\\') || file_name.contains('\0') {
        return Err("absolute paths are not allowed".to_string());
    }
    let portable = file_name.replace('\\', "/");
    if portable.starts_with('/') || portable.contains("//") {
        return Err("absolute or empty path segments are not allowed".to_string());
    }
    let segments: Vec<_> = portable.split('/').collect();
    if segments.is_empty()
        || segments.len() > MAX_PLAIN_NBS_CUSTOM_AUDIO_SEGMENTS
        || segments
            .iter()
            .any(|segment| unsafe_nbs_audio_segment(segment))
    {
        return Err("the path contains an unsafe segment".to_string());
    }
    let extension = segments
        .last()
        .and_then(|segment| Path::new(segment).extension())
        .and_then(|extension| extension.to_str());
    if !extension.is_some_and(|extension| {
        extension.eq_ignore_ascii_case("ogg") || extension.eq_ignore_ascii_case("wav")
    }) {
        return Err("only .ogg and .wav custom sounds are supported".to_string());
    }
    let relative = segments.iter().fold(PathBuf::new(), |mut path, segment| {
        path.push(segment);
        path
    });
    let canonical_key = portable.to_lowercase();
    Ok((relative, canonical_key))
}

fn metadata_is_link_or_reparse(metadata: &fs::Metadata) -> bool {
    if metadata.file_type().is_symlink() {
        return true;
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        // FILE_ATTRIBUTE_REPARSE_POINT. This also catches junctions and other
        // redirecting reparse tags that FileType::is_symlink does not expose.
        metadata.file_attributes() & 0x400 != 0
    }
    #[cfg(not(windows))]
    {
        false
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct StableFileMetadata {
    identity: StableFileIdentity,
    len: u64,
    modified: Option<SystemTime>,
}

#[cfg(unix)]
#[derive(Debug, Clone, PartialEq, Eq)]
struct StableFileIdentity {
    device: u64,
    inode: u64,
}

#[cfg(windows)]
#[derive(Debug, Clone, PartialEq, Eq)]
struct StableFileIdentity {
    volume: u32,
    index: u64,
}

#[cfg(not(any(unix, windows)))]
#[derive(Debug, Clone, PartialEq, Eq)]
struct StableFileIdentity {
    created: Option<SystemTime>,
}

#[cfg(windows)]
#[repr(C)]
struct WindowsFileTime {
    low: u32,
    high: u32,
}

#[cfg(windows)]
#[repr(C)]
struct WindowsByHandleFileInformation {
    attributes: u32,
    creation_time: WindowsFileTime,
    last_access_time: WindowsFileTime,
    last_write_time: WindowsFileTime,
    volume_serial_number: u32,
    file_size_high: u32,
    file_size_low: u32,
    number_of_links: u32,
    file_index_high: u32,
    file_index_low: u32,
}

#[cfg(windows)]
#[link(name = "Kernel32")]
extern "system" {
    fn GetFileInformationByHandle(
        file: *mut std::ffi::c_void,
        information: *mut WindowsByHandleFileInformation,
    ) -> i32;
}

fn stable_file_metadata(file: &fs::File) -> Result<StableFileMetadata, String> {
    let metadata = file.metadata().map_err(|error| error.to_string())?;
    #[cfg(unix)]
    let identity = {
        use std::os::unix::fs::MetadataExt;
        StableFileIdentity {
            device: metadata.dev(),
            inode: metadata.ino(),
        }
    };
    #[cfg(windows)]
    let identity = {
        use std::mem::MaybeUninit;
        use std::os::windows::io::AsRawHandle;

        let mut information = MaybeUninit::<WindowsByHandleFileInformation>::uninit();
        // SAFETY: `file` owns a valid Windows handle for this call and
        // `information` points to writable storage of the documented layout.
        let succeeded = unsafe {
            GetFileInformationByHandle(file.as_raw_handle().cast(), information.as_mut_ptr())
        };
        if succeeded == 0 {
            return Err(std::io::Error::last_os_error().to_string());
        }
        // SAFETY: GetFileInformationByHandle returned success and initialized
        // every field in BY_HANDLE_FILE_INFORMATION.
        let information = unsafe { information.assume_init() };
        StableFileIdentity {
            volume: information.volume_serial_number,
            index: (u64::from(information.file_index_high) << 32)
                | u64::from(information.file_index_low),
        }
    };
    #[cfg(not(any(unix, windows)))]
    let identity = StableFileIdentity {
        created: metadata.created().ok(),
    };
    Ok(StableFileMetadata {
        identity,
        len: metadata.len(),
        modified: metadata.modified().ok(),
    })
}

fn verified_nbs_audio_candidate(root: &Path, relative: &Path) -> Result<Option<PathBuf>, String> {
    let mut current = root.to_path_buf();
    let mut components = relative.components().peekable();
    while let Some(component) = components.next() {
        let Component::Normal(segment) = component else {
            return Err("the resolved sound path is not relative".to_string());
        };
        current.push(segment);
        let metadata = match fs::symlink_metadata(&current) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(error.to_string()),
        };
        if metadata_is_link_or_reparse(&metadata) {
            return Err("a symlink or reparse point was rejected".to_string());
        }
        if components.peek().is_some() && !metadata.is_dir() {
            return Err("a sound path parent is not a directory".to_string());
        }
        if components.peek().is_none() && !metadata.is_file() {
            return Err("the sound path is not a regular file".to_string());
        }
    }
    let canonical = current.canonicalize().map_err(|error| error.to_string())?;
    if canonical == root || !canonical.starts_with(root) {
        return Err("the resolved sound escaped the NBS directory".to_string());
    }
    Ok(Some(canonical))
}

fn read_plain_nbs_audio_candidate_with_hook<F>(
    root: &Path,
    relative: &Path,
    per_file_bytes: u64,
    remaining_total_bytes: u64,
    after_open: F,
) -> Result<Option<Vec<u8>>, String>
where
    F: FnOnce(&Path),
{
    let Some(canonical_before) = verified_nbs_audio_candidate(root, relative)? else {
        return Ok(None);
    };
    let metadata_before = fs::metadata(&canonical_before).map_err(|error| error.to_string())?;
    if metadata_before.len() == 0 || metadata_before.len() > per_file_bytes {
        return Err("the sound must be between 1 byte and 32 MiB".to_string());
    }
    if metadata_before.len() > remaining_total_bytes {
        return Err("the 96 MiB custom-sound project budget was reached".to_string());
    }

    let mut file = fs::File::open(&canonical_before).map_err(|error| error.to_string())?;
    let opened = stable_file_metadata(&file)?;
    if opened.len != metadata_before.len() || opened.modified != metadata_before.modified().ok() {
        return Err("the sound changed before it could be read".to_string());
    }
    after_open(&canonical_before);
    let Some(canonical_after_open) = verified_nbs_audio_candidate(root, relative)? else {
        return Err("the sound disappeared before it could be read".to_string());
    };
    if canonical_after_open != canonical_before {
        return Err("the sound path changed before it could be read".to_string());
    }
    let path_after_open = stable_file_metadata(
        &fs::File::open(&canonical_after_open).map_err(|error| error.to_string())?,
    )?;
    if path_after_open != opened {
        return Err("the sound path changed before it could be read".to_string());
    }

    let read_limit = per_file_bytes.min(remaining_total_bytes);
    let mut data = Vec::with_capacity(opened.len as usize);
    (&mut file)
        .take(read_limit + 1)
        .read_to_end(&mut data)
        .map_err(|error| error.to_string())?;
    let after = stable_file_metadata(&file)?;
    let Some(canonical_after_read) = verified_nbs_audio_candidate(root, relative)? else {
        return Err("the sound disappeared while it was being read".to_string());
    };
    let path_after_read = stable_file_metadata(
        &fs::File::open(&canonical_after_read).map_err(|error| error.to_string())?,
    )?;
    if data.len() as u64 != opened.len
        || data.len() as u64 > read_limit
        || after != opened
        || path_after_read != opened
        || canonical_after_read != canonical_before
    {
        return Err("the sound changed while it was being read".to_string());
    }
    Ok(Some(data))
}

fn read_plain_nbs_audio_candidate(
    root: &Path,
    relative: &Path,
    per_file_bytes: u64,
    remaining_total_bytes: u64,
) -> Result<Option<Vec<u8>>, String> {
    read_plain_nbs_audio_candidate_with_hook(
        root,
        relative,
        per_file_bytes,
        remaining_total_bytes,
        |_| {},
    )
}

fn bounded_nbs_audio_name(file_name: &str) -> String {
    let mut value: String = file_name.chars().take(160).collect();
    if value.len() < file_name.len() {
        value.push('…');
    }
    serde_json::to_string(&value).unwrap_or_else(|_| "\"invalid name\"".to_string())
}

fn resolve_plain_nbs_custom_audio_with_limits(
    nbs_path: &Path,
    file_names: Vec<String>,
    per_file_bytes: u64,
    total_bytes: u64,
) -> Result<PlainNbsCustomAudioResolution, String> {
    if file_names.len() > MAX_PLAIN_NBS_CUSTOM_AUDIO_FILES {
        return Err("At most 240 NBS custom-sound names may be resolved at once".to_string());
    }
    if !nbs_path.is_absolute() {
        return Err("The NBS path must be absolute and canonical".to_string());
    }
    let canonical_song = validate_timeline_path(nbs_path.to_path_buf())?;
    if StudioSongFileKind::from_path(&canonical_song) != Some(StudioSongFileKind::Nbs)
        || canonical_song != nbs_path
    {
        return Err("The NBS path must be the canonical path returned by open".to_string());
    }
    let root = canonical_song
        .parent()
        .ok_or_else(|| "The NBS file has no containing directory".to_string())?
        .to_path_buf();
    let mut result = PlainNbsCustomAudioResolution::default();
    let mut seen = HashSet::new();
    let mut loaded_bytes = 0_u64;

    for file_name in file_names {
        let label = bounded_nbs_audio_name(&file_name);
        let (relative, canonical_key) = match normalize_plain_nbs_audio_name(&file_name) {
            Ok(value) => value,
            Err(error) => {
                result.warnings.push(format!(
                    "Custom instrument sound path {label} was rejected: {error}."
                ));
                continue;
            }
        };
        if !seen.insert(canonical_key) {
            continue;
        }
        let remaining = total_bytes.saturating_sub(loaded_bytes);
        let mut errors = Vec::new();
        let mut resolved = None;
        for sounds_directory in ["Sounds", "sounds"] {
            let candidate = Path::new(sounds_directory).join(&relative);
            match read_plain_nbs_audio_candidate(&root, &candidate, per_file_bytes, remaining) {
                Ok(Some(data)) => {
                    let Some(mime_type) = reference_audio_mime(&relative, &data) else {
                        errors.push("its extension and OGG/WAV signature do not match".to_string());
                        continue;
                    };
                    resolved = Some((mime_type, data));
                    break;
                }
                Ok(None) => {}
                Err(error) => errors.push(error),
            }
        }
        let Some((mime_type, data)) = resolved else {
            let reason = errors.into_iter().next().unwrap_or_else(|| {
                "it was not found in the sibling Sounds/sounds directory".to_string()
            });
            result.warnings.push(format!(
                "Custom instrument sound {label} was not loaded: {reason}."
            ));
            continue;
        };
        loaded_bytes = loaded_bytes
            .checked_add(data.len() as u64)
            .ok_or_else(|| "Custom-sound size overflow".to_string())?;
        if loaded_bytes > total_bytes {
            return Err("Custom sounds exceeded the aggregate read budget".to_string());
        }
        result.assets.push(PlainNbsCustomAudioAsset {
            file_name,
            mime_type,
            byte_length: data.len(),
            data_base64: BASE64_STANDARD.encode(data),
        });
    }
    Ok(result)
}

#[tauri::command]
fn timeline_resolve_nbs_custom_audio(
    window: WebviewWindow,
    document_id: String,
    file_names: Vec<String>,
    state: State<'_, AppState>,
) -> Value {
    if let Err(error) = validate_timeline_window_label(window.label()) {
        return json!({ "ok": false, "error": error });
    }
    let nbs_path = match state.timeline_paths.lock() {
        Ok(paths) => match bound_timeline_nbs_path(&paths, window.label(), &document_id) {
            Ok(path) => path,
            Err(error) => return json!({ "ok": false, "error": error }),
        },
        Err(error) => return json!({ "ok": false, "error": error.to_string() }),
    };
    match resolve_plain_nbs_custom_audio_with_limits(
        &nbs_path,
        file_names,
        MAX_PLAIN_NBS_CUSTOM_AUDIO_BYTES,
        MAX_PLAIN_NBS_CUSTOM_AUDIO_TOTAL_BYTES,
    ) {
        Ok(result) => json!({
            "ok": true,
            "assets": result.assets,
            "warnings": result.warnings,
        }),
        Err(error) => json!({ "ok": false, "error": error }),
    }
}

#[tauri::command]
fn timeline_bind_current_path(
    window: WebviewWindow,
    document_id: String,
    path: String,
    state: State<'_, AppState>,
) -> Value {
    if let Err(error) = validate_timeline_document_id(&document_id) {
        return json!({ "ok": false, "error": error });
    }
    let path = match validate_timeline_path(PathBuf::from(path)) {
        Ok(path) => path,
        Err(error) => return json!({ "ok": false, "error": error }),
    };
    match state.timeline_paths.lock() {
        Ok(mut paths) => {
            match bind_timeline_path(&mut paths, window.label(), &document_id, path.clone()) {
                Ok(()) => ok_path(&path),
                Err(error) => json!({ "ok": false, "error": error }),
            }
        }
        Err(error) => json!({ "ok": false, "error": error.to_string() }),
    }
}

#[tauri::command]
fn timeline_release_current_path(
    window: WebviewWindow,
    document_id: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let mut paths = state
        .timeline_paths
        .lock()
        .map_err(|error| error.to_string())?;
    release_timeline_path(&mut paths, window.label(), &document_id)
}

#[tauri::command]
fn timeline_take_open_requests(
    window: WebviewWindow,
    state: State<'_, AppState>,
) -> Result<Vec<String>, String> {
    if window.label() != "sub" {
        return Err(
            "Timeline open requests can only be consumed by the timeline window".to_string(),
        );
    }
    Ok(state
        .pending_timeline_paths
        .lock()
        .map_err(|error| error.to_string())?
        .drain(..)
        .map(|path| path.to_string_lossy().into_owned())
        .collect())
}

#[tauri::command]
fn timeline_set_close_ready(
    window: WebviewWindow,
    ready: bool,
    state: State<'_, AppState>,
) -> Result<(), String> {
    validate_timeline_window_label(window.label())?;
    let mut windows = state
        .timeline_ready_windows
        .lock()
        .map_err(|error| error.to_string())?;
    if ready {
        windows.insert(window.label().to_string());
    } else {
        windows.remove(window.label());
    }
    Ok(())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TimelineCloseMode {
    Hide,
    Exit,
}

impl TimelineCloseMode {
    fn parse(mode: &str) -> Result<Self, String> {
        match mode {
            "hide" => Ok(Self::Hide),
            "exit" => Ok(Self::Exit),
            _ => Err("Invalid timeline close mode".to_string()),
        }
    }

    fn as_str(self) -> &'static str {
        match self {
            Self::Hide => "hide",
            Self::Exit => "exit",
        }
    }
}

fn validate_timeline_window_label(window_label: &str) -> Result<(), String> {
    if window_label == "sub" {
        Ok(())
    } else {
        Err("Timeline close confirmation must come from the timeline window".to_string())
    }
}

fn request_timeline_close(app: &AppHandle, mode: TimelineCloseMode) -> bool {
    let Some(state) = app.try_state::<AppState>() else {
        return false;
    };
    let ready = state
        .timeline_ready_windows
        .lock()
        .ok()
        .is_some_and(|windows| windows.contains("sub"));
    if !ready {
        return false;
    }
    app.get_webview_window("sub").is_some_and(|window| {
        window
            .emit(
                TIMELINE_CLOSE_REQUESTED_EVENT,
                json!({ "mode": mode.as_str() }),
            )
            .is_ok()
    })
}

#[tauri::command]
fn timeline_confirm_close(window: WebviewWindow, mode: String) -> Result<(), String> {
    validate_timeline_window_label(window.label())?;
    match TimelineCloseMode::parse(&mode)? {
        TimelineCloseMode::Hide => {
            window.hide().map_err(|error| error.to_string())?;
            if let Some(main) = window.app_handle().get_webview_window("main") {
                let _ = main.set_focus();
            }
        }
        TimelineCloseMode::Exit => window.app_handle().exit(0),
    }
    Ok(())
}

#[tauri::command]
async fn audio_export_start(
    app: AppHandle,
    window: WebviewWindow,
    request: audio_export::AudioExportRequest,
    state: State<'_, AppState>,
) -> Result<Value, String> {
    let (format, format_label) = match request.options.format.as_str() {
        "wav" => ("wav", "WAV Audio"),
        "aiff" => ("aiff", "AIFF Audio"),
        "flac" => ("flac", "FLAC Audio"),
        "ogg" => ("ogg", "Ogg Vorbis Audio"),
        "mp3" => ("mp3", "MP3 Audio"),
        other => {
            return Ok(json!({ "ok": false, "error": format!("Unsupported format: {other}") }))
        }
    };
    if let Err(error) = audio_export::validate_options(&request.options) {
        return Ok(json!({ "ok": false, "error": error }));
    }
    let path_is_directory = request
        .options
        .targets
        .iter()
        .any(|target| target == "stems");
    let selected_path = if path_is_directory {
        let Some(folder) = app
            .dialog()
            .file()
            .set_parent(&window)
            .set_title("書き出し先フォルダーを選択")
            .blocking_pick_folder()
        else {
            return Ok(json!({ "ok": false, "canceled": true }));
        };
        match folder.into_path() {
            Ok(path) => path,
            Err(error) => return Ok(json!({ "ok": false, "error": error.to_string() })),
        }
    } else {
        let default_name = format!(
            "{}.{}",
            audio_export::sanitize_name(&request.default_name),
            format
        );
        let Some(file) = app
            .dialog()
            .file()
            .set_parent(&window)
            .set_title("オーディオを書き出す")
            .add_filter(format_label, &[format])
            .set_file_name(&default_name)
            .blocking_save_file()
        else {
            return Ok(json!({ "ok": false, "canceled": true }));
        };
        match file.into_path() {
            Ok(mut path) => {
                if !path
                    .extension()
                    .and_then(|value| value.to_str())
                    .is_some_and(|value| value.eq_ignore_ascii_case(format))
                {
                    path.set_extension(format);
                }
                path
            }
            Err(error) => return Ok(json!({ "ok": false, "error": error.to_string() })),
        }
    };

    let planned = match audio_export::planned_outputs(&selected_path, path_is_directory, &request) {
        Ok(paths) => paths,
        Err(error) => return Ok(json!({ "ok": false, "error": error })),
    };
    let existing = planned
        .iter()
        .filter(|(path, _)| path.exists())
        .map(|(path, _)| {
            path.file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .into_owned()
        })
        .collect::<Vec<_>>();
    if !existing.is_empty() {
        let accepted = app
            .dialog()
            .message(format!("{}\n\n上書きしますか？", existing.join("\n")))
            .title("既存ファイルがあります")
            .parent(&window)
            .kind(MessageDialogKind::Warning)
            .buttons(MessageDialogButtons::OkCancel)
            .blocking_show();
        if !accepted {
            return Ok(json!({ "ok": false, "canceled": true }));
        }
    }

    let root = minecraft_dir(&app)?;
    let job_id = format!(
        "export-{}-{}",
        std::process::id(),
        EXPORT_JOB_COUNTER.fetch_add(1, Ordering::Relaxed)
    );
    let canceled = Arc::new(AtomicBool::new(false));
    state
        .export_jobs
        .lock()
        .map_err(|error| error.to_string())?
        .insert(job_id.clone(), canceled.clone());

    let app_for_job = app.clone();
    let job_id_for_job = job_id.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let emit_progress = |progress: audio_export::ExportProgress| {
            let _ = app_for_job.emit("audio-export-progress", progress);
        };
        let result = audio_export::run_export(
            &job_id_for_job,
            &root,
            &selected_path,
            path_is_directory,
            request,
            canceled,
            emit_progress,
        );
        let progress = match result {
            Ok(paths) => audio_export::ExportProgress {
                job_id: job_id_for_job.clone(),
                progress: 1.0,
                stage: "完了".to_string(),
                current_track: None,
                done: true,
                canceled: false,
                error: None,
                output_paths: Some(paths),
            },
            Err(error) if error == "canceled" => audio_export::ExportProgress {
                job_id: job_id_for_job.clone(),
                progress: 0.0,
                stage: "キャンセルしました".to_string(),
                current_track: None,
                done: false,
                canceled: true,
                error: None,
                output_paths: None,
            },
            Err(error) => audio_export::ExportProgress {
                job_id: job_id_for_job.clone(),
                progress: 0.0,
                stage: "失敗".to_string(),
                current_track: None,
                done: false,
                canceled: false,
                error: Some(error),
                output_paths: None,
            },
        };
        let _ = app_for_job.emit("audio-export-progress", progress);
        if let Some(state) = app_for_job.try_state::<AppState>() {
            if let Ok(mut jobs) = state.export_jobs.lock() {
                jobs.remove(&job_id_for_job);
            }
        }
    });

    Ok(json!({ "ok": true, "jobId": job_id }))
}

#[tauri::command]
fn audio_export_cancel(job_id: String, state: State<'_, AppState>) -> Result<(), String> {
    let jobs = state
        .export_jobs
        .lock()
        .map_err(|error| error.to_string())?;
    if let Some(canceled) = jobs.get(&job_id) {
        canceled.store(true, Ordering::Relaxed);
    }
    Ok(())
}

#[cfg(not(debug_assertions))]
fn show_update_error(app: &AppHandle, title: &str, message: impl Into<String>) {
    app.dialog()
        .message(message.into())
        .title(title)
        .kind(MessageDialogKind::Error)
        .show(|_| {});
}

#[cfg(not(debug_assertions))]
fn updater_executable_name() -> Option<&'static str> {
    #[cfg(target_os = "windows")]
    return Some("Knead-Updater.exe");
    #[cfg(target_os = "macos")]
    return Some("Knead-Updater-macos");
    #[cfg(all(unix, not(target_os = "macos")))]
    return Some("Knead-Updater-linux");
    #[allow(unreachable_code)]
    None
}

#[cfg(not(debug_assertions))]
async fn check_for_updates(app: AppHandle) -> Result<(), String> {
    let current = app.package_info().version.clone();
    let settings = merged_settings(&app)?;
    let language = settings
        .get("language")
        .and_then(Value::as_str)
        .unwrap_or("en");
    let text = updater_text(language);
    let client = reqwest::Client::builder()
        .user_agent(format!("Knead/{current}"))
        .build()
        .map_err(|error| error.to_string())?;
    let release: ReleaseInfo = client
        .get("https://api.github.com/repos/nea-c/Knead/releases/latest")
        .send()
        .await
        .map_err(|error| error.to_string())?
        .error_for_status()
        .map_err(|error| error.to_string())?
        .json()
        .await
        .map_err(|error| error.to_string())?;
    let latest = semver::Version::parse(release.tag_name.trim_start_matches('v'))
        .map_err(|error| error.to_string())?;
    if latest <= current {
        return Ok(());
    }

    let Some(main) = app.get_webview_window("main") else {
        return Err("Main window not found".to_string());
    };
    let message = text
        .message
        .replace("{latest}", &latest.to_string())
        .replace("{current}", &current.to_string());
    let accepted = app
        .dialog()
        .message(message)
        .title(text.title)
        .parent(&main)
        .kind(MessageDialogKind::Info)
        .buttons(MessageDialogButtons::OkCancelCustom(
            text.update.to_string(),
            text.later.to_string(),
        ))
        .blocking_show();
    if !accepted {
        return Ok(());
    }

    let updater_name = updater_executable_name()
        .ok_or_else(|| "The current platform is not supported by the updater".to_string())?;
    let executable = env::current_exe().map_err(|error| error.to_string())?;
    let executable_dir = executable
        .parent()
        .ok_or_else(|| "Application directory not found".to_string())?;
    let updater = executable_dir.join(updater_name);
    if !updater.is_file() {
        show_update_error(
            &app,
            text.error,
            format!("{}: {}", text.missing, updater.display()),
        );
        return Ok(());
    }
    let asset = release
        .assets
        .iter()
        .find(|asset| asset.name.ends_with(".zip"))
        .ok_or_else(|| "No ZIP asset found in the latest release".to_string())?;
    let zip_path = executable_dir.join(&asset.name);
    let response = client
        .get(&asset.browser_download_url)
        .send()
        .await
        .map_err(|error| error.to_string())?
        .error_for_status()
        .map_err(|error| error.to_string())?;
    let total = response.content_length();
    let mut downloaded = 0_u64;
    let mut stream = response.bytes_stream();
    let mut output = fs::File::create(&zip_path).map_err(|error| error.to_string())?;
    let _ = main.set_title(text.downloading);
    let _ = main.set_progress_bar(ProgressBarState {
        status: Some(ProgressBarStatus::Normal),
        progress: Some(0),
    });
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|error| error.to_string())?;
        output
            .write_all(&chunk)
            .map_err(|error| error.to_string())?;
        downloaded += chunk.len() as u64;
        if let Some(total) = total.filter(|total| *total > 0) {
            let percent = (downloaded.saturating_mul(100) / total).min(100);
            let _ = main.set_title(&format!("{} {percent}%", text.downloading));
            let _ = main.set_progress_bar(ProgressBarState {
                status: Some(ProgressBarStatus::Normal),
                progress: Some(percent),
            });
        }
    }
    output.flush().map_err(|error| error.to_string())?;
    let _ = main.set_title(text.launching);
    let _ = main.set_progress_bar(ProgressBarState {
        status: Some(ProgressBarStatus::None),
        progress: None,
    });

    Command::new(&updater)
        .arg("--zip")
        .arg(&zip_path)
        .arg("--appExe")
        .arg(&executable)
        .arg("--called-from-parent")
        .current_dir(executable_dir)
        .spawn()
        .map_err(|error| error.to_string())?;
    app.exit(0);
    Ok(())
}

fn start_update_check(app: AppHandle) {
    #[cfg(not(debug_assertions))]
    tauri::async_runtime::spawn(async move {
        if let Err(error) = check_for_updates(app.clone()).await {
            let language = merged_settings(&app)
                .ok()
                .and_then(|settings| settings.get("language").cloned())
                .and_then(|value| value.as_str().map(ToOwned::to_owned))
                .unwrap_or_else(|| "en".to_string());
            let text = updater_text(&language);
            show_update_error(&app, text.error, error);
        }
    });
    #[cfg(debug_assertions)]
    let _ = app;
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, args, cwd| {
            let projects = project_paths_from_args(&args, Path::new(&cwd));
            if queue_timeline_opens(app, projects) > 0 {
                return;
            }
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState::default())
        .on_window_event(|window, event| match event {
            tauri::WindowEvent::CloseRequested { api, .. } if window.label() == "sub" => {
                api.prevent_close();
                if !request_timeline_close(window.app_handle(), TimelineCloseMode::Hide) {
                    let _ = window.hide();
                    if let Some(main) = window.app_handle().get_webview_window("main") {
                        let _ = main.set_focus();
                    }
                }
            }
            tauri::WindowEvent::CloseRequested { api, .. } if window.label() == "main" => {
                if request_timeline_close(window.app_handle(), TimelineCloseMode::Exit) {
                    api.prevent_close();
                } else {
                    window.app_handle().exit(0);
                }
            }
            _ => {}
        })
        .setup(|app| {
            if !is_portable(app.handle()) {
                start_update_check(app.handle().clone());
            }
            let args: Vec<String> = env::args().collect();
            if let Ok(cwd) = env::current_dir() {
                let projects = project_paths_from_args(&args, &cwd);
                queue_timeline_opens(app.handle(), projects);
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_versions,
            download_version_assets,
            get_mc_sounds,
            get_mc_sound_hash,
            get_mc_sound_data,
            get_mc_marker_icons,
            make_sub_window,
            load_settings,
            update_settings,
            get_setting,
            set_setting,
            load_rating_star,
            save_rating_star,
            save_rating_star_as_string,
            update_rating_star,
            get_current_sounds,
            set_selected_sound,
            get_main_selected_sound,
            timeline_save,
            timeline_save_dialog,
            timeline_open_dialog,
            timeline_open_path,
            timeline_resolve_nbs_custom_audio,
            timeline_bind_current_path,
            timeline_release_current_path,
            timeline_take_open_requests,
            timeline_set_close_ready,
            timeline_confirm_close,
            timeline_recovery_save,
            timeline_recovery_list,
            timeline_recovery_restore,
            timeline_recovery_discard,
            timeline_recovery_clear_project,
            command_export_save,
            note_block_build_save_dialog,
            nbs_open_dialog,
            nbs_bundle_open_dialog,
            resource_pack_open_dialog,
            nbs_save_dialog,
            nbs_bundle_save_dialog,
            midi_open_dialog,
            nbp_open_dialog,
            nbp_save_dialog,
            reference_audio_open_dialog,
            audio_export_start,
            audio_export_cancel,
        ])
        .build(tauri::generate_context!())
        .expect("error while running Knead");

    app.run(|app, event| {
        #[cfg(target_os = "macos")]
        {
            if let tauri::RunEvent::Opened { urls } = event {
                let paths = urls
                    .into_iter()
                    .filter_map(|url| url.to_file_path().ok())
                    .filter(|path| is_studio_song_path(path));
                queue_timeline_opens(app, paths);
            }
        }
        #[cfg(not(target_os = "macos"))]
        let _ = (app, event);
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reference_audio_requires_matching_extension_and_magic() {
        let mut wav = b"RIFF\0\0\0\0WAVE".to_vec();
        wav.extend_from_slice(&[0; 16]);
        assert_eq!(
            reference_audio_mime(Path::new("guide.wav"), &wav),
            Some("audio/wav")
        );
        assert_eq!(reference_audio_mime(Path::new("guide.ogg"), &wav), None);
        assert_eq!(
            reference_audio_mime(Path::new("guide.OGG"), b"OggS\0\0\0\0"),
            Some("audio/ogg")
        );
        assert_eq!(
            reference_audio_mime(Path::new("guide.wav"), b"not audio"),
            None
        );
    }

    #[test]
    fn midi_data_size_is_checked_again_after_reading() {
        assert!(!valid_midi_data_size(0));
        assert!(valid_midi_data_size(1));
        assert!(valid_midi_data_size(MAX_MIDI_DATA_BYTES));
        assert!(!valid_midi_data_size(MAX_MIDI_DATA_BYTES + 1));

        let bounded = read_midi_bytes_with_limit(std::io::Cursor::new(b"123456"), 4)
            .expect("bounded MIDI read should succeed");
        assert_eq!(bounded, b"12345");
    }

    fn object(hash_character: char, size: u64) -> AssetObject {
        AssetObject {
            hash: std::iter::repeat(hash_character).take(40).collect(),
            size,
        }
    }

    #[test]
    fn sound_assets_only_include_the_sound_manifest_and_audio() {
        let shared_audio = object('a', 10);
        let index = AssetIndex {
            objects: HashMap::from([
                ("minecraft/sounds.json".to_string(), object('b', 20)),
                (
                    "minecraft/sounds/ui/click.ogg".to_string(),
                    shared_audio.clone(),
                ),
                (
                    "minecraft/sounds/ui/click-copy.ogg".to_string(),
                    shared_audio,
                ),
                ("minecraft/textures/gui.png".to_string(), object('c', 30)),
            ]),
        };

        let assets = sound_asset_objects(&index).expect("sound assets should be valid");
        assert_eq!(assets.len(), 2);
        assert!(assets.iter().any(|asset| asset.hash == "a".repeat(40)));
        assert!(assets.iter().any(|asset| asset.hash == "b".repeat(40)));
    }

    #[test]
    fn sound_assets_require_sounds_json() {
        let index = AssetIndex {
            objects: HashMap::from([(
                "minecraft/sounds/ui/click.ogg".to_string(),
                object('a', 10),
            )]),
        };
        assert!(sound_asset_objects(&index).is_err());
    }

    #[test]
    fn marker_visuals_parse_specific_block_entity_and_item_events() {
        assert_eq!(
            marker_visual_subject("block.stone.break"),
            Some(MarkerVisualSubject {
                kind: MarkerVisualKind::Block,
                id: "stone".to_string(),
            })
        );
        assert_eq!(
            marker_visual_subject("minecraft:entity.zombie.death"),
            Some(MarkerVisualSubject {
                kind: MarkerVisualKind::Entity,
                id: "zombie".to_string(),
            })
        );
        assert_eq!(
            marker_visual_subject("item.crossbow.shoot"),
            Some(MarkerVisualSubject {
                kind: MarkerVisualKind::Item,
                id: "crossbow".to_string(),
            })
        );
        assert_eq!(
            marker_visual_subject("item.armor.equip_diamond"),
            Some(MarkerVisualSubject {
                kind: MarkerVisualKind::Item,
                id: "diamond_chestplate".to_string(),
            })
        );
        assert_eq!(
            marker_visual_subject("item.nautilus_saddle_equip"),
            Some(MarkerVisualSubject {
                kind: MarkerVisualKind::Item,
                id: "nautilus_saddle_equip".to_string(),
            })
        );
        assert_eq!(marker_visual_subject("entity.generic.hurt"), None);
        assert_eq!(marker_visual_subject("music.overworld.jungle"), None);
    }

    #[test]
    fn marker_visuals_resolve_aliases_and_fallbacks() {
        let names = vec![
            "assets/minecraft/textures/block/grass_block_top.png".to_string(),
            "assets/minecraft/textures/entity/zombie/zombie.png".to_string(),
            "assets/minecraft/textures/item/crossbow_standby.png".to_string(),
            "assets/minecraft/textures/entity/shield/shield_base_nopattern.png".to_string(),
            "assets/minecraft/textures/entity/equipment/nautilus_saddle/saddle.png".to_string(),
        ];
        assert_eq!(
            marker_texture_path(
                &names,
                &MarkerVisualSubject {
                    kind: MarkerVisualKind::Block,
                    id: "grass".to_string(),
                }
            ),
            Some("assets/minecraft/textures/block/grass_block_top.png".to_string())
        );
        assert_eq!(
            marker_texture_path(
                &names,
                &MarkerVisualSubject {
                    kind: MarkerVisualKind::Entity,
                    id: "zombie".to_string(),
                }
            ),
            Some("assets/minecraft/textures/entity/zombie/zombie.png".to_string())
        );
        assert_eq!(
            marker_texture_path(
                &names,
                &MarkerVisualSubject {
                    kind: MarkerVisualKind::Item,
                    id: "crossbow".to_string(),
                }
            ),
            Some("assets/minecraft/textures/item/crossbow_standby.png".to_string())
        );
        assert_eq!(
            marker_texture_path(
                &names,
                &MarkerVisualSubject {
                    kind: MarkerVisualKind::Item,
                    id: "shield".to_string(),
                }
            ),
            Some("assets/minecraft/textures/entity/shield/shield_base_nopattern.png".to_string())
        );
        assert_eq!(
            marker_texture_path(
                &names,
                &MarkerVisualSubject {
                    kind: MarkerVisualKind::Item,
                    id: "nautilus_saddle_equip".to_string(),
                }
            ),
            Some(
                "assets/minecraft/textures/entity/equipment/nautilus_saddle/saddle.png".to_string()
            )
        );
        assert_eq!(
            marker_texture_path(
                &names,
                &MarkerVisualSubject {
                    kind: MarkerVisualKind::Block,
                    id: "missing".to_string(),
                }
            ),
            None
        );
    }

    #[test]
    fn marker_visuals_are_loaded_from_client_archive() {
        let archive_path = std::env::temp_dir().join(format!(
            "knead-marker-icons-{}-{}.jar",
            std::process::id(),
            DOWNLOAD_TEMP_COUNTER.fetch_add(1, Ordering::Relaxed)
        ));
        let file = fs::File::create(&archive_path).expect("archive should be created");
        let mut archive = zip::ZipWriter::new(file);
        archive
            .start_file(
                "assets/minecraft/textures/block/stone.png",
                zip::write::SimpleFileOptions::default()
                    .compression_method(zip::CompressionMethod::Stored),
            )
            .expect("texture entry should start");
        let mut png_header = vec![0; 24];
        png_header[..8].copy_from_slice(b"\x89PNG\r\n\x1a\n");
        png_header[16..20].copy_from_slice(&16_u32.to_be_bytes());
        png_header[20..24].copy_from_slice(&16_u32.to_be_bytes());
        archive
            .write_all(&png_header)
            .expect("texture should be written");
        archive
            .start_file(
                "assets/minecraft/textures/item/bucket.png",
                zip::write::SimpleFileOptions::default()
                    .compression_method(zip::CompressionMethod::Stored),
            )
            .expect("item texture entry should start");
        archive
            .write_all(&png_header)
            .expect("item texture should be written");
        archive.finish().expect("archive should finish");

        let icons = load_marker_icons(
            &archive_path,
            &[
                "block.stone.break".to_string(),
                "item.bucket.fill".to_string(),
            ],
        )
        .expect("icons should load");
        let icon = icons
            .get("block.stone.break")
            .expect("stone icon should resolve");
        assert_eq!(icon.kind, "block");
        assert_eq!((icon.crop_width, icon.crop_height), (16, 16));
        assert!(icon.data_url.starts_with("data:image/png;base64,"));
        let item_icon = icons
            .get("item.bucket.fill")
            .expect("bucket icon should resolve");
        assert_eq!(item_icon.kind, "item");
        assert_eq!((item_icon.crop_width, item_icon.crop_height), (16, 16));

        fs::remove_file(archive_path).expect("archive should be removed");
    }

    #[test]
    fn minecraft_version_cannot_escape_the_cache_directory() {
        assert!(validate_version("1.21.8").is_ok());
        assert!(validate_version("26.3-snapshot-4").is_ok());
        assert!(validate_version("../assets").is_err());
        assert!(validate_version("folder\\version").is_err());
    }

    #[test]
    fn studio_song_extensions_are_case_insensitive_and_strict() {
        assert!(is_studio_song_path(Path::new("project.kp")));
        assert!(is_studio_song_path(Path::new("PROJECT.KP")));
        assert!(is_studio_song_path(Path::new("song.nbs")));
        assert!(is_studio_song_path(Path::new("SONG.NBS")));
        assert!(!is_studio_song_path(Path::new("project.json")));
        assert!(!is_studio_song_path(Path::new("project.kp.json")));
        assert!(!is_studio_song_path(Path::new("song.nbs.zip")));
    }

    #[test]
    fn command_export_rejects_zip_slip_paths() {
        assert!(valid_zip_entry("data/knead/function/start.mcfunction"));
        assert!(!valid_zip_entry("../escape.mcfunction"));
        assert!(!valid_zip_entry("/absolute.mcfunction"));
        assert!(!valid_zip_entry("data\\escape.mcfunction"));
        assert!(!valid_zip_entry("data//escape.mcfunction"));
        assert!(!valid_zip_entry("data/escape.mcfunction\0"));
        assert!(!valid_zip_entry("data/C:/escape.mcfunction"));
        assert!(!valid_zip_entry("data/%2e%2e/escape.mcfunction"));
    }

    #[test]
    fn command_export_payload_is_backward_compatible_and_binary_safe() {
        let legacy_request: CommandExportRequest = serde_json::from_value(json!({
            "defaultName": "legacy.zip",
            "files": { "README.txt": "legacy text" }
        }))
        .expect("legacy text-only request should deserialize");
        assert_eq!(legacy_request.kind, CommandExportKind::DataPack);

        let files: HashMap<String, CommandExportFilePayload> = serde_json::from_value(json!({
            "README.txt": "hello",
            "assets/knead/sample.bin": { "encoding": "base64", "data": "AAEC/w==" }
        }))
        .expect("mixed command export payload should deserialize");
        let decoded = decode_command_export_files_with_limits(files, 16, 32)
            .expect("mixed payload should validate");
        assert_eq!(decoded[0].0, "README.txt");
        assert_eq!(decoded[0].1, b"hello");
        assert_eq!(decoded[1].0, "assets/knead/sample.bin");
        assert_eq!(decoded[1].1, vec![0, 1, 2, 255]);

        let zip = build_command_export_zip(decoded).expect("ZIP should be encoded");
        let mut archive = zip::ZipArchive::new(Cursor::new(zip)).expect("ZIP should reopen");
        let mut binary = Vec::new();
        archive
            .by_name("assets/knead/sample.bin")
            .expect("binary entry should exist")
            .read_to_end(&mut binary)
            .expect("binary entry should read");
        assert_eq!(binary, vec![0, 1, 2, 255]);
    }

    #[test]
    fn command_export_payload_enforces_per_file_total_and_encoding_budgets() {
        let oversized: HashMap<String, CommandExportFilePayload> =
            serde_json::from_value(json!({ "large.txt": "12345" })).unwrap();
        assert!(decode_command_export_files_with_limits(oversized, 4, 16)
            .unwrap_err()
            .contains("per-file"));

        let over_total: HashMap<String, CommandExportFilePayload> = serde_json::from_value(json!({
            "first.txt": "123",
            "second.txt": "456"
        }))
        .unwrap();
        assert!(decode_command_export_files_with_limits(over_total, 4, 5)
            .unwrap_err()
            .contains("total"));

        let invalid_encoding: HashMap<String, CommandExportFilePayload> =
            serde_json::from_value(json!({ "sample.bin": { "encoding": "hex", "data": "00" } }))
                .unwrap();
        assert!(
            decode_command_export_files_with_limits(invalid_encoding, 4, 8)
                .unwrap_err()
                .contains("Unsupported")
        );

        let invalid_base64: HashMap<String, CommandExportFilePayload> = serde_json::from_value(
            json!({ "sample.bin": { "encoding": "base64", "data": "%%%=" } }),
        )
        .unwrap();
        assert!(
            decode_command_export_files_with_limits(invalid_base64, 4, 8)
                .unwrap_err()
                .contains("Invalid base64")
        );
    }

    #[test]
    fn project_path_is_found_in_file_association_arguments() {
        let root = std::env::temp_dir().join(format!(
            "knead-project-args-test-{}-{}",
            std::process::id(),
            DOWNLOAD_TEMP_COUNTER.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&root).expect("test directory should be created");
        let project = root.join("example.kp");
        fs::write(&project, "{}").expect("test project should be written");
        let args = vec!["knead".to_string(), "example.kp".to_string()];

        assert_eq!(
            project_path_from_args(&args, &root),
            Some(project.canonicalize().expect("project should resolve"))
        );

        fs::remove_dir_all(&root).expect("test directory should be removed");
    }

    #[test]
    fn project_paths_collect_all_unique_file_association_arguments() {
        let root = std::env::temp_dir().join(format!(
            "knead-project-args-batch-test-{}-{}",
            std::process::id(),
            DOWNLOAD_TEMP_COUNTER.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&root).expect("test directory should be created");
        let first = root.join("first.kp");
        let second = root.join("second.NBS");
        fs::write(&first, "{}").expect("first project should be written");
        fs::write(&second, "{}").expect("second project should be written");
        let args = vec![
            "knead".to_string(),
            "first.kp".to_string(),
            "ignore.txt".to_string(),
            second.to_string_lossy().into_owned(),
            first.to_string_lossy().into_owned(),
        ];

        assert_eq!(
            project_paths_from_args(&args, &root),
            vec![
                first.canonicalize().expect("first project should resolve"),
                second
                    .canonicalize()
                    .expect("second project should resolve"),
            ]
        );

        fs::remove_dir_all(&root).expect("test directory should be removed");
    }

    #[test]
    fn timeline_document_ids_are_strictly_validated() {
        assert!(validate_timeline_document_id("86a73463-b033-4893-82de-b55f5375d62e").is_ok());
        assert!(validate_timeline_document_id("song_42").is_ok());
        assert!(validate_timeline_document_id("").is_err());
        assert!(validate_timeline_document_id("../other-tab").is_err());
        assert!(validate_timeline_document_id("with whitespace").is_err());
        assert!(
            validate_timeline_document_id(&"a".repeat(MAX_TIMELINE_DOCUMENT_ID_BYTES + 1)).is_err()
        );
    }

    #[test]
    fn timeline_save_paths_are_canonical_and_kind_checked() {
        let root = std::env::temp_dir().join(format!(
            "knead-project-save-path-test-{}-{}",
            std::process::id(),
            DOWNLOAD_TEMP_COUNTER.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&root).expect("test directory should be created");
        let canonical_root = root.canonicalize().expect("test directory should resolve");

        assert_eq!(
            canonical_timeline_save_path(root.join("untitled"), StudioSongFileKind::Kp)
                .expect("missing extension should be supplied"),
            canonical_root.join("untitled.kp")
        );
        assert_eq!(
            canonical_timeline_save_path(root.join("song"), StudioSongFileKind::Nbs)
                .expect("NBS extension should be supplied"),
            canonical_root.join("song.nbs")
        );
        assert!(
            canonical_timeline_save_path(root.join("untitled.json"), StudioSongFileKind::Kp)
                .is_err()
        );
        assert!(
            canonical_timeline_save_path(root.join("wrong.kp"), StudioSongFileKind::Nbs).is_err()
        );

        fs::remove_dir_all(&root).expect("test directory should be removed");
    }

    #[test]
    fn timeline_path_bindings_reject_cross_document_conflicts_and_release_cleanly() {
        let path = PathBuf::from("C:/projects/song.kp");
        let mut bindings = HashMap::new();
        bind_timeline_path(&mut bindings, "sub", "document-a", path.clone())
            .expect("first document should bind");

        assert!(bind_timeline_path(&mut bindings, "sub", "document-b", path.clone()).is_err());
        assert!(
            bind_timeline_path(&mut bindings, "other-window", "document-b", path.clone()).is_err()
        );
        bind_timeline_path(&mut bindings, "sub", "document-a", path.clone())
            .expect("the existing owner may rebind its canonical path");
        release_timeline_path(&mut bindings, "sub", "document-a").expect("binding should release");
        bind_timeline_path(&mut bindings, "sub", "document-b", path)
            .expect("released path should be reusable");
    }

    #[test]
    fn plain_nbs_audio_lookup_requires_the_callers_bound_nbs_document() {
        let mut bindings = HashMap::new();
        bindings.insert(
            ("sub".to_string(), "nbs-document".to_string()),
            PathBuf::from("C:/projects/song.nbs"),
        );
        bindings.insert(
            ("sub".to_string(), "kp-document".to_string()),
            PathBuf::from("C:/projects/song.kp"),
        );
        assert_eq!(
            bound_timeline_nbs_path(&bindings, "sub", "nbs-document"),
            Ok(PathBuf::from("C:/projects/song.nbs"))
        );
        assert!(bound_timeline_nbs_path(&bindings, "sub", "missing").is_err());
        assert!(bound_timeline_nbs_path(&bindings, "other", "nbs-document").is_err());
        assert!(bound_timeline_nbs_path(&bindings, "sub", "kp-document").is_err());
        assert!(bound_timeline_nbs_path(&bindings, "sub", "../nbs-document").is_err());
    }

    #[test]
    fn timeline_open_queue_is_deduplicated_and_bounded() {
        let mut pending = VecDeque::new();
        let duplicate = PathBuf::from("duplicate.kp");
        assert_eq!(
            enqueue_timeline_paths(
                &mut pending,
                [duplicate.clone(), duplicate, PathBuf::from("other.kp")],
            ),
            2
        );
        pending.clear();
        let paths: Vec<_> = (0..(MAX_PENDING_TIMELINE_PATHS + 8))
            .map(|index| PathBuf::from(format!("song-{index}.kp")))
            .collect();

        assert_eq!(
            enqueue_timeline_paths(&mut pending, paths.clone()),
            MAX_PENDING_TIMELINE_PATHS
        );
        assert_eq!(pending.len(), MAX_PENDING_TIMELINE_PATHS);
        assert_eq!(enqueue_timeline_paths(&mut pending, paths), 0);
    }

    #[test]
    fn timeline_close_mode_and_caller_are_validated() {
        assert_eq!(
            TimelineCloseMode::parse("hide"),
            Ok(TimelineCloseMode::Hide)
        );
        assert_eq!(
            TimelineCloseMode::parse("exit"),
            Ok(TimelineCloseMode::Exit)
        );
        assert!(TimelineCloseMode::parse("close").is_err());
        assert!(validate_timeline_window_label("sub").is_ok());
        assert!(validate_timeline_window_label("main").is_err());
        assert!(validate_timeline_window_label("../../sub").is_err());
    }

    #[test]
    fn timeline_path_reader_returns_project_contents() {
        let root = std::env::temp_dir().join(format!(
            "knead-project-read-test-{}-{}",
            std::process::id(),
            DOWNLOAD_TEMP_COUNTER.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&root).expect("test directory should be created");
        let project = root.join("example.kp");
        fs::write(&project, "{\"format\":\"knead-project\"}")
            .expect("test project should be written");

        let result = read_timeline_path(project);
        assert_eq!(result.get("ok").and_then(Value::as_bool), Some(true));
        assert_eq!(result.get("kind").and_then(Value::as_str), Some("kp"));
        assert_eq!(
            result.get("json").and_then(Value::as_str),
            Some("{\"format\":\"knead-project\"}")
        );

        fs::remove_dir_all(&root).expect("test directory should be removed");
    }

    #[test]
    fn timeline_path_reader_returns_binary_nbs_without_utf8_conversion() {
        let root = std::env::temp_dir().join(format!(
            "knead-nbs-read-test-{}-{}",
            std::process::id(),
            DOWNLOAD_TEMP_COUNTER.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&root).expect("test directory should be created");
        let song = root.join("example.nbs");
        let bytes = [0, 0, 5, 16, 0xff, 0x80];
        fs::write(&song, bytes).expect("test NBS should be written");

        let result = read_timeline_path(song);
        let expected_base64 = BASE64_STANDARD.encode(bytes);
        assert_eq!(result.get("ok").and_then(Value::as_bool), Some(true));
        assert_eq!(result.get("kind").and_then(Value::as_str), Some("nbs"));
        assert_eq!(
            result.get("dataBase64").and_then(Value::as_str),
            Some(expected_base64.as_str())
        );

        fs::remove_dir_all(&root).expect("test directory should be removed");
    }

    fn plain_nbs_audio_test_directory(label: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!(
            "knead-plain-nbs-audio-{label}-{}-{}",
            std::process::id(),
            DOWNLOAD_TEMP_COUNTER.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&root).expect("test directory should be created");
        fs::write(root.join("song.nbs"), [0_u8, 0, 5, 16]).expect("test NBS should be created");
        root
    }

    fn test_ogg(seed: u8) -> Vec<u8> {
        vec![b'O', b'g', b'g', b'S', seed, seed, seed, seed]
    }

    #[test]
    fn plain_nbs_audio_names_reject_traversal_absolute_drives_and_non_audio() {
        assert!(normalize_plain_nbs_audio_name("kit/lead.ogg").is_ok());
        assert!(normalize_plain_nbs_audio_name("kit\\lead.WAV").is_ok());
        for unsafe_name in [
            "../escape.ogg",
            "kit/../../escape.wav",
            "/absolute.ogg",
            "\\\\server\\share.wav",
            "C:\\escape.ogg",
            "kit//lead.ogg",
            "kit/lead.mp3",
            "kit/NUL.wav",
        ] {
            assert!(
                normalize_plain_nbs_audio_name(unsafe_name).is_err(),
                "unsafe name should fail: {unsafe_name}"
            );
        }
        assert!(normalize_plain_nbs_audio_name(&format!(
            "{}.ogg",
            "a".repeat(MAX_PLAIN_NBS_CUSTOM_AUDIO_NAME_BYTES)
        ))
        .is_err());
    }

    #[test]
    fn plain_nbs_audio_resolution_checks_magic_and_per_file_and_total_budgets() {
        let root = plain_nbs_audio_test_directory("budgets");
        let sounds = root.join("Sounds/kit");
        fs::create_dir_all(&sounds).expect("sounds directory should be created");
        fs::write(sounds.join("first.ogg"), test_ogg(1)).expect("first sound should be written");
        fs::write(sounds.join("second.ogg"), test_ogg(2)).expect("second sound should be written");
        fs::write(sounds.join("fake.wav"), test_ogg(3)).expect("fake WAV should be written");
        let song = root
            .join("song.nbs")
            .canonicalize()
            .expect("song should resolve");

        let resolved = resolve_plain_nbs_custom_audio_with_limits(
            &song,
            vec!["kit/first.ogg".to_string(), "kit/fake.wav".to_string()],
            16,
            32,
        )
        .expect("optional sound failures should stay nonfatal");
        assert_eq!(resolved.assets.len(), 1);
        assert_eq!(resolved.assets[0].file_name, "kit/first.ogg");
        assert_eq!(resolved.assets[0].byte_length, 8);
        assert_eq!(resolved.assets[0].mime_type, "audio/ogg");
        assert_eq!(resolved.warnings.len(), 1);
        assert!(resolved
            .warnings
            .iter()
            .any(|warning| warning.contains("signature")));

        let aggregate = resolve_plain_nbs_custom_audio_with_limits(
            &song,
            vec!["kit/first.ogg".to_string(), "kit/second.ogg".to_string()],
            16,
            12,
        )
        .expect("aggregate overflow should stay nonfatal");
        assert_eq!(aggregate.assets.len(), 1);
        assert!(aggregate.warnings[0].contains("96 MiB"));

        let per_file = resolve_plain_nbs_custom_audio_with_limits(
            &song,
            vec!["kit/first.ogg".to_string()],
            7,
            64,
        )
        .expect("oversized optional sounds should stay nonfatal");
        assert!(per_file.assets.is_empty());
        assert!(per_file.warnings[0].contains("32 MiB"));
        fs::remove_dir_all(&root).expect("test directory should be removed");
    }

    #[cfg(unix)]
    #[test]
    fn plain_nbs_audio_resolution_rejects_symlink_escape() {
        use std::os::unix::fs::symlink;

        let root = plain_nbs_audio_test_directory("symlink");
        let outside = plain_nbs_audio_test_directory("outside");
        fs::write(outside.join("escape.ogg"), test_ogg(4))
            .expect("outside sound should be written");
        symlink(&outside, root.join("Sounds")).expect("directory symlink should be created");
        let song = root
            .join("song.nbs")
            .canonicalize()
            .expect("song should resolve");
        let resolved = resolve_plain_nbs_custom_audio_with_limits(
            &song,
            vec!["escape.ogg".to_string()],
            16,
            32,
        )
        .expect("unsafe optional sound should become a warning");
        assert!(resolved.assets.is_empty());
        assert!(resolved.warnings[0].contains("symlink or reparse point"));
        fs::remove_dir_all(&root).expect("test directory should be removed");
        fs::remove_dir_all(&outside).expect("outside directory should be removed");
    }

    #[test]
    fn plain_nbs_audio_reader_detects_path_replacement_after_open() {
        let root = plain_nbs_audio_test_directory("toctou");
        fs::create_dir_all(root.join("Sounds")).expect("sounds directory should be created");
        let sound = root.join("Sounds/swap.ogg");
        fs::write(&sound, test_ogg(5)).expect("sound should be written");
        let replaced = root.join("Sounds/original.ogg");
        let error = read_plain_nbs_audio_candidate_with_hook(
            &root.canonicalize().expect("root should resolve"),
            Path::new("Sounds/swap.ogg"),
            16,
            32,
            |_| {
                fs::rename(&sound, &replaced).expect("opened sound should be renamed");
                fs::write(&sound, test_ogg(6)).expect("replacement should be written");
            },
        )
        .expect_err("path replacement must be detected");
        assert!(error.contains("changed"));
        fs::remove_dir_all(&root).expect("test directory should be removed");
    }

    #[test]
    fn timeline_write_payload_enforces_utf8_and_base64_budgets() {
        let utf8 = TimelineWritePayload {
            kind: "kp".to_string(),
            data: Some("éé".to_string()),
            data_base64: None,
        };
        assert!(decode_timeline_write_payload_with_limits(utf8, 3, 16).is_err());

        let encoded = BASE64_STANDARD.encode([1_u8, 2, 3, 4]);
        let decoded_too_large = TimelineWritePayload {
            kind: "nbs".to_string(),
            data: None,
            data_base64: Some(encoded),
        };
        assert!(decode_timeline_write_payload_with_limits(decoded_too_large, 16, 3).is_err());

        let amplified_before_decode = TimelineWritePayload {
            kind: "nbs".to_string(),
            data: None,
            data_base64: Some("A".repeat(9)),
        };
        assert!(decode_timeline_write_payload_with_limits(amplified_before_decode, 16, 3).is_err());
    }

    #[test]
    fn timeline_path_reader_rejects_oversized_projects_before_reading() {
        let root = std::env::temp_dir().join(format!(
            "knead-project-budget-test-{}-{}",
            std::process::id(),
            DOWNLOAD_TEMP_COUNTER.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&root).expect("test directory should be created");
        let project = root.join("oversized.kp");
        let file = fs::File::create(&project).expect("test project should be created");
        file.set_len(MAX_TIMELINE_PROJECT_BYTES + 1)
            .expect("test project should be expanded");

        let result = read_timeline_path(project);
        assert_eq!(result.get("ok").and_then(Value::as_bool), Some(false));
        assert!(result
            .get("error")
            .and_then(Value::as_str)
            .is_some_and(|error| error.contains("144 MiB")));

        fs::remove_dir_all(&root).expect("test directory should be removed");
    }

    #[test]
    fn timeline_path_reader_enforces_the_smaller_nbs_budget() {
        let root = std::env::temp_dir().join(format!(
            "knead-nbs-budget-test-{}-{}",
            std::process::id(),
            DOWNLOAD_TEMP_COUNTER.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&root).expect("test directory should be created");
        let song = root.join("oversized.nbs");
        let file = fs::File::create(&song).expect("test NBS should be created");
        file.set_len(MAX_STUDIO_NBS_BYTES + 1)
            .expect("test NBS should be expanded");

        let result = read_timeline_path(song);
        assert_eq!(result.get("ok").and_then(Value::as_bool), Some(false));
        assert!(result
            .get("error")
            .and_then(Value::as_str)
            .is_some_and(|error| error.contains("16 MiB")));

        fs::remove_dir_all(&root).expect("test directory should be removed");
    }

    #[test]
    fn user_file_writer_replaces_existing_content_without_partial_files() {
        let root = std::env::temp_dir().join(format!(
            "knead-safe-save-test-{}-{}",
            std::process::id(),
            DOWNLOAD_TEMP_COUNTER.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&root).expect("test directory should be created");
        let path = root.join("song.nbs");
        fs::write(&path, b"old").expect("initial file should be written");

        write_user_file_safely(&path, b"complete replacement")
            .expect("safe replacement should succeed");

        assert_eq!(
            fs::read(&path).expect("saved file should be readable"),
            b"complete replacement"
        );
        assert_eq!(
            fs::read_dir(&root)
                .expect("test directory should be readable")
                .count(),
            1
        );
        fs::remove_dir_all(&root).expect("test directory should be removed");
    }

    #[test]
    fn downloaded_version_supports_legacy_cache_and_completion_marker() {
        let root = std::env::temp_dir().join(format!(
            "knead-assets-test-{}-{}",
            std::process::id(),
            DOWNLOAD_TEMP_COUNTER.fetch_add(1, Ordering::Relaxed)
        ));
        let version = "test-version";
        let hash = "d".repeat(40);
        let metadata_path = version_json_path(&root, version);
        let index_path = asset_index_path(&root, "test-index");
        fs::create_dir_all(
            metadata_path
                .parent()
                .expect("metadata parent should exist"),
        )
        .expect("metadata directory should be created");
        fs::create_dir_all(index_path.parent().expect("index parent should exist"))
            .expect("index directory should be created");
        fs::write(
            &metadata_path,
            serde_json::to_vec(&json!({
                "assetIndex": {
                    "id": "test-index",
                    "url": "https://example.invalid/index.json",
                    "sha1": "0".repeat(40)
                }
            }))
            .expect("metadata should serialize"),
        )
        .expect("metadata should be written");
        fs::write(
            &index_path,
            serde_json::to_vec(&json!({
                "objects": {
                    "minecraft/sounds.json": { "hash": hash.clone(), "size": 4 }
                }
            }))
            .expect("index should serialize"),
        )
        .expect("index should be written");

        assert!(!is_version_downloaded(&root, version));
        let object_path = root.join("assets/objects").join(&hash[..2]).join(&hash);
        fs::create_dir_all(object_path.parent().expect("object parent should exist"))
            .expect("object directory should be created");
        fs::write(&object_path, [0_u8; 4]).expect("object should be written");
        assert!(is_version_downloaded(&root, version));
        fs::remove_file(&object_path).expect("legacy object should be removed");
        assert!(!is_version_downloaded(&root, version));
        mark_version_downloaded(&root, version).expect("completion marker should be written");
        assert!(is_version_downloaded(&root, version));

        fs::remove_dir_all(&root).expect("test cache should be removed");
    }

    fn recovery_test_directory(label: &str) -> PathBuf {
        let directory = std::env::temp_dir().join(format!(
            "knead-recovery-{label}-{}-{}",
            std::process::id(),
            DOWNLOAD_TEMP_COUNTER.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&directory).expect("recovery test directory should be created");
        directory
    }

    fn recovery_project(project_id: &str) -> String {
        serde_json::to_string(&json!({
            "format": "knead-project",
            "version": 5,
            "projectId": project_id,
        }))
        .expect("recovery project should serialize")
    }

    #[test]
    fn recovery_snapshot_round_trips_and_ignores_stale_writes() {
        let directory = recovery_test_directory("round-trip");
        let now = 1_800_000_000_000_u64;
        let initial = recovery_project("project-a");
        let metadata = write_recovery_snapshot_in_directory(
            &directory,
            "project-a",
            Some("C:\\Music\\song.kp".to_string()),
            now,
            &initial,
            now,
        )
        .expect("snapshot should be written");
        assert!(is_recovery_snapshot_id(&metadata.id));
        assert_eq!(metadata.fingerprint, sha1_hex(initial.as_bytes()));

        let stale = recovery_project("project-a").replace("\"version\":5", "\"version\":4");
        let retained = write_recovery_snapshot_in_directory(
            &directory,
            "project-a",
            None,
            now - 1,
            &stale,
            now,
        )
        .expect("stale save should return the current snapshot");
        assert_eq!(retained, metadata);

        let path = recovery_snapshot_path(&directory, &metadata.id).expect("path should resolve");
        let (restored, contents) =
            read_recovery_snapshot_file(&path, now).expect("snapshot should restore");
        assert_eq!(restored, metadata);
        assert_eq!(contents, initial);
        assert_eq!(
            fs::read_dir(&directory)
                .expect("directory should be readable")
                .count(),
            1
        );

        fs::remove_dir_all(&directory).expect("test directory should be removed");
    }

    #[test]
    fn recovery_cleanup_rejects_corrupt_expired_and_oversized_files() {
        let directory = recovery_test_directory("cleanup");
        let now = 1_800_000_000_000_u64;

        let expired_at = now - RECOVERY_TTL_MS - 1;
        let expired = write_recovery_snapshot_in_directory(
            &directory,
            "expired-project",
            None,
            expired_at,
            &recovery_project("expired-project"),
            expired_at,
        )
        .expect("expired fixture should be written relative to its original clock");

        let corrupt_id = recovery_snapshot_id("corrupt-project").expect("ID should be derived");
        fs::write(
            recovery_snapshot_path(&directory, &corrupt_id).expect("path should resolve"),
            b"not a recovery snapshot",
        )
        .expect("corrupt fixture should be written");

        let oversized_id = recovery_snapshot_id("oversized-project").expect("ID should be derived");
        let oversized_path =
            recovery_snapshot_path(&directory, &oversized_id).expect("path should resolve");
        let oversized =
            fs::File::create(&oversized_path).expect("oversized fixture should be created");
        oversized
            .set_len(MAX_RECOVERY_FILE_BYTES + 1)
            .expect("oversized fixture should be expanded");

        let snapshots =
            list_recovery_snapshots_in_directory(&directory, now).expect("cleanup should complete");
        assert!(snapshots.is_empty());
        assert!(!recovery_snapshot_path(&directory, &expired.id)
            .expect("path should resolve")
            .exists());
        assert!(!oversized_path.exists());
        assert!(!recovery_snapshot_path(&directory, &corrupt_id)
            .expect("path should resolve")
            .exists());

        fs::remove_dir_all(&directory).expect("test directory should be removed");
    }

    #[test]
    fn recovery_snapshot_count_is_bounded_and_ids_cannot_traverse() {
        let directory = recovery_test_directory("budget");
        let now = 1_800_000_000_000_u64;
        for index in 0..(MAX_RECOVERY_SNAPSHOTS + 3) {
            let project_id = format!("project-{index}");
            write_recovery_snapshot_in_directory(
                &directory,
                &project_id,
                None,
                now - 100 + index as u64,
                &recovery_project(&project_id),
                now,
            )
            .expect("snapshot should be written");
        }
        let snapshots =
            list_recovery_snapshots_in_directory(&directory, now).expect("snapshots should list");
        assert_eq!(snapshots.len(), MAX_RECOVERY_SNAPSHOTS);
        assert_eq!(
            fs::read_dir(&directory)
                .expect("directory should be readable")
                .count(),
            MAX_RECOVERY_SNAPSHOTS
        );
        assert!(recovery_snapshot_path(&directory, "../../escape").is_err());
        assert!(discard_recovery_snapshot_in_directory(&directory, "..\\escape").is_err());

        fs::remove_dir_all(&directory).expect("test directory should be removed");
    }

    fn note_block_test_tag(bytes: &mut Vec<u8>, tag: u8, name: &str) {
        bytes.push(tag);
        bytes.extend_from_slice(&(name.len() as u16).to_be_bytes());
        bytes.extend_from_slice(name.as_bytes());
    }

    fn note_block_test_modern_nbt() -> Vec<u8> {
        let mut nbt = vec![10, 0, 0];
        note_block_test_tag(&mut nbt, 3, "DataVersion");
        nbt.extend_from_slice(&1519_i32.to_be_bytes());
        note_block_test_tag(&mut nbt, 9, "size");
        nbt.push(3);
        nbt.extend_from_slice(&3_i32.to_be_bytes());
        for value in [1_i32, 2, 3] {
            nbt.extend_from_slice(&value.to_be_bytes());
        }
        for name in ["palette", "blocks", "entities"] {
            note_block_test_tag(&mut nbt, 9, name);
            nbt.push(10);
            nbt.extend_from_slice(&0_i32.to_be_bytes());
        }
        nbt.push(0);
        nbt
    }

    fn note_block_test_gzip(data: &[u8]) -> Vec<u8> {
        let mut encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
        encoder.write_all(data).expect("fixture should compress");
        encoder.finish().expect("fixture should finish")
    }

    #[test]
    fn note_block_build_formats_and_payloads_are_strictly_validated() {
        assert_eq!(
            note_block_build_extension("structure-block-nbt"),
            Some("nbt")
        );
        assert_eq!(
            note_block_build_extension("litematica-compatible-nbt"),
            Some("nbt")
        );
        assert_eq!(
            note_block_build_extension("schematic-1.11-1.12"),
            Some("schematic")
        );
        assert_eq!(
            note_block_build_extension("schematic-pre-1.11"),
            Some("schematic")
        );
        assert_eq!(note_block_build_extension("native-litematic"), None);
        assert_eq!(note_block_build_extension("../../escape"), None);

        let valid_gzip = note_block_test_gzip(&note_block_test_modern_nbt());
        assert_eq!(
            validate_note_block_build_data("structure-block-nbt", &valid_gzip),
            Ok("nbt")
        );
        assert_eq!(
            validate_note_block_build_data("native-litematic", &valid_gzip),
            Err("Unsupported note-block build format".to_string())
        );
        assert_eq!(
            validate_note_block_build_data("schematic-1.11-1.12", &valid_gzip),
            Err("Note-block build NBT root does not match the selected format".to_string())
        );
        assert_eq!(
            validate_note_block_build_data("schematic-pre-1.11", &[]),
            Err("Invalid note-block build data size".to_string())
        );

        let fake_gzip = [
            0x1f, 0x8b, 0x08, 0, 0, 0, 0, 0, 0, 0xff, 0, 0, 0, 0, 0, 0, 0, 0,
        ];
        assert_eq!(
            validate_note_block_build_data("structure-block-nbt", &fake_gzip),
            Err("Note-block build GZIP payload or CRC is invalid".to_string())
        );
        let mut corrupt_crc = valid_gzip.clone();
        *corrupt_crc.last_mut().expect("fixture has trailer") ^= 1;
        assert_eq!(
            validate_note_block_build_data("structure-block-nbt", &corrupt_crc),
            Err("Note-block build GZIP payload or CRC is invalid".to_string())
        );
        let missing_schema = note_block_test_gzip(&[10, 0, 0, 0]);
        assert_eq!(
            validate_note_block_build_data("structure-block-nbt", &missing_schema),
            Err("Missing required note-block build NBT tag: DataVersion".to_string())
        );
    }
}
