use blake3::Hasher;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    fs::{self, File},
    io::{Read, Write},
    path::{Component, Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
};
use tauri::{AppHandle, Manager};

use super::{
    indexed_directory, initial_loudness_status, initial_metadata_status, normalize_directory_key,
    now_ms, setup_database, windowless_command,
};

static NEXT_PROJECT_OPERATION_ID: AtomicU64 = AtomicU64::new(1);
const DEFAULT_PROJECT_DIRECTORIES: [&str; 4] = ["image", "audio", "video", "gif"];

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProjectSummary {
    id: i64,
    name: String,
    parent_path: String,
    root_path: String,
    status: String,
    last_error: Option<String>,
    resource_count: u64,
    reference_count: u64,
    copy_count: u64,
    created_at_ms: i64,
    updated_at_ms: i64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProjectDirectory {
    relative_path: String,
    name: String,
    depth: u32,
    exists: bool,
    resource_count: u64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProjectAssetSummary {
    membership_id: i64,
    project_id: i64,
    source_asset_uid: String,
    name: String,
    format: String,
    kind: String,
    storage_mode: String,
    relative_directory: String,
    copied_relative_path: Option<String>,
    status: String,
    effective_path: String,
    thumbnail_path: Option<String>,
    size_bytes: i64,
    modified_ms: i64,
    source_changed: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AssetProjectMembership {
    id: i64,
    project_id: i64,
    project_name: String,
    project_root_path: String,
    source_asset_uid: String,
    storage_mode: String,
    relative_directory: String,
    copied_relative_path: Option<String>,
    status: String,
    source_changed: bool,
    created_at_ms: i64,
    updated_at_ms: i64,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProjectAssetAssignment {
    project_id: i64,
    storage_mode: String,
    relative_directory: Option<String>,
}

#[derive(Clone)]
struct SourceAsset {
    asset_uid: String,
    path: String,
    name: String,
    extension: String,
    kind: String,
    size_bytes: i64,
    modified_ms: i64,
    content_hash: Option<String>,
    availability: String,
}

#[derive(Clone)]
struct ProjectRecord {
    id: i64,
    name: String,
    parent_path: String,
    root_path: String,
    status: String,
}

#[derive(Clone)]
struct MembershipRecord {
    id: i64,
    project_id: i64,
    source_asset_uid: String,
    storage_mode: String,
    relative_directory: String,
    materialized_asset_uid: Option<String>,
    copied_relative_path: Option<String>,
}

pub(crate) fn initialize_projects_database(connection: &Connection) -> Result<(), String> {
    connection
        .execute_batch(
            "CREATE TABLE IF NOT EXISTS projects (
               id INTEGER PRIMARY KEY AUTOINCREMENT,
               name TEXT NOT NULL COLLATE NOCASE UNIQUE,
               parent_path TEXT NOT NULL,
               root_path TEXT NOT NULL,
               root_key TEXT NOT NULL UNIQUE,
               status TEXT NOT NULL DEFAULT 'ready'
                 CHECK (status IN ('ready', 'missing', 'moving', 'error')),
               last_error TEXT,
               created_at_ms INTEGER NOT NULL,
               updated_at_ms INTEGER NOT NULL
             );
             CREATE TABLE IF NOT EXISTS project_assets (
               id INTEGER PRIMARY KEY AUTOINCREMENT,
               project_id INTEGER NOT NULL,
               source_asset_uid TEXT NOT NULL,
               storage_mode TEXT NOT NULL
                 CHECK (storage_mode IN ('reference', 'copy')),
               relative_directory TEXT NOT NULL DEFAULT '',
               materialized_asset_uid TEXT,
               copied_relative_path TEXT,
               source_name_snapshot TEXT NOT NULL,
               source_kind_snapshot TEXT NOT NULL,
               source_format_snapshot TEXT NOT NULL,
               source_path_snapshot TEXT NOT NULL,
               source_size_at_copy INTEGER,
               source_modified_at_copy INTEGER,
               source_hash_at_copy TEXT,
               status TEXT NOT NULL DEFAULT 'ready'
                 CHECK (status IN ('ready', 'source_missing', 'copy_missing', 'copying', 'error')),
               last_error TEXT,
               created_at_ms INTEGER NOT NULL,
               updated_at_ms INTEGER NOT NULL,
               FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE,
               UNIQUE(project_id, source_asset_uid),
               CHECK (
                 (storage_mode = 'reference' AND materialized_asset_uid IS NULL AND copied_relative_path IS NULL)
                 OR
                 (storage_mode = 'copy' AND materialized_asset_uid IS NOT NULL AND copied_relative_path IS NOT NULL)
               )
             );
             CREATE TABLE IF NOT EXISTS project_file_operations (
               id TEXT PRIMARY KEY,
               project_id INTEGER NOT NULL,
               project_asset_id INTEGER,
               operation_type TEXT NOT NULL
                 CHECK (operation_type IN ('copy', 'move_copy', 'delete_copy', 'rename_project', 'move_project')),
               source_path TEXT,
               target_path TEXT,
               temp_path TEXT,
               state TEXT NOT NULL
                 CHECK (state IN ('prepared', 'files_done', 'db_done', 'failed')),
               error_message TEXT,
               created_at_ms INTEGER NOT NULL,
               updated_at_ms INTEGER NOT NULL,
               FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE CASCADE
             );
             CREATE INDEX IF NOT EXISTS projects_updated_idx
               ON projects(updated_at_ms DESC, id DESC);
             CREATE INDEX IF NOT EXISTS project_assets_project_directory_idx
               ON project_assets(project_id, relative_directory, updated_at_ms DESC);
             CREATE INDEX IF NOT EXISTS project_assets_source_idx
               ON project_assets(source_asset_uid, project_id);
             CREATE UNIQUE INDEX IF NOT EXISTS project_assets_materialized_idx
               ON project_assets(materialized_asset_uid)
               WHERE materialized_asset_uid IS NOT NULL;
             CREATE INDEX IF NOT EXISTS project_file_operations_state_idx
               ON project_file_operations(state, updated_at_ms);",
        )
        .map_err(|error| error.to_string())
}

fn project_database(app: &AppHandle) -> Result<Connection, String> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?;
    fs::create_dir_all(&app_data_dir).map_err(|error| error.to_string())?;
    setup_database(&app_data_dir.join("mavo-index.sqlite3"))
}

fn validate_project_name(value: &str) -> Result<String, String> {
    let value = value.trim();
    if value.is_empty() {
        return Err("项目名称不能为空".to_string());
    }
    if value.chars().count() > 100 {
        return Err("项目名称不能超过 100 个字符".to_string());
    }
    if value.ends_with([' ', '.'])
        || value.chars().any(|character| {
            character.is_control()
                || matches!(
                    character,
                    '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*'
                )
        })
    {
        return Err("项目名称包含 Windows 不允许的字符".to_string());
    }
    let stem = value
        .split('.')
        .next()
        .unwrap_or(value)
        .trim_end_matches('.')
        .to_ascii_uppercase();
    let reserved = [
        "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "COM5", "COM6", "COM7", "COM8",
        "COM9", "LPT1", "LPT2", "LPT3", "LPT4", "LPT5", "LPT6", "LPT7", "LPT8", "LPT9",
    ];
    if reserved.contains(&stem.as_str()) {
        return Err("项目名称是 Windows 保留名称".to_string());
    }
    Ok(value.to_string())
}

fn validate_directory_name(value: &str) -> Result<String, String> {
    validate_project_name(value).map_err(|error| error.replace("项目名称", "文件夹名称"))
}

fn canonicalize_user_path(path: &Path) -> Result<PathBuf, std::io::Error> {
    let canonical = fs::canonicalize(path)?;
    #[cfg(windows)]
    {
        let value = canonical.to_string_lossy();
        if let Some(unc) = value.strip_prefix(r"\\?\UNC\") {
            return Ok(PathBuf::from(format!(r"\\{unc}")));
        }
        if let Some(local) = value.strip_prefix(r"\\?\") {
            return Ok(PathBuf::from(local));
        }
    }
    Ok(canonical)
}

fn normalize_relative_directory(value: &str) -> Result<String, String> {
    let value = value.trim().replace('\\', "/");
    if value.is_empty() {
        return Ok(String::new());
    }
    let path = Path::new(&value);
    if path.components().any(|component| {
        matches!(
            component,
            Component::ParentDir | Component::RootDir | Component::Prefix(_) | Component::CurDir
        )
    }) {
        return Err("项目子目录路径无效".to_string());
    }
    let mut parts = Vec::new();
    for component in path.components() {
        let Component::Normal(part) = component else {
            return Err("项目子目录路径无效".to_string());
        };
        let part = part.to_string_lossy();
        parts.push(validate_directory_name(&part)?);
    }
    Ok(parts.join("/"))
}

fn path_for_relative(root: &Path, relative: &str) -> Result<PathBuf, String> {
    let relative = normalize_relative_directory(relative)?;
    let mut path = root.to_path_buf();
    for part in relative.split('/').filter(|part| !part.is_empty()) {
        path.push(part);
    }
    Ok(path)
}

fn default_directory(kind: &str) -> &'static str {
    match kind {
        "图片" => "image",
        "音频" => "audio",
        "视频" => "video",
        "动图" => "gif",
        _ => "",
    }
}

fn project_record(connection: &Connection, project_id: i64) -> Result<ProjectRecord, String> {
    connection
        .query_row(
            "SELECT id, name, parent_path, root_path, status FROM projects WHERE id = ?1",
            params![project_id],
            |row| {
                Ok(ProjectRecord {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    parent_path: row.get(2)?,
                    root_path: row.get(3)?,
                    status: row.get(4)?,
                })
            },
        )
        .optional()
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "项目不存在".to_string())
}

fn membership_record(
    connection: &Connection,
    membership_id: i64,
) -> Result<MembershipRecord, String> {
    connection
        .query_row(
            "SELECT id, project_id, source_asset_uid, storage_mode, relative_directory,
                    materialized_asset_uid, copied_relative_path
               FROM project_assets WHERE id = ?1",
            params![membership_id],
            |row| {
                Ok(MembershipRecord {
                    id: row.get(0)?,
                    project_id: row.get(1)?,
                    source_asset_uid: row.get(2)?,
                    storage_mode: row.get(3)?,
                    relative_directory: row.get(4)?,
                    materialized_asset_uid: row.get(5)?,
                    copied_relative_path: row.get(6)?,
                })
            },
        )
        .optional()
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "项目资源关系不存在".to_string())
}

fn source_asset(connection: &Connection, asset_uid: &str) -> Result<SourceAsset, String> {
    connection
        .query_row(
            "SELECT asset_uid, path, name, extension, kind, size_bytes, modified_ms,
                    content_hash, availability
               FROM indexed_assets WHERE asset_uid = ?1 AND asset_scope = 'library'",
            params![asset_uid],
            |row| {
                Ok(SourceAsset {
                    asset_uid: row.get(0)?,
                    path: row.get(1)?,
                    name: row.get(2)?,
                    extension: row.get(3)?,
                    kind: row.get(4)?,
                    size_bytes: row.get(5)?,
                    modified_ms: row.get(6)?,
                    content_hash: row.get(7)?,
                    availability: row.get(8)?,
                })
            },
        )
        .optional()
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "资产不存在或不是资产库资源".to_string())
}

fn operation_id(prefix: &str) -> String {
    format!(
        "{prefix}-{}-{}",
        now_ms(),
        NEXT_PROJECT_OPERATION_ID.fetch_add(1, Ordering::Relaxed)
    )
}

fn generated_asset_uid(operation_id: &str, path: &Path) -> String {
    let mut hasher = Hasher::new();
    hasher.update(operation_id.as_bytes());
    hasher.update(path.to_string_lossy().as_bytes());
    hasher.finalize().to_hex().to_string()
}

fn unique_destination(directory: &Path, name: &str) -> PathBuf {
    let requested = directory.join(name);
    if !requested.exists() {
        return requested;
    }
    let path = Path::new(name);
    let stem = path
        .file_stem()
        .map(|value| value.to_string_lossy().into_owned())
        .unwrap_or_else(|| name.to_string());
    let extension = path
        .extension()
        .map(|value| value.to_string_lossy().into_owned());
    for index in 2_u64.. {
        let candidate_name = match extension.as_deref() {
            Some(extension) if !extension.is_empty() => format!("{stem} ({index}).{extension}"),
            _ => format!("{stem} ({index})"),
        };
        let candidate = directory.join(candidate_name);
        if !candidate.exists() {
            return candidate;
        }
    }
    unreachable!()
}

fn copy_file_verified(source: &Path, temporary: &Path) -> Result<(u64, String), String> {
    let mut source_file = File::open(source)
        .map_err(|error| format!("无法读取源文件 {}：{error}", source.display()))?;
    let mut target_file = File::create(temporary)
        .map_err(|error| format!("无法创建项目副本 {}：{error}", temporary.display()))?;
    let mut buffer = vec![0_u8; 4 * 1024 * 1024];
    let mut hasher = Hasher::new();
    let mut copied = 0_u64;
    loop {
        let count = source_file
            .read(&mut buffer)
            .map_err(|error| error.to_string())?;
        if count == 0 {
            break;
        }
        target_file
            .write_all(&buffer[..count])
            .map_err(|error| error.to_string())?;
        hasher.update(&buffer[..count]);
        copied += count as u64;
    }
    target_file.sync_all().map_err(|error| error.to_string())?;
    if source.metadata().map_err(|error| error.to_string())?.len() != copied {
        return Err("项目副本大小校验失败".to_string());
    }
    Ok((copied, hasher.finalize().to_hex().to_string()))
}

fn create_materialized_copy(
    connection: &mut Connection,
    project: &ProjectRecord,
    source: &SourceAsset,
    relative_directory: &str,
) -> Result<(String, String, String), String> {
    if source.availability != "available" || !Path::new(&source.path).is_file() {
        return Err("源文件缺失，无法复制到项目".to_string());
    }
    let relative_directory = normalize_relative_directory(relative_directory)?;
    let root = Path::new(&project.root_path);
    if !root.is_dir() {
        return Err("项目文件夹不存在或无法访问".to_string());
    }
    let directory = path_for_relative(root, &relative_directory)?;
    fs::create_dir_all(&directory).map_err(|error| format!("无法创建项目子目录：{error}"))?;
    let destination = unique_destination(&directory, &source.name);
    let operation = operation_id("project-copy");
    let temporary = directory.join(format!(".mavo-copy-{operation}.part"));
    let timestamp = now_ms() as i64;
    connection
        .execute(
            "INSERT INTO project_file_operations
             (id, project_id, operation_type, source_path, target_path, temp_path, state, created_at_ms, updated_at_ms)
             VALUES (?1, ?2, 'copy', ?3, ?4, ?5, 'prepared', ?6, ?6)",
            params![
                operation,
                project.id,
                source.path,
                destination.to_string_lossy(),
                temporary.to_string_lossy(),
                timestamp
            ],
        )
        .map_err(|error| error.to_string())?;
    let copy_result = copy_file_verified(Path::new(&source.path), &temporary);
    let (copied_size, content_hash) = match copy_result {
        Ok(result) => result,
        Err(error) => {
            let _ = fs::remove_file(&temporary);
            let _ = connection.execute(
                "UPDATE project_file_operations SET state = 'failed', error_message = ?1, updated_at_ms = ?2 WHERE id = ?3",
                params![error, now_ms() as i64, operation],
            );
            return Err(error);
        }
    };
    if let Err(error) = fs::rename(&temporary, &destination) {
        let _ = fs::remove_file(&temporary);
        return Err(format!("无法完成项目副本写入：{error}"));
    }
    connection
        .execute(
            "UPDATE project_file_operations SET state = 'files_done', updated_at_ms = ?1 WHERE id = ?2",
            params![now_ms() as i64, operation],
        )
        .map_err(|error| error.to_string())?;
    let materialized_uid = generated_asset_uid(&operation, &destination);
    let metadata = destination.metadata().map_err(|error| error.to_string())?;
    let modified_ms = metadata
        .modified()
        .ok()
        .and_then(|value| value.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|value| value.as_millis() as i64)
        .unwrap_or(timestamp);
    let (directory_path, directory_key) = indexed_directory(&destination);
    let insert_result = connection.execute(
        "INSERT INTO indexed_assets
         (path, name, extension, size_bytes, modified_ms, scan_root, last_scan_id, indexed_at_ms,
          asset_uid, kind, metadata_status, availability, content_hash, hash_modified_ms,
          loudness_status, directory_path, directory_key, asset_scope, origin_asset_uid)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'project-copy', ?7, ?8, ?9, ?10, 'available',
                 ?11, ?5, ?12, ?13, ?14, 'project', ?15)",
        params![
            destination.to_string_lossy(),
            destination
                .file_name()
                .unwrap_or_default()
                .to_string_lossy(),
            source.extension,
            copied_size as i64,
            modified_ms,
            project.root_path,
            timestamp,
            materialized_uid,
            source.kind,
            initial_metadata_status(&source.extension),
            content_hash,
            initial_loudness_status(&source.extension),
            directory_path,
            directory_key,
            source.asset_uid,
        ],
    );
    if let Err(error) = insert_result {
        let _ = trash::delete(&destination);
        return Err(error.to_string());
    }
    Ok((
        materialized_uid,
        destination
            .strip_prefix(root)
            .unwrap_or(&destination)
            .to_string_lossy()
            .replace('\\', "/"),
        operation,
    ))
}

fn project_summary(connection: &Connection, id: i64) -> Result<ProjectSummary, String> {
    let mut summary = connection
        .query_row(
            "SELECT p.id, p.name, p.parent_path, p.root_path, p.status, p.last_error,
                    COUNT(pa.id),
                    SUM(CASE WHEN pa.storage_mode = 'reference' THEN 1 ELSE 0 END),
                    SUM(CASE WHEN pa.storage_mode = 'copy' THEN 1 ELSE 0 END),
                    p.created_at_ms, p.updated_at_ms
               FROM projects p
               LEFT JOIN project_assets pa ON pa.project_id = p.id
              WHERE p.id = ?1 GROUP BY p.id",
            params![id],
            |row| {
                Ok(ProjectSummary {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    parent_path: row.get(2)?,
                    root_path: row.get(3)?,
                    status: row.get(4)?,
                    last_error: row.get(5)?,
                    resource_count: row.get::<_, i64>(6)? as u64,
                    reference_count: row.get::<_, Option<i64>>(7)?.unwrap_or(0) as u64,
                    copy_count: row.get::<_, Option<i64>>(8)?.unwrap_or(0) as u64,
                    created_at_ms: row.get(9)?,
                    updated_at_ms: row.get(10)?,
                })
            },
        )
        .map_err(|error| error.to_string())?;
    if !Path::new(&summary.root_path).is_dir() {
        summary.status = "missing".to_string();
    }
    Ok(summary)
}

#[tauri::command]
pub(crate) async fn list_projects(
    query: Option<String>,
    app: AppHandle,
) -> Result<Vec<ProjectSummary>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let connection = project_database(&app)?;
        let search = query.unwrap_or_default().trim().to_string();
        let pattern = format!("%{search}%");
        let ids = {
            let mut statement = connection
                .prepare(
                    "SELECT id FROM projects
                     WHERE (?1 = '' OR name LIKE ?2 OR root_path LIKE ?2)
                     ORDER BY updated_at_ms DESC, id DESC",
                )
                .map_err(|error| error.to_string())?;
            let rows = statement
                .query_map(params![search, pattern], |row| row.get::<_, i64>(0))
                .map_err(|error| error.to_string())?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|error| error.to_string())?;
            rows
        };
        ids.into_iter()
            .map(|id| project_summary(&connection, id))
            .collect()
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub(crate) async fn create_project(
    name: String,
    parent_path: String,
    app: AppHandle,
) -> Result<ProjectSummary, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let name = validate_project_name(&name)?;
        let parent = canonicalize_user_path(Path::new(parent_path.trim()))
            .map_err(|error| format!("项目所在位置不存在或无法访问：{error}"))?;
        if !parent.is_dir() {
            return Err("项目所在位置不是文件夹".to_string());
        }
        let root = parent.join(&name);
        if root.exists() {
            return Err("该位置已存在同名文件或文件夹".to_string());
        }
        fs::create_dir(&root).map_err(|error| format!("无法创建项目文件夹：{error}"))?;
        let create_result = DEFAULT_PROJECT_DIRECTORIES
            .iter()
            .try_for_each(|directory| fs::create_dir(root.join(directory)));
        if let Err(error) = create_result {
            let _ = fs::remove_dir_all(&root);
            return Err(format!("无法创建项目默认目录：{error}"));
        }
        let mut connection = project_database(&app)?;
        let timestamp = now_ms() as i64;
        let transaction = connection
            .transaction()
            .map_err(|error| error.to_string())?;
        let insert_result = transaction.execute(
            "INSERT INTO projects
             (name, parent_path, root_path, root_key, status, created_at_ms, updated_at_ms)
             VALUES (?1, ?2, ?3, ?4, 'ready', ?5, ?5)",
            params![
                name,
                parent.to_string_lossy(),
                root.to_string_lossy(),
                normalize_directory_key(&root),
                timestamp
            ],
        );
        let id = match insert_result {
            Ok(_) => transaction.last_insert_rowid(),
            Err(error) => {
                let _ = fs::remove_dir_all(&root);
                return Err(if error.to_string().contains("UNIQUE") {
                    "项目名称或项目路径已存在".to_string()
                } else {
                    error.to_string()
                });
            }
        };
        transaction.commit().map_err(|error| error.to_string())?;
        project_summary(&connection, id)
    })
    .await
    .map_err(|error| error.to_string())?
}

fn copy_directory_recursive(source: &Path, target: &Path) -> Result<(), String> {
    fs::create_dir(target).map_err(|error| error.to_string())?;
    for entry in fs::read_dir(source).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        let file_type = entry.file_type().map_err(|error| error.to_string())?;
        let destination = target.join(entry.file_name());
        if file_type.is_symlink() {
            continue;
        }
        if file_type.is_dir() {
            copy_directory_recursive(&entry.path(), &destination)?;
        } else if file_type.is_file() {
            fs::copy(entry.path(), destination).map_err(|error| error.to_string())?;
        }
    }
    Ok(())
}

fn move_project_root(
    connection: &mut Connection,
    project: &ProjectRecord,
    new_parent: &Path,
    new_name: &str,
) -> Result<i64, String> {
    if project.status == "moving" {
        return Err("项目正在迁移中".to_string());
    }
    let old_root = PathBuf::from(&project.root_path);
    if !old_root.is_dir() {
        return Err("项目文件夹缺失，无法移动".to_string());
    }
    let target = new_parent.join(new_name);
    if target.exists() {
        return Err("目标位置已存在同名文件或文件夹".to_string());
    }
    let timestamp = now_ms() as i64;
    connection
        .execute(
            "UPDATE projects SET status = 'moving', last_error = NULL, updated_at_ms = ?1 WHERE id = ?2",
            params![timestamp, project.id],
        )
        .map_err(|error| error.to_string())?;
    let move_result = fs::rename(&old_root, &target).or_else(|_| {
        copy_directory_recursive(&old_root, &target)
            .map_err(std::io::Error::other)
            .and_then(|_| trash::delete(&old_root).map_err(std::io::Error::other))
    });
    if let Err(error) = move_result {
        if target.exists() {
            let _ = fs::remove_dir_all(&target);
        }
        let _ = connection.execute(
            "UPDATE projects SET status = 'error', last_error = ?1, updated_at_ms = ?2 WHERE id = ?3",
            params![error.to_string(), now_ms() as i64, project.id],
        );
        return Err(format!("无法移动项目文件夹：{error}"));
    }
    let copied_paths = {
        let mut statement = connection
            .prepare(
                "SELECT materialized_asset_uid, copied_relative_path FROM project_assets
                 WHERE project_id = ?1 AND storage_mode = 'copy'",
            )
            .map_err(|error| error.to_string())?;
        let rows = statement
            .query_map(params![project.id], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(|error| error.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())?;
        rows
    };
    let transaction = connection
        .transaction()
        .map_err(|error| error.to_string())?;
    transaction
        .execute(
            "UPDATE projects SET name = ?1, parent_path = ?2, root_path = ?3, root_key = ?4,
                    status = 'ready', last_error = NULL, updated_at_ms = ?5 WHERE id = ?6",
            params![
                new_name,
                new_parent.to_string_lossy(),
                target.to_string_lossy(),
                normalize_directory_key(&target),
                now_ms() as i64,
                project.id
            ],
        )
        .map_err(|error| error.to_string())?;
    for (asset_uid, relative_path) in copied_paths {
        let new_path = path_for_relative(&target, &relative_path)?;
        let (directory_path, directory_key) = indexed_directory(&new_path);
        transaction
            .execute(
                "UPDATE indexed_assets
                 SET path = ?1, scan_root = ?2, directory_path = ?3, directory_key = ?4
                 WHERE asset_uid = ?5 AND asset_scope = 'project'",
                params![
                    new_path.to_string_lossy(),
                    target.to_string_lossy(),
                    directory_path,
                    directory_key,
                    asset_uid
                ],
            )
            .map_err(|error| error.to_string())?;
    }
    transaction.commit().map_err(|error| error.to_string())?;
    Ok(project.id)
}

#[tauri::command]
pub(crate) async fn rename_project(
    project_id: i64,
    new_name: String,
    app: AppHandle,
) -> Result<ProjectSummary, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let new_name = validate_project_name(&new_name)?;
        let mut connection = project_database(&app)?;
        let project = project_record(&connection, project_id)?;
        if project.name.eq_ignore_ascii_case(&new_name) && project.name == new_name {
            return project_summary(&connection, project_id);
        }
        let parent = PathBuf::from(&project.parent_path);
        let id = move_project_root(&mut connection, &project, &parent, &new_name)?;
        project_summary(&connection, id)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub(crate) async fn move_project(
    project_id: i64,
    new_parent_path: String,
    app: AppHandle,
) -> Result<ProjectSummary, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let new_parent = canonicalize_user_path(Path::new(new_parent_path.trim()))
            .map_err(|error| format!("新的项目位置不存在或无法访问：{error}"))?;
        if !new_parent.is_dir() {
            return Err("新的项目位置不是文件夹".to_string());
        }
        let mut connection = project_database(&app)?;
        let project = project_record(&connection, project_id)?;
        let name = project.name.clone();
        let id = move_project_root(&mut connection, &project, &new_parent, &name)?;
        project_summary(&connection, id)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub(crate) async fn relink_project(
    project_id: i64,
    root_path: String,
    app: AppHandle,
) -> Result<ProjectSummary, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = canonicalize_user_path(Path::new(root_path.trim()))
            .map_err(|error| format!("项目文件夹不存在或无法访问：{error}"))?;
        if !root.is_dir() {
            return Err("重新定位目标不是文件夹".to_string());
        }
        let parent = root.parent().ok_or_else(|| "无法确定项目所在位置".to_string())?;
        let mut connection = project_database(&app)?;
        let project = project_record(&connection, project_id)?;
        let transaction = connection.transaction().map_err(|error| error.to_string())?;
        transaction
            .execute(
                "UPDATE projects SET parent_path = ?1, root_path = ?2, root_key = ?3,
                 status = 'ready', last_error = NULL, updated_at_ms = ?4 WHERE id = ?5",
                params![
                    parent.to_string_lossy(),
                    root.to_string_lossy(),
                    normalize_directory_key(&root),
                    now_ms() as i64,
                    project.id
                ],
            )
            .map_err(|error| error.to_string())?;
        let copies = {
            let mut statement = transaction
                .prepare(
                    "SELECT materialized_asset_uid, copied_relative_path FROM project_assets
                     WHERE project_id = ?1 AND storage_mode = 'copy'",
                )
                .map_err(|error| error.to_string())?;
            let rows = statement
                .query_map(params![project.id], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))
                .map_err(|error| error.to_string())?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|error| error.to_string())?;
            rows
        };
        for (asset_uid, relative_path) in copies {
            let path = path_for_relative(&root, &relative_path)?;
            let (directory_path, directory_key) = indexed_directory(&path);
            transaction
                .execute(
                    "UPDATE indexed_assets SET path = ?1, scan_root = ?2, directory_path = ?3,
                     directory_key = ?4, availability = CASE WHEN ?5 THEN 'available' ELSE 'missing' END
                     WHERE asset_uid = ?6 AND asset_scope = 'project'",
                    params![
                        path.to_string_lossy(), root.to_string_lossy(), directory_path, directory_key,
                        path.is_file(), asset_uid
                    ],
                )
                .map_err(|error| error.to_string())?;
        }
        transaction.commit().map_err(|error| error.to_string())?;
        project_summary(&connection, project_id)
    })
    .await
    .map_err(|error| error.to_string())?
}

fn collect_directories(
    root: &Path,
    current: &Path,
    depth: u32,
    directories: &mut BTreeMap<String, ProjectDirectory>,
) -> Result<(), String> {
    let relative = current
        .strip_prefix(root)
        .unwrap_or(current)
        .to_string_lossy()
        .replace('\\', "/");
    let name = if relative.is_empty() {
        "项目根目录".to_string()
    } else {
        current
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .into_owned()
    };
    directories.insert(
        relative.to_lowercase(),
        ProjectDirectory {
            relative_path: relative,
            name,
            depth,
            exists: true,
            resource_count: 0,
        },
    );
    let mut entries = fs::read_dir(current)
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    entries.sort_by_key(|entry| entry.file_name().to_string_lossy().to_lowercase());
    for entry in entries {
        let file_type = entry.file_type().map_err(|error| error.to_string())?;
        if file_type.is_dir() && !file_type.is_symlink() {
            collect_directories(root, &entry.path(), depth + 1, directories)?;
        }
    }
    Ok(())
}

#[tauri::command]
pub(crate) async fn list_project_directories(
    project_id: i64,
    app: AppHandle,
) -> Result<Vec<ProjectDirectory>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let connection = project_database(&app)?;
        let project = project_record(&connection, project_id)?;
        let root = PathBuf::from(&project.root_path);
        let mut directories = BTreeMap::new();
        if root.is_dir() {
            collect_directories(&root, &root, 0, &mut directories)?;
        } else {
            directories.insert(
                String::new(),
                ProjectDirectory {
                    relative_path: String::new(),
                    name: "项目根目录".to_string(),
                    depth: 0,
                    exists: false,
                    resource_count: 0,
                },
            );
        }
        let logical = {
            let mut statement = connection
                .prepare(
                    "SELECT relative_directory, COUNT(*) FROM project_assets
                     WHERE project_id = ?1 GROUP BY relative_directory",
                )
                .map_err(|error| error.to_string())?;
            let rows = statement
                .query_map(params![project_id], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
                })
                .map_err(|error| error.to_string())?
                .collect::<Result<Vec<_>, _>>()
                .map_err(|error| error.to_string())?;
            rows
        };
        for (relative, count) in logical {
            let key = relative.to_lowercase();
            if let Some(directory) = directories.get_mut(&key) {
                directory.resource_count = count as u64;
            } else {
                directories.insert(
                    key,
                    ProjectDirectory {
                        name: relative
                            .rsplit('/')
                            .next()
                            .unwrap_or("项目根目录")
                            .to_string(),
                        depth: relative.split('/').filter(|part| !part.is_empty()).count() as u32,
                        relative_path: relative,
                        exists: false,
                        resource_count: count as u64,
                    },
                );
            }
        }
        let mut result = directories.into_values().collect::<Vec<_>>();
        result.sort_by(|left, right| {
            if left.relative_path.is_empty() {
                std::cmp::Ordering::Less
            } else if right.relative_path.is_empty() {
                std::cmp::Ordering::Greater
            } else {
                left.relative_path
                    .to_lowercase()
                    .cmp(&right.relative_path.to_lowercase())
            }
        });
        Ok(result)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub(crate) async fn create_project_directory(
    project_id: i64,
    parent_relative_path: String,
    name: String,
    app: AppHandle,
) -> Result<Vec<ProjectDirectory>, String> {
    let app_for_create = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let connection = project_database(&app_for_create)?;
        let project = project_record(&connection, project_id)?;
        if project.status == "moving" {
            return Err("项目正在迁移中".to_string());
        }
        let name = validate_directory_name(&name)?;
        let parent = path_for_relative(Path::new(&project.root_path), &parent_relative_path)?;
        if !parent.is_dir() {
            return Err("父目录不存在".to_string());
        }
        let target = parent.join(name);
        if target.exists() {
            return Err("同一位置已存在同名文件或文件夹".to_string());
        }
        fs::create_dir(&target).map_err(|error| format!("无法创建项目子目录：{error}"))?;
        Ok(())
    })
    .await
    .map_err(|error| error.to_string())??;
    list_project_directories(project_id, app).await
}

fn resolved_membership_status(
    storage_mode: &str,
    source_path: Option<&str>,
    copied_path: Option<&Path>,
) -> String {
    if storage_mode == "copy" {
        if copied_path.is_some_and(Path::is_file) {
            "ready".to_string()
        } else {
            "copy_missing".to_string()
        }
    } else if source_path.is_some_and(|path| Path::new(path).is_file()) {
        "ready".to_string()
    } else {
        "source_missing".to_string()
    }
}

#[tauri::command]
pub(crate) async fn list_project_assets(
    project_id: i64,
    relative_directory: Option<String>,
    query: Option<String>,
    app: AppHandle,
) -> Result<Vec<ProjectAssetSummary>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let connection = project_database(&app)?;
        let project = project_record(&connection, project_id)?;
        let directory = relative_directory
            .as_deref()
            .map(normalize_relative_directory)
            .transpose()?;
        let search = query.unwrap_or_default().trim().to_string();
        let pattern = format!("%{search}%");
        let sql = "SELECT pa.id, pa.source_asset_uid, pa.storage_mode, pa.relative_directory,
                          pa.copied_relative_path, pa.status,
                          COALESCE(CASE WHEN pa.storage_mode = 'copy' THEN materialized.name END,
                                   source.name, pa.source_name_snapshot),
                          COALESCE(CASE WHEN pa.storage_mode = 'copy' THEN materialized.extension END,
                                   source.extension, pa.source_format_snapshot),
                          COALESCE(CASE WHEN pa.storage_mode = 'copy' THEN materialized.kind END,
                                   source.kind, pa.source_kind_snapshot),
                          COALESCE(CASE WHEN pa.storage_mode = 'copy' THEN materialized.path END,
                                   source.path, pa.source_path_snapshot),
                          CASE WHEN pa.storage_mode = 'copy' THEN materialized.thumbnail_path ELSE source.thumbnail_path END,
                          COALESCE(CASE WHEN pa.storage_mode = 'copy' THEN materialized.size_bytes END,
                                   source.size_bytes, 0),
                          COALESCE(CASE WHEN pa.storage_mode = 'copy' THEN materialized.modified_ms END,
                                   source.modified_ms, 0),
                          source.path, source.modified_ms, pa.source_modified_at_copy
                     FROM project_assets pa
                     LEFT JOIN indexed_assets source ON source.asset_uid = pa.source_asset_uid
                     LEFT JOIN indexed_assets materialized ON materialized.asset_uid = pa.materialized_asset_uid
                    WHERE pa.project_id = ?1
                      AND (?2 IS NULL OR pa.relative_directory = ?2)
                      AND (?3 = '' OR COALESCE(source.name, pa.source_name_snapshot) LIKE ?4)
                    ORDER BY pa.updated_at_ms DESC, pa.id DESC";
        let mut statement = connection.prepare(sql).map_err(|error| error.to_string())?;
        let rows = statement
            .query_map(params![project_id, directory, search, pattern], |row| {
                let storage_mode: String = row.get(2)?;
                let copied_relative_path: Option<String> = row.get(4)?;
                let copied_path = copied_relative_path
                    .as_deref()
                    .map(|relative| PathBuf::from(&project.root_path).join(relative));
                let source_path: Option<String> = row.get(13)?;
                let status = resolved_membership_status(
                    &storage_mode,
                    source_path.as_deref(),
                    copied_path.as_deref(),
                );
                let source_modified: Option<i64> = row.get(14)?;
                let copied_from_modified: Option<i64> = row.get(15)?;
                Ok(ProjectAssetSummary {
                    membership_id: row.get(0)?,
                    project_id,
                    source_asset_uid: row.get(1)?,
                    storage_mode,
                    relative_directory: row.get(3)?,
                    copied_relative_path,
                    status,
                    name: row.get(6)?,
                    format: row.get::<_, String>(7)?.to_ascii_uppercase(),
                    kind: row.get(8)?,
                    effective_path: row.get(9)?,
                    thumbnail_path: row.get(10)?,
                    size_bytes: row.get(11)?,
                    modified_ms: row.get(12)?,
                    source_changed: source_modified.zip(copied_from_modified).is_some_and(|(current, copied)| current != copied),
                })
            })
            .map_err(|error| error.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())?;
        Ok(rows)
    })
    .await
    .map_err(|error| error.to_string())?
}

fn list_memberships(
    connection: &Connection,
    asset_uid: &str,
) -> Result<Vec<AssetProjectMembership>, String> {
    let mut statement = connection
        .prepare(
            "SELECT pa.id, p.id, p.name, p.root_path, pa.source_asset_uid, pa.storage_mode,
                    pa.relative_directory, pa.copied_relative_path, pa.status,
                    source.path, source.modified_ms, pa.source_modified_at_copy,
                    pa.created_at_ms, pa.updated_at_ms
               FROM project_assets pa
               JOIN projects p ON p.id = pa.project_id
               LEFT JOIN indexed_assets source ON source.asset_uid = pa.source_asset_uid
              WHERE pa.source_asset_uid = ?1
              ORDER BY p.name COLLATE NOCASE",
        )
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map(params![asset_uid], |row| {
            let root_path: String = row.get(3)?;
            let storage_mode: String = row.get(5)?;
            let copied_relative_path: Option<String> = row.get(7)?;
            let copied_path = copied_relative_path
                .as_deref()
                .map(|relative| PathBuf::from(&root_path).join(relative));
            let source_path: Option<String> = row.get(9)?;
            let source_modified: Option<i64> = row.get(10)?;
            let copied_from_modified: Option<i64> = row.get(11)?;
            Ok(AssetProjectMembership {
                id: row.get(0)?,
                project_id: row.get(1)?,
                project_name: row.get(2)?,
                project_root_path: root_path,
                source_asset_uid: row.get(4)?,
                storage_mode: storage_mode.clone(),
                relative_directory: row.get(6)?,
                copied_relative_path,
                status: resolved_membership_status(
                    &storage_mode,
                    source_path.as_deref(),
                    copied_path.as_deref(),
                ),
                source_changed: source_modified
                    .zip(copied_from_modified)
                    .is_some_and(|(current, copied)| current != copied),
                created_at_ms: row.get(12)?,
                updated_at_ms: row.get(13)?,
            })
        })
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    Ok(rows)
}

#[tauri::command]
pub(crate) async fn list_asset_projects(
    asset_uid: String,
    app: AppHandle,
) -> Result<Vec<AssetProjectMembership>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let connection = project_database(&app)?;
        list_memberships(&connection, &asset_uid)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub(crate) async fn add_asset_to_projects(
    asset_uid: String,
    assignments: Vec<ProjectAssetAssignment>,
    app: AppHandle,
) -> Result<Vec<AssetProjectMembership>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        if assignments.is_empty() {
            return Err("请至少选择一个项目".to_string());
        }
        let mut connection = project_database(&app)?;
        let source = source_asset(&connection, &asset_uid)?;
        for assignment in assignments {
            if !matches!(assignment.storage_mode.as_str(), "reference" | "copy") {
                return Err("资源存在方式无效".to_string());
            }
            let project = project_record(&connection, assignment.project_id)?;
            if project.status == "moving" || !Path::new(&project.root_path).is_dir() {
                return Err(format!("项目“{}”当前不可写", project.name));
            }
            let relative = assignment
                .relative_directory
                .as_deref()
                .map(normalize_relative_directory)
                .transpose()?
                .unwrap_or_else(|| default_directory(&source.kind).to_string());
            let project_directory = path_for_relative(Path::new(&project.root_path), &relative)?;
            fs::create_dir_all(&project_directory)
                .map_err(|error| format!("无法创建项目子目录：{error}"))?;
            let timestamp = now_ms() as i64;
            if assignment.storage_mode == "reference" {
                connection
                    .execute(
                        "INSERT INTO project_assets
                         (project_id, source_asset_uid, storage_mode, relative_directory,
                          source_name_snapshot, source_kind_snapshot, source_format_snapshot,
                          source_path_snapshot, status, created_at_ms, updated_at_ms)
                         VALUES (?1, ?2, 'reference', ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9)",
                        params![
                            project.id,
                            source.asset_uid,
                            relative,
                            source.name,
                            source.kind,
                            source.extension,
                            source.path,
                            if source.availability == "available" { "ready" } else { "source_missing" },
                            timestamp
                        ],
                    )
                    .map_err(|error| {
                        if error.to_string().contains("UNIQUE") {
                            format!("资源已属于项目“{}”", project.name)
                        } else {
                            error.to_string()
                        }
                    })?;
            } else {
                let (materialized_uid, copied_relative_path, operation) =
                    create_materialized_copy(&mut connection, &project, &source, &relative)?;
                let insert_result = connection.execute(
                    "INSERT INTO project_assets
                     (project_id, source_asset_uid, storage_mode, relative_directory,
                      materialized_asset_uid, copied_relative_path,
                      source_name_snapshot, source_kind_snapshot, source_format_snapshot,
                      source_path_snapshot, source_size_at_copy, source_modified_at_copy,
                      source_hash_at_copy, status, created_at_ms, updated_at_ms)
                     VALUES (?1, ?2, 'copy', ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, 'ready', ?13, ?13)",
                    params![
                        project.id,
                        source.asset_uid,
                        relative,
                        materialized_uid,
                        copied_relative_path,
                        source.name,
                        source.kind,
                        source.extension,
                        source.path,
                        source.size_bytes,
                        source.modified_ms,
                        source.content_hash,
                        timestamp
                    ],
                );
                if let Err(error) = insert_result {
                    let copy_path: Option<String> = connection
                        .query_row(
                            "SELECT path FROM indexed_assets WHERE asset_uid = ?1",
                            params![materialized_uid],
                            |row| row.get(0),
                        )
                        .optional()
                        .unwrap_or(None);
                    if let Some(path) = copy_path {
                        let _ = trash::delete(path);
                    }
                    let _ = connection.execute(
                        "DELETE FROM indexed_assets WHERE asset_uid = ?1",
                        params![materialized_uid],
                    );
                    return Err(if error.to_string().contains("UNIQUE") {
                        format!("资源已属于项目“{}”", project.name)
                    } else {
                        error.to_string()
                    });
                }
                connection
                    .execute(
                        "UPDATE project_file_operations SET state = 'db_done', updated_at_ms = ?1 WHERE id = ?2",
                        params![now_ms() as i64, operation],
                    )
                    .map_err(|error| error.to_string())?;
                connection
                    .execute("DELETE FROM project_file_operations WHERE id = ?1", params![operation])
                    .map_err(|error| error.to_string())?;
            }
            connection
                .execute(
                    "UPDATE projects SET updated_at_ms = ?1 WHERE id = ?2",
                    params![timestamp, project.id],
                )
                .map_err(|error| error.to_string())?;
        }
        list_memberships(&connection, &asset_uid)
    })
    .await
    .map_err(|error| error.to_string())?
}

fn remove_materialized_copy(
    connection: &mut Connection,
    membership: &MembershipRecord,
    project: &ProjectRecord,
) -> Result<(), String> {
    let relative_path = membership
        .copied_relative_path
        .as_deref()
        .ok_or_else(|| "项目副本路径缺失".to_string())?;
    let path = path_for_relative(Path::new(&project.root_path), relative_path)?;
    if path.exists() {
        trash::delete(&path).map_err(|error| format!("无法将项目副本移入回收站：{error}"))?;
    }
    if let Some(asset_uid) = membership.materialized_asset_uid.as_deref() {
        let thumbnail: Option<String> = connection
            .query_row(
                "SELECT thumbnail_path FROM indexed_assets WHERE asset_uid = ?1",
                params![asset_uid],
                |row| row.get(0),
            )
            .optional()
            .map_err(|error| error.to_string())?
            .flatten();
        connection
            .execute(
                "DELETE FROM indexed_assets WHERE asset_uid = ?1 AND asset_scope = 'project'",
                params![asset_uid],
            )
            .map_err(|error| error.to_string())?;
        if let Some(thumbnail) = thumbnail {
            let _ = fs::remove_file(thumbnail);
        }
    }
    Ok(())
}

#[tauri::command]
pub(crate) async fn update_project_asset(
    membership_id: i64,
    storage_mode: String,
    relative_directory: String,
    app: AppHandle,
) -> Result<AssetProjectMembership, String> {
    tauri::async_runtime::spawn_blocking(move || {
        if !matches!(storage_mode.as_str(), "reference" | "copy") {
            return Err("资源存在方式无效".to_string());
        }
        let relative = normalize_relative_directory(&relative_directory)?;
        let mut connection = project_database(&app)?;
        let membership = membership_record(&connection, membership_id)?;
        let project = project_record(&connection, membership.project_id)?;
        if project.status == "moving" {
            return Err("项目正在迁移中".to_string());
        }
        let timestamp = now_ms() as i64;
        let project_directory = path_for_relative(Path::new(&project.root_path), &relative)?;
        fs::create_dir_all(&project_directory)
            .map_err(|error| format!("无法创建项目子目录：{error}"))?;
        if membership.storage_mode == "reference" && storage_mode == "copy" {
            let source = source_asset(&connection, &membership.source_asset_uid)?;
            let (materialized_uid, copied_relative_path, operation) =
                create_materialized_copy(&mut connection, &project, &source, &relative)?;
            connection
                .execute(
                    "UPDATE project_assets SET storage_mode = 'copy', relative_directory = ?1,
                     materialized_asset_uid = ?2, copied_relative_path = ?3,
                     source_size_at_copy = ?4, source_modified_at_copy = ?5,
                     source_hash_at_copy = ?6, status = 'ready', last_error = NULL, updated_at_ms = ?7
                     WHERE id = ?8",
                    params![
                        relative, materialized_uid, copied_relative_path, source.size_bytes,
                        source.modified_ms, source.content_hash, timestamp, membership.id
                    ],
                )
                .map_err(|error| error.to_string())?;
            connection
                .execute(
                    "UPDATE project_file_operations SET state = 'db_done', updated_at_ms = ?1 WHERE id = ?2",
                    params![now_ms() as i64, operation],
                )
                .map_err(|error| error.to_string())?;
            connection
                .execute("DELETE FROM project_file_operations WHERE id = ?1", params![operation])
                .map_err(|error| error.to_string())?;
        } else if membership.storage_mode == "copy" && storage_mode == "reference" {
            remove_materialized_copy(&mut connection, &membership, &project)?;
            connection
                .execute(
                    "UPDATE project_assets SET storage_mode = 'reference', relative_directory = ?1,
                     materialized_asset_uid = NULL, copied_relative_path = NULL,
                     source_size_at_copy = NULL, source_modified_at_copy = NULL,
                     source_hash_at_copy = NULL, status = 'ready', last_error = NULL, updated_at_ms = ?2
                     WHERE id = ?3",
                    params![relative, timestamp, membership.id],
                )
                .map_err(|error| error.to_string())?;
        } else if storage_mode == "copy" && membership.relative_directory != relative {
            let old_relative_path = membership
                .copied_relative_path
                .as_deref()
                .ok_or_else(|| "项目副本路径缺失".to_string())?;
            let old_path = path_for_relative(Path::new(&project.root_path), old_relative_path)?;
            if !old_path.is_file() {
                return Err("项目副本缺失，无法移动".to_string());
            }
            let target_directory = path_for_relative(Path::new(&project.root_path), &relative)?;
            fs::create_dir_all(&target_directory).map_err(|error| error.to_string())?;
            let target_path = unique_destination(&target_directory, old_path.file_name().unwrap_or_default().to_string_lossy().as_ref());
            fs::rename(&old_path, &target_path).map_err(|error| format!("无法移动项目副本：{error}"))?;
            let copied_relative_path = target_path
                .strip_prefix(&project.root_path)
                .unwrap_or(&target_path)
                .to_string_lossy()
                .replace('\\', "/");
            let (directory_path, directory_key) = indexed_directory(&target_path);
            let transaction = connection.transaction().map_err(|error| error.to_string())?;
            transaction
                .execute(
                    "UPDATE project_assets SET relative_directory = ?1, copied_relative_path = ?2,
                     updated_at_ms = ?3 WHERE id = ?4",
                    params![relative, copied_relative_path, timestamp, membership.id],
                )
                .map_err(|error| error.to_string())?;
            transaction
                .execute(
                    "UPDATE indexed_assets SET path = ?1, name = ?2, directory_path = ?3, directory_key = ?4
                     WHERE asset_uid = ?5 AND asset_scope = 'project'",
                    params![
                        target_path.to_string_lossy(),
                        target_path.file_name().unwrap_or_default().to_string_lossy(),
                        directory_path,
                        directory_key,
                        membership.materialized_asset_uid
                    ],
                )
                .map_err(|error| error.to_string())?;
            transaction.commit().map_err(|error| error.to_string())?;
        } else {
            connection
                .execute(
                    "UPDATE project_assets SET relative_directory = ?1, updated_at_ms = ?2 WHERE id = ?3",
                    params![relative, timestamp, membership.id],
                )
                .map_err(|error| error.to_string())?;
        }
        connection
            .execute(
                "UPDATE projects SET updated_at_ms = ?1 WHERE id = ?2",
                params![timestamp, project.id],
            )
            .map_err(|error| error.to_string())?;
        list_memberships(&connection, &membership.source_asset_uid)?
            .into_iter()
            .find(|item| item.id == membership.id)
            .ok_or_else(|| "无法读取更新后的项目关系".to_string())
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub(crate) async fn remove_asset_from_project(
    membership_id: i64,
    app: AppHandle,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut connection = project_database(&app)?;
        let membership = membership_record(&connection, membership_id)?;
        let project = project_record(&connection, membership.project_id)?;
        if membership.storage_mode == "copy" {
            remove_materialized_copy(&mut connection, &membership, &project)?;
        }
        connection
            .execute(
                "DELETE FROM project_assets WHERE id = ?1",
                params![membership.id],
            )
            .map_err(|error| error.to_string())?;
        connection
            .execute(
                "UPDATE projects SET updated_at_ms = ?1 WHERE id = ?2",
                params![now_ms() as i64, project.id],
            )
            .map_err(|error| error.to_string())?;
        Ok(())
    })
    .await
    .map_err(|error| error.to_string())?
}

fn project_asset_effective_path(
    connection: &Connection,
    membership_id: i64,
) -> Result<PathBuf, String> {
    let membership = membership_record(connection, membership_id)?;
    let project = project_record(connection, membership.project_id)?;
    if membership.storage_mode == "copy" {
        let relative = membership
            .copied_relative_path
            .as_deref()
            .ok_or_else(|| "项目副本路径缺失".to_string())?;
        path_for_relative(Path::new(&project.root_path), relative)
    } else {
        connection
            .query_row(
                "SELECT path FROM indexed_assets WHERE asset_uid = ?1",
                params![membership.source_asset_uid],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(|error| error.to_string())?
            .map(PathBuf::from)
            .ok_or_else(|| "源文件索引缺失".to_string())
    }
}

#[tauri::command]
pub(crate) fn open_project_folder(
    project_id: i64,
    relative_directory: Option<String>,
    app: AppHandle,
) -> Result<(), String> {
    let connection = project_database(&app)?;
    let project = project_record(&connection, project_id)?;
    let directory = path_for_relative(
        Path::new(&project.root_path),
        relative_directory.as_deref().unwrap_or(""),
    )?;
    if !directory.is_dir() {
        return Err("项目文件夹不存在或无法访问".to_string());
    }
    #[cfg(target_os = "windows")]
    windowless_command("explorer.exe")
        .arg(&directory)
        .spawn()
        .map_err(|error| format!("无法打开项目文件夹：{error}"))?;
    #[cfg(target_os = "macos")]
    windowless_command("open")
        .arg(&directory)
        .spawn()
        .map_err(|error| format!("无法打开项目文件夹：{error}"))?;
    #[cfg(all(unix, not(target_os = "macos")))]
    windowless_command("xdg-open")
        .arg(&directory)
        .spawn()
        .map_err(|error| format!("无法打开项目文件夹：{error}"))?;
    Ok(())
}

#[tauri::command]
pub(crate) fn open_project_asset(membership_id: i64, app: AppHandle) -> Result<(), String> {
    let connection = project_database(&app)?;
    let path = project_asset_effective_path(&connection, membership_id)?;
    if !path.is_file() {
        return Err("项目资源文件不存在".to_string());
    }
    #[cfg(target_os = "windows")]
    windowless_command("rundll32.exe")
        .arg("url.dll,FileProtocolHandler")
        .arg(&path)
        .spawn()
        .map_err(|error| format!("无法打开项目资源：{error}"))?;
    #[cfg(target_os = "macos")]
    windowless_command("open")
        .arg(&path)
        .spawn()
        .map_err(|error| format!("无法打开项目资源：{error}"))?;
    #[cfg(all(unix, not(target_os = "macos")))]
    windowless_command("xdg-open")
        .arg(&path)
        .spawn()
        .map_err(|error| format!("无法打开项目资源：{error}"))?;
    Ok(())
}

#[tauri::command]
pub(crate) fn open_project_asset_folder(membership_id: i64, app: AppHandle) -> Result<(), String> {
    let connection = project_database(&app)?;
    let path = project_asset_effective_path(&connection, membership_id)?;
    if !path.exists() {
        return Err("项目资源文件不存在".to_string());
    }
    #[cfg(target_os = "windows")]
    windowless_command("explorer.exe")
        .arg("/select,")
        .arg(&path)
        .spawn()
        .map_err(|error| format!("无法打开项目资源所在文件夹：{error}"))?;
    #[cfg(target_os = "macos")]
    windowless_command("open")
        .arg("-R")
        .arg(&path)
        .spawn()
        .map_err(|error| format!("无法打开项目资源所在文件夹：{error}"))?;
    #[cfg(all(unix, not(target_os = "macos")))]
    windowless_command("xdg-open")
        .arg(path.parent().unwrap_or(Path::new("/")))
        .spawn()
        .map_err(|error| format!("无法打开项目资源所在文件夹：{error}"))?;
    Ok(())
}

pub(crate) fn recover_project_file_operations(connection: &Connection) -> Result<(), String> {
    let operations = {
        let mut statement = connection
            .prepare(
                "SELECT id, temp_path, target_path, state FROM project_file_operations
                 WHERE state != 'db_done'",
            )
            .map_err(|error| error.to_string())?;
        let rows = statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, Option<String>>(2)?,
                    row.get::<_, String>(3)?,
                ))
            })
            .map_err(|error| error.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())?;
        rows
    };
    for (id, temporary, target, state) in operations {
        if let Some(temporary) = temporary {
            let temporary = PathBuf::from(temporary);
            if temporary.is_file() {
                let _ = fs::remove_file(temporary);
            }
        }
        if state == "files_done" {
            if let Some(target) = target {
                let target = PathBuf::from(target);
                let linked: bool = connection
                    .query_row(
                        "SELECT EXISTS(
                           SELECT 1 FROM project_assets pa
                           JOIN indexed_assets ia ON ia.asset_uid = pa.materialized_asset_uid
                           WHERE ia.path = ?1 AND ia.asset_scope = 'project'
                         )",
                        params![target.to_string_lossy()],
                        |row| row.get(0),
                    )
                    .unwrap_or(false);
                if target.is_file() && !linked {
                    let _ = trash::delete(&target);
                }
                if !linked {
                    let _ = connection.execute(
                        "DELETE FROM indexed_assets WHERE path = ?1 AND asset_scope = 'project'",
                        params![target.to_string_lossy()],
                    );
                }
            }
        }
        connection
            .execute(
                "DELETE FROM project_file_operations WHERE id = ?1",
                params![id],
            )
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_windows_names() {
        assert_eq!(validate_project_name("Demo").unwrap(), "Demo");
        assert!(validate_project_name("CON").is_err());
        assert!(validate_project_name("bad/name").is_err());
        assert!(validate_project_name("trailing.").is_err());
    }

    #[test]
    fn normalizes_safe_relative_directories() {
        assert_eq!(
            normalize_relative_directory("image\\hero").unwrap(),
            "image/hero"
        );
        assert_eq!(normalize_relative_directory("").unwrap(), "");
        assert!(normalize_relative_directory("../outside").is_err());
        assert!(normalize_relative_directory("C:\\outside").is_err());
    }

    #[test]
    fn maps_default_directories() {
        assert_eq!(default_directory("图片"), "image");
        assert_eq!(default_directory("音频"), "audio");
        assert_eq!(default_directory("视频"), "video");
        assert_eq!(default_directory("动图"), "gif");
        assert_eq!(default_directory("文档"), "");
    }

    #[test]
    fn creates_non_conflicting_destination_names() {
        let workspace = std::env::temp_dir().join(operation_id("mavo-project-name-test"));
        fs::create_dir_all(&workspace).unwrap();
        fs::write(workspace.join("hero.png"), b"one").unwrap();
        fs::write(workspace.join("hero (2).png"), b"two").unwrap();
        assert_eq!(
            unique_destination(&workspace, "hero.png")
                .file_name()
                .unwrap()
                .to_string_lossy(),
            "hero (3).png"
        );
        fs::remove_dir_all(workspace).unwrap();
    }

    #[test]
    fn project_schema_enforces_one_membership_per_project() {
        let connection = Connection::open_in_memory().unwrap();
        connection
            .execute_batch("PRAGMA foreign_keys = ON;")
            .unwrap();
        initialize_projects_database(&connection).unwrap();
        connection
            .execute(
                "INSERT INTO projects
             (name, parent_path, root_path, root_key, status, created_at_ms, updated_at_ms)
             VALUES ('Demo', 'C:\\Work', 'C:\\Work\\Demo', 'c:\\work\\demo', 'ready', 1, 1)",
                [],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO project_assets
             (project_id, source_asset_uid, storage_mode, relative_directory,
              source_name_snapshot, source_kind_snapshot, source_format_snapshot,
              source_path_snapshot, status, created_at_ms, updated_at_ms)
             VALUES (1, 'asset-1', 'reference', 'image', 'hero.png', '图片', 'png',
                     'C:\\Assets\\hero.png', 'ready', 1, 1)",
                [],
            )
            .unwrap();
        assert!(connection
            .execute(
                "INSERT INTO project_assets
             (project_id, source_asset_uid, storage_mode, relative_directory,
              source_name_snapshot, source_kind_snapshot, source_format_snapshot,
              source_path_snapshot, status, created_at_ms, updated_at_ms)
             VALUES (1, 'asset-1', 'reference', 'audio', 'hero.png', '图片', 'png',
                     'C:\\Assets\\hero.png', 'ready', 1, 1)",
                [],
            )
            .is_err());
    }
}
