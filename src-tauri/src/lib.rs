use ignore::{WalkBuilder, WalkState};
use image::{DynamicImage, GenericImageView, ImageBuffer, ImageFormat, ImageReader, Rgba};
use notify::{Event, RecommendedWatcher, RecursiveMode, Watcher};
use psd::Psd;
use rusqlite::{params, params_from_iter, types::Value, Connection};
use serde::{Deserialize, Serialize};
use std::{
    any::Any,
    collections::hash_map::DefaultHasher,
    collections::{HashMap, HashSet},
    fs::{self, File},
    hash::{Hash, Hasher},
    io::Read,
    panic::{catch_unwind, AssertUnwindSafe},
    path::{Path, PathBuf},
    process::{Command, Output, Stdio},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        mpsc::{self, sync_channel, Receiver},
        Arc, Mutex, OnceLock,
    },
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tauri::{
    ipc::{Channel, Response},
    AppHandle, Emitter, Manager, State,
};

static NEXT_SCAN_ID: AtomicU64 = AtomicU64::new(1);
static MEDIA_TOOL_DIR: OnceLock<PathBuf> = OnceLock::new();

fn windowless_command(program: impl AsRef<std::ffi::OsStr>) -> Command {
    let mut command = Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;

        // Mavo is a GUI application: console child processes must stay invisible.
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    command
}

const MAX_PSD_FILE_BYTES: u64 = 1024 * 1024 * 1024;
const MAX_PSD_PREVIEW_PIXELS: u64 = 64 * 1024 * 1024;
const PREVIEW_REFRESH_INTERVAL: usize = 8;

const ASSET_EXTENSIONS: &[&str] = &[
    "3ds", "aac", "ai", "aif", "aiff", "ase", "aseprite", "avif", "avi", "blend", "bmp", "cdr",
    "clip", "dae", "dng", "eps", "exr", "fbx", "fig", "flac", "flv", "gif", "glb", "gltf", "hdr",
    "heic", "heif", "ico", "indd", "jpeg", "jpg", "kra", "m4a", "m4v", "max", "mkv", "mov", "mp3",
    "mp4", "obj", "ogg", "otf", "pdf", "png", "psb", "psd", "raw", "sketch", "svg", "tga", "tif",
    "tiff", "ttf", "wav", "webm", "webp", "wma", "wmv", "woff", "woff2", "xd",
];

#[derive(Clone, Default)]
struct ScanManager {
    jobs: Arc<Mutex<HashMap<String, Arc<AtomicBool>>>>,
}

#[derive(Clone, Default)]
struct BackgroundTaskManager {
    tasks: Arc<Mutex<HashMap<String, BackgroundTask>>>,
    enrichment_lock: Arc<Mutex<()>>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct BackgroundTask {
    id: String,
    task_type: String,
    title: String,
    status: String,
    completed: u64,
    total: Option<u64>,
    current_item: Option<String>,
    message: Option<String>,
    started_at_ms: u64,
    updated_at_ms: u64,
}

fn publish_background_task(app: &AppHandle, manager: &BackgroundTaskManager, task: BackgroundTask) {
    if let Ok(mut tasks) = manager.tasks.lock() {
        tasks.insert(task.id.clone(), task.clone());
        if tasks.len() > 24 {
            let mut completed = tasks
                .values()
                .filter(|item| item.status != "running")
                .map(|item| (item.id.clone(), item.updated_at_ms))
                .collect::<Vec<_>>();
            completed.sort_by_key(|(_, updated_at_ms)| *updated_at_ms);
            let remove_count = tasks.len().saturating_sub(24);
            for (id, _) in completed.into_iter().take(remove_count) {
                tasks.remove(&id);
            }
        }
    }
    let _ = app.emit("background-task-progress", task);
}

#[derive(Default)]
struct WatchManager {
    watcher: Mutex<Option<RecommendedWatcher>>,
    watched: Mutex<HashSet<PathBuf>>,
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

#[derive(Clone, Deserialize)]
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

#[derive(Clone, Deserialize, Serialize, Default)]
#[serde(rename_all = "camelCase")]
struct AssetQuery {
    offset: Option<u32>,
    limit: Option<u32>,
    query: Option<String>,
    kinds: Option<Vec<String>>,
    extensions: Option<Vec<String>>,
    folders: Option<Vec<String>>,
    sort: Option<String>,
    availability: Option<String>,
    duplicate_only: Option<bool>,
    min_width: Option<u32>,
    max_width: Option<u32>,
    orientation: Option<String>,
    min_duration_ms: Option<u64>,
    max_duration_ms: Option<u64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct FacetOption {
    value: String,
    count: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AssetFacets {
    kinds: Vec<FacetOption>,
    extensions: Vec<FacetOption>,
    folders: Vec<FacetOption>,
    available_count: u64,
    missing_count: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SmartView {
    id: i64,
    name: String,
    query: AssetQuery,
    updated_at_ms: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DuplicateScanSummary {
    hashed_files: u64,
    duplicate_groups: u64,
    duplicate_files: u64,
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
        "png" | "jpg" | "jpeg" | "webp" | "bmp" | "tif" | "tiff" | "avif" | "heic" | "heif"
        | "dng" | "raw" | "tga" | "hdr" | "exr" | "ico" => "图片",
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
             CREATE TABLE IF NOT EXISTS scan_roots (
               path TEXT PRIMARY KEY,
               enabled INTEGER NOT NULL DEFAULT 1,
               added_at_ms INTEGER NOT NULL
             );
             CREATE TABLE IF NOT EXISTS smart_views (
               id INTEGER PRIMARY KEY AUTOINCREMENT,
               name TEXT NOT NULL UNIQUE,
               query_json TEXT NOT NULL,
               created_at_ms INTEGER NOT NULL,
               updated_at_ms INTEGER NOT NULL
             );
             CREATE TABLE IF NOT EXISTS app_metadata (
               key TEXT PRIMARY KEY,
               value TEXT NOT NULL
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
        ("content_hash", "TEXT"),
        ("hash_modified_ms", "INTEGER"),
        ("metadata_error", "TEXT"),
    ];
    for (name, definition) in additions {
        if !columns.iter().any(|column| column == name) {
            connection
                .execute_batch(&format!(
                    "ALTER TABLE indexed_assets ADD COLUMN {name} {definition};"
                ))
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
             CREATE INDEX IF NOT EXISTS indexed_assets_modified_idx ON indexed_assets(modified_ms DESC);
             CREATE INDEX IF NOT EXISTS indexed_assets_hash_idx ON indexed_assets(content_hash);",
        )
        .map_err(|error| error.to_string())?;
    setup_fts(connection)?;
    Ok(())
}

fn setup_fts(connection: &Connection) -> Result<(), String> {
    connection
        .execute_batch(
            "CREATE VIRTUAL TABLE IF NOT EXISTS indexed_assets_fts USING fts5(
               name, path, content='indexed_assets', content_rowid='rowid', tokenize='trigram'
             );
             CREATE TRIGGER IF NOT EXISTS indexed_assets_fts_insert AFTER INSERT ON indexed_assets BEGIN
               INSERT INTO indexed_assets_fts(rowid, name, path) VALUES (new.rowid, new.name, new.path);
             END;
             CREATE TRIGGER IF NOT EXISTS indexed_assets_fts_delete AFTER DELETE ON indexed_assets BEGIN
               INSERT INTO indexed_assets_fts(indexed_assets_fts, rowid, name, path)
               VALUES ('delete', old.rowid, old.name, old.path);
             END;
             CREATE TRIGGER IF NOT EXISTS indexed_assets_fts_update AFTER UPDATE OF name, path ON indexed_assets BEGIN
               INSERT INTO indexed_assets_fts(indexed_assets_fts, rowid, name, path)
               VALUES ('delete', old.rowid, old.name, old.path);
               INSERT INTO indexed_assets_fts(rowid, name, path) VALUES (new.rowid, new.name, new.path);
             END;",
        )
        .map_err(|error| error.to_string())?;
    let initialized: bool = connection
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM app_metadata WHERE key = 'fts_initialized_v1')",
            [],
            |row| row.get(0),
        )
        .map_err(|error| error.to_string())?;
    if !initialized {
        connection
            .execute_batch("INSERT INTO indexed_assets_fts(indexed_assets_fts) VALUES('rebuild');")
            .map_err(|error| error.to_string())?;
        connection
            .execute(
                "INSERT INTO app_metadata (key, value) VALUES ('fts_initialized_v1', '1')",
                [],
            )
            .map_err(|error| error.to_string())?;
    }
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
            let _ = on_event.send(ScanEvent::new(
                "assetsCommitted",
                &scan_id,
                &counters,
                started,
            ));
        }
    }

    if !batch.is_empty() {
        flush_batch(&mut connection, &scan_id, &mut batch)?;
        let _ = on_event.send(ScanEvent::new(
            "assetsCommitted",
            &scan_id,
            &counters,
            started,
        ));
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

    let transaction = connection
        .transaction()
        .map_err(|error| error.to_string())?;
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
                   duration_ms = CASE WHEN indexed_assets.modified_ms <> excluded.modified_ms THEN NULL ELSE indexed_assets.duration_ms END,
                   content_hash = CASE WHEN indexed_assets.modified_ms <> excluded.modified_ms THEN NULL ELSE indexed_assets.content_hash END,
                   hash_modified_ms = CASE WHEN indexed_assets.modified_ms <> excluded.modified_ms THEN NULL ELSE indexed_assets.hash_modified_ms END,
                   metadata_status = CASE WHEN indexed_assets.modified_ms <> excluded.modified_ms THEN 'pending' ELSE indexed_assets.metadata_status END,
                   metadata_error = CASE WHEN indexed_assets.modified_ms <> excluded.modified_ms THEN NULL ELSE indexed_assets.metadata_error END,
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

fn build_asset_where(query: &AssetQuery) -> (String, Vec<Value>) {
    let availability = query.availability.as_deref().unwrap_or("available");
    let mut where_parts = vec!["availability = ?".to_string()];
    let mut values: Vec<Value> = vec![Value::Text(availability.to_string())];

    if let Some(search) = query
        .query
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        if search.chars().count() >= 3 {
            where_parts.push(
                "rowid IN (SELECT rowid FROM indexed_assets_fts WHERE indexed_assets_fts MATCH ?)"
                    .to_string(),
            );
            values.push(Value::Text(format!("\"{}\"", search.replace('"', "\"\""))));
        } else {
            where_parts.push("(name LIKE ? OR path LIKE ?)".to_string());
            let pattern = format!("%{search}%");
            values.push(Value::Text(pattern.clone()));
            values.push(Value::Text(pattern));
        }
    }
    if let Some(kinds) = query.kinds.as_ref().filter(|items| !items.is_empty()) {
        where_parts.push(format!("kind IN ({})", vec!["?"; kinds.len()].join(",")));
        values.extend(kinds.iter().cloned().map(Value::Text));
    }
    if let Some(extensions) = query.extensions.as_ref().filter(|items| !items.is_empty()) {
        where_parts.push(format!(
            "extension IN ({})",
            vec!["?"; extensions.len()].join(",")
        ));
        values.extend(
            extensions
                .iter()
                .map(|value| Value::Text(value.to_ascii_lowercase())),
        );
    }
    if let Some(folders) = query.folders.as_ref().filter(|items| !items.is_empty()) {
        let clauses = vec!["path LIKE ?"; folders.len()].join(" OR ");
        where_parts.push(format!("({clauses})"));
        values.extend(
            folders
                .iter()
                .map(|folder| Value::Text(format!("{folder}%"))),
        );
    }
    if let Some(min_width) = query.min_width {
        where_parts.push("width >= ?".to_string());
        values.push(Value::Integer(min_width as i64));
    }
    if let Some(max_width) = query.max_width {
        where_parts.push("width <= ?".to_string());
        values.push(Value::Integer(max_width as i64));
    }
    match query.orientation.as_deref() {
        Some("square") => where_parts.push("width IS NOT NULL AND height IS NOT NULL AND ABS(width - height) <= MAX(width, height) * 0.05".to_string()),
        Some("landscape") => where_parts.push("width > height".to_string()),
        Some("portrait") => where_parts.push("height > width".to_string()),
        Some("wide") => where_parts.push("width >= height * 2".to_string()),
        _ => {}
    }
    if let Some(min_duration_ms) = query.min_duration_ms {
        where_parts.push("duration_ms >= ?".to_string());
        values.push(Value::Integer(min_duration_ms as i64));
    }
    if let Some(max_duration_ms) = query.max_duration_ms {
        where_parts.push("duration_ms <= ?".to_string());
        values.push(Value::Integer(max_duration_ms as i64));
    }
    if query.duplicate_only.unwrap_or(false) {
        where_parts.push(
            "content_hash IS NOT NULL AND content_hash IN (
               SELECT content_hash FROM indexed_assets
               WHERE availability = 'available' AND content_hash IS NOT NULL
               GROUP BY content_hash HAVING COUNT(*) > 1
             )"
            .to_string(),
        );
    }
    (where_parts.join(" AND "), values)
}

#[tauri::command]
fn list_indexed_assets(query: AssetQuery, app: AppHandle) -> Result<AssetPage, String> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?;
    fs::create_dir_all(&app_data_dir).map_err(|error| error.to_string())?;
    let connection = setup_database(&app_data_dir.join("mavo-index.sqlite3"))?;
    let limit = query.limit.unwrap_or(200).clamp(1, 500);
    let offset = query.offset.unwrap_or(0);
    let (where_sql, values) = build_asset_where(&query);
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
        Some("duplicates") => "content_hash ASC, size_bytes DESC, path ASC",
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
    let mut statement = connection
        .prepare(&sql)
        .map_err(|error| error.to_string())?;
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

fn query_facets(
    connection: &Connection,
    column: &str,
    where_sql: &str,
    values: &[Value],
) -> Result<Vec<FacetOption>, String> {
    let sql = format!(
        "SELECT {column}, COUNT(*) FROM indexed_assets WHERE {where_sql}
         AND {column} <> '' GROUP BY {column} ORDER BY COUNT(*) DESC, {column} ASC LIMIT 200"
    );
    let mut statement = connection
        .prepare(&sql)
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map(params_from_iter(values.iter()), |row| {
            Ok(FacetOption {
                value: row.get(0)?,
                count: row.get::<_, i64>(1)? as u64,
            })
        })
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    Ok(rows)
}

#[tauri::command]
fn get_asset_facets(query: AssetQuery, app: AppHandle) -> Result<AssetFacets, String> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?;
    let connection = setup_database(&app_data_dir.join("mavo-index.sqlite3"))?;
    let mut kind_query = query.clone();
    kind_query.kinds = None;
    kind_query.availability = Some("available".to_string());
    let (kind_where, kind_values) = build_asset_where(&kind_query);
    let mut extension_query = query.clone();
    extension_query.extensions = None;
    extension_query.availability = Some("available".to_string());
    let (extension_where, extension_values) = build_asset_where(&extension_query);
    let mut folder_query = query;
    folder_query.folders = None;
    folder_query.availability = Some("available".to_string());
    let (folder_where, folder_values) = build_asset_where(&folder_query);
    let available_count: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM indexed_assets WHERE availability = 'available'",
            [],
            |row| row.get(0),
        )
        .map_err(|error| error.to_string())?;
    let missing_count: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM indexed_assets WHERE availability = 'missing'",
            [],
            |row| row.get(0),
        )
        .map_err(|error| error.to_string())?;
    Ok(AssetFacets {
        kinds: query_facets(&connection, "kind", &kind_where, &kind_values)?,
        extensions: query_facets(
            &connection,
            "extension",
            &extension_where,
            &extension_values,
        )?,
        folders: query_facets(&connection, "scan_root", &folder_where, &folder_values)?,
        available_count: available_count as u64,
        missing_count: missing_count as u64,
    })
}

#[tauri::command]
fn list_smart_views(app: AppHandle) -> Result<Vec<SmartView>, String> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?;
    let connection = setup_database(&app_data_dir.join("mavo-index.sqlite3"))?;
    let mut statement = connection
        .prepare("SELECT id, name, query_json, updated_at_ms FROM smart_views ORDER BY name COLLATE NOCASE")
        .map_err(|error| error.to_string())?;
    let views = statement
        .query_map([], |row| {
            let json: String = row.get(2)?;
            let query = serde_json::from_str(&json).unwrap_or_default();
            Ok(SmartView {
                id: row.get(0)?,
                name: row.get(1)?,
                query,
                updated_at_ms: row.get(3)?,
            })
        })
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    Ok(views)
}

#[tauri::command]
fn save_smart_view(name: String, query: AssetQuery, app: AppHandle) -> Result<(), String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("智能视图名称不能为空".to_string());
    }
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?;
    let connection = setup_database(&app_data_dir.join("mavo-index.sqlite3"))?;
    let json = serde_json::to_string(&query).map_err(|error| error.to_string())?;
    let timestamp = now_ms() as i64;
    connection
        .execute(
            "INSERT INTO smart_views (name, query_json, created_at_ms, updated_at_ms)
             VALUES (?1, ?2, ?3, ?3)
             ON CONFLICT(name) DO UPDATE SET query_json = excluded.query_json, updated_at_ms = excluded.updated_at_ms",
            params![name, json, timestamp],
        )
        .map_err(|error| error.to_string())?;
    Ok(())
}

#[tauri::command]
fn delete_smart_view(view_id: i64, app: AppHandle) -> Result<(), String> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?;
    let connection = setup_database(&app_data_dir.join("mavo-index.sqlite3"))?;
    connection
        .execute("DELETE FROM smart_views WHERE id = ?1", params![view_id])
        .map_err(|error| error.to_string())?;
    Ok(())
}

fn indexed_asset_path(asset_id: i64, app: &AppHandle) -> Result<PathBuf, String> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?;
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
    windowless_command("rundll32.exe")
        .arg("url.dll,FileProtocolHandler")
        .arg(&path)
        .spawn()
        .map_err(|error| format!("无法调用系统查看器：{error}"))?;

    #[cfg(target_os = "macos")]
    windowless_command("open")
        .arg(&path)
        .spawn()
        .map_err(|error| format!("无法调用系统查看器：{error}"))?;

    #[cfg(all(unix, not(target_os = "macos")))]
    windowless_command("xdg-open")
        .arg(&path)
        .spawn()
        .map_err(|error| format!("无法调用系统查看器：{error}"))?;

    Ok(())
}

#[tauri::command]
fn open_asset_folder(asset_id: i64, app: AppHandle) -> Result<(), String> {
    let path = indexed_asset_path(asset_id, &app)?;
    let folder = path
        .parent()
        .ok_or_else(|| "无法确定所属文件夹".to_string())?;

    #[cfg(target_os = "windows")]
    windowless_command("explorer.exe")
        .arg(folder)
        .spawn()
        .map_err(|error| format!("无法打开所属文件夹：{error}"))?;

    #[cfg(target_os = "macos")]
    windowless_command("open")
        .arg(folder)
        .spawn()
        .map_err(|error| format!("无法打开所属文件夹：{error}"))?;

    #[cfg(all(unix, not(target_os = "macos")))]
    windowless_command("xdg-open")
        .arg(folder)
        .spawn()
        .map_err(|error| format!("无法打开所属文件夹：{error}"))?;

    Ok(())
}

#[tauri::command]
fn relink_asset(
    asset_id: i64,
    new_path: String,
    app: AppHandle,
    watch_manager: State<'_, WatchManager>,
) -> Result<(), String> {
    let path = PathBuf::from(new_path.trim());
    if !path.is_file() {
        return Err("选择的文件不存在或无法访问".to_string());
    }
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    if !ASSET_EXTENSIONS.contains(&extension.as_str()) {
        return Err("选择的文件不是受支持的资产格式".to_string());
    }
    let metadata = path.metadata().map_err(|error| error.to_string())?;
    let modified_ms = metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or_default();
    let name = path
        .file_name()
        .map(|value| value.to_string_lossy().into_owned())
        .unwrap_or_default();
    let folder = path
        .parent()
        .unwrap_or(Path::new(""))
        .to_string_lossy()
        .into_owned();
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?;
    let database_path = app_data_dir.join("mavo-index.sqlite3");
    let connection = setup_database(&database_path)?;
    connection.execute(
        "UPDATE indexed_assets SET path = ?1, name = ?2, extension = ?3, kind = ?4,
         size_bytes = ?5, modified_ms = ?6, scan_root = ?7, availability = 'available',
         width = NULL, height = NULL, duration_ms = NULL, thumbnail_path = NULL,
         metadata_status = 'pending', metadata_error = NULL, content_hash = NULL, hash_modified_ms = NULL
         WHERE rowid = ?8",
        params![path.to_string_lossy().into_owned(), name, extension, asset_kind(&extension), metadata.len() as i64, modified_ms, folder, asset_id],
    ).map_err(|error| error.to_string())?;
    register_scan_roots(&database_path, &[PathBuf::from(folder)])?;
    let _ = watch_manager.watch_root(path.parent().unwrap_or(Path::new("")));
    Ok(())
}

#[tauri::command]
fn remove_asset_from_index(asset_id: i64, app: AppHandle) -> Result<(), String> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?;
    let database_path = app_data_dir.join("mavo-index.sqlite3");
    let connection = setup_database(&database_path)?;
    let thumbnail: Option<String> = connection
        .query_row(
            "SELECT thumbnail_path FROM indexed_assets WHERE rowid = ?1",
            params![asset_id],
            |row| row.get(0),
        )
        .unwrap_or(None);
    connection
        .execute(
            "DELETE FROM indexed_assets WHERE rowid = ?1",
            params![asset_id],
        )
        .map_err(|error| error.to_string())?;
    if let Some(path) = thumbnail {
        let _ = fs::remove_file(path);
    }
    Ok(())
}

fn hash_file(path: &Path) -> Result<String, String> {
    let mut file = File::open(path).map_err(|error| error.to_string())?;
    let mut hasher = blake3::Hasher::new();
    let mut buffer = [0_u8; 1024 * 1024];
    loop {
        let read = file.read(&mut buffer).map_err(|error| error.to_string())?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    Ok(hasher.finalize().to_hex().to_string())
}

#[tauri::command]
async fn scan_duplicates(app: AppHandle) -> Result<DuplicateScanSummary, String> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?;
    let database_path = app_data_dir.join("mavo-index.sqlite3");
    tauri::async_runtime::spawn_blocking(move || {
        let connection = setup_database(&database_path)?;
        let candidates: Vec<(i64, String, i64)> = {
            let mut statement = connection.prepare(
                "SELECT rowid, path, modified_ms FROM indexed_assets
                 WHERE availability = 'available' AND size_bytes IN (
                   SELECT size_bytes FROM indexed_assets WHERE availability = 'available'
                   GROUP BY size_bytes HAVING COUNT(*) > 1
                 ) ORDER BY size_bytes, path"
            ).map_err(|error| error.to_string())?;
            let rows = statement.query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
                .map_err(|error| error.to_string())?
                .collect::<Result<Vec<_>, _>>().map_err(|error| error.to_string())?;
            rows
        };
        let mut hashed_files = 0_u64;
        for (id, path, modified_ms) in candidates {
            let cached: Option<i64> = connection.query_row(
                "SELECT hash_modified_ms FROM indexed_assets WHERE rowid = ?1", params![id], |row| row.get(0)
            ).unwrap_or(None);
            if cached == Some(modified_ms) { continue; }
            if let Ok(hash) = hash_file(Path::new(&path)) {
                connection.execute(
                    "UPDATE indexed_assets SET content_hash = ?1, hash_modified_ms = ?2 WHERE rowid = ?3",
                    params![hash, modified_ms, id],
                ).map_err(|error| error.to_string())?;
                hashed_files += 1;
            }
        }
        let duplicate_groups: i64 = connection.query_row(
            "SELECT COUNT(*) FROM (SELECT content_hash FROM indexed_assets
             WHERE availability = 'available' AND content_hash IS NOT NULL
             GROUP BY content_hash HAVING COUNT(*) > 1)", [], |row| row.get(0)
        ).map_err(|error| error.to_string())?;
        let duplicate_files: i64 = connection.query_row(
            "SELECT COUNT(*) FROM indexed_assets WHERE availability = 'available' AND content_hash IN (
               SELECT content_hash FROM indexed_assets WHERE availability = 'available' AND content_hash IS NOT NULL
               GROUP BY content_hash HAVING COUNT(*) > 1)", [], |row| row.get(0)
        ).map_err(|error| error.to_string())?;
        Ok(DuplicateScanSummary { hashed_files, duplicate_groups: duplicate_groups as u64, duplicate_files: duplicate_files as u64 })
    }).await.map_err(|error| error.to_string())?
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

fn mark_missing_assets(
    database_path: &Path,
    roots: &[PathBuf],
    scan_id: &str,
) -> Result<(), String> {
    let mut connection = setup_database(database_path)?;
    let transaction = connection
        .transaction()
        .map_err(|error| error.to_string())?;
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

fn register_scan_roots(database_path: &Path, roots: &[PathBuf]) -> Result<(), String> {
    let connection = setup_database(database_path)?;
    for root in roots {
        connection
            .execute(
                "INSERT INTO scan_roots (path, enabled, added_at_ms) VALUES (?1, 1, ?2)
                 ON CONFLICT(path) DO UPDATE SET enabled = 1",
                params![root.to_string_lossy().into_owned(), now_ms() as i64],
            )
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

fn indexed_file_from_path(path: &Path, root: &Path) -> Option<IndexedFile> {
    let extension = path.extension()?.to_str()?.to_ascii_lowercase();
    if !ASSET_EXTENSIONS.contains(&extension.as_str()) {
        return None;
    }
    let metadata = path.metadata().ok()?;
    if !metadata.is_file() {
        return None;
    }
    let modified_ms = metadata
        .modified()
        .ok()?
        .duration_since(UNIX_EPOCH)
        .ok()?
        .as_millis() as u64;
    Some(IndexedFile {
        path: path.to_string_lossy().into_owned(),
        name: path.file_name()?.to_string_lossy().into_owned(),
        kind: asset_kind(&extension).to_string(),
        extension,
        size_bytes: metadata.len(),
        modified_ms,
        root: root.to_string_lossy().into_owned(),
    })
}

fn process_watched_paths(database_path: &Path, paths: &HashSet<PathBuf>) -> Result<bool, String> {
    let mut connection = setup_database(database_path)?;
    let roots: Vec<PathBuf> = {
        let mut statement = connection
            .prepare("SELECT path FROM scan_roots WHERE enabled = 1")
            .map_err(|error| error.to_string())?;
        let roots = statement
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(|error| error.to_string())?
            .filter_map(Result::ok)
            .map(PathBuf::from)
            .collect();
        roots
    };
    let mut files = Vec::new();
    let mut changed = false;
    for path in paths {
        if path.is_dir() {
            continue;
        } else if path.is_file() {
            let root = roots
                .iter()
                .filter(|root| path.starts_with(root))
                .max_by_key(|root| root.components().count());
            if let Some(file) = root.and_then(|root| indexed_file_from_path(path, root)) {
                files.push(file);
                changed = true;
            }
        } else {
            let raw = path.to_string_lossy().into_owned();
            let prefix = format!("{}%", raw.trim_end_matches(['\\', '/']));
            let count = connection
                .execute(
                    "UPDATE indexed_assets SET availability = 'missing' WHERE path = ?1 OR path LIKE ?2",
                    params![raw, prefix],
                )
                .map_err(|error| error.to_string())?;
            changed |= count > 0;
        }
    }
    if !files.is_empty() {
        flush_batch(&mut connection, "watcher", &mut files)?;
    }
    Ok(changed)
}

impl WatchManager {
    fn initialize(
        &self,
        app: AppHandle,
        database_path: PathBuf,
        thumbnail_dir: PathBuf,
        task_manager: BackgroundTaskManager,
    ) -> Result<(), String> {
        let (sender, receiver) = mpsc::channel::<Event>();
        let watcher = notify::recommended_watcher(move |result: notify::Result<Event>| {
            if let Ok(event) = result {
                let _ = sender.send(event);
            }
        })
        .map_err(|error| error.to_string())?;
        *self
            .watcher
            .lock()
            .map_err(|_| "文件监听器状态不可用".to_string())? = Some(watcher);

        thread::spawn(move || {
            while let Ok(first) = receiver.recv() {
                let mut paths: HashSet<PathBuf> = first.paths.into_iter().collect();
                while let Ok(next) = receiver.recv_timeout(Duration::from_millis(700)) {
                    paths.extend(next.paths);
                }
                if process_watched_paths(&database_path, &paths).unwrap_or(false) {
                    let task_id = format!("watcher-preview-{}", now_ms());
                    let _ = enrich_pending_images(
                        database_path.clone(),
                        thumbnail_dir.clone(),
                        task_id,
                        Arc::new(ScanCounters::default()),
                        Instant::now(),
                        None,
                        Some(app.clone()),
                        Some(task_manager.clone()),
                    );
                    let _ = app.emit("asset-index-changed", ());
                }
            }
        });
        Ok(())
    }

    fn watch_root(&self, root: &Path) -> Result<(), String> {
        let mut watched = self
            .watched
            .lock()
            .map_err(|_| "文件监听目录状态不可用".to_string())?;
        if watched.contains(root) {
            return Ok(());
        }
        let mut watcher = self
            .watcher
            .lock()
            .map_err(|_| "文件监听器状态不可用".to_string())?;
        watcher
            .as_mut()
            .ok_or_else(|| "文件监听器尚未初始化".to_string())?
            .watch(root, RecursiveMode::Recursive)
            .map_err(|error| error.to_string())?;
        watched.insert(root.to_path_buf());
        Ok(())
    }
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

fn media_thumbnail_path(thumbnail_dir: &Path, path: &str, modified_ms: i64) -> PathBuf {
    let mut hasher = DefaultHasher::new();
    path.hash(&mut hasher);
    modified_ms.hash(&mut hasher);
    thumbnail_dir.join(format!("{:016x}.png", hasher.finish()))
}

fn media_command(name: &str) -> Command {
    if let Some(directory) = MEDIA_TOOL_DIR.get() {
        let file_name = if cfg!(windows) {
            format!("{name}.exe")
        } else {
            name.to_string()
        };
        let bundled = directory.join(file_name);
        if bundled.is_file() {
            return windowless_command(bundled);
        }
    }
    windowless_command(name)
}

fn command_output_with_timeout(command: &mut Command, timeout: Duration) -> Result<Output, String> {
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = command.spawn().map_err(|error| error.to_string())?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "无法读取媒体工具输出".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "无法读取媒体工具错误信息".to_string())?;
    let stdout_reader = thread::spawn(move || {
        let mut bytes = Vec::new();
        let mut stdout = stdout;
        let _ = stdout.read_to_end(&mut bytes);
        bytes
    });
    let stderr_reader = thread::spawn(move || {
        let mut bytes = Vec::new();
        let mut stderr = stderr;
        let _ = stderr.read_to_end(&mut bytes);
        bytes
    });
    let deadline = Instant::now() + timeout;

    let status = loop {
        match child.try_wait().map_err(|error| error.to_string())? {
            Some(status) => break status,
            None if Instant::now() >= deadline => {
                let _ = child.kill();
                let _ = child.wait();
                let _ = stdout_reader.join();
                let _ = stderr_reader.join();
                return Err(format!(
                    "媒体处理超过 {} 秒，已跳过该文件",
                    timeout.as_secs()
                ));
            }
            None => thread::sleep(Duration::from_millis(50)),
        }
    };
    let stdout = stdout_reader
        .join()
        .map_err(|_| "读取媒体工具输出时发生异常".to_string())?;
    let stderr = stderr_reader
        .join()
        .map_err(|_| "读取媒体工具错误信息时发生异常".to_string())?;
    Ok(Output {
        status,
        stdout,
        stderr,
    })
}

fn panic_message(payload: Box<dyn Any + Send>) -> String {
    payload
        .downcast_ref::<String>()
        .cloned()
        .or_else(|| {
            payload
                .downcast_ref::<&str>()
                .map(|message| (*message).to_string())
        })
        .unwrap_or_else(|| "未知解码异常".to_string())
}

fn generate_image_preview(path: &Path, thumbnail_path: &Path) -> Result<(u32, u32), String> {
    catch_unwind(AssertUnwindSafe(|| {
        let image = decode_preview(path)?;
        let dimensions = image.dimensions();
        image
            .thumbnail(480, 320)
            .save_with_format(thumbnail_path, ImageFormat::Png)
            .map_err(|error| error.to_string())?;
        Ok(dimensions)
    }))
    .unwrap_or_else(|payload| Err(format!("预览解码异常：{}", panic_message(payload))))
}

fn enrich_media_file(
    path: &Path,
    kind: &str,
    thumbnail_path: &Path,
) -> Result<(Option<i64>, Option<i64>, i64, Option<String>), String> {
    let mut probe = media_command("ffprobe");
    probe
        .args([
            "-v",
            "error",
            "-show_entries",
            "stream=width,height:format=duration",
            "-of",
            "json",
        ])
        .arg(path);
    let output = command_output_with_timeout(&mut probe, Duration::from_secs(30))
        .map_err(|error| format!("ffprobe 处理失败：{error}"))?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    let value: serde_json::Value =
        serde_json::from_slice(&output.stdout).map_err(|error| error.to_string())?;
    let video_stream = value
        .get("streams")
        .and_then(|value| value.as_array())
        .and_then(|streams| {
            streams.iter().find(|stream| {
                stream
                    .get("width")
                    .and_then(|value| value.as_i64())
                    .is_some()
            })
        });
    let width = video_stream
        .and_then(|stream| stream.get("width"))
        .and_then(|value| value.as_i64());
    let height = video_stream
        .and_then(|stream| stream.get("height"))
        .and_then(|value| value.as_i64());
    let duration = value
        .get("format")
        .and_then(|format| format.get("duration"))
        .and_then(|value| {
            value
                .as_str()
                .and_then(|raw| raw.parse::<f64>().ok())
                .or_else(|| value.as_f64())
        })
        .map(|seconds| (seconds * 1000.0).round() as i64)
        .unwrap_or_default();

    let mut command = media_command("ffmpeg");
    command.args(["-nostdin", "-v", "error", "-y"]);
    if kind == "视频" {
        command.args(["-ss", "1"]).arg("-i").arg(path).args([
            "-frames:v",
            "1",
            "-vf",
            "scale=480:320:force_original_aspect_ratio=decrease",
        ]);
    } else {
        command.arg("-i").arg(path).args([
            "-filter_complex",
            "showwavespic=s=480x240:colors=4f8cff",
            "-frames:v",
            "1",
        ]);
    }
    command.arg(thumbnail_path);
    let thumbnail = command_output_with_timeout(&mut command, Duration::from_secs(60));
    let generated = thumbnail
        .ok()
        .filter(|result| result.status.success())
        .and_then(|_| {
            thumbnail_path
                .is_file()
                .then(|| thumbnail_path.to_string_lossy().into_owned())
        });
    Ok((width, height, duration, generated))
}

fn publish_enrichment_tasks(
    app: &AppHandle,
    manager: &BackgroundTaskManager,
    scan_id: &str,
    completed: u64,
    total: u64,
    current_item: Option<String>,
    status: &str,
    started_at_ms: u64,
) {
    let updated_at_ms = now_ms();
    for (task_type, title, message) in [
        ("analysis", "分析资源", "读取尺寸、时长和媒体信息"),
        ("thumbnail", "创建缩略图", "生成可视化预览"),
    ] {
        publish_background_task(
            app,
            manager,
            BackgroundTask {
                id: format!("{task_type}:{scan_id}"),
                task_type: task_type.to_string(),
                title: title.to_string(),
                status: if status == "finished" {
                    "completed".to_string()
                } else {
                    status.to_string()
                },
                completed,
                total: Some(total),
                current_item: current_item.clone(),
                message: Some(message.to_string()),
                started_at_ms,
                updated_at_ms,
            },
        );
    }
}

fn enrich_pending_images(
    database_path: PathBuf,
    thumbnail_dir: PathBuf,
    scan_id: String,
    counters: Arc<ScanCounters>,
    started: Instant,
    on_event: Option<Channel<ScanEvent>>,
    app: Option<AppHandle>,
    task_manager: Option<BackgroundTaskManager>,
) -> Result<(), String> {
    enter_background_mode();
    // Preview enrichment may be requested by startup, a completed scan, and the
    // file watcher at nearly the same time. Process one snapshot at a time so
    // workers do not decode the same files or contend over SQLite writes.
    let _enrichment_guard = task_manager.as_ref().map(|manager| {
        manager
            .enrichment_lock
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    });
    fs::create_dir_all(&thumbnail_dir).map_err(|error| error.to_string())?;
    let connection = setup_database(&database_path)?;
    let paths = {
        let mut statement = connection
            .prepare(
                "SELECT path, modified_ms, kind FROM indexed_assets
                 WHERE availability = 'available' AND metadata_status = 'pending'
                   AND (kind IN ('图片', '动图', '视频', '音频') OR extension = 'psd')
                 ORDER BY modified_ms DESC, path ASC",
            )
            .map_err(|error| error.to_string())?;
        let rows = statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, String>(2)?,
                ))
            })
            .map_err(|error| error.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())?;
        rows
    };

    let total = paths.len() as u64;
    let task_started_at_ms = now_ms();
    if total > 0 {
        if let (Some(app), Some(manager)) = (app.as_ref(), task_manager.as_ref()) {
            publish_enrichment_tasks(
                app,
                manager,
                &scan_id,
                0,
                total,
                None,
                "running",
                task_started_at_ms,
            );
        }
    }

    let mut completed = 0;
    for (index, (path, modified_ms, kind)) in paths.into_iter().enumerate() {
        thread::sleep(Duration::from_millis(4));
        let current_item = Path::new(&path)
            .file_name()
            .map(|name| name.to_string_lossy().into_owned());
        if index == 0 {
            if let (Some(app), Some(manager)) = (app.as_ref(), task_manager.as_ref()) {
                publish_enrichment_tasks(
                    app,
                    manager,
                    &scan_id,
                    0,
                    total,
                    current_item.clone(),
                    "running",
                    task_started_at_ms,
                );
            }
        }

        let item_result = if kind == "视频" || kind == "音频" {
            let thumbnail_path = media_thumbnail_path(&thumbnail_dir, &path, modified_ms);
            let enrichment = catch_unwind(AssertUnwindSafe(|| {
                enrich_media_file(Path::new(&path), &kind, &thumbnail_path)
            }))
            .unwrap_or_else(|payload| Err(format!("媒体解码异常：{}", panic_message(payload))));
            match enrichment {
                Ok((width, height, duration_ms, generated_thumbnail)) => {
                    connection
                        .execute(
                            "UPDATE indexed_assets SET width = ?1, height = ?2, duration_ms = ?3,
                         thumbnail_path = ?4, metadata_status = 'ready', metadata_error = NULL
                         WHERE path = ?5 AND modified_ms = ?6",
                            params![
                                width,
                                height,
                                duration_ms,
                                generated_thumbnail,
                                path,
                                modified_ms
                            ],
                        )
                        .map(|_| ())
                        .map_err(|error| error.to_string())
                }
                Err(error) => {
                    connection
                        .execute(
                            "UPDATE indexed_assets SET metadata_status = 'unsupported', metadata_error = ?1 WHERE path = ?2",
                            params![error, path],
                        )
                        .map(|_| ())
                        .map_err(|error| error.to_string())
                }
            }
        } else {
            let thumbnail_path = media_thumbnail_path(&thumbnail_dir, &path, modified_ms);
            match generate_image_preview(Path::new(&path), &thumbnail_path) {
                Ok((width, height)) => connection
                    .execute(
                        "UPDATE indexed_assets SET width = ?1, height = ?2,
                         thumbnail_path = ?3, metadata_status = 'ready', metadata_error = NULL
                         WHERE path = ?4 AND modified_ms = ?5",
                        params![
                            width as i64,
                            height as i64,
                            thumbnail_path.to_string_lossy().into_owned(),
                            path,
                            modified_ms,
                        ],
                    )
                    .map(|_| ())
                    .map_err(|error| error.to_string()),
                Err(error) => connection
                    .execute(
                        "UPDATE indexed_assets SET metadata_status = 'unsupported', metadata_error = ?1 WHERE path = ?2",
                        params![error, path],
                    )
                    .map(|_| ())
                    .map_err(|error| error.to_string()),
            }
        };

        if let Err(error) = item_result {
            if let (Some(app), Some(manager)) = (app.as_ref(), task_manager.as_ref()) {
                publish_enrichment_tasks(
                    app,
                    manager,
                    &scan_id,
                    completed,
                    total,
                    Some(format!("处理失败：{error}")),
                    "failed",
                    task_started_at_ms,
                );
            }
            return Err(error);
        }
        completed = (index + 1) as u64;
        if index % PREVIEW_REFRESH_INTERVAL == PREVIEW_REFRESH_INTERVAL - 1 {
            if let Some(channel) = on_event.as_ref() {
                let _ = channel.send(ScanEvent::new(
                    "assetsCommitted",
                    &scan_id,
                    &counters,
                    started,
                ));
            }
        }
        if completed == 1 || completed % 4 == 0 || completed == total {
            if let (Some(app), Some(manager)) = (app.as_ref(), task_manager.as_ref()) {
                publish_enrichment_tasks(
                    app,
                    manager,
                    &scan_id,
                    completed,
                    total,
                    current_item,
                    if completed == total {
                        "completed"
                    } else {
                        "running"
                    },
                    task_started_at_ms,
                );
            }
        }
    }
    if let Some(channel) = on_event {
        let _ = channel.send(ScanEvent::new(
            "assetsCommitted",
            &scan_id,
            &counters,
            started,
        ));
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
    app: Option<AppHandle>,
    task_manager: Option<BackgroundTaskManager>,
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
    let task_started_at_ms = now_ms();

    if let (Some(app), Some(manager)) = (app.as_ref(), task_manager.as_ref()) {
        publish_background_task(
            app,
            manager,
            BackgroundTask {
                id: format!("index:{scan_id}"),
                task_type: "index".to_string(),
                title: "建立资源索引".to_string(),
                status: "running".to_string(),
                completed: 0,
                total: None,
                current_item: None,
                message: Some("正在遍历文件并写入本地索引".to_string()),
                started_at_ms: task_started_at_ms,
                updated_at_ms: task_started_at_ms,
            },
        );
    }

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
    let progress_app = app.clone();
    let progress_task_manager = task_manager.clone();
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
        let progress_app = progress_app.clone();
        let progress_task_manager = progress_task_manager.clone();

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

            if !entry
                .file_type()
                .is_some_and(|file_type| file_type.is_file())
            {
                return WalkState::Continue;
            }

            let scanned = counters.scanned.fetch_add(1, Ordering::Relaxed) + 1;
            let path = entry.path();
            let extension = path
                .extension()
                .and_then(|value| value.to_str())
                .map(str::to_ascii_lowercase);

            if let Some(extension) =
                extension.filter(|extension| ASSET_EXTENSIONS.contains(&extension.as_str()))
            {
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
                if let (Some(app), Some(manager)) =
                    (progress_app.as_ref(), progress_task_manager.as_ref())
                {
                    publish_background_task(
                        app,
                        manager,
                        BackgroundTask {
                            id: format!("index:{scan_id}"),
                            task_type: "index".to_string(),
                            title: "建立资源索引".to_string(),
                            status: "running".to_string(),
                            completed: scanned,
                            total: None,
                            current_item: path
                                .file_name()
                                .map(|name| name.to_string_lossy().into_owned()),
                            message: Some(format!(
                                "已发现 {} 个资源",
                                counters.matched.load(Ordering::Relaxed)
                            )),
                            started_at_ms: task_started_at_ms,
                            updated_at_ms: now_ms(),
                        },
                    );
                }
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
        let enrichment_app = app.clone();
        let enrichment_task_manager = task_manager.clone();
        thread::spawn(move || {
            let _ = enrich_pending_images(
                enrichment_database,
                thumbnail_dir,
                enrichment_scan_id,
                enrichment_counters,
                started,
                Some(enrichment_channel),
                enrichment_app,
                enrichment_task_manager,
            );
        });
    }

    if let (Some(app), Some(manager)) = (app.as_ref(), task_manager.as_ref()) {
        publish_background_task(
            app,
            manager,
            BackgroundTask {
                id: format!("index:{scan_id}"),
                task_type: "index".to_string(),
                title: "建立资源索引".to_string(),
                status: if status == "finished" {
                    "completed".to_string()
                } else {
                    status.to_string()
                },
                completed: counters.scanned.load(Ordering::Relaxed),
                total: Some(counters.scanned.load(Ordering::Relaxed)),
                current_item: None,
                message: Some(format!(
                    "已索引 {} 个资源",
                    counters.matched.load(Ordering::Relaxed)
                )),
                started_at_ms: task_started_at_ms,
                updated_at_ms: now_ms(),
            },
        );
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
    watch_manager: State<'_, WatchManager>,
    task_manager: State<'_, BackgroundTaskManager>,
) -> Result<String, String> {
    let scan_id = create_scan_id();
    let cancel = Arc::new(AtomicBool::new(false));
    manager
        .jobs
        .lock()
        .map_err(|_| "扫描任务状态不可用".to_string())?
        .insert(scan_id.clone(), Arc::clone(&cancel));

    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?;
    fs::create_dir_all(&app_data_dir).map_err(|error| error.to_string())?;
    let database_path = app_data_dir.join("mavo-index.sqlite3");
    let thumbnail_dir = app_data_dir.join("thumbnails");
    let roots = resolve_roots(&request)?;
    register_scan_roots(&database_path, &roots)?;
    for root in &roots {
        let _ = watch_manager.watch_root(root);
    }
    let manager = manager.inner().clone();
    let worker_scan_id = scan_id.clone();
    let failure_channel = on_event.clone();
    let failure_database_path = database_path.clone();
    let worker_app = app.clone();
    let worker_task_manager = task_manager.inner().clone();
    let failure_app = app;
    let failure_task_manager = worker_task_manager.clone();

    tauri::async_runtime::spawn_blocking(move || {
        if let Err(error) = run_scan(
            request,
            worker_scan_id.clone(),
            database_path,
            cancel,
            on_event,
            Some(thumbnail_dir),
            Some(worker_app),
            Some(worker_task_manager),
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
            publish_background_task(
                &failure_app,
                &failure_task_manager,
                BackgroundTask {
                    id: format!("index:{worker_scan_id}"),
                    task_type: "index".to_string(),
                    title: "建立资源索引".to_string(),
                    status: "failed".to_string(),
                    completed: 0,
                    total: None,
                    current_item: None,
                    message: Some("索引任务失败".to_string()),
                    started_at_ms: now_ms(),
                    updated_at_ms: now_ms(),
                },
            );
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
async fn enrich_pending_previews(
    app: AppHandle,
    on_event: Channel<ScanEvent>,
    task_manager: State<'_, BackgroundTaskManager>,
) -> Result<(), String> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?;
    fs::create_dir_all(&app_data_dir).map_err(|error| error.to_string())?;
    let database_path = app_data_dir.join("mavo-index.sqlite3");
    let thumbnail_dir = app_data_dir.join("thumbnails");
    let task_manager = task_manager.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        enrich_pending_images(
            database_path,
            thumbnail_dir,
            "startup-preview-backfill".to_string(),
            Arc::new(ScanCounters::default()),
            Instant::now(),
            Some(on_event),
            Some(app),
            Some(task_manager),
        )
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
fn list_background_tasks(
    manager: State<'_, BackgroundTaskManager>,
) -> Result<Vec<BackgroundTask>, String> {
    let mut tasks = manager
        .tasks
        .lock()
        .map_err(|_| "后台任务状态不可用".to_string())?
        .values()
        .cloned()
        .collect::<Vec<_>>();
    tasks.sort_by(|left, right| right.updated_at_ms.cmp(&left.updated_at_ms));
    Ok(tasks)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(ScanManager::default())
        .manage(BackgroundTaskManager::default())
        .manage(WatchManager::default())
        .setup(|app| {
            let resource_media_dir = app.path().resource_dir()?.join("ffmpeg");
            let development_media_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("resources")
                .join("ffmpeg");
            for candidate in [resource_media_dir, development_media_dir] {
                if candidate.join("ffmpeg.exe").is_file() && candidate.join("ffprobe.exe").is_file()
                {
                    let _ = MEDIA_TOOL_DIR.set(candidate);
                    break;
                }
            }
            let app_data_dir = app.path().app_data_dir()?;
            fs::create_dir_all(&app_data_dir)?;
            let database_path = app_data_dir.join("mavo-index.sqlite3");
            let thumbnail_dir = app_data_dir.join("thumbnails");
            setup_database(&database_path).map_err(std::io::Error::other)?;
            let watch_manager = app.state::<WatchManager>();
            let task_manager = app.state::<BackgroundTaskManager>().inner().clone();
            watch_manager
                .initialize(
                    app.handle().clone(),
                    database_path.clone(),
                    thumbnail_dir,
                    task_manager,
                )
                .map_err(std::io::Error::other)?;
            let connection = setup_database(&database_path).map_err(std::io::Error::other)?;
            let roots: Vec<PathBuf> = {
                let mut statement =
                    connection.prepare("SELECT path FROM scan_roots WHERE enabled = 1")?;
                let roots = statement
                    .query_map([], |row| row.get::<_, String>(0))?
                    .filter_map(Result::ok)
                    .map(PathBuf::from)
                    .collect();
                roots
            };
            for root in roots.into_iter().filter(|root| root.is_dir()) {
                let _ = watch_manager.watch_root(&root);
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            list_scan_roots,
            list_indexed_assets,
            get_asset_facets,
            list_smart_views,
            save_smart_view,
            delete_smart_view,
            read_asset_preview,
            open_asset_original,
            open_asset_folder,
            relink_asset,
            remove_asset_from_index,
            scan_duplicates,
            list_background_tasks,
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
        fs::write(
            source.join("nested").join("sound.wav"),
            b"audio metadata placeholder",
        )
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
            event_channel,
            None,
            None,
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
            None,
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
                None,
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
            None,
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
            None,
            None,
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
            None,
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
            None,
            None,
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

    #[test]
    fn fts_search_finds_unicode_asset_names() {
        let workspace = test_workspace("fts-search");
        let source = workspace.join("source");
        fs::create_dir_all(&source).unwrap();
        fs::write(source.join("角色立绘最终版.png"), b"placeholder").unwrap();
        let database = workspace.join("index.sqlite3");
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
            None,
            None,
        )
        .unwrap();
        let connection = setup_database(&database).unwrap();
        let query = AssetQuery {
            query: Some("角色立".to_string()),
            ..Default::default()
        };
        let (where_sql, values) = build_asset_where(&query);
        let count: i64 = connection
            .query_row(
                &format!("SELECT COUNT(*) FROM indexed_assets WHERE {where_sql}"),
                params_from_iter(values.iter()),
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(count, 1);
        drop(connection);
        fs::remove_dir_all(workspace).unwrap();
    }

    #[test]
    fn watched_path_updates_and_marks_missing() {
        let workspace = test_workspace("watcher");
        let source = workspace.join("source");
        fs::create_dir_all(&source).unwrap();
        let asset = source.join("watched.wav");
        fs::write(&asset, b"audio").unwrap();
        let database = workspace.join("index.sqlite3");
        register_scan_roots(&database, std::slice::from_ref(&source)).unwrap();
        process_watched_paths(&database, &HashSet::from([asset.clone()])).unwrap();
        fs::remove_file(&asset).unwrap();
        process_watched_paths(&database, &HashSet::from([asset])).unwrap();
        let connection = setup_database(&database).unwrap();
        let availability: String = connection
            .query_row("SELECT availability FROM indexed_assets", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(availability, "missing");
        drop(connection);
        fs::remove_dir_all(workspace).unwrap();
    }

    #[test]
    fn content_hash_distinguishes_files() {
        let workspace = test_workspace("hash");
        fs::create_dir_all(&workspace).unwrap();
        let first = workspace.join("first.bin");
        let second = workspace.join("second.bin");
        let third = workspace.join("third.bin");
        fs::write(&first, b"same content").unwrap();
        fs::write(&second, b"same content").unwrap();
        fs::write(&third, b"different content").unwrap();
        assert_eq!(hash_file(&first).unwrap(), hash_file(&second).unwrap());
        assert_ne!(hash_file(&first).unwrap(), hash_file(&third).unwrap());
        fs::remove_dir_all(workspace).unwrap();
    }

    #[test]
    fn bundled_ffmpeg_analyzes_audio_and_generates_waveform() {
        let media_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("resources")
            .join("ffmpeg");
        if !media_dir.join("ffmpeg.exe").is_file() || !media_dir.join("ffprobe.exe").is_file() {
            return;
        }
        let _ = MEDIA_TOOL_DIR.set(media_dir);
        let workspace = test_workspace("bundled-ffmpeg");
        fs::create_dir_all(&workspace).unwrap();
        let audio = workspace.join("tone.wav");
        let thumbnail = workspace.join("waveform.png");
        let generated = media_command("ffmpeg")
            .args([
                "-v",
                "error",
                "-y",
                "-f",
                "lavfi",
                "-i",
                "sine=frequency=440:duration=0.25",
            ])
            .arg(&audio)
            .status()
            .unwrap();
        assert!(generated.success());
        let (_, _, duration_ms, thumbnail_path) =
            enrich_media_file(&audio, "音频", &thumbnail).unwrap();
        assert!(duration_ms >= 200);
        assert_eq!(
            thumbnail_path.as_deref(),
            Some(thumbnail.to_string_lossy().as_ref())
        );
        assert!(thumbnail.is_file());
        fs::remove_dir_all(workspace).unwrap();
    }
}
