//! Versioned, streaming Caevir portable packages.
//!
//! The frontend only selects inputs/outputs and renders progress. All format,
//! validation, staging, hashing, conflict and SQLite work lives in this module.

use blake3::Hasher;
use rusqlite::{params, Connection, OptionalExtension, Transaction};
use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, HashSet},
    fs::{self, File, OpenOptions},
    io::{self, Read, Write},
    path::{Component, Path, PathBuf},
    sync::{
        atomic::{AtomicU64, Ordering},
        Mutex, OnceLock,
    },
};
use tauri::{ipc::Channel, AppHandle, Manager};
use zip::{write::SimpleFileOptions, CompressionMethod, ZipArchive, ZipWriter};

use super::{asset_kind, indexed_directory, normalize_directory_key, now_ms, setup_database};

const SCHEMA_VERSION: &str = "1.0.0";
const ASSET_PACKAGE_TYPE: &str = "caevir.assetPackage";
const PROJECT_PACKAGE_TYPE: &str = "caevir.projectArchive";
const MANIFEST_PATH: &str = "manifest.json";
const MAX_ENTRIES: usize = 100_000;
const MAX_MANIFEST_BYTES: u64 = 16 * 1024 * 1024;
const MAX_FILE_BYTES: u64 = 8 * 1024 * 1024 * 1024;
const MAX_TOTAL_BYTES: u64 = 32 * 1024 * 1024 * 1024;
const MAX_COMPRESSION_RATIO: u64 = 200;
const DISK_HEADROOM_BYTES: u64 = 256 * 1024 * 1024;
static NEXT_OPERATION: AtomicU64 = AtomicU64::new(1);
static CANCELLED_OPERATIONS: OnceLock<Mutex<HashSet<String>>> = OnceLock::new();

fn cancelled_operations() -> &'static Mutex<HashSet<String>> {
    CANCELLED_OPERATIONS.get_or_init(|| Mutex::new(HashSet::new()))
}

fn check_cancelled(operation_id: &str) -> Result<(), String> {
    if cancelled_operations()
        .lock()
        .map_err(|_| "取消状态锁损坏".to_string())?
        .contains(operation_id)
    {
        Err("操作已取消，所有临时文件和数据库变更均已回滚".to_string())
    } else {
        Ok(())
    }
}

fn finish_operation(operation_id: &str) {
    if let Ok(mut cancelled) = cancelled_operations().lock() {
        cancelled.remove(operation_id);
    }
}

#[tauri::command]
pub(crate) fn cancel_package_operation(operation_id: String) -> Result<(), String> {
    cancelled_operations()
        .lock()
        .map_err(|_| "取消状态锁损坏".to_string())?
        .insert(operation_id);
    Ok(())
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct ManifestEntry {
    relative_path: String,
    role: String,
    size: u64,
    blake3: String,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct PortableTagGroup {
    name: String,
    sort_order: i64,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct PortableTag {
    name: String,
    group: PortableTagGroup,
    color: String,
    description: String,
    scopes: Vec<String>,
    archived: bool,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
struct PortableMetadata {
    original_source_method: String,
    original_source_url: String,
    author: String,
    author_status: String,
    chinese_name: String,
    pinyin: String,
    ai_prompt_english: String,
    ai_prompt_chinese: String,
    width: Option<i64>,
    height: Option<i64>,
    duration_ms: Option<i64>,
    audio_sample_rate: Option<i64>,
    audio_bit_depth: Option<i64>,
    audio_channels: Option<i64>,
    audio_codec: Option<String>,
    audio_endianness: Option<String>,
    audio_frame_size: Option<i64>,
    integrated_lufs: Option<f64>,
    true_peak_dbtp: Option<f64>,
    loudness_range_lu: Option<f64>,
    dhash: Option<String>,
    palette: Vec<String>,
    feature_version: Option<i64>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
struct PortableAsset {
    id: String,
    file_name: String,
    logical_directory: String,
    kind: String,
    extension: String,
    modified_at_ms: i64,
    file_path: Option<String>,
    thumbnail_path: Option<String>,
    missing: bool,
    metadata: PortableMetadata,
    tags: Vec<PortableTag>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct PortableProject {
    name: String,
    directories: Vec<String>,
    assets: Vec<ProjectMember>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
struct ProjectMember {
    asset_id: String,
    storage_mode: String,
    relative_directory: String,
    copied_relative_path: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
struct PackageManifest {
    schema_version: String,
    package_type: String,
    created_at: i64,
    app_version: String,
    entries: Vec<ManifestEntry>,
    assets: Vec<PortableAsset>,
    #[serde(skip_serializing_if = "Option::is_none")]
    project: Option<PortableProject>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PackageProgress {
    stage: String,
    completed: u64,
    total: u64,
    current_item: String,
    message: String,
}

#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PackageSummary {
    package_path: String,
    project_id: Option<i64>,
    project_path: Option<String>,
    succeeded: u64,
    reused: u64,
    skipped: u64,
    conflicts: u64,
    failed: u64,
    missing: u64,
    messages: Vec<String>,
}

#[derive(Clone, Debug)]
struct SourceFile {
    path: PathBuf,
    relative_path: String,
    role: String,
    size: u64,
    blake3: String,
}

#[derive(Debug)]
struct ArchiveLimits {
    total_size: u64,
    names: HashSet<String>,
}

fn operation_id(prefix: &str) -> String {
    format!(
        "{prefix}-{}-{}",
        now_ms(),
        NEXT_OPERATION.fetch_add(1, Ordering::Relaxed)
    )
}

fn create_owned_staging(path: &Path, owner: &str) -> Result<(), String> {
    fs::create_dir(path).map_err(|error| format!("无法创建同目录 staging：{error}"))?;
    let marker = path.join(".caevir-import-owner");
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&marker)
        .map_err(|error| error.to_string())?;
    file.write_all(owner.as_bytes())
        .map_err(|error| error.to_string())?;
    file.sync_all().map_err(|error| error.to_string())
}

fn cleanup_owned_directory(path: &Path, owner: &str) {
    if !path.is_dir() || is_reparse_point(path).unwrap_or(true) {
        return;
    }
    let marker = path.join(".caevir-import-owner");
    if fs::read_to_string(marker).ok().as_deref() == Some(owner) {
        let _ = fs::remove_dir_all(path);
    }
}

fn report(
    channel: &Channel<PackageProgress>,
    stage: &str,
    completed: u64,
    total: u64,
    current_item: impl Into<String>,
    message: impl Into<String>,
) {
    let _ = channel.send(PackageProgress {
        stage: stage.to_string(),
        completed,
        total,
        current_item: current_item.into(),
        message: message.into(),
    });
}

fn package_database(app: &AppHandle) -> Result<Connection, String> {
    let app_data = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?;
    fs::create_dir_all(&app_data).map_err(|error| error.to_string())?;
    setup_database(&app_data.join("caevir-index.sqlite3"))
}

fn hash_reader(mut reader: impl Read) -> Result<(String, u64), String> {
    let mut hasher = Hasher::new();
    let mut buffer = [0_u8; 1024 * 1024];
    let mut size = 0_u64;
    loop {
        let read = reader
            .read(&mut buffer)
            .map_err(|error| error.to_string())?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
        size = size
            .checked_add(read as u64)
            .ok_or_else(|| "文件大小溢出".to_string())?;
    }
    Ok((hasher.finalize().to_hex().to_string(), size))
}

fn hash_file(path: &Path) -> Result<(String, u64), String> {
    let file = File::open(path).map_err(|error| format!("无法读取 {}：{error}", path.display()))?;
    hash_reader(file)
}

fn copy_and_hash(reader: &mut impl Read, writer: &mut impl Write) -> Result<(String, u64), String> {
    let mut hasher = Hasher::new();
    let mut buffer = [0_u8; 1024 * 1024];
    let mut size = 0_u64;
    loop {
        let read = reader
            .read(&mut buffer)
            .map_err(|error| error.to_string())?;
        if read == 0 {
            break;
        }
        writer
            .write_all(&buffer[..read])
            .map_err(|error| error.to_string())?;
        hasher.update(&buffer[..read]);
        size = size
            .checked_add(read as u64)
            .ok_or_else(|| "文件大小溢出".to_string())?;
    }
    Ok((hasher.finalize().to_hex().to_string(), size))
}

fn is_reserved_windows_name(value: &str) -> bool {
    let stem = value
        .split('.')
        .next()
        .unwrap_or(value)
        .trim_end_matches([' ', '.'])
        .to_ascii_uppercase();
    matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        || (stem.len() == 4
            && (stem.starts_with("COM") || stem.starts_with("LPT"))
            && matches!(stem.as_bytes()[3], b'1'..=b'9'))
}

fn validate_component(component: &str) -> Result<(), String> {
    if component.is_empty() || component == "." || component == ".." {
        return Err("包路径包含空段或相对跳转".to_string());
    }
    if component.ends_with([' ', '.'])
        || component.chars().any(|character| {
            character.is_control()
                || matches!(
                    character,
                    '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*'
                )
        })
        || is_reserved_windows_name(component)
    {
        return Err(format!("包路径包含 Windows 非法名称：{component}"));
    }
    Ok(())
}

fn sanitize_relative_path(value: &str) -> Result<PathBuf, String> {
    if value.is_empty() || value.starts_with('/') || value.starts_with('\\') {
        return Err("包路径不能为空或为绝对路径".to_string());
    }
    if value.contains('\\') {
        return Err("包路径必须使用正斜杠，不能包含反斜杠".to_string());
    }
    let normalized = value.to_string();
    if normalized.contains('\0') || normalized.len() > 2048 {
        return Err("包路径无效或过长".to_string());
    }
    if normalized.as_bytes().get(1) == Some(&b':') {
        return Err("包路径不得包含盘符".to_string());
    }
    let mut result = PathBuf::new();
    for component in normalized.split('/') {
        validate_component(component)?;
        result.push(component);
    }
    if result.components().any(|component| {
        matches!(
            component,
            Component::Prefix(_) | Component::RootDir | Component::ParentDir | Component::CurDir
        )
    }) {
        return Err("包路径包含路径穿越".to_string());
    }
    Ok(result)
}

fn safe_manifest_path(value: &str) -> Result<String, String> {
    let path = sanitize_relative_path(value)?;
    Ok(path
        .components()
        .map(|part| part.as_os_str().to_string_lossy())
        .collect::<Vec<_>>()
        .join("/"))
}

fn validate_schema(manifest: &PackageManifest, expected_type: &str) -> Result<(), String> {
    let major = manifest
        .schema_version
        .split('.')
        .next()
        .and_then(|value| value.parse::<u64>().ok())
        .ok_or_else(|| "manifest.schemaVersion 无效".to_string())?;
    if major > 1 {
        return Err(format!(
            "此包使用较新的主版本 {}，当前 Caevir 仅支持 1.x",
            manifest.schema_version
        ));
    }
    if major == 0 {
        return Err("不支持 schemaVersion 0.x".to_string());
    }
    if manifest.package_type != expected_type {
        return Err(format!("包类型不匹配：{}", manifest.package_type));
    }
    Ok(())
}

fn validate_archive_headers(archive: &mut ZipArchive<File>) -> Result<ArchiveLimits, String> {
    if archive.len() == 0 || archive.len() > MAX_ENTRIES + 1 {
        return Err(format!("ZIP 条目数超出限制（最多 {}）", MAX_ENTRIES + 1));
    }
    let mut total_size = 0_u64;
    let mut names = HashSet::new();
    let mut folded_names = HashSet::new();
    for index in 0..archive.len() {
        let file = archive.by_index(index).map_err(|error| error.to_string())?;
        let name = safe_manifest_path(file.name())?;
        if !names.insert(name.clone()) {
            return Err(format!("ZIP 包含重复路径：{name}"));
        }
        if !folded_names.insert(name.to_lowercase()) {
            return Err(format!("ZIP 包含 Windows 大小写等价冲突：{name}"));
        }
        if file.is_dir() {
            return Err(format!("ZIP 不允许显式目录条目：{name}"));
        }
        if file.encrypted() {
            return Err(format!("ZIP 不允许加密条目：{name}"));
        }
        if !matches!(
            file.compression(),
            CompressionMethod::Stored | CompressionMethod::Deflated
        ) {
            return Err(format!("ZIP 使用不支持的压缩方法：{name}"));
        }
        if let Some(mode) = file.unix_mode() {
            let kind = mode & 0o170000;
            if kind != 0 && kind != 0o100000 {
                return Err(format!("ZIP 不允许符号链接、设备或其他非普通文件：{name}"));
            }
        }
        let size = file.size();
        if size > MAX_FILE_BYTES || (name == MANIFEST_PATH && size > MAX_MANIFEST_BYTES) {
            return Err(format!("ZIP 条目超过单文件限制：{name}"));
        }
        total_size = total_size
            .checked_add(size)
            .ok_or_else(|| "ZIP 解压大小溢出".to_string())?;
        if total_size > MAX_TOTAL_BYTES {
            return Err("ZIP 总解压大小超过 32 GiB 限制".to_string());
        }
        let compressed = file.compressed_size();
        if size > 1024 * 1024
            && (compressed == 0 || size / compressed.max(1) > MAX_COMPRESSION_RATIO)
        {
            return Err(format!("ZIP 条目压缩比异常：{name}"));
        }
    }
    Ok(ArchiveLimits { total_size, names })
}

fn read_manifest(
    archive: &mut ZipArchive<File>,
    expected_type: &str,
) -> Result<(PackageManifest, ArchiveLimits), String> {
    let limits = validate_archive_headers(archive)?;
    let manifest: PackageManifest = {
        let mut entry = archive
            .by_name(MANIFEST_PATH)
            .map_err(|_| "ZIP 缺少 manifest.json".to_string())?;
        let mut bytes = Vec::with_capacity(entry.size() as usize);
        entry
            .read_to_end(&mut bytes)
            .map_err(|error| format!("无法读取 manifest：{error}"))?;
        serde_json::from_slice(&bytes).map_err(|error| format!("manifest JSON 无效：{error}"))?
    };
    validate_schema(&manifest, expected_type)?;
    if manifest.entries.len() > MAX_ENTRIES {
        return Err("manifest 条目数超出限制".to_string());
    }
    let mut declared = HashSet::new();
    for entry in &manifest.entries {
        let path = safe_manifest_path(&entry.relative_path)?;
        if path == MANIFEST_PATH || !declared.insert(path.clone()) {
            return Err(format!("manifest 包含重复或保留路径：{path}"));
        }
        if entry.size > MAX_FILE_BYTES || entry.blake3.len() != 64 {
            return Err(format!("manifest 条目大小或 BLAKE3 无效：{path}"));
        }
        if !limits.names.contains(&path) {
            return Err(format!("manifest 声明的文件不存在：{path}"));
        }
    }
    if limits.names.len() != declared.len() + 1
        || limits
            .names
            .iter()
            .any(|name| name != MANIFEST_PATH && !declared.contains(name))
    {
        return Err("ZIP 含有 manifest 未声明的条目".to_string());
    }
    validate_manifest_semantics(&manifest)?;
    Ok((manifest, limits))
}

fn valid_blake3(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
}

fn validate_manifest_semantics(manifest: &PackageManifest) -> Result<(), String> {
    let entries: HashMap<&str, &ManifestEntry> = manifest
        .entries
        .iter()
        .map(|entry| (entry.relative_path.as_str(), entry))
        .collect();
    let mut ids = HashSet::new();
    let mut referenced = HashSet::new();
    for entry in &manifest.entries {
        if !valid_blake3(&entry.blake3) {
            return Err(format!(
                "BLAKE3 必须是 64 位小写十六进制：{}",
                entry.relative_path
            ));
        }
        if !matches!(entry.role.as_str(), "asset" | "thumbnail") {
            return Err(format!("未知条目角色：{}", entry.role));
        }
    }
    for asset in &manifest.assets {
        if asset.id.is_empty() || !ids.insert(asset.id.to_lowercase()) {
            return Err(format!("资产 ID 为空或重复：{}", asset.id));
        }
        validate_component(&asset.file_name)?;
        if !asset.logical_directory.is_empty() {
            safe_manifest_path(&asset.logical_directory)?;
        }
        if asset.missing != asset.file_path.is_none() {
            return Err(format!("资产 missing 与 filePath 不一致：{}", asset.id));
        }
        if let Some(path) = asset.file_path.as_deref() {
            let entry = entries
                .get(path)
                .ok_or_else(|| format!("资产引用不存在：{path}"))?;
            if entry.role != "asset" || !referenced.insert(path.to_lowercase()) {
                return Err(format!("资产条目角色错误或被重复引用：{path}"));
            }
        }
        if let Some(path) = asset.thumbnail_path.as_deref() {
            let entry = entries
                .get(path)
                .ok_or_else(|| format!("缩略图引用不存在：{path}"))?;
            if entry.role != "thumbnail" || !referenced.insert(path.to_lowercase()) {
                return Err(format!("缩略图角色错误或被重复引用：{path}"));
            }
        }
    }
    if referenced.len() != manifest.entries.len() {
        return Err("manifest 包含没有被资产引用的孤立条目".to_string());
    }
    match manifest.package_type.as_str() {
        ASSET_PACKAGE_TYPE if manifest.project.is_some() => {
            return Err("资产包不得包含 project 配置".to_string())
        }
        PROJECT_PACKAGE_TYPE => {
            let project = manifest
                .project
                .as_ref()
                .ok_or_else(|| "项目归档缺少 project 配置".to_string())?;
            validate_component(&project.name)?;
            let asset_ids: HashSet<&str> = manifest
                .assets
                .iter()
                .map(|asset| asset.id.as_str())
                .collect();
            let mut member_ids = HashSet::new();
            for directory in &project.directories {
                safe_manifest_path(directory)?;
            }
            for member in &project.assets {
                if !asset_ids.contains(member.asset_id.as_str())
                    || !member_ids.insert(member.asset_id.to_lowercase())
                {
                    return Err(format!("项目成员资产不存在或重复：{}", member.asset_id));
                }
                if !matches!(member.storage_mode.as_str(), "reference" | "copy") {
                    return Err(format!(
                        "项目成员 storageMode 无效：{}",
                        member.storage_mode
                    ));
                }
                if !member.relative_directory.is_empty() {
                    safe_manifest_path(&member.relative_directory)?;
                }
                if let Some(path) = member.copied_relative_path.as_deref() {
                    safe_manifest_path(path)?;
                }
            }
        }
        _ => {}
    }
    Ok(())
}

#[cfg(windows)]
fn available_disk_space(path: &Path) -> Result<u64, String> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::GetDiskFreeSpaceExW;
    let mut wide: Vec<u16> = path.as_os_str().encode_wide().collect();
    wide.push(0);
    let mut available = 0_u64;
    let ok = unsafe {
        GetDiskFreeSpaceExW(
            wide.as_ptr(),
            &mut available,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
        )
    };
    if ok == 0 {
        return Err(format!(
            "无法检查可用磁盘空间：{}",
            io::Error::last_os_error()
        ));
    }
    Ok(available)
}

#[cfg(not(windows))]
fn available_disk_space(_path: &Path) -> Result<u64, String> {
    Ok(u64::MAX)
}

fn ensure_disk_space(path: &Path, needed: u64) -> Result<(), String> {
    let available = available_disk_space(path)?;
    let required = needed.saturating_add(DISK_HEADROOM_BYTES);
    if available < required {
        return Err(format!(
            "磁盘空间不足：至少需要 {} MiB（含安全余量），当前仅有 {} MiB",
            required / 1024 / 1024,
            available / 1024 / 1024
        ));
    }
    Ok(())
}

#[cfg(windows)]
fn is_reparse_point(path: &Path) -> Result<bool, String> {
    use std::os::windows::fs::MetadataExt;
    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
    let metadata = fs::symlink_metadata(path).map_err(|error| error.to_string())?;
    Ok(metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0)
}

#[cfg(not(windows))]
fn is_reparse_point(path: &Path) -> Result<bool, String> {
    Ok(fs::symlink_metadata(path)
        .map_err(|error| error.to_string())?
        .file_type()
        .is_symlink())
}

fn ensure_regular_source(path: &Path) -> Result<(), String> {
    let metadata = fs::symlink_metadata(path)
        .map_err(|error| format!("无法读取 {}：{error}", path.display()))?;
    if !metadata.is_file() || metadata.file_type().is_symlink() || is_reparse_point(path)? {
        return Err(format!(
            "拒绝符号链接、重解析点或非普通文件：{}",
            path.display()
        ));
    }
    Ok(())
}

fn unique_file_name(
    directory: &str,
    file_name: &str,
    used: &mut HashSet<String>,
    suffix: &str,
) -> Result<(String, bool), String> {
    validate_component(file_name)?;
    let path = if directory.is_empty() {
        file_name.to_string()
    } else {
        format!("{directory}/{file_name}")
    };
    let path = safe_manifest_path(&path)?;
    let key = path.to_lowercase();
    if used.insert(key) {
        return Ok((path, false));
    }
    let source = Path::new(file_name);
    let stem = source
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("asset");
    let extension = source.extension().and_then(|value| value.to_str());
    for index in 1..=10_000 {
        let candidate = match extension {
            Some(extension) => format!("{stem} {suffix} {index}.{extension}"),
            None => format!("{stem} {suffix} {index}"),
        };
        let joined = if directory.is_empty() {
            candidate
        } else {
            format!("{directory}/{candidate}")
        };
        let joined = safe_manifest_path(&joined)?;
        if used.insert(joined.to_lowercase()) {
            return Ok((joined, true));
        }
    }
    Err(format!("无法为同名文件生成唯一名称：{file_name}"))
}

fn relative_logical_directory(path: &Path, scan_root: &Path) -> String {
    path.parent()
        .and_then(|parent| parent.strip_prefix(scan_root).ok())
        .map(|relative| {
            relative
                .components()
                .filter_map(|part| part.as_os_str().to_str())
                .filter(|part| validate_component(part).is_ok())
                .collect::<Vec<_>>()
                .join("/")
        })
        .unwrap_or_default()
}

fn load_tags(connection: &Connection, asset_uid: &str) -> Result<Vec<PortableTag>, String> {
    let mut statement = connection
        .prepare(
            "SELECT t.id, t.name, g.name, g.sort_order, t.color, t.description, t.archived
             FROM asset_tags at
             JOIN tags t ON t.id = at.tag_id
             JOIN tag_groups g ON g.id = t.group_id
             WHERE at.asset_uid = ?1 ORDER BY g.sort_order, t.name COLLATE NOCASE",
        )
        .map_err(|error| error.to_string())?;
    let base = statement
        .query_map(params![asset_uid], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, i64>(3)?,
                row.get::<_, String>(4)?,
                row.get::<_, String>(5)?,
                row.get::<_, bool>(6)?,
            ))
        })
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    let mut result = Vec::with_capacity(base.len());
    for (id, name, group_name, sort_order, color, description, archived) in base {
        let mut scopes = connection
            .prepare("SELECT asset_kind FROM tag_kind_scopes WHERE tag_id = ?1 ORDER BY asset_kind")
            .map_err(|error| error.to_string())?
            .query_map(params![id], |row| row.get::<_, String>(0))
            .map_err(|error| error.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())?;
        scopes.sort();
        result.push(PortableTag {
            name,
            group: PortableTagGroup {
                name: group_name,
                sort_order,
            },
            color,
            description,
            scopes,
            archived,
        });
    }
    Ok(result)
}

fn read_portable_asset(
    connection: &Connection,
    asset_id: i64,
) -> Result<(PortableAsset, PathBuf, Option<PathBuf>), String> {
    let row = connection
        .query_row(
            "SELECT asset_uid, path, name, extension, kind, size_bytes, modified_ms, scan_root,
                    thumbnail_path, original_source_method, original_source_url, author, author_status,
                    chinese_name, pinyin, ai_prompt_english, ai_prompt_chinese,
                    width, height, duration_ms, audio_sample_rate, audio_bit_depth, audio_channels,
                    audio_codec, audio_endianness, audio_frame_size, integrated_lufs, true_peak_dbtp,
                    loudness_range_lu, availability
             FROM indexed_assets WHERE rowid = ?1",
            params![asset_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?, row.get::<_, String>(4)?, row.get::<_, i64>(5)?,
                    row.get::<_, i64>(6)?, row.get::<_, String>(7)?, row.get::<_, Option<String>>(8)?,
                    row.get::<_, String>(9)?, row.get::<_, String>(10)?, row.get::<_, String>(11)?,
                    row.get::<_, String>(12)?, row.get::<_, String>(13)?, row.get::<_, String>(14)?,
                    row.get::<_, String>(15)?, row.get::<_, String>(16)?, row.get::<_, Option<i64>>(17)?,
                    row.get::<_, Option<i64>>(18)?, row.get::<_, Option<i64>>(19)?, row.get::<_, Option<i64>>(20)?,
                    row.get::<_, Option<i64>>(21)?, row.get::<_, Option<i64>>(22)?, row.get::<_, Option<String>>(23)?,
                    row.get::<_, Option<String>>(24)?, row.get::<_, Option<i64>>(25)?, row.get::<_, Option<f64>>(26)?,
                    row.get::<_, Option<f64>>(27)?, row.get::<_, Option<f64>>(28)?, row.get::<_, String>(29)?,
                ))
            },
        )
        .optional()
        .map_err(|error| error.to_string())?
        .ok_or_else(|| format!("找不到资产 ID {asset_id}"))?;
    if row.29 != "available" {
        return Err(format!("资产“{}”当前不可用", row.2));
    }
    let path = PathBuf::from(&row.1);
    ensure_regular_source(&path)?;
    let thumbnail = row
        .8
        .as_ref()
        .map(PathBuf::from)
        .filter(|path| path.is_file());
    if let Some(path) = thumbnail.as_deref() {
        ensure_regular_source(path)?;
    }
    let visual = connection
        .query_row(
            "SELECT dhash, palette_json, feature_version FROM asset_visual_features WHERE asset_uid = ?1 AND modified_ms = ?2",
            params![row.0, row.6],
            |visual| Ok((visual.get::<_, String>(0)?, visual.get::<_, String>(1)?, visual.get::<_, i64>(2)?)),
        )
        .optional()
        .map_err(|error| error.to_string())?;
    let (dhash, palette, feature_version) = match visual {
        Some((dhash, palette_json, version)) => (
            Some(dhash),
            serde_json::from_str::<Vec<String>>(&palette_json).unwrap_or_default(),
            Some(version),
        ),
        None => (None, Vec::new(), None),
    };
    let logical_directory = relative_logical_directory(&path, Path::new(&row.7));
    Ok((
        PortableAsset {
            id: row.0.clone(),
            file_name: row.2,
            logical_directory,
            kind: row.4,
            extension: row.3,
            modified_at_ms: row.6,
            file_path: None,
            thumbnail_path: None,
            missing: false,
            metadata: PortableMetadata {
                original_source_method: row.9,
                original_source_url: row.10,
                author: row.11,
                author_status: row.12,
                chinese_name: row.13,
                pinyin: row.14,
                ai_prompt_english: row.15,
                ai_prompt_chinese: row.16,
                width: row.17,
                height: row.18,
                duration_ms: row.19,
                audio_sample_rate: row.20,
                audio_bit_depth: row.21,
                audio_channels: row.22,
                audio_codec: row.23,
                audio_endianness: row.24,
                audio_frame_size: row.25,
                integrated_lufs: row.26,
                true_peak_dbtp: row.27,
                loudness_range_lu: row.28,
                dhash,
                palette,
                feature_version,
            },
            tags: load_tags(connection, &row.0)?,
        },
        path,
        thumbnail,
    ))
}

fn write_zip(
    output_path: &Path,
    manifest: &PackageManifest,
    sources: &[SourceFile],
    progress: &Channel<PackageProgress>,
    cancel_id: &str,
) -> Result<(), String> {
    let parent = output_path
        .parent()
        .ok_or_else(|| "输出路径缺少父目录".to_string())?;
    fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    let temp_path = parent.join(format!(".{}.tmp", operation_id("cae-package")));
    let result = (|| -> Result<(), String> {
        let file = File::create(&temp_path).map_err(|error| format!("无法创建临时包：{error}"))?;
        let mut zip = ZipWriter::new(file);
        let options = SimpleFileOptions::default()
            .compression_method(CompressionMethod::Deflated)
            .unix_permissions(0o600);
        zip.start_file(MANIFEST_PATH, options)
            .map_err(|error| error.to_string())?;
        let manifest_json =
            serde_json::to_vec_pretty(manifest).map_err(|error| error.to_string())?;
        zip.write_all(&manifest_json)
            .map_err(|error| error.to_string())?;
        for (index, source) in sources.iter().enumerate() {
            check_cancelled(cancel_id)?;
            report(
                progress,
                "writing",
                index as u64,
                sources.len() as u64,
                &source.relative_path,
                "正在写入包",
            );
            ensure_regular_source(&source.path)?;
            zip.start_file(&source.relative_path, options)
                .map_err(|error| error.to_string())?;
            let mut input = File::open(&source.path).map_err(|error| error.to_string())?;
            let (hash, size) = copy_and_hash(&mut input, &mut zip)?;
            if hash != source.blake3 || size != source.size {
                return Err(format!(
                    "源文件在打包期间发生变化：{}",
                    source.path.display()
                ));
            }
        }
        let file = zip.finish().map_err(|error| error.to_string())?;
        file.sync_all().map_err(|error| error.to_string())?;
        atomic_replace_file(&temp_path, output_path)?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temp_path);
    }
    result
}

fn atomic_replace_file(temp: &Path, destination: &Path) -> Result<(), String> {
    if !destination.exists() {
        return fs::rename(temp, destination).map_err(|error| error.to_string());
    }
    let backup = destination.with_file_name(format!(".{}.backup", operation_id("cae-package")));
    fs::rename(destination, &backup).map_err(|error| format!("无法暂存旧包：{error}"))?;
    if let Err(error) = fs::rename(temp, destination) {
        let _ = fs::rename(&backup, destination);
        return Err(format!("无法提交新包：{error}"));
    }
    let _ = fs::remove_file(backup);
    Ok(())
}

fn export_asset_package_impl(
    asset_ids: Vec<i64>,
    output_path: PathBuf,
    app: AppHandle,
    progress: Channel<PackageProgress>,
    cancel_id: String,
) -> Result<PackageSummary, String> {
    if asset_ids.is_empty() {
        return Err("请至少选择一个资产".to_string());
    }
    if asset_ids.len() > MAX_ENTRIES / 2 {
        return Err("选择的资产数量超出包限制".to_string());
    }
    let connection = package_database(&app)?;
    let mut used = HashSet::new();
    let mut assets = Vec::with_capacity(asset_ids.len());
    let mut sources = Vec::new();
    let mut messages = Vec::new();
    let mut conflicts = 0_u64;
    for (index, asset_id) in asset_ids.into_iter().enumerate() {
        check_cancelled(&cancel_id)?;
        report(
            &progress,
            "hashing",
            index as u64,
            assets.capacity() as u64,
            asset_id.to_string(),
            "正在读取元数据并计算 BLAKE3",
        );
        let scope: Option<String> = connection
            .query_row(
                "SELECT asset_scope FROM indexed_assets WHERE rowid = ?1",
                params![asset_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(|error| error.to_string())?;
        if scope.as_deref() != Some("library") {
            return Err(format!("资产 ID {asset_id} 不是可导出的真实资产库记录"));
        }
        let (mut asset, path, thumbnail) = read_portable_asset(&connection, asset_id)?;
        let logical = if asset.logical_directory.is_empty() {
            "assets".to_string()
        } else {
            format!("assets/{}", asset.logical_directory)
        };
        let (file_path, renamed) =
            unique_file_name(&logical, &asset.file_name, &mut used, "(conflict)")?;
        if renamed {
            conflicts += 1;
            messages.push(format!("包内同名冲突：{} 已确定性改名", asset.file_name));
        }
        let (hash, size) = hash_file(&path)?;
        connection
            .execute(
                "UPDATE indexed_assets SET content_hash = ?1, hash_modified_ms = modified_ms WHERE rowid = ?2",
                params![hash, asset_id],
            )
            .map_err(|error| error.to_string())?;
        asset.file_path = Some(file_path.clone());
        sources.push(SourceFile {
            path,
            relative_path: file_path,
            role: "asset".to_string(),
            size,
            blake3: hash,
        });
        if let Some(thumbnail) = thumbnail {
            let extension = thumbnail
                .extension()
                .and_then(|value| value.to_str())
                .unwrap_or("png");
            let thumbnail_path = format!("thumbnails/{}.{}", asset.id, extension);
            let thumbnail_path = safe_manifest_path(&thumbnail_path)?;
            let (hash, size) = hash_file(&thumbnail)?;
            asset.thumbnail_path = Some(thumbnail_path.clone());
            sources.push(SourceFile {
                path: thumbnail,
                relative_path: thumbnail_path,
                role: "thumbnail".to_string(),
                size,
                blake3: hash,
            });
        }
        assets.push(asset);
    }
    let entries = sources
        .iter()
        .map(|source| ManifestEntry {
            relative_path: source.relative_path.clone(),
            role: source.role.clone(),
            size: source.size,
            blake3: source.blake3.clone(),
        })
        .collect();
    let manifest = PackageManifest {
        schema_version: SCHEMA_VERSION.to_string(),
        package_type: ASSET_PACKAGE_TYPE.to_string(),
        created_at: now_ms() as i64,
        app_version: app.package_info().version.to_string(),
        entries,
        assets,
        project: None,
    };
    write_zip(&output_path, &manifest, &sources, &progress, &cancel_id)?;
    report(
        &progress,
        "completed",
        manifest.assets.len() as u64,
        manifest.assets.len() as u64,
        "",
        "资产包导出完成",
    );
    Ok(PackageSummary {
        package_path: output_path.to_string_lossy().into_owned(),
        succeeded: manifest.assets.len() as u64,
        conflicts,
        messages,
        ..PackageSummary::default()
    })
}

#[tauri::command]
pub(crate) async fn export_asset_package(
    asset_ids: Vec<i64>,
    output_path: String,
    on_progress: Channel<PackageProgress>,
    operation_id: String,
    app: AppHandle,
) -> Result<PackageSummary, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let result = export_asset_package_impl(
            asset_ids,
            PathBuf::from(output_path),
            app,
            on_progress,
            operation_id.clone(),
        );
        finish_operation(&operation_id);
        result
    })
    .await
    .map_err(|error| error.to_string())?
}

fn find_duplicate_asset(
    connection: &Connection,
    expected_hash: &str,
    expected_size: u64,
) -> Result<Option<(String, String)>, String> {
    let candidates = {
        let mut statement = connection
            .prepare(
                "SELECT rowid, asset_uid, path FROM indexed_assets
                 WHERE asset_scope = 'library' AND availability = 'available' AND size_bytes = ?1
                 ORDER BY indexed_at_ms, rowid",
            )
            .map_err(|error| error.to_string())?;
        let rows = statement
            .query_map(params![expected_size as i64], |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                ))
            })
            .map_err(|error| error.to_string())?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())?
    };
    for (_rowid, asset_uid, path) in candidates {
        let source = PathBuf::from(&path);
        if ensure_regular_source(&source).is_err() {
            continue;
        }
        let (hash, size) = hash_file(&source)?;
        if size == expected_size && hash == expected_hash {
            return Ok(Some((asset_uid, path)));
        }
    }
    Ok(None)
}

fn entry_by_path<'a>(
    manifest: &'a PackageManifest,
    path: &str,
) -> Result<&'a ManifestEntry, String> {
    manifest
        .entries
        .iter()
        .find(|entry| entry.relative_path == path)
        .ok_or_else(|| format!("manifest 未声明资产文件：{path}"))
}

fn destination_folder(parent: &Path, preferred: &str) -> Result<(PathBuf, bool), String> {
    validate_component(preferred)?;
    let direct = parent.join(preferred);
    if !direct.exists() {
        return Ok((direct, false));
    }
    for index in 2..=10_000 {
        let candidate = parent.join(format!("{preferred} (imported {index})"));
        if !candidate.exists() {
            return Ok((candidate, true));
        }
    }
    Err(format!("无法为“{preferred}”生成唯一导入目录"))
}

fn unique_import_name(file_name: &str, index: usize) -> Result<String, String> {
    validate_component(file_name)?;
    let path = Path::new(file_name);
    let stem = path
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("asset");
    let extension = path.extension().and_then(|value| value.to_str());
    Ok(match extension {
        Some(extension) => format!("{stem} (imported {index}).{extension}"),
        None => format!("{stem} (imported {index})"),
    })
}

fn resolve_import_relative_paths(
    connection: &Connection,
    manifest: &PackageManifest,
) -> Result<
    (
        HashMap<String, String>,
        HashMap<String, (String, String)>,
        Vec<String>,
    ),
    String,
> {
    let mut mapped = HashMap::new();
    let mut reused = HashMap::new();
    let mut messages = Vec::new();
    let mut occupied = HashSet::new();
    for asset in &manifest.assets {
        if asset.missing {
            continue;
        }
        let file_path = asset
            .file_path
            .as_deref()
            .ok_or_else(|| format!("资产 {} 缺少 filePath", asset.id))?;
        let entry = entry_by_path(manifest, file_path)?;
        if entry.role != "asset" {
            return Err(format!("资产文件角色错误：{file_path}"));
        }
        if let Some(existing) = find_duplicate_asset(connection, &entry.blake3, entry.size)? {
            reused.insert(asset.id.clone(), existing);
            continue;
        }
        let mut logical = asset.logical_directory.clone();
        if !logical.is_empty() {
            logical = safe_manifest_path(&logical)?;
        }
        let mut name = asset.file_name.clone();
        let same_name_exists: bool = connection
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM indexed_assets
                 WHERE asset_scope = 'library' AND availability = 'available' AND name = ?1 COLLATE NOCASE)",
                params![asset.file_name],
                |row| row.get(0),
            )
            .map_err(|error| error.to_string())?;
        if same_name_exists {
            let mut suffix = 2;
            loop {
                let candidate = unique_import_name(&asset.file_name, suffix)?;
                let key = format!("{logical}/{candidate}").to_lowercase();
                if !occupied.contains(&key) {
                    name = candidate;
                    break;
                }
                suffix += 1;
            }
            messages.push(format!("同名异内容：{} → {}", asset.file_name, name));
        }
        let relative = if logical.is_empty() {
            name
        } else {
            format!("{logical}/{name}")
        };
        let relative = safe_manifest_path(&relative)?;
        if !occupied.insert(relative.to_lowercase()) {
            let mut suffix = 2;
            loop {
                let candidate = unique_import_name(&asset.file_name, suffix)?;
                let relative = if logical.is_empty() {
                    candidate
                } else {
                    format!("{logical}/{candidate}")
                };
                let relative = safe_manifest_path(&relative)?;
                if occupied.insert(relative.to_lowercase()) {
                    messages.push(format!("包内同名冲突：{} → {}", asset.file_name, relative));
                    mapped.insert(asset.id.clone(), relative);
                    break;
                }
                suffix += 1;
            }
        } else {
            mapped.insert(asset.id.clone(), relative);
        }
    }
    Ok((mapped, reused, messages))
}

fn extract_verified(
    archive: &mut ZipArchive<File>,
    manifest: &PackageManifest,
    staging: &Path,
    asset_destinations: &HashMap<String, String>,
    reused: &HashMap<String, (String, String)>,
    progress: &Channel<PackageProgress>,
    operation_id: &str,
) -> Result<(), String> {
    let asset_by_entry: HashMap<&str, &PortableAsset> = manifest
        .assets
        .iter()
        .filter_map(|asset| asset.file_path.as_deref().map(|path| (path, asset)))
        .collect();
    let mut actual_total = 0_u64;
    for (index, declaration) in manifest.entries.iter().enumerate() {
        check_cancelled(operation_id)?;
        report(
            progress,
            "extracting",
            index as u64,
            manifest.entries.len() as u64,
            &declaration.relative_path,
            "正在流式校验并解压",
        );
        let mut entry = archive
            .by_name(&declaration.relative_path)
            .map_err(|error| error.to_string())?;
        let destination_relative =
            if let Some(asset) = asset_by_entry.get(declaration.relative_path.as_str()) {
                if reused.contains_key(&asset.id) {
                    format!(".verified-reused/{}", asset.id)
                } else {
                    asset_destinations
                        .get(&asset.id)
                        .cloned()
                        .ok_or_else(|| format!("缺少资产导入路径：{}", asset.id))?
                }
            } else {
                format!(".caevir/{}", declaration.relative_path)
            };
        let destination_relative = sanitize_relative_path(&destination_relative)?;
        let destination = staging.join(&destination_relative);
        if !destination.starts_with(staging) {
            return Err("ZIP Slip 路径逃逸".to_string());
        }
        if let Some(parent) = destination.parent() {
            fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        let mut output = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&destination)
            .map_err(|error| error.to_string())?;
        let mut hasher = Hasher::new();
        let mut size = 0_u64;
        let mut buffer = [0_u8; 1024 * 1024];
        loop {
            check_cancelled(operation_id)?;
            let read = entry.read(&mut buffer).map_err(|error| error.to_string())?;
            if read == 0 {
                break;
            }
            size = size
                .checked_add(read as u64)
                .ok_or_else(|| "实际条目大小溢出".to_string())?;
            actual_total = actual_total
                .checked_add(read as u64)
                .ok_or_else(|| "实际解压大小溢出".to_string())?;
            if size > declaration.size || size > MAX_FILE_BYTES || actual_total > MAX_TOTAL_BYTES {
                return Err(format!(
                    "条目在流式解压时超过声明或安全上限：{}",
                    declaration.relative_path
                ));
            }
            output
                .write_all(&buffer[..read])
                .map_err(|error| error.to_string())?;
            hasher.update(&buffer[..read]);
        }
        output.sync_all().map_err(|error| error.to_string())?;
        let hash = hasher.finalize().to_hex().to_string();
        if size != declaration.size || hash != declaration.blake3 {
            return Err(format!(
                "条目大小或 BLAKE3 校验失败：{}",
                declaration.relative_path
            ));
        }
    }
    let _ = fs::remove_dir_all(staging.join(".verified-reused"));
    Ok(())
}

fn resolve_tag(transaction: &Transaction<'_>, tag: &PortableTag) -> Result<(i64, bool), String> {
    let timestamp = now_ms() as i64;
    let group_id = match transaction
        .query_row(
            "SELECT id FROM tag_groups WHERE name = ?1 COLLATE NOCASE",
            params![tag.group.name],
            |row| row.get::<_, i64>(0),
        )
        .optional()
        .map_err(|error| error.to_string())?
    {
        Some(id) => id,
        None => {
            transaction
                .execute(
                    "INSERT INTO tag_groups (name, sort_order, created_at_ms, updated_at_ms) VALUES (?1, ?2, ?3, ?3)",
                    params![tag.group.name, tag.group.sort_order, timestamp],
                )
                .map_err(|error| error.to_string())?;
            transaction.last_insert_rowid()
        }
    };
    let existing = transaction
        .query_row(
            "SELECT id, group_id, color, description, archived FROM tags WHERE name = ?1 COLLATE NOCASE",
            params![tag.name],
            |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?, row.get::<_, String>(2)?, row.get::<_, String>(3)?, row.get::<_, bool>(4)?)),
        )
        .optional()
        .map_err(|error| error.to_string())?;
    let (tag_id, conflict) = match existing {
        Some((id, existing_group, color, description, archived)) => (
            id,
            existing_group != group_id
                || color != tag.color
                || description != tag.description
                || archived != tag.archived,
        ),
        None => {
            transaction
                .execute(
                    "INSERT INTO tags (group_id, name, color, description, archived, created_at_ms, updated_at_ms)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?6)",
                    params![group_id, tag.name, tag.color, tag.description, tag.archived, timestamp],
                )
                .map_err(|error| error.to_string())?;
            (transaction.last_insert_rowid(), false)
        }
    };
    for scope in &tag.scopes {
        transaction
            .execute(
                "INSERT OR IGNORE INTO tag_kind_scopes (tag_id, asset_kind) VALUES (?1, ?2)",
                params![tag_id, scope],
            )
            .map_err(|error| error.to_string())?;
    }
    Ok((tag_id, conflict))
}

fn apply_asset_metadata(
    transaction: &Transaction<'_>,
    asset_uid: &str,
    asset: &PortableAsset,
    modified_ms: i64,
) -> Result<u64, String> {
    let mut conflicts = 0_u64;
    for tag in &asset.tags {
        let (tag_id, conflict) = resolve_tag(transaction, tag)?;
        conflicts += u64::from(conflict);
        transaction
            .execute(
                "INSERT OR IGNORE INTO asset_tags (asset_uid, tag_id, created_at_ms) VALUES (?1, ?2, ?3)",
                params![asset_uid, tag_id, now_ms() as i64],
            )
            .map_err(|error| error.to_string())?;
    }
    if let (Some(dhash), Some(version)) = (&asset.metadata.dhash, asset.metadata.feature_version) {
        transaction
            .execute(
                "INSERT OR IGNORE INTO asset_visual_features
                 (asset_uid, modified_ms, dhash, palette_json, feature_version) VALUES (?1, ?2, ?3, ?4, ?5)",
                params![asset_uid, modified_ms, dhash, serde_json::to_string(&asset.metadata.palette).map_err(|error| error.to_string())?, version],
            )
            .map_err(|error| error.to_string())?;
    }
    Ok(conflicts)
}

fn insert_imported_asset(
    transaction: &Transaction<'_>,
    asset: &PortableAsset,
    file_path: &Path,
    scan_root: &Path,
    hash: &str,
    size: u64,
    operation: &str,
    asset_scope: &str,
    origin_asset_uid: Option<&str>,
    thumbnail_path: Option<&Path>,
) -> Result<(String, i64), String> {
    let metadata = fs::metadata(file_path).map_err(|error| error.to_string())?;
    let modified_ms = metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis().min(i64::MAX as u128) as i64)
        .unwrap_or_else(|| asset.modified_at_ms.max(0));
    let (directory_path, directory_key) = indexed_directory(file_path);
    let asset_uid =
        blake3::hash(format!("{}:{}:{}", operation, asset.id, file_path.display()).as_bytes())
            .to_hex()[..32]
            .to_string();
    let extension = file_path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or(&asset.extension)
        .to_ascii_lowercase();
    let kind = asset_kind(&extension).to_string();
    let metadata_status = if asset.metadata.width.is_some() || asset.metadata.duration_ms.is_some()
    {
        "ready"
    } else {
        "pending"
    };
    let loudness_status = if kind == "音频" {
        if asset.metadata.integrated_lufs.is_some() {
            "ready"
        } else {
            "pending"
        }
    } else {
        "unsupported"
    };
    transaction
        .execute(
            "INSERT INTO indexed_assets
             (path, name, extension, size_bytes, modified_ms, scan_root, last_scan_id, indexed_at_ms,
              asset_uid, kind, width, height, duration_ms, audio_sample_rate, audio_bit_depth,
              audio_channels, audio_codec, audio_endianness, audio_frame_size, thumbnail_path,
              metadata_status, availability, content_hash, hash_modified_ms, integrated_lufs,
              true_peak_dbtp, loudness_range_lu, loudness_status, directory_path, directory_key,
              asset_scope, origin_asset_uid, original_source_method, original_source_url, author, author_status,
              chinese_name, pinyin, ai_prompt_english, ai_prompt_chinese)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15,
                     ?16, ?17, ?18, ?19, ?20, ?21, 'available', ?22, ?5, ?23, ?24, ?25, ?26,
                     ?27, ?28, ?29, ?30, ?31, ?32, ?33, ?34, ?35, ?36, ?37, ?38)",
            params![
                file_path.to_string_lossy(),
                file_path.file_name().and_then(|value| value.to_str()).unwrap_or(&asset.file_name),
                extension,
                size as i64,
                modified_ms,
                scan_root.to_string_lossy(),
                operation,
                now_ms() as i64,
                asset_uid,
                kind,
                asset.metadata.width,
                asset.metadata.height,
                asset.metadata.duration_ms,
                asset.metadata.audio_sample_rate,
                asset.metadata.audio_bit_depth,
                asset.metadata.audio_channels,
                asset.metadata.audio_codec,
                asset.metadata.audio_endianness,
                asset.metadata.audio_frame_size,
                thumbnail_path.map(|path| path.to_string_lossy().into_owned()),
                metadata_status,
                hash,
                asset.metadata.integrated_lufs,
                asset.metadata.true_peak_dbtp,
                asset.metadata.loudness_range_lu,
                loudness_status,
                directory_path,
                directory_key,
                asset_scope,
                origin_asset_uid,
                if asset.metadata.original_source_method.is_empty() { "资产包导入" } else { &asset.metadata.original_source_method },
                asset.metadata.original_source_url,
                asset.metadata.author,
                if asset.metadata.author_status.is_empty() { "pending" } else { &asset.metadata.author_status },
                asset.metadata.chinese_name,
                asset.metadata.pinyin,
                asset.metadata.ai_prompt_english,
                asset.metadata.ai_prompt_chinese,
            ],
        )
        .map_err(|error| error.to_string())?;
    Ok((asset_uid, modified_ms))
}

fn merge_reused_metadata(
    transaction: &Transaction<'_>,
    asset_uid: &str,
    asset: &PortableAsset,
) -> Result<u64, String> {
    let existing = transaction.query_row(
        "SELECT original_source_url, author, chinese_name, pinyin, ai_prompt_english, ai_prompt_chinese
         FROM indexed_assets WHERE asset_uid = ?1 AND asset_scope = 'library'",
        params![asset_uid],
        |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?, row.get::<_, String>(3)?, row.get::<_, String>(4)?, row.get::<_, String>(5)?)),
    ).map_err(|error| error.to_string())?;
    let incoming = [
        asset.metadata.original_source_url.as_str(),
        asset.metadata.author.as_str(),
        asset.metadata.chinese_name.as_str(),
        asset.metadata.pinyin.as_str(),
        asset.metadata.ai_prompt_english.as_str(),
        asset.metadata.ai_prompt_chinese.as_str(),
    ];
    let local = [
        &existing.0,
        &existing.1,
        &existing.2,
        &existing.3,
        &existing.4,
        &existing.5,
    ];
    let metadata_conflicts = local
        .iter()
        .zip(incoming)
        .filter(|(left, right)| !left.is_empty() && !right.is_empty() && left.as_str() != *right)
        .count() as u64;
    transaction
        .execute(
            "UPDATE indexed_assets SET
               original_source_url = CASE WHEN original_source_url = '' THEN ?1 ELSE original_source_url END,
               author = CASE WHEN author = '' THEN ?2 ELSE author END,
               author_status = CASE WHEN author = '' AND ?2 <> '' THEN ?3 ELSE author_status END,
               chinese_name = CASE WHEN chinese_name = '' THEN ?4 ELSE chinese_name END,
               pinyin = CASE WHEN pinyin = '' THEN ?5 ELSE pinyin END,
               ai_prompt_english = CASE WHEN ai_prompt_english = '' THEN ?6 ELSE ai_prompt_english END,
               ai_prompt_chinese = CASE WHEN ai_prompt_chinese = '' THEN ?7 ELSE ai_prompt_chinese END
             WHERE asset_uid = ?8 AND asset_scope = 'library'",
            params![
                asset.metadata.original_source_url,
                asset.metadata.author,
                asset.metadata.author_status,
                asset.metadata.chinese_name,
                asset.metadata.pinyin,
                asset.metadata.ai_prompt_english,
                asset.metadata.ai_prompt_chinese,
                asset_uid,
            ],
        )
        .map_err(|error| error.to_string())?;
    let modified = transaction
        .query_row(
            "SELECT modified_ms FROM indexed_assets WHERE asset_uid = ?1",
            params![asset_uid],
            |row| row.get::<_, i64>(0),
        )
        .map_err(|error| error.to_string())?;
    Ok(metadata_conflicts + apply_asset_metadata(transaction, asset_uid, asset, modified)?)
}

fn import_asset_package_impl(
    package_path: PathBuf,
    destination_parent: PathBuf,
    app: AppHandle,
    progress: Channel<PackageProgress>,
    cancel_id: String,
) -> Result<PackageSummary, String> {
    ensure_regular_source(&package_path)?;
    if !destination_parent.is_dir() || is_reparse_point(&destination_parent)? {
        return Err("资产包目标必须是存在的普通文件夹，且不能是重解析点".to_string());
    }
    let file = File::open(&package_path).map_err(|error| error.to_string())?;
    let mut archive = ZipArchive::new(file).map_err(|error| format!("无法打开 ZIP：{error}"))?;
    report(
        &progress,
        "validating",
        0,
        1,
        MANIFEST_PATH,
        "正在预检包格式与安全限制",
    );
    let (manifest, limits) = read_manifest(&mut archive, ASSET_PACKAGE_TYPE)?;
    ensure_disk_space(&destination_parent, limits.total_size)?;
    let mut connection = package_database(&app)?;
    let (asset_destinations, reused, mut messages) =
        resolve_import_relative_paths(&connection, &manifest)?;
    let preferred = package_path
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("Caevir Assets");
    let preferred = if validate_component(preferred).is_ok() {
        preferred.to_string()
    } else {
        "Caevir Assets".to_string()
    };
    let (final_root, root_conflict) = destination_folder(&destination_parent, &preferred)?;
    let operation = operation_id("caepack");
    let staging = destination_parent.join(format!(".{operation}.stage"));
    create_owned_staging(&staging, &operation)?;
    let mut renamed_to_final = false;
    let result = (|| -> Result<PackageSummary, String> {
        extract_verified(
            &mut archive,
            &manifest,
            &staging,
            &asset_destinations,
            &reused,
            &progress,
            &cancel_id,
        )?;
        check_cancelled(&cancel_id)?;
        fs::rename(&staging, &final_root)
            .map_err(|error| format!("无法原子提交资产目录：{error}"))?;
        renamed_to_final = true;
        let transaction = connection
            .transaction()
            .map_err(|error| error.to_string())?;
        let mut succeeded = 0_u64;
        let mut reused_count = 0_u64;
        let mut conflicts = u64::from(root_conflict) + messages.len() as u64;
        for asset in &manifest.assets {
            check_cancelled(&cancel_id)?;
            if asset.missing {
                continue;
            }
            if let Some((asset_uid, _)) = reused.get(&asset.id) {
                conflicts += merge_reused_metadata(&transaction, asset_uid, asset)?;
                reused_count += 1;
                continue;
            }
            let relative = asset_destinations
                .get(&asset.id)
                .ok_or_else(|| format!("缺少导入映射：{}", asset.id))?;
            let declaration =
                entry_by_path(&manifest, asset.file_path.as_deref().unwrap_or_default())?;
            let path = final_root.join(sanitize_relative_path(relative)?);
            let thumbnail = asset
                .thumbnail_path
                .as_deref()
                .map(|value| {
                    sanitize_relative_path(value).map(|path| final_root.join(".caevir").join(path))
                })
                .transpose()?;
            let (asset_uid, actual_modified_ms) = insert_imported_asset(
                &transaction,
                asset,
                &path,
                &final_root,
                &declaration.blake3,
                declaration.size,
                &operation,
                "library",
                None,
                thumbnail.as_deref(),
            )?;
            conflicts += apply_asset_metadata(&transaction, &asset_uid, asset, actual_modified_ms)?;
            succeeded += 1;
        }
        check_cancelled(&cancel_id)?;
        transaction.commit().map_err(|error| error.to_string())?;
        let _ = fs::remove_file(final_root.join(".caevir-import-owner"));
        if root_conflict {
            messages.push(format!(
                "目标目录重名，已恢复为 {}",
                final_root.file_name().unwrap_or_default().to_string_lossy()
            ));
        }
        report(
            &progress,
            "completed",
            manifest.assets.len() as u64,
            manifest.assets.len() as u64,
            "",
            "资产包导入完成",
        );
        Ok(PackageSummary {
            package_path: package_path.to_string_lossy().into_owned(),
            project_path: Some(final_root.to_string_lossy().into_owned()),
            succeeded,
            reused: reused_count,
            skipped: reused_count,
            conflicts,
            missing: manifest.assets.iter().filter(|asset| asset.missing).count() as u64,
            messages,
            ..PackageSummary::default()
        })
    })();
    if result.is_err() {
        cleanup_owned_directory(&staging, &operation);
        if renamed_to_final {
            cleanup_owned_directory(&final_root, &operation);
        }
    }
    result
}

#[tauri::command]
pub(crate) async fn import_asset_package(
    package_path: String,
    destination_parent: String,
    on_progress: Channel<PackageProgress>,
    operation_id: String,
    app: AppHandle,
) -> Result<PackageSummary, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let result = import_asset_package_impl(
            PathBuf::from(package_path),
            PathBuf::from(destination_parent),
            app,
            on_progress,
            operation_id.clone(),
        );
        finish_operation(&operation_id);
        result
    })
    .await
    .map_err(|error| error.to_string())?
}

fn collect_project_directories(root: &Path) -> Result<Vec<String>, String> {
    fn visit(root: &Path, current: &Path, result: &mut Vec<String>) -> Result<(), String> {
        for entry in fs::read_dir(current).map_err(|error| error.to_string())? {
            let entry = entry.map_err(|error| error.to_string())?;
            let path = entry.path();
            let metadata = fs::symlink_metadata(&path).map_err(|error| error.to_string())?;
            if metadata.file_type().is_symlink() || is_reparse_point(&path)? {
                return Err(format!(
                    "项目包含符号链接或重解析点，无法安全归档：{}",
                    path.display()
                ));
            }
            if metadata.is_dir() {
                let relative = path.strip_prefix(root).map_err(|error| error.to_string())?;
                let portable = relative
                    .components()
                    .map(|component| component.as_os_str().to_string_lossy())
                    .collect::<Vec<_>>()
                    .join("/");
                result.push(safe_manifest_path(&portable)?);
                visit(root, &path, result)?;
            }
        }
        Ok(())
    }
    let mut result = Vec::new();
    visit(root, root, &mut result)?;
    result.sort();
    result.dedup();
    Ok(result)
}

#[derive(Clone, Debug)]
struct ProjectMembershipExport {
    source_asset_uid: String,
    storage_mode: String,
    relative_directory: String,
    copied_relative_path: Option<String>,
    materialized_asset_uid: Option<String>,
    source_name: String,
    source_kind: String,
    source_format: String,
}

fn export_project_archive_impl(
    project_id: i64,
    output_path: PathBuf,
    app: AppHandle,
    progress: Channel<PackageProgress>,
    cancel_id: String,
) -> Result<PackageSummary, String> {
    let connection = package_database(&app)?;
    let (project_name, project_root): (String, String) = connection
        .query_row(
            "SELECT name, root_path FROM projects WHERE id = ?1",
            params![project_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "项目不存在".to_string())?;
    let root = PathBuf::from(&project_root);
    if !root.is_dir() || is_reparse_point(&root)? {
        return Err("项目根目录缺失或是重解析点".to_string());
    }
    let directories = collect_project_directories(&root)?;
    let memberships = {
        let mut statement = connection
            .prepare(
                "SELECT source_asset_uid, storage_mode, relative_directory, copied_relative_path,
                        materialized_asset_uid, source_name_snapshot, source_kind_snapshot, source_format_snapshot
                 FROM project_assets WHERE project_id = ?1 ORDER BY id",
            )
            .map_err(|error| error.to_string())?;
        let rows = statement
            .query_map(params![project_id], |row| {
                Ok(ProjectMembershipExport {
                    source_asset_uid: row.get(0)?,
                    storage_mode: row.get(1)?,
                    relative_directory: row.get(2)?,
                    copied_relative_path: row.get(3)?,
                    materialized_asset_uid: row.get(4)?,
                    source_name: row.get(5)?,
                    source_kind: row.get(6)?,
                    source_format: row.get(7)?,
                })
            })
            .map_err(|error| error.to_string())?;
        rows.collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())?
    };
    let mut assets = Vec::with_capacity(memberships.len());
    let mut members = Vec::with_capacity(memberships.len());
    let mut sources = Vec::new();
    let mut missing = 0_u64;
    let mut messages = Vec::new();
    for (index, membership) in memberships.iter().enumerate() {
        check_cancelled(&cancel_id)?;
        report(
            &progress,
            "collecting",
            index as u64,
            memberships.len() as u64,
            &membership.source_name,
            "正在收集项目文件（包括外部引用）",
        );
        let effective_uid = if membership.storage_mode == "copy" {
            membership
                .materialized_asset_uid
                .as_deref()
                .unwrap_or(&membership.source_asset_uid)
        } else {
            &membership.source_asset_uid
        };
        let effective_rowid: Option<i64> = connection
            .query_row(
                "SELECT rowid FROM indexed_assets WHERE asset_uid = ?1 AND availability = 'available'",
                params![effective_uid],
                |row| row.get(0),
            )
            .optional()
            .map_err(|error| error.to_string())?;
        let asset_id = format!("member-{}", index + 1);
        let mut portable = if let Some(rowid) = effective_rowid {
            let metadata_rowid: Option<i64> = connection
                .query_row(
                    "SELECT rowid FROM indexed_assets WHERE asset_uid = ?1 AND availability = 'available'",
                    params![membership.source_asset_uid],
                    |row| row.get(0),
                )
                .optional()
                .map_err(|error| error.to_string())?;
            let (mut asset, _, thumbnail) =
                read_portable_asset(&connection, metadata_rowid.unwrap_or(rowid))?;
            let path: PathBuf = connection
                .query_row(
                    "SELECT path FROM indexed_assets WHERE rowid = ?1",
                    params![rowid],
                    |row| row.get::<_, String>(0),
                )
                .map(PathBuf::from)
                .map_err(|error| error.to_string())?;
            ensure_regular_source(&path)?;
            asset.id = asset_id.clone();
            asset.file_name = path
                .file_name()
                .and_then(|value| value.to_str())
                .unwrap_or(&membership.source_name)
                .to_string();
            asset.logical_directory = membership.relative_directory.clone();
            let object_path =
                safe_manifest_path(&format!("objects/{asset_id}/{}", asset.file_name))?;
            let (hash, size) = hash_file(&path)?;
            asset.file_path = Some(object_path.clone());
            sources.push(SourceFile {
                path,
                relative_path: object_path,
                role: "asset".to_string(),
                size,
                blake3: hash,
            });
            if let Some(thumbnail) = thumbnail {
                let extension = thumbnail
                    .extension()
                    .and_then(|value| value.to_str())
                    .unwrap_or("png");
                let thumbnail_path =
                    safe_manifest_path(&format!("thumbnails/{asset_id}.{extension}"))?;
                let (hash, size) = hash_file(&thumbnail)?;
                asset.thumbnail_path = Some(thumbnail_path.clone());
                sources.push(SourceFile {
                    path: thumbnail,
                    relative_path: thumbnail_path,
                    role: "thumbnail".to_string(),
                    size,
                    blake3: hash,
                });
            }
            asset
        } else {
            missing += 1;
            messages.push(format!("缺失成员：{}", membership.source_name));
            PortableAsset {
                id: asset_id.clone(),
                file_name: membership.source_name.clone(),
                logical_directory: membership.relative_directory.clone(),
                kind: membership.source_kind.clone(),
                extension: membership.source_format.to_ascii_lowercase(),
                modified_at_ms: 0,
                file_path: None,
                thumbnail_path: None,
                missing: true,
                metadata: PortableMetadata::default(),
                tags: Vec::new(),
            }
        };
        portable.missing = effective_rowid.is_none();
        assets.push(portable);
        members.push(ProjectMember {
            asset_id,
            storage_mode: membership.storage_mode.clone(),
            relative_directory: membership.relative_directory.clone(),
            copied_relative_path: membership.copied_relative_path.clone(),
        });
    }
    let entries = sources
        .iter()
        .map(|source| ManifestEntry {
            relative_path: source.relative_path.clone(),
            role: source.role.clone(),
            size: source.size,
            blake3: source.blake3.clone(),
        })
        .collect();
    let manifest = PackageManifest {
        schema_version: SCHEMA_VERSION.to_string(),
        package_type: PROJECT_PACKAGE_TYPE.to_string(),
        created_at: now_ms() as i64,
        app_version: app.package_info().version.to_string(),
        entries,
        assets,
        project: Some(PortableProject {
            name: project_name,
            directories,
            assets: members,
        }),
    };
    write_zip(&output_path, &manifest, &sources, &progress, &cancel_id)?;
    report(
        &progress,
        "completed",
        manifest.assets.len() as u64,
        manifest.assets.len() as u64,
        "",
        "项目归档完成",
    );
    Ok(PackageSummary {
        package_path: output_path.to_string_lossy().into_owned(),
        succeeded: manifest.assets.len() as u64 - missing,
        missing,
        messages,
        ..PackageSummary::default()
    })
}

#[tauri::command]
pub(crate) async fn export_project_archive(
    project_id: i64,
    output_path: String,
    on_progress: Channel<PackageProgress>,
    operation_id: String,
    app: AppHandle,
) -> Result<PackageSummary, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let result = export_project_archive_impl(
            project_id,
            PathBuf::from(output_path),
            app,
            on_progress,
            operation_id.clone(),
        );
        finish_operation(&operation_id);
        result
    })
    .await
    .map_err(|error| error.to_string())?
}

fn restored_project_destination(
    connection: &Connection,
    parent: &Path,
    preferred: &str,
) -> Result<(String, PathBuf, bool), String> {
    validate_component(preferred)?;
    for index in 1..=10_000 {
        let name = if index == 1 {
            preferred.to_string()
        } else {
            format!("{preferred} (imported {index})")
        };
        let exists_in_db: bool = connection
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM projects WHERE name = ?1 COLLATE NOCASE)",
                params![name],
                |row| row.get(0),
            )
            .map_err(|error| error.to_string())?;
        let path = parent.join(&name);
        if !exists_in_db && !path.exists() {
            return Ok((name, path, index != 1));
        }
    }
    Err("无法生成唯一项目名称".to_string())
}

fn copy_verified_file(
    source: &Path,
    destination: &Path,
    expected_hash: &str,
    expected_size: u64,
) -> Result<(), String> {
    if let Some(parent) = destination.parent() {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    let mut input = File::open(source).map_err(|error| error.to_string())?;
    let mut output = File::create(destination).map_err(|error| error.to_string())?;
    let (hash, size) = copy_and_hash(&mut input, &mut output)?;
    output.sync_all().map_err(|error| error.to_string())?;
    if hash != expected_hash || size != expected_size {
        return Err(format!("收集文件复制校验失败：{}", source.display()));
    }
    Ok(())
}

fn import_project_archive_impl(
    package_path: PathBuf,
    destination_parent: PathBuf,
    app: AppHandle,
    progress: Channel<PackageProgress>,
    cancel_id: String,
) -> Result<PackageSummary, String> {
    ensure_regular_source(&package_path)?;
    if !destination_parent.is_dir() || is_reparse_point(&destination_parent)? {
        return Err("项目恢复目标必须是存在的普通文件夹，且不能是重解析点".to_string());
    }
    let file = File::open(&package_path).map_err(|error| error.to_string())?;
    let mut archive = ZipArchive::new(file).map_err(|error| format!("无法打开 ZIP：{error}"))?;
    report(
        &progress,
        "validating",
        0,
        1,
        MANIFEST_PATH,
        "正在预检项目归档与安全限制",
    );
    let (manifest, limits) = read_manifest(&mut archive, PROJECT_PACKAGE_TYPE)?;
    let project = manifest
        .project
        .as_ref()
        .ok_or_else(|| "项目归档缺少 project 配置".to_string())?;
    if project.assets.len() != manifest.assets.len() {
        return Err("项目成员与资产清单数量不一致".to_string());
    }
    ensure_disk_space(&destination_parent, limits.total_size.saturating_mul(2))?;
    let mut connection = package_database(&app)?;
    let (restored_name, final_root, project_conflict) =
        restored_project_destination(&connection, &destination_parent, &project.name)?;
    let operation = operation_id("caeproject");
    let staging = destination_parent.join(format!(".{operation}.stage"));
    create_owned_staging(&staging, &operation)?;
    let mut destinations = HashMap::new();
    let mut reused = HashMap::new();
    let mut used = HashSet::new();
    let mut messages = Vec::new();
    for member in &project.assets {
        let asset = manifest
            .assets
            .iter()
            .find(|asset| asset.id == member.asset_id)
            .ok_or_else(|| format!("找不到项目成员资产：{}", member.asset_id))?;
        if asset.missing {
            continue;
        }
        let file_path = asset
            .file_path
            .as_deref()
            .ok_or_else(|| format!("成员 {} 缺少 filePath", asset.id))?;
        let declaration = entry_by_path(&manifest, file_path)?;
        if let Some(existing) =
            find_duplicate_asset(&connection, &declaration.blake3, declaration.size)?
        {
            reused.insert(asset.id.clone(), existing);
        }
        let directory = if member.relative_directory.is_empty() {
            String::new()
        } else {
            safe_manifest_path(&member.relative_directory)?
        };
        let (relative, renamed) =
            unique_file_name(&directory, &asset.file_name, &mut used, "(imported)")?;
        if renamed {
            messages.push(format!(
                "项目内同名冲突：{} → {}",
                asset.file_name, relative
            ));
        }
        destinations.insert(asset.id.clone(), relative);
    }
    let mut renamed_to_final = false;
    let result = (|| -> Result<PackageSummary, String> {
        for directory in &project.directories {
            let relative = sanitize_relative_path(directory)?;
            fs::create_dir_all(staging.join(relative)).map_err(|error| error.to_string())?;
        }
        // Project members must be materialized even when the source can be reused.
        extract_verified(
            &mut archive,
            &manifest,
            &staging,
            &destinations,
            &HashMap::new(),
            &progress,
            &cancel_id,
        )?;
        check_cancelled(&cancel_id)?;
        for member in &project.assets {
            check_cancelled(&cancel_id)?;
            let asset = manifest
                .assets
                .iter()
                .find(|asset| asset.id == member.asset_id)
                .unwrap();
            if asset.missing || member.storage_mode != "copy" || reused.contains_key(&asset.id) {
                continue;
            }
            let relative = destinations.get(&asset.id).unwrap();
            let declaration = entry_by_path(&manifest, asset.file_path.as_deref().unwrap())?;
            let hidden = staging
                .join(".caevir")
                .join("sources")
                .join(&asset.id)
                .join(&asset.file_name);
            copy_verified_file(
                &staging.join(sanitize_relative_path(relative)?),
                &hidden,
                &declaration.blake3,
                declaration.size,
            )?;
        }
        fs::rename(&staging, &final_root)
            .map_err(|error| format!("无法原子提交项目目录：{error}"))?;
        renamed_to_final = true;
        let transaction = connection
            .transaction()
            .map_err(|error| error.to_string())?;
        let timestamp = now_ms() as i64;
        transaction.execute(
            "INSERT INTO projects (name, parent_path, root_path, root_key, status, created_at_ms, updated_at_ms)
             VALUES (?1, ?2, ?3, ?4, 'ready', ?5, ?5)",
            params![restored_name, destination_parent.to_string_lossy(), final_root.to_string_lossy(), normalize_directory_key(&final_root), timestamp],
        ).map_err(|error| error.to_string())?;
        let project_id = transaction.last_insert_rowid();
        let mut succeeded = 0_u64;
        let mut reused_count = 0_u64;
        let mut missing_count = 0_u64;
        let mut conflicts = u64::from(project_conflict) + messages.len() as u64;
        for member in &project.assets {
            check_cancelled(&cancel_id)?;
            let asset = manifest
                .assets
                .iter()
                .find(|asset| asset.id == member.asset_id)
                .unwrap();
            if asset.missing {
                let synthetic_uid =
                    blake3::hash(format!("missing:{}:{}", operation, asset.id).as_bytes()).to_hex()
                        [..32]
                        .to_string();
                transaction.execute(
                    "INSERT INTO project_assets
                     (project_id, source_asset_uid, storage_mode, relative_directory, materialized_asset_uid,
                      copied_relative_path, source_name_snapshot, source_kind_snapshot, source_format_snapshot,
                      source_path_snapshot, status, created_at_ms, updated_at_ms)
                     VALUES (?1, ?2, 'reference', ?3, NULL, NULL, ?4, ?5, ?6, ?4, 'source_missing', ?7, ?7)",
                    params![project_id, synthetic_uid, member.relative_directory, asset.file_name, asset.kind, asset.extension, timestamp],
                ).map_err(|error| error.to_string())?;
                missing_count += 1;
                continue;
            }
            let declaration = entry_by_path(&manifest, asset.file_path.as_deref().unwrap())?;
            let visible_relative = destinations.get(&asset.id).unwrap();
            let visible_path = final_root.join(sanitize_relative_path(visible_relative)?);
            let source_uid = if let Some((uid, _)) = reused.get(&asset.id) {
                conflicts += merge_reused_metadata(&transaction, uid, asset)?;
                reused_count += 1;
                uid.clone()
            } else {
                let source_path = if member.storage_mode == "copy" {
                    final_root
                        .join(".caevir")
                        .join("sources")
                        .join(&asset.id)
                        .join(&asset.file_name)
                } else {
                    visible_path.clone()
                };
                let thumbnail = asset
                    .thumbnail_path
                    .as_deref()
                    .map(|value| {
                        sanitize_relative_path(value)
                            .map(|path| final_root.join(".caevir").join(path))
                    })
                    .transpose()?;
                let (uid, actual_modified_ms) = insert_imported_asset(
                    &transaction,
                    asset,
                    &source_path,
                    &final_root,
                    &declaration.blake3,
                    declaration.size,
                    &operation,
                    "library",
                    None,
                    thumbnail.as_deref(),
                )?;
                conflicts += apply_asset_metadata(&transaction, &uid, asset, actual_modified_ms)?;
                uid
            };
            if member.storage_mode == "copy" {
                let thumbnail = asset
                    .thumbnail_path
                    .as_deref()
                    .map(|value| {
                        sanitize_relative_path(value)
                            .map(|path| final_root.join(".caevir").join(path))
                    })
                    .transpose()?;
                let (materialized_uid, _) = insert_imported_asset(
                    &transaction,
                    asset,
                    &visible_path,
                    &final_root,
                    &declaration.blake3,
                    declaration.size,
                    &operation,
                    "project",
                    Some(&source_uid),
                    thumbnail.as_deref(),
                )?;
                transaction.execute(
                    "INSERT INTO project_assets
                     (project_id, source_asset_uid, storage_mode, relative_directory, materialized_asset_uid,
                      copied_relative_path, source_name_snapshot, source_kind_snapshot, source_format_snapshot,
                      source_path_snapshot, source_size_at_copy, source_modified_at_copy, source_hash_at_copy,
                      status, created_at_ms, updated_at_ms)
                     VALUES (?1, ?2, 'copy', ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, 'ready', ?13, ?13)",
                    params![project_id, source_uid, member.relative_directory, materialized_uid, visible_relative,
                        asset.file_name, asset.kind, asset.extension, visible_path.to_string_lossy(), declaration.size as i64,
                        asset.modified_at_ms, declaration.blake3, timestamp],
                ).map_err(|error| error.to_string())?;
            } else {
                transaction.execute(
                    "INSERT INTO project_assets
                     (project_id, source_asset_uid, storage_mode, relative_directory, materialized_asset_uid,
                      copied_relative_path, source_name_snapshot, source_kind_snapshot, source_format_snapshot,
                      source_path_snapshot, status, created_at_ms, updated_at_ms)
                     VALUES (?1, ?2, 'reference', ?3, NULL, NULL, ?4, ?5, ?6, ?7, 'ready', ?8, ?8)",
                    params![project_id, source_uid, member.relative_directory, asset.file_name, asset.kind, asset.extension,
                        visible_path.to_string_lossy(), timestamp],
                ).map_err(|error| error.to_string())?;
            }
            succeeded += 1;
        }
        check_cancelled(&cancel_id)?;
        transaction.commit().map_err(|error| error.to_string())?;
        let _ = fs::remove_file(final_root.join(".caevir-import-owner"));
        if project_conflict {
            messages.push(format!("项目重名，已恢复为“{restored_name}”"));
        }
        report(
            &progress,
            "completed",
            project.assets.len() as u64,
            project.assets.len() as u64,
            "",
            "项目归档恢复完成",
        );
        Ok(PackageSummary {
            package_path: package_path.to_string_lossy().into_owned(),
            project_id: Some(project_id),
            project_path: Some(final_root.to_string_lossy().into_owned()),
            succeeded,
            reused: reused_count,
            skipped: 0,
            conflicts,
            missing: missing_count,
            messages,
            ..PackageSummary::default()
        })
    })();
    if result.is_err() {
        cleanup_owned_directory(&staging, &operation);
        if renamed_to_final {
            cleanup_owned_directory(&final_root, &operation);
        }
    }
    result
}

#[tauri::command]
pub(crate) async fn import_project_archive(
    package_path: String,
    destination_parent: String,
    on_progress: Channel<PackageProgress>,
    operation_id: String,
    app: AppHandle,
) -> Result<PackageSummary, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let result = import_project_archive_impl(
            PathBuf::from(package_path),
            PathBuf::from(destination_parent),
            app,
            on_progress,
            operation_id.clone(),
        );
        finish_operation(&operation_id);
        result
    })
    .await
    .map_err(|error| error.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    static NEXT_TEST: AtomicU64 = AtomicU64::new(1);

    struct TestDir(PathBuf);
    impl TestDir {
        fn new(name: &str) -> Self {
            let path = std::env::temp_dir().join(format!(
                "caevir-package-{name}-{}-{}",
                std::process::id(),
                NEXT_TEST.fetch_add(1, Ordering::Relaxed)
            ));
            let _ = fs::remove_dir_all(&path);
            fs::create_dir_all(&path).unwrap();
            Self(path)
        }
    }
    impl Drop for TestDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn channel() -> Channel<PackageProgress> {
        Channel::new(|_| Ok(()))
    }

    fn asset(id: &str, file_path: Option<&str>) -> PortableAsset {
        PortableAsset {
            id: id.to_string(),
            file_name: "asset.txt".to_string(),
            logical_directory: "folder".to_string(),
            kind: "设计文件".to_string(),
            extension: "txt".to_string(),
            modified_at_ms: 1,
            file_path: file_path.map(str::to_string),
            thumbnail_path: None,
            missing: file_path.is_none(),
            metadata: PortableMetadata {
                author: "作者".to_string(),
                chinese_name: "资源".to_string(),
                pinyin: "zi yuan".to_string(),
                ..PortableMetadata::default()
            },
            tags: vec![PortableTag {
                name: "测试标签".to_string(),
                group: PortableTagGroup {
                    name: "测试组".to_string(),
                    sort_order: 1,
                },
                color: "#123456".to_string(),
                description: "roundtrip".to_string(),
                scopes: vec!["设计文件".to_string()],
                archived: false,
            }],
        }
    }

    fn manifest(
        package_type: &str,
        entry: ManifestEntry,
        project: Option<PortableProject>,
    ) -> PackageManifest {
        PackageManifest {
            schema_version: SCHEMA_VERSION.to_string(),
            package_type: package_type.to_string(),
            created_at: 1,
            app_version: "test".to_string(),
            entries: vec![entry],
            assets: vec![asset("asset-1", Some("objects/asset-1/asset.txt"))],
            project,
        }
    }

    #[test]
    fn manifest_roundtrip_and_forward_optional_fields() {
        let source = br#"{"schemaVersion":"1.0.0","packageType":"caevir.assetPackage","createdAt":1,"appVersion":"x","entries":[],"assets":[],"futureOptional":{"ok":true}}"#;
        let parsed: PackageManifest = serde_json::from_slice(source).unwrap();
        validate_schema(&parsed, ASSET_PACKAGE_TYPE).unwrap();
        let roundtrip: PackageManifest =
            serde_json::from_slice(&serde_json::to_vec(&parsed).unwrap()).unwrap();
        assert_eq!(parsed, roundtrip);
        let mut newer = parsed;
        newer.schema_version = "2.0.0".to_string();
        assert!(validate_schema(&newer, ASSET_PACKAGE_TYPE)
            .unwrap_err()
            .contains("较新的主版本"));
    }

    #[test]
    fn blake3_streaming_matches_known_value() {
        let (hash, size) = hash_reader(&b"abc"[..]).unwrap();
        assert_eq!(size, 3);
        assert_eq!(
            hash,
            "6437b3ac38465133ffb63b75273a8db548c558465d79db03fd359c6cd5bd9d85"
        );
    }

    #[test]
    fn path_sanitizer_rejects_zip_slip_and_windows_names() {
        for invalid in [
            "../evil",
            "C:/evil",
            "/root",
            "safe\\evil",
            "CON.txt",
            "folder/name. ",
            "a//b",
        ] {
            assert!(sanitize_relative_path(invalid).is_err(), "{invalid}");
        }
        assert_eq!(
            safe_manifest_path("folder/资产.png").unwrap(),
            "folder/资产.png"
        );
    }

    #[test]
    fn zip_header_rejects_zip_slip_case_collisions_and_bombs() {
        fn make_zip(entries: &[(&str, Vec<u8>)]) -> TestDir {
            let root = TestDir::new("unsafe-zip");
            let file = File::create(root.0.join("test.zip")).unwrap();
            let mut zip = ZipWriter::new(file);
            let options =
                SimpleFileOptions::default().compression_method(CompressionMethod::Deflated);
            for (name, bytes) in entries {
                zip.start_file(*name, options).unwrap();
                zip.write_all(bytes).unwrap();
            }
            zip.finish().unwrap();
            root
        }
        let slip = make_zip(&[("../evil", b"x".to_vec())]);
        let mut archive = ZipArchive::new(File::open(slip.0.join("test.zip")).unwrap()).unwrap();
        assert!(validate_archive_headers(&mut archive).is_err());
        let collision = make_zip(&[("A.txt", b"a".to_vec()), ("a.txt", b"b".to_vec())]);
        let mut archive =
            ZipArchive::new(File::open(collision.0.join("test.zip")).unwrap()).unwrap();
        assert!(validate_archive_headers(&mut archive)
            .unwrap_err()
            .to_string()
            .contains("大小写"));
        let bomb = make_zip(&[("zeros.bin", vec![0; 2 * 1024 * 1024])]);
        let mut archive = ZipArchive::new(File::open(bomb.0.join("test.zip")).unwrap()).unwrap();
        assert!(validate_archive_headers(&mut archive)
            .unwrap_err()
            .to_string()
            .contains("压缩比"));
    }

    #[test]
    fn deterministic_conflict_rename_is_visible() {
        let mut used = HashSet::new();
        assert_eq!(
            unique_file_name("folder", "same.png", &mut used, "(imported)").unwrap(),
            ("folder/same.png".to_string(), false)
        );
        assert_eq!(
            unique_file_name("folder", "same.png", &mut used, "(imported)").unwrap(),
            ("folder/same (imported) 1.png".to_string(), true)
        );
    }

    #[test]
    fn exact_duplicate_is_reused_after_real_hash_verification() {
        let root = TestDir::new("duplicate");
        let path = root.0.join("same.bin");
        fs::write(&path, b"identical bytes").unwrap();
        let connection = Connection::open_in_memory().unwrap();
        super::super::initialize_database_schema(&connection).unwrap();
        connection.execute(
            "INSERT INTO indexed_assets (path,name,extension,size_bytes,modified_ms,scan_root,last_scan_id,indexed_at_ms,asset_uid,kind,directory_path,directory_key)
             VALUES (?1,'same.bin','bin',15,1,?2,'test',1,'uid-existing','设计文件',?2,?2)",
            params![path.to_string_lossy(), root.0.to_string_lossy()],
        ).unwrap();
        let hash = blake3::hash(b"identical bytes").to_hex().to_string();
        assert_eq!(
            find_duplicate_asset(&connection, &hash, 15)
                .unwrap()
                .unwrap()
                .0,
            "uid-existing"
        );
    }

    #[test]
    fn database_transaction_and_owned_staging_roll_back() {
        let root = TestDir::new("rollback");
        let owned = root.0.join("stage");
        create_owned_staging(&owned, "owner-1").unwrap();
        fs::write(owned.join("partial"), b"partial").unwrap();
        let mut connection = Connection::open_in_memory().unwrap();
        super::super::initialize_database_schema(&connection).unwrap();
        {
            let transaction = connection.transaction().unwrap();
            transaction.execute("INSERT INTO projects (name,parent_path,root_path,root_key,created_at_ms,updated_at_ms) VALUES ('p','x','y','y',1,1)", []).unwrap();
            transaction.rollback().unwrap();
        }
        assert_eq!(
            connection
                .query_row("SELECT COUNT(*) FROM projects", [], |row| row
                    .get::<_, i64>(0))
                .unwrap(),
            0
        );
        cleanup_owned_directory(&owned, "wrong-owner");
        assert!(owned.exists());
        cleanup_owned_directory(&owned, "owner-1");
        assert!(!owned.exists());
    }

    #[test]
    fn cancellation_is_observed_before_commit_boundaries() {
        cancel_package_operation("cancel-test".to_string()).unwrap();
        assert!(check_cancelled("cancel-test")
            .unwrap_err()
            .contains("已回滚"));
        finish_operation("cancel-test");
        assert!(check_cancelled("cancel-test").is_ok());
    }

    #[test]
    fn imported_asset_sql_restores_metadata_tags_and_visuals() {
        let root = TestDir::new("database-roundtrip");
        let file = root.0.join("asset.txt");
        fs::write(&file, b"payload").unwrap();
        let mut connection = Connection::open_in_memory().unwrap();
        super::super::initialize_database_schema(&connection).unwrap();
        let mut portable = asset("asset-1", Some("objects/asset-1/asset.txt"));
        portable.metadata.dhash = Some("0123456789abcdef".to_string());
        portable.metadata.palette = vec!["#112233".to_string()];
        portable.metadata.feature_version = Some(1);
        let transaction = connection.transaction().unwrap();
        let (uid, modified) = insert_imported_asset(
            &transaction,
            &portable,
            &file,
            &root.0,
            &blake3::hash(b"payload").to_hex().to_string(),
            7,
            "test-op",
            "library",
            None,
            None,
        )
        .unwrap();
        apply_asset_metadata(&transaction, &uid, &portable, modified).unwrap();
        transaction.commit().unwrap();
        assert_eq!(
            connection
                .query_row(
                    "SELECT author FROM indexed_assets WHERE asset_uid=?1",
                    params![uid],
                    |row| row.get::<_, String>(0)
                )
                .unwrap(),
            "作者"
        );
        assert_eq!(
            connection
                .query_row("SELECT COUNT(*) FROM asset_tags", [], |row| row
                    .get::<_, i64>(0))
                .unwrap(),
            1
        );
        assert_eq!(
            connection
                .query_row("SELECT COUNT(*) FROM asset_visual_features", [], |row| row
                    .get::<_, i64>(
                    0
                ))
                .unwrap(),
            1
        );
    }

    fn package_roundtrip(package_type: &str) {
        let root = TestDir::new("package-roundtrip");
        let source = root.0.join("asset.txt");
        fs::write(&source, b"portable payload").unwrap();
        let (hash, size) = hash_file(&source).unwrap();
        let relative = "objects/asset-1/asset.txt";
        let project = (package_type == PROJECT_PACKAGE_TYPE).then(|| PortableProject {
            name: "Roundtrip Project".to_string(),
            directories: vec!["folder".to_string()],
            assets: vec![ProjectMember {
                asset_id: "asset-1".to_string(),
                storage_mode: "reference".to_string(),
                relative_directory: "folder".to_string(),
                copied_relative_path: None,
            }],
        });
        let manifest = manifest(
            package_type,
            ManifestEntry {
                relative_path: relative.to_string(),
                role: "asset".to_string(),
                size,
                blake3: hash.clone(),
            },
            project,
        );
        let source_file = SourceFile {
            path: source,
            relative_path: relative.to_string(),
            role: "asset".to_string(),
            size,
            blake3: hash,
        };
        let package = root.0.join(if package_type == ASSET_PACKAGE_TYPE {
            "test.caepack"
        } else {
            "test.caeproject"
        });
        write_zip(
            &package,
            &manifest,
            &[source_file],
            &channel(),
            "test-operation",
        )
        .unwrap();
        let mut archive = ZipArchive::new(File::open(&package).unwrap()).unwrap();
        let (read, _) = read_manifest(&mut archive, package_type).unwrap();
        assert_eq!(read, manifest);
        let staging = root.0.join("extract");
        fs::create_dir(&staging).unwrap();
        let destinations = HashMap::from([("asset-1".to_string(), "folder/asset.txt".to_string())]);
        extract_verified(
            &mut archive,
            &read,
            &staging,
            &destinations,
            &HashMap::new(),
            &channel(),
            "test-operation",
        )
        .unwrap();
        assert_eq!(
            fs::read(staging.join("folder/asset.txt")).unwrap(),
            b"portable payload"
        );
    }

    #[test]
    fn asset_package_roundtrip() {
        package_roundtrip(ASSET_PACKAGE_TYPE);
    }

    #[test]
    fn project_archive_roundtrip() {
        package_roundtrip(PROJECT_PACKAGE_TYPE);
    }
}
