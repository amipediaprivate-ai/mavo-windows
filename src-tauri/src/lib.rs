use ignore::{WalkBuilder, WalkState};
use rusqlite::{params, params_from_iter, types::Value, Connection};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    collections::hash_map::DefaultHasher,
    fs,
    hash::{Hash, Hasher},
    path::{Path, PathBuf},
    process::Command,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        mpsc::{sync_channel, Receiver},
        Arc, Mutex,
    },
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tauri::{ipc::{Channel, Response}, AppHandle, Manager, State};
use image::{DynamicImage, GenericImageView, ImageBuffer, ImageFormat, ImageReader, Rgba};
use psd::Psd;

static NEXT_SCAN_ID: AtomicU64 = AtomicU64::new(1);

const MAX_PSD_FILE_BYTES: u64 = 1024 * 1024 * 1024;
const MAX_PSD_PREVIEW_PIXELS: u64 = 64 * 1024 * 1024;

const ASSET_EXTENSIONS: &[&str] = &[
    "3ds", "aac", "ai", "aif", "aiff", "ase", "aseprite", "avif", "avi", "blend",
    "bmp", "cdr", "clip", "dae", "dng", "eps", "exr", "fbx", "fig", "flac", "flv",
    "gif", "glb", "gltf", "hdr", "heic", "heif", "ico", "indd", "jpeg", "jpg", "kra",
    "m4a", "m4v", "max", "mkv", "mov", "mp3", "mp4", "obj", "ogg", "otf", "pdf",
    "png", "psb", "psd", "raw", "sketch", "svg", "tga", "tif", "tiff", "ttf", "wav",
    "webm", "webp", "wma", "wmv", "woff", "woff2", "xd",
];

#[derive(Clone, Default)]
struct ScanManager {
    jobs: Arc<Mutex<HashMap<String, Arc<AtomicBool>>>>,
}

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
enum ScanScope {
    Computer,
    Folder,
}

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
enum ScanSpeed {
    Slow,
    Fast,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ScanRequest {
    scope: ScanScope,
    paths: Vec<String>,
    speed: ScanSpeed,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ScanRoot {
    path: String,
    label: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ScanEvent {
    event_type: String,
    scan_id: String,
    scanned_count: u64,
    matched_count: u64,
    error_count: u64,
    current_path: Option<String>,
    elapsed_ms: u64,
    message: Option<String>,
}

impl ScanEvent {
    fn new(event_type: &str, scan_id: &str, counters: &ScanCounters, started: Instant) -> Self {
        Self {
            event_type: event_type.to_string(),
            scan_id: scan_id.to_string(),
            scanned_count: counters.scanned.load(Ordering::Relaxed),
            matched_count: counters.matched.load(Ordering::Relaxed),
            error_count: counters.errors.load(Ordering::Relaxed),
            current_path: None,
            elapsed_ms: started.elapsed().as_millis() as u64,
            message: None,
        }
    }
}

#[derive(Default)]
struct ScanCounters {
    scanned: AtomicU64,
    matched: AtomicU64,
    errors: AtomicU64,
    last_progress_at: AtomicU64,
}

#[derive(Clone)]
struct IndexedFile {
    path: String,
    name: String,
    extension: String,
    size_bytes: u64,
    modified_ms: u64,
    root: String,
    kind: String,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct AssetQuery {
    offset: Option<u32>,
    limit: Option<u32>,
    query: Option<String>,
    kinds: Option<Vec<String>>,
    extensions: Option<Vec<String>>,
    folders: Option<Vec<String>>,
    sort: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct IndexedAssetSummary {
    id: i64,
    path: String,
    name: String,
    format: String,
    kind: String,
    size_bytes: i64,
    modified_ms: i64,
    indexed_at_ms: i64,
    folder: String,
    width: Option<i64>,
    height: Option<i64>,
    duration_ms: Option<i64>,
    thumbnail_path: Option<String>,
    metadata_status: String,
    availability: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AssetPage {
    items: Vec<IndexedAssetSummary>,
    next_offset: Option<u32>,
    total: u64,
}

fn asset_kind(extension: &str) -> &'static str {
    match extension {
        "gif" | "ase" | "aseprite" => "动图",
        "mp4" | "mov" | "mkv" | "avi" | "webm" | "wmv" | "m4v" | "flv" => "视频",
        "mp3" | "wav" | "flac" | "aac" | "ogg" | "m4a" | "aif" | "aiff" | "wma" => "音频",
        "fbx" | "obj" | "glb" | "gltf" | "blend" | "3ds" | "dae" | "max" => "3D 模型",
        "ttf" | "otf" | "woff" | "woff2" => "字体",
        "pdf" => "文档",
        "png" | "jpg" | "jpeg" | "webp" | "bmp" | "tif" | "tiff" | "avif"
        | "heic" | "heif" | "dng" | "raw" | "tga" | "hdr" | "exr" | "ico" => "图片",
        _ => "设计文件",
    }
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn create_scan_id() -> String {
    format!(
        "scan-{}-{}",
        now_ms(),
        NEXT_SCAN_ID.fetch_add(1, Ordering::Relaxed)
    )
}

#[cfg(windows)]
fn available_scan_roots() -> Vec<ScanRoot> {
    use std::{ffi::OsStr, iter::once, os::windows::ffi::OsStrExt};
    use windows_sys::Win32::Storage::FileSystem::{GetDriveTypeW, GetLogicalDrives};

    const DRIVE_FIXED: u32 = 3;

    let mask = unsafe { GetLogicalDrives() };
    (0..26)
        .filter_map(|index| {
            if mask & (1 << index) == 0 {
                return None;
            }
            let letter = (b'A' + index as u8) as char;
            let path = format!("{letter}:\\");
            let wide: Vec<u16> = OsStr::new(&path).encode_wide().chain(once(0)).collect();
            let drive_type = unsafe { GetDriveTypeW(wide.as_ptr()) };
            (drive_type == DRIVE_FIXED).then(|| ScanRoot {
                label: format!("本地磁盘 ({letter}:)"),
                path,
            })
        })
        .collect()
}

#[cfg(not(windows))]
fn available_scan_roots() -> Vec<ScanRoot> {
    vec![ScanRoot {
        path: "/".to_string(),
        label: "系统磁盘".to_string(),
    }]
}

#[cfg(windows)]
fn enter_background_mode() {
    use windows_sys::Win32::System::Threading::{GetCurrentThread, SetThreadPriority};
    const THREAD_MODE_BACKGROUND_BEGIN: i32 = 0x0001_0000;
    unsafe {
        SetThreadPriority(GetCurrentThread(), THREAD_MODE_BACKGROUND_BEGIN);
    }
}

#[cfg(not(windows))]
fn enter_background_mode() {}

fn resolve_roots(request: &ScanRequest) -> Result<Vec<PathBuf>, String> {
    let roots: Vec<PathBuf> = match request.scope {
        ScanScope::Computer => available_scan_roots()
            .into_iter()
            .map(|root| PathBuf::from(root.path))
            .collect(),
        ScanScope::Folder => request.paths.iter().map(PathBuf::from).collect(),
    };

    if roots.is_empty() {
        return Err("没有找到可以扫描的位置".to_string());
    }

    for root in &roots {
        if !root.is_dir() {
            return Err(format!("扫描文件夹不存在或无法访问：{}", root.display()));
        }
    }

    Ok(roots)
}

fn setup_database(path: &Path) -> Result<Connection, String> {
    let connection = Connection::open(path).map_err(|error| error.to_string())?;
    connection
        .busy_timeout(Duration::from_secs(5))
        .map_err(|error| error.to_string())?;
    connection
        .execute_batch(
            "PRAGMA journal_mode = WAL;
             PRAGMA synchronous = NORMAL;
             CREATE TABLE IF NOT EXISTS scan_runs (
               id TEXT PRIMARY KEY,
               scope TEXT NOT NULL,
               speed TEXT NOT NULL,
               started_at_ms INTEGER NOT NULL,
               finished_at_ms INTEGER,
               status TEXT NOT NULL,
               scanned_count INTEGER NOT NULL DEFAULT 0,
               matched_count INTEGER NOT NULL DEFAULT 0,
               error_count INTEGER NOT NULL DEFAULT 0
             );
             CREATE TABLE IF NOT EXISTS indexed_assets (
               path TEXT PRIMARY KEY,
               name TEXT NOT NULL,
               extension TEXT NOT NULL,
               size_bytes INTEGER NOT NULL,
               modified_ms INTEGER NOT NULL,
               scan_root TEXT NOT NULL,
               last_scan_id TEXT NOT NULL,
               indexed_at_ms INTEGER NOT NULL
             );
             CREATE INDEX IF NOT EXISTS indexed_assets_extension_idx ON indexed_assets(extension);
             CREATE INDEX IF NOT EXISTS indexed_assets_scan_root_idx ON indexed_assets(scan_root);",
        )
        .map_err(|error| error.to_string())?;
    migrate_indexed_assets(&connection)?;
    Ok(connection)
}

fn migrate_indexed_assets(connection: &Connection) -> Result<(), String> {
    let mut statement = connection
        .prepare("PRAGMA table_info(indexed_assets)")
        .map_err(|error| error.to_string())?;
    let columns = statement
        .query_map([], |row| row.get::<_, String>(1))
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    drop(statement);

    let kind_was_missing = !columns.iter().any(|column| column == "kind");
    let additions = [
        ("kind", "TEXT NOT NULL DEFAULT '设计文件'"),
        ("width", "INTEGER"),
        ("height", "INTEGER"),
        ("duration_ms", "INTEGER"),
        ("thumbnail_path", "TEXT"),
        ("metadata_status", "TEXT NOT NULL DEFAULT 'pending'"),
        ("availability", "TEXT NOT NULL DEFAULT 'available'"),
    ];
    for (name, definition) in additions {
        if !columns.iter().any(|column| column == name) {
            connection
                .execute_batch(&format!("ALTER TABLE indexed_assets ADD COLUMN {name} {definition};"))
                .map_err(|error| error.to_string())?;
        }
    }
    if kind_was_missing {
        let mut statement = connection
            .prepare("UPDATE indexed_assets SET kind = ?1 WHERE extension = ?2")
            .map_err(|error| error.to_string())?;
        for extension in ASSET_EXTENSIONS {
            statement
                .execute(params![asset_kind(extension), extension])
                .map_err(|error| error.to_string())?;
        }
    }
    connection
        .execute_batch(
            "CREATE INDEX IF NOT EXISTS indexed_assets_kind_idx ON indexed_assets(kind);
             CREATE INDEX IF NOT EXISTS indexed_assets_availability_idx ON indexed_assets(availability);
             CREATE INDEX IF NOT EXISTS indexed_assets_modified_idx ON indexed_assets(modified_ms DESC);",
        )
        .map_err(|error| error.to_string())?;
    Ok(())
}

fn write_indexed_files(
    database_path: PathBuf,
    receiver: Receiver<IndexedFile>,
    scan_id: String,
    counters: Arc<ScanCounters>,
    started: Instant,
    on_event: Channel<ScanEvent>,
) -> Result<(), String> {
    let mut connection = setup_database(&database_path)?;
    let mut batch = Vec::with_capacity(500);

    while let Ok(file) = receiver.recv() {
        batch.push(file);
        if batch.len() >= 500 {
            flush_batch(&mut connection, &scan_id, &mut batch)?;
            let _ = on_event.send(ScanEvent::new("assetsCommitted", &scan_id, &counters, started));
        }
    }

    if !batch.is_empty() {
        flush_batch(&mut connection, &scan_id, &mut batch)?;
        let _ = on_event.send(ScanEvent::new("assetsCommitted", &scan_id, &counters, started));
    }
    Ok(())
}

fn flush_batch(
    connection: &mut Connection,
    scan_id: &str,
    batch: &mut Vec<IndexedFile>,
) -> Result<(), String> {
    if batch.is_empty() {
        return Ok(());
    }

    let transaction = connection.transaction().map_err(|error| error.to_string())?;
    {
        let mut statement = transaction
            .prepare_cached(
                "INSERT INTO indexed_assets
                 (path, name, extension, size_bytes, modified_ms, scan_root, last_scan_id, indexed_at_ms, kind, availability)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 'available')
                 ON CONFLICT(path) DO UPDATE SET
                   name = excluded.name,
                   extension = excluded.extension,
                   size_bytes = excluded.size_bytes,
                   thumbnail_path = CASE WHEN indexed_assets.modified_ms <> excluded.modified_ms THEN NULL ELSE indexed_assets.thumbnail_path END,
                   width = CASE WHEN indexed_assets.modified_ms <> excluded.modified_ms THEN NULL ELSE indexed_assets.width END,
                   height = CASE WHEN indexed_assets.modified_ms <> excluded.modified_ms THEN NULL ELSE indexed_assets.height END,
                   metadata_status = CASE WHEN indexed_assets.modified_ms <> excluded.modified_ms THEN 'pending' ELSE indexed_assets.metadata_status END,
                   modified_ms = excluded.modified_ms,
                   scan_root = excluded.scan_root,
                   last_scan_id = excluded.last_scan_id,
                   indexed_at_ms = excluded.indexed_at_ms,
                   kind = excluded.kind,
                   availability = 'available'",
            )
            .map_err(|error| error.to_string())?;
        let indexed_at = now_ms();
        for file in batch.drain(..) {
            statement
                .execute(params![
                    file.path,
                    file.name,
                    file.extension,
                    file.size_bytes as i64,
                    file.modified_ms as i64,
                    file.root,
                    scan_id,
                    indexed_at as i64,
                    file.kind,
                ])
                .map_err(|error| error.to_string())?;
        }
    }
    transaction.commit().map_err(|error| error.to_string())
}

#[tauri::command]
fn list_indexed_assets(query: AssetQuery, app: AppHandle) -> Result<AssetPage, String> {
    let app_data_dir = app.path().app_data_dir().map_err(|error| error.to_string())?;
    fs::create_dir_all(&app_data_dir).map_err(|error| error.to_string())?;
    let connection = setup_database(&app_data_dir.join("mavo-index.sqlite3"))?;
    let limit = query.limit.unwrap_or(200).clamp(1, 500);
    let offset = query.offset.unwrap_or(0);
    let mut where_parts = vec!["availability = 'available'".to_string()];
    let mut values: Vec<Value> = Vec::new();

    if let Some(search) = query.query.as_deref().map(str::trim).filter(|value| !value.is_empty()) {
        where_parts.push("(name LIKE ? OR path LIKE ?)".to_string());
        let pattern = format!("%{search}%");
        values.push(Value::Text(pattern.clone()));
        values.push(Value::Text(pattern));
    }
    if let Some(kinds) = query.kinds.filter(|items| !items.is_empty()) {
        where_parts.push(format!("kind IN ({})", vec!["?"; kinds.len()].join(",")));
        values.extend(kinds.into_iter().map(Value::Text));
    }
    if let Some(extensions) = query.extensions.filter(|items| !items.is_empty()) {
        where_parts.push(format!("extension IN ({})", vec!["?"; extensions.len()].join(",")));
        values.extend(extensions.into_iter().map(|value| Value::Text(value.to_ascii_lowercase())));
    }
    if let Some(folders) = query.folders.filter(|items| !items.is_empty()) {
        let clauses = vec!["path LIKE ?"; folders.len()].join(" OR ");
        where_parts.push(format!("({clauses})"));
        values.extend(folders.into_iter().map(|folder| Value::Text(format!("{folder}%"))));
    }

    let where_sql = where_parts.join(" AND ");
    let total: i64 = connection
        .query_row(
            &format!("SELECT COUNT(*) FROM indexed_assets WHERE {where_sql}"),
            params_from_iter(values.iter()),
            |row| row.get(0),
        )
        .map_err(|error| error.to_string())?;
    let order_sql = match query.sort.as_deref() {
        Some("name") => "name COLLATE NOCASE ASC, path ASC",
        Some("size") => "size_bytes DESC, path ASC",
        _ => "modified_ms DESC, path ASC",
    };
    let sql = format!(
        "SELECT rowid, path, name, extension, kind, size_bytes, modified_ms, indexed_at_ms,
                width, height, duration_ms, thumbnail_path, metadata_status, availability
         FROM indexed_assets WHERE {where_sql} ORDER BY {order_sql} LIMIT ? OFFSET ?"
    );
    let mut page_values = values;
    page_values.push(Value::Integer(limit as i64));
    page_values.push(Value::Integer(offset as i64));
    let mut statement = connection.prepare(&sql).map_err(|error| error.to_string())?;
    let rows = statement
        .query_map(params_from_iter(page_values.iter()), |row| {
            let path: String = row.get(1)?;
            let folder = Path::new(&path)
                .parent()
                .map(|value| value.to_string_lossy().into_owned())
                .unwrap_or_default();
            Ok(IndexedAssetSummary {
                id: row.get(0)?,
                path,
                name: row.get(2)?,
                format: row.get::<_, String>(3)?.to_ascii_uppercase(),
                kind: row.get(4)?,
                size_bytes: row.get(5)?,
                modified_ms: row.get(6)?,
                indexed_at_ms: row.get(7)?,
                folder,
                width: row.get(8)?,
                height: row.get(9)?,
                duration_ms: row.get(10)?,
                thumbnail_path: row.get(11)?,
                metadata_status: row.get(12)?,
                availability: row.get(13)?,
            })
        })
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    let consumed = offset.saturating_add(rows.len() as u32);
    Ok(AssetPage {
        items: rows,
        next_offset: (consumed < total as u32).then_some(consumed),
        total: total as u64,
    })
}

fn indexed_asset_path(asset_id: i64, app: &AppHandle) -> Result<PathBuf, String> {
    let app_data_dir = app.path().app_data_dir().map_err(|error| error.to_string())?;
    let connection = setup_database(&app_data_dir.join("mavo-index.sqlite3"))?;
    let path: String = connection
        .query_row(
            "SELECT path FROM indexed_assets WHERE rowid = ?1 AND availability = 'available'",
            params![asset_id],
            |row| row.get(0),
        )
        .map_err(|_| "资源不存在或已不可用".to_string())?;
    let path = PathBuf::from(path);
    if !path.is_file() {
        return Err("原始文件不存在或无法访问".to_string());
    }
    Ok(path)
}

#[tauri::command]
fn read_asset_preview(asset_id: i64, app: AppHandle) -> Result<Response, String> {
    let path = indexed_asset_path(asset_id, &app)?;
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    let bytes = if matches!(extension.as_str(), "psd" | "tif" | "tiff") {
        let image = decode_preview(&path)?;
        let mut cursor = std::io::Cursor::new(Vec::new());
        image
            .write_to(&mut cursor, ImageFormat::Png)
            .map_err(|error| error.to_string())?;
        cursor.into_inner()
    } else {
        fs::read(&path).map_err(|error| error.to_string())?
    };
    Ok(Response::new(bytes))
}

#[tauri::command]
fn open_asset_original(asset_id: i64, app: AppHandle) -> Result<(), String> {
    let path = indexed_asset_path(asset_id, &app)?;

    #[cfg(target_os = "windows")]
    Command::new("rundll32.exe")
        .arg("url.dll,FileProtocolHandler")
        .arg(&path)
        .spawn()
        .map_err(|error| format!("无法调用系统查看器：{error}"))?;

    #[cfg(target_os = "macos")]
    Command::new("open")
        .arg(&path)
        .spawn()
        .map_err(|error| format!("无法调用系统查看器：{error}"))?;

    #[cfg(all(unix, not(target_os = "macos")))]
    Command::new("xdg-open")
        .arg(&path)
        .spawn()
        .map_err(|error| format!("无法调用系统查看器：{error}"))?;

    Ok(())
}

#[tauri::command]
fn open_asset_folder(asset_id: i64, app: AppHandle) -> Result<(), String> {
    let path = indexed_asset_path(asset_id, &app)?;
    let folder = path.parent().ok_or_else(|| "无法确定所属文件夹".to_string())?;

    #[cfg(target_os = "windows")]
    Command::new("explorer.exe")
        .arg(folder)
        .spawn()
        .map_err(|error| format!("无法打开所属文件夹：{error}"))?;

    #[cfg(target_os = "macos")]
    Command::new("open")
        .arg(folder)
        .spawn()
        .map_err(|error| format!("无法打开所属文件夹：{error}"))?;

    #[cfg(all(unix, not(target_os = "macos")))]
    Command::new("xdg-open")
        .arg(folder)
        .spawn()
        .map_err(|error| format!("无法打开所属文件夹：{error}"))?;

    Ok(())
}

fn finish_scan_run(
    database_path: &Path,
    scan_id: &str,
    status: &str,
    counters: &ScanCounters,
) -> Result<(), String> {
    let connection = setup_database(database_path)?;
    connection
        .execute(
            "UPDATE scan_runs SET finished_at_ms = ?1, status = ?2,
             scanned_count = ?3, matched_count = ?4, error_count = ?5 WHERE id = ?6",
            params![
                now_ms() as i64,
                status,
                counters.scanned.load(Ordering::Relaxed) as i64,
                counters.matched.load(Ordering::Relaxed) as i64,
                counters.errors.load(Ordering::Relaxed) as i64,
                scan_id,
            ],
        )
        .map_err(|error| error.to_string())?;
    Ok(())
}

fn mark_missing_assets(database_path: &Path, roots: &[PathBuf], scan_id: &str) -> Result<(), String> {
    let mut connection = setup_database(database_path)?;
    let transaction = connection.transaction().map_err(|error| error.to_string())?;
    for root in roots {
        transaction
            .execute(
                "UPDATE indexed_assets SET availability = 'missing'
                 WHERE scan_root = ?1 AND last_scan_id <> ?2",
                params![root.to_string_lossy().into_owned(), scan_id],
            )
            .map_err(|error| error.to_string())?;
    }
    transaction.commit().map_err(|error| error.to_string())
}

fn decode_psd_preview(path: &Path) -> Result<DynamicImage, String> {
    let file_size = fs::metadata(path).map_err(|error| error.to_string())?.len();
    if file_size > MAX_PSD_FILE_BYTES {
        return Err("PSD file is too large to preview safely".to_string());
    }

    let bytes = fs::read(path).map_err(|error| error.to_string())?;
    let psd = Psd::from_bytes(&bytes).map_err(|error| error.to_string())?;
    let width = psd.width();
    let height = psd.height();
    let pixels = u64::from(width).saturating_mul(u64::from(height));
    if pixels > MAX_PSD_PREVIEW_PIXELS {
        return Err("PSD dimensions are too large to preview safely".to_string());
    }

    let rgba = psd.rgba();
    let buffer = ImageBuffer::<Rgba<u8>, Vec<u8>>::from_raw(width, height, rgba)
        .ok_or_else(|| "PSD composite image has an invalid pixel buffer".to_string())?;
    Ok(DynamicImage::ImageRgba8(buffer))
}

fn decode_preview(path: &Path) -> Result<DynamicImage, String> {
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default();
    if extension.eq_ignore_ascii_case("psd") {
        decode_psd_preview(path)
    } else {
        ImageReader::open(path)
            .map_err(|error| error.to_string())?
            .decode()
            .map_err(|error| error.to_string())
    }
}

fn enrich_pending_images(
    database_path: PathBuf,
    thumbnail_dir: PathBuf,
    scan_id: String,
    counters: Arc<ScanCounters>,
    started: Instant,
    on_event: Option<Channel<ScanEvent>>,
) -> Result<(), String> {
    enter_background_mode();
    fs::create_dir_all(&thumbnail_dir).map_err(|error| error.to_string())?;
    let connection = setup_database(&database_path)?;
    let paths = {
        let mut statement = connection
            .prepare(
                "SELECT path, modified_ms FROM indexed_assets
                 WHERE availability = 'available' AND metadata_status = 'pending'
                   AND (kind IN ('图片', '动图') OR extension = 'psd')",
            )
            .map_err(|error| error.to_string())?;
        let rows = statement
            .query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)))
            .map_err(|error| error.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())?;
        rows
    };

    for (index, (path, modified_ms)) in paths.into_iter().enumerate() {
        thread::sleep(Duration::from_millis(4));
        let result = decode_preview(Path::new(&path));
        match result {
            Ok(image) => {
                let (width, height) = image.dimensions();
                let mut hasher = DefaultHasher::new();
                path.hash(&mut hasher);
                modified_ms.hash(&mut hasher);
                let thumbnail_path = thumbnail_dir.join(format!("{:016x}.png", hasher.finish()));
                let thumbnail = image.thumbnail(480, 320);
                if thumbnail.save_with_format(&thumbnail_path, ImageFormat::Png).is_ok() {
                    connection
                        .execute(
                            "UPDATE indexed_assets SET width = ?1, height = ?2,
                             thumbnail_path = ?3, metadata_status = 'ready'
                             WHERE path = ?4 AND modified_ms = ?5",
                            params![
                                width as i64,
                                height as i64,
                                thumbnail_path.to_string_lossy().into_owned(),
                                path,
                                modified_ms,
                            ],
                        )
                        .map_err(|error| error.to_string())?;
                } else {
                    let _ = connection.execute(
                        "UPDATE indexed_assets SET metadata_status = 'unsupported' WHERE path = ?1",
                        params![path],
                    );
                }
            }
            Err(_) => {
                let _ = connection.execute(
                    "UPDATE indexed_assets SET metadata_status = 'unsupported' WHERE path = ?1",
                    params![path],
                );
            }
        }
        if index % 20 == 19 {
            if let Some(channel) = on_event.as_ref() {
                let _ = channel.send(ScanEvent::new("assetsCommitted", &scan_id, &counters, started));
            }
        }
    }
    if let Some(channel) = on_event {
        let _ = channel.send(ScanEvent::new("assetsCommitted", &scan_id, &counters, started));
    }
    Ok(())
}

fn run_scan(
    request: ScanRequest,
    scan_id: String,
    database_path: PathBuf,
    cancel: Arc<AtomicBool>,
    on_event: Channel<ScanEvent>,
    thumbnail_dir: Option<PathBuf>,
) -> Result<(), String> {
    let roots = resolve_roots(&request)?;
    let started = Instant::now();
    let counters = Arc::new(ScanCounters::default());
    let scope_name = match request.scope {
        ScanScope::Computer => "computer",
        ScanScope::Folder => "folder",
    };
    let speed_name = match request.speed {
        ScanSpeed::Slow => "slow",
        ScanSpeed::Fast => "fast",
    };

    let connection = setup_database(&database_path)?;
    connection
        .execute(
            "INSERT INTO scan_runs (id, scope, speed, started_at_ms, status) VALUES (?1, ?2, ?3, ?4, 'running')",
            params![scan_id, scope_name, speed_name, now_ms() as i64],
        )
        .map_err(|error| error.to_string())?;
    drop(connection);

    let mut started_event = ScanEvent::new("started", &scan_id, &counters, started);
    started_event.message = Some(format!("正在扫描 {} 个位置", roots.len()));
    let _ = on_event.send(started_event);

    let (sender, receiver) = sync_channel::<IndexedFile>(1024);
    let writer_path = database_path.clone();
    let writer_scan_id = scan_id.clone();
    let writer_counters = Arc::clone(&counters);
    let writer_channel = on_event.clone();
    let writer = thread::spawn(move || {
        write_indexed_files(
            writer_path,
            receiver,
            writer_scan_id,
            writer_counters,
            started,
            writer_channel,
        )
    });

    let mut builder = WalkBuilder::new(&roots[0]);
    for root in roots.iter().skip(1) {
        builder.add(root);
    }
    builder
        .hidden(false)
        .ignore(false)
        .git_ignore(false)
        .git_global(false)
        .git_exclude(false)
        .parents(false)
        .follow_links(false)
        .threads(match request.speed {
            ScanSpeed::Slow => 1,
            ScanSpeed::Fast => thread::available_parallelism()
                .map(|count| count.get().clamp(2, 8))
                .unwrap_or(4),
        });

    let roots = Arc::new(roots);
    let is_slow = matches!(request.speed, ScanSpeed::Slow);
    builder.build_parallel().run(|| {
        if is_slow {
            enter_background_mode();
        }
        let sender = sender.clone();
        let roots = Arc::clone(&roots);
        let counters = Arc::clone(&counters);
        let cancel = Arc::clone(&cancel);
        let on_event = on_event.clone();
        let scan_id = scan_id.clone();

        Box::new(move |entry_result| {
            if cancel.load(Ordering::Relaxed) {
                return WalkState::Quit;
            }

            if is_slow {
                thread::sleep(Duration::from_millis(2));
            }

            let entry = match entry_result {
                Ok(entry) => entry,
                Err(_) => {
                    counters.errors.fetch_add(1, Ordering::Relaxed);
                    return WalkState::Continue;
                }
            };

            if !entry.file_type().is_some_and(|file_type| file_type.is_file()) {
                return WalkState::Continue;
            }

            let scanned = counters.scanned.fetch_add(1, Ordering::Relaxed) + 1;
            let path = entry.path();
            let extension = path
                .extension()
                .and_then(|value| value.to_str())
                .map(str::to_ascii_lowercase);

            if let Some(extension) = extension.filter(|extension| {
                ASSET_EXTENSIONS.contains(&extension.as_str())
            }) {
                match entry.metadata() {
                    Ok(metadata) => {
                        let modified_ms = metadata
                            .modified()
                            .ok()
                            .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
                            .map(|duration| duration.as_millis() as u64)
                            .unwrap_or_default();
                        let root = roots
                            .iter()
                            .filter(|root| path.starts_with(root))
                            .max_by_key(|root| root.components().count())
                            .map(|root| root.to_string_lossy().into_owned())
                            .unwrap_or_default();
                        let file = IndexedFile {
                            path: path.to_string_lossy().into_owned(),
                            name: path
                                .file_name()
                                .map(|name| name.to_string_lossy().into_owned())
                                .unwrap_or_default(),
                            kind: asset_kind(&extension).to_string(),
                            extension,
                            size_bytes: metadata.len(),
                            modified_ms,
                            root,
                        };
                        if sender.send(file).is_err() {
                            cancel.store(true, Ordering::Relaxed);
                            return WalkState::Quit;
                        }
                        counters.matched.fetch_add(1, Ordering::Relaxed);
                    }
                    Err(_) => {
                        counters.errors.fetch_add(1, Ordering::Relaxed);
                    }
                }
            }

            let interval = if is_slow { 100 } else { 500 };
            let previous_progress = counters.last_progress_at.load(Ordering::Relaxed);
            if scanned >= previous_progress + interval
                && counters
                    .last_progress_at
                    .compare_exchange(
                        previous_progress,
                        scanned,
                        Ordering::Relaxed,
                        Ordering::Relaxed,
                    )
                    .is_ok()
            {
                let mut event = ScanEvent::new("progress", &scan_id, &counters, started);
                event.current_path = Some(path.to_string_lossy().into_owned());
                let _ = on_event.send(event);
            }

            WalkState::Continue
        })
    });

    drop(sender);
    writer
        .join()
        .map_err(|_| "索引写入线程异常退出".to_string())??;

    let status = if cancel.load(Ordering::Relaxed) {
        "cancelled"
    } else {
        "finished"
    };
    if status == "finished" && counters.errors.load(Ordering::Relaxed) == 0 {
        mark_missing_assets(&database_path, roots.as_ref(), &scan_id)?;
    }
    finish_scan_run(&database_path, &scan_id, status, &counters)?;

    // Cancellation preserves every committed asset, so those assets still need the
    // same background metadata and thumbnail enrichment as a completed scan.
    if let Some(thumbnail_dir) = thumbnail_dir {
        let enrichment_database = database_path.clone();
        let enrichment_scan_id = scan_id.clone();
        let enrichment_counters = Arc::clone(&counters);
        let enrichment_channel = on_event.clone();
        thread::spawn(move || {
            let _ = enrich_pending_images(
                enrichment_database,
                thumbnail_dir,
                enrichment_scan_id,
                enrichment_counters,
                started,
                Some(enrichment_channel),
            );
        });
    }

    let mut final_event = ScanEvent::new(status, &scan_id, &counters, started);
    final_event.message = Some(if status == "finished" {
        "扫描完成，资源已写入本地索引".to_string()
    } else {
        "扫描已取消，已发现的资源仍保留在索引中".to_string()
    });
    let _ = on_event.send(final_event);
    Ok(())
}

#[tauri::command]
fn list_scan_roots() -> Vec<ScanRoot> {
    available_scan_roots()
}

#[tauri::command]
fn start_scan(
    request: ScanRequest,
    on_event: Channel<ScanEvent>,
    app: AppHandle,
    manager: State<'_, ScanManager>,
) -> Result<String, String> {
    let scan_id = create_scan_id();
    let cancel = Arc::new(AtomicBool::new(false));
    manager
        .jobs
        .lock()
        .map_err(|_| "扫描任务状态不可用".to_string())?
        .insert(scan_id.clone(), Arc::clone(&cancel));

    let app_data_dir = app.path().app_data_dir().map_err(|error| error.to_string())?;
    fs::create_dir_all(&app_data_dir).map_err(|error| error.to_string())?;
    let database_path = app_data_dir.join("mavo-index.sqlite3");
    let thumbnail_dir = app_data_dir.join("thumbnails");
    let manager = manager.inner().clone();
    let worker_scan_id = scan_id.clone();
    let failure_channel = on_event.clone();
    let failure_database_path = database_path.clone();

    tauri::async_runtime::spawn_blocking(move || {
        if let Err(error) = run_scan(
            request,
            worker_scan_id.clone(),
            database_path,
            cancel,
            on_event,
            Some(thumbnail_dir),
        ) {
            if let Ok(connection) = setup_database(&failure_database_path) {
                let _ = connection.execute(
                    "UPDATE scan_runs SET finished_at_ms = ?1, status = 'failed' WHERE id = ?2",
                    params![now_ms() as i64, worker_scan_id],
                );
            }
            let _ = failure_channel.send(ScanEvent {
                event_type: "failed".to_string(),
                scan_id: worker_scan_id.clone(),
                scanned_count: 0,
                matched_count: 0,
                error_count: 1,
                current_path: None,
                elapsed_ms: 0,
                message: Some(error),
            });
        }
        if let Ok(mut jobs) = manager.jobs.lock() {
            jobs.remove(&worker_scan_id);
        }
    });

    Ok(scan_id)
}

#[tauri::command]
fn cancel_scan(scan_id: String, manager: State<'_, ScanManager>) -> Result<(), String> {
    let jobs = manager
        .jobs
        .lock()
        .map_err(|_| "扫描任务状态不可用".to_string())?;
    let cancel = jobs
        .get(&scan_id)
        .ok_or_else(|| "扫描任务已经结束".to_string())?;
    cancel.store(true, Ordering::Relaxed);
    Ok(())
}

#[tauri::command]
async fn enrich_pending_previews(app: AppHandle) -> Result<(), String> {
    let app_data_dir = app.path().app_data_dir().map_err(|error| error.to_string())?;
    fs::create_dir_all(&app_data_dir).map_err(|error| error.to_string())?;
    let database_path = app_data_dir.join("mavo-index.sqlite3");
    let thumbnail_dir = app_data_dir.join("thumbnails");
    tauri::async_runtime::spawn_blocking(move || {
        enrich_pending_images(
            database_path,
            thumbnail_dir,
            "startup-preview-backfill".to_string(),
            Arc::new(ScanCounters::default()),
            Instant::now(),
            None,
        )
    })
    .await
    .map_err(|error| error.to_string())?
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(ScanManager::default())
        .invoke_handler(tauri::generate_handler![
            list_scan_roots,
            list_indexed_assets,
            read_asset_preview,
            open_asset_original,
            open_asset_folder,
            enrich_pending_previews,
            start_scan,
            cancel_scan
        ])
        .run(tauri::generate_context!())
        .expect("error while running Mavo");
}

#[cfg(test)]
mod tests {
    use super::*;
    use tauri::ipc::InvokeResponseBody;

    fn test_workspace(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!("mavo-{name}-{}", create_scan_id()))
    }

    #[test]
    fn folder_scan_indexes_supported_assets_in_sqlite() {
        let workspace = test_workspace("folder-scan");
        let source = workspace.join("source");
        fs::create_dir_all(source.join("nested")).unwrap();
        fs::write(source.join("cover.PNG"), b"image metadata placeholder").unwrap();
        fs::write(source.join("nested").join("notes.txt"), b"not an asset").unwrap();
        fs::write(source.join("nested").join("sound.wav"), b"audio metadata placeholder").unwrap();

        let database = workspace.join("index.sqlite3");
        let scan_id = create_scan_id();
        let event_channel = Channel::<ScanEvent>::new(|_body: InvokeResponseBody| Ok(()));
        run_scan(
            ScanRequest {
                scope: ScanScope::Folder,
                paths: vec![source.to_string_lossy().into_owned()],
                speed: ScanSpeed::Fast,
            },
            scan_id.clone(),
            database.clone(),
            Arc::new(AtomicBool::new(false)),
            event_channel,
            None,
        )
        .unwrap();

        let connection = Connection::open(database).unwrap();
        let indexed_count: i64 = connection
            .query_row("SELECT COUNT(*) FROM indexed_assets", [], |row| row.get(0))
            .unwrap();
        let status: String = connection
            .query_row(
                "SELECT status FROM scan_runs WHERE id = ?1",
                params![scan_id],
                |row| row.get(0),
            )
            .unwrap();

        assert_eq!(indexed_count, 2);
        assert_eq!(status, "finished");
        drop(connection);
        fs::remove_dir_all(workspace).unwrap();
    }

    #[test]
    fn cancelled_scan_records_cancelled_status() {
        let workspace = test_workspace("cancelled-scan");
        let source = workspace.join("source");
        fs::create_dir_all(&source).unwrap();
        fs::write(source.join("asset.png"), b"image metadata placeholder").unwrap();

        let database = workspace.join("index.sqlite3");
        let scan_id = create_scan_id();
        let cancellation = Arc::new(AtomicBool::new(true));
        let event_channel = Channel::<ScanEvent>::new(|_body: InvokeResponseBody| Ok(()));
        run_scan(
            ScanRequest {
                scope: ScanScope::Folder,
                paths: vec![source.to_string_lossy().into_owned()],
                speed: ScanSpeed::Slow,
            },
            scan_id.clone(),
            database.clone(),
            cancellation,
            event_channel,
            None,
        )
        .unwrap();

        let connection = Connection::open(database).unwrap();
        let status: String = connection
            .query_row(
                "SELECT status FROM scan_runs WHERE id = ?1",
                params![scan_id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(status, "cancelled");
        drop(connection);
        fs::remove_dir_all(workspace).unwrap();
    }

    #[test]
    fn rescan_deduplicates_and_marks_removed_assets_missing() {
        let workspace = test_workspace("rescan");
        let source = workspace.join("source");
        fs::create_dir_all(&source).unwrap();
        let retained = source.join("retained.jpg");
        let removed = source.join("removed.pdf");
        fs::write(&retained, b"image placeholder").unwrap();
        fs::write(&removed, b"pdf placeholder").unwrap();
        let database = workspace.join("index.sqlite3");

        for iteration in 0..2 {
            if iteration == 1 {
                fs::remove_file(&removed).unwrap();
            }
            let event_channel = Channel::<ScanEvent>::new(|_body: InvokeResponseBody| Ok(()));
            run_scan(
                ScanRequest {
                    scope: ScanScope::Folder,
                    paths: vec![source.to_string_lossy().into_owned()],
                    speed: ScanSpeed::Fast,
                },
                create_scan_id(),
                database.clone(),
                Arc::new(AtomicBool::new(false)),
                event_channel,
                None,
            )
            .unwrap();
        }

        let connection = Connection::open(&database).unwrap();
        let total: i64 = connection
            .query_row("SELECT COUNT(*) FROM indexed_assets", [], |row| row.get(0))
            .unwrap();
        let available: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM indexed_assets WHERE availability = 'available'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let missing: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM indexed_assets WHERE availability = 'missing'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(total, 2);
        assert_eq!(available, 1);
        assert_eq!(missing, 1);
        drop(connection);
        fs::remove_dir_all(workspace).unwrap();
    }

    #[test]
    fn image_enrichment_generates_thumbnail_and_dimensions() {
        let workspace = test_workspace("thumbnail");
        let source = workspace.join("source");
        let thumbnails = workspace.join("thumbnails");
        fs::create_dir_all(&source).unwrap();
        let image_path = source.join("preview.png");
        image::RgbImage::from_pixel(32, 18, image::Rgb([40, 90, 160]))
            .save(&image_path)
            .unwrap();
        let database = workspace.join("index.sqlite3");
        let scan_id = create_scan_id();
        let event_channel = Channel::<ScanEvent>::new(|_body: InvokeResponseBody| Ok(()));
        run_scan(
            ScanRequest {
                scope: ScanScope::Folder,
                paths: vec![source.to_string_lossy().into_owned()],
                speed: ScanSpeed::Fast,
            },
            scan_id.clone(),
            database.clone(),
            Arc::new(AtomicBool::new(false)),
            event_channel.clone(),
            None,
        )
        .unwrap();
        enrich_pending_images(
            database.clone(),
            thumbnails,
            scan_id,
            Arc::new(ScanCounters::default()),
            Instant::now(),
            Some(event_channel),
        )
        .unwrap();

        let connection = Connection::open(database).unwrap();
        let (width, height, thumbnail_path): (i64, i64, String) = connection
            .query_row(
                "SELECT width, height, thumbnail_path FROM indexed_assets WHERE path = ?1",
                params![image_path.to_string_lossy().into_owned()],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        assert_eq!((width, height), (32, 18));
        assert!(Path::new(&thumbnail_path).is_file());
        drop(connection);
        fs::remove_dir_all(workspace).unwrap();
    }

    fn write_test_psd(path: &Path, width: u32, height: u32) {
        let pixel_count = (width * height) as usize;
        let mut bytes = Vec::new();
        bytes.extend_from_slice(b"8BPS");
        bytes.extend_from_slice(&1u16.to_be_bytes());
        bytes.extend_from_slice(&[0; 6]);
        bytes.extend_from_slice(&3u16.to_be_bytes());
        bytes.extend_from_slice(&height.to_be_bytes());
        bytes.extend_from_slice(&width.to_be_bytes());
        bytes.extend_from_slice(&8u16.to_be_bytes());
        bytes.extend_from_slice(&3u16.to_be_bytes());
        bytes.extend_from_slice(&0u32.to_be_bytes());
        bytes.extend_from_slice(&0u32.to_be_bytes());
        bytes.extend_from_slice(&0u32.to_be_bytes());
        bytes.extend_from_slice(&0u16.to_be_bytes());
        bytes.extend(std::iter::repeat_n(40, pixel_count));
        bytes.extend(std::iter::repeat_n(90, pixel_count));
        bytes.extend(std::iter::repeat_n(160, pixel_count));
        fs::write(path, bytes).unwrap();
    }

    #[test]
    fn psd_enrichment_generates_thumbnail_from_composite_image() {
        let workspace = test_workspace("psd-thumbnail");
        let source = workspace.join("source");
        let thumbnails = workspace.join("thumbnails");
        fs::create_dir_all(&source).unwrap();
        let image_path = source.join("preview.psd");
        write_test_psd(&image_path, 32, 18);
        let database = workspace.join("index.sqlite3");
        let scan_id = create_scan_id();
        let event_channel = Channel::<ScanEvent>::new(|_body: InvokeResponseBody| Ok(()));
        run_scan(
            ScanRequest {
                scope: ScanScope::Folder,
                paths: vec![source.to_string_lossy().into_owned()],
                speed: ScanSpeed::Fast,
            },
            scan_id.clone(),
            database.clone(),
            Arc::new(AtomicBool::new(false)),
            event_channel.clone(),
            None,
        )
        .unwrap();
        enrich_pending_images(
            database.clone(),
            thumbnails,
            scan_id,
            Arc::new(ScanCounters::default()),
            Instant::now(),
            Some(event_channel),
        )
        .unwrap();

        let connection = Connection::open(database).unwrap();
        let (width, height, thumbnail_path, status): (i64, i64, String, String) = connection
            .query_row(
                "SELECT width, height, thumbnail_path, metadata_status FROM indexed_assets WHERE path = ?1",
                params![image_path.to_string_lossy().into_owned()],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .unwrap();
        assert_eq!((width, height), (32, 18));
        assert_eq!(status, "ready");
        assert!(Path::new(&thumbnail_path).is_file());
        drop(connection);
        fs::remove_dir_all(workspace).unwrap();
    }
}
