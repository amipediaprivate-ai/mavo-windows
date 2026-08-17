use rusqlite::{backup::Backup, Connection, OpenFlags};
use std::{
    ffi::OsString,
    fs::{self, OpenOptions},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicU64, Ordering},
        Mutex,
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};

pub(crate) const BACKUP_RETENTION: usize = 5;
const CURRENT_SCHEMA_VERSION: i64 = 1;
const BACKUP_DIR_NAME: &str = "database-backups";
const QUARANTINE_DIR_NAME: &str = "database-quarantine";
const RECOVERY_MARKER_NAME: &str = "caevir-index.recovery-required";
const BACKUP_PREFIX: &str = "caevir-index-";
const BACKUP_SUFFIX: &str = ".sqlite3";
const TEMP_SUFFIX: &str = ".tmp";

static DATABASE_LIFECYCLE_LOCK: Mutex<()> = Mutex::new(());
static UNIQUE_SEQUENCE: AtomicU64 = AtomicU64::new(0);

pub(crate) fn prepare_database<M, V>(
    database_path: &Path,
    migrate: M,
    validate_schema: V,
) -> Result<Connection, String>
where
    M: Fn(&Connection) -> Result<(), String>,
    V: Fn(&Connection) -> Result<(), String>,
{
    let _guard = DATABASE_LIFECYCLE_LOCK
        .lock()
        .map_err(|_| "数据库备份与恢复锁不可用".to_string())?;
    prepare_database_locked(database_path, &migrate, &validate_schema)
}

fn prepare_database_locked<M, V>(
    database_path: &Path,
    migrate: &M,
    validate_schema: &V,
) -> Result<Connection, String>
where
    M: Fn(&Connection) -> Result<(), String>,
    V: Fn(&Connection) -> Result<(), String>,
{
    let app_data_dir = database_path
        .parent()
        .ok_or_else(|| "数据库路径没有父目录".to_string())?;
    fs::create_dir_all(app_data_dir)
        .map_err(|error| format!("无法创建应用数据目录 {}：{error}", app_data_dir.display()))?;
    let backup_dir = app_data_dir.join(BACKUP_DIR_NAME);
    let quarantine_dir = app_data_dir.join(QUARANTINE_DIR_NAME);
    fs::create_dir_all(&backup_dir)
        .map_err(|error| format!("无法创建数据库备份目录 {}：{error}", backup_dir.display()))?;
    cleanup_stale_temporary_files(&backup_dir)?;
    cleanup_backup_sidecars(&backup_dir)?;

    let recovery_marker = app_data_dir.join(RECOVERY_MARKER_NAME);
    let mut recovery_source = None;
    if database_path.is_file() {
        if let Err(current_error) = validate_working_database(database_path, validate_schema) {
            let backup = newest_recoverable_backup(&backup_dir, validate_schema)?.ok_or_else(|| {
                format!(
                    "数据库健康检查失败，且没有可用的已验证备份。原数据库保留在 {}。检查结果：{current_error}",
                    database_path.display()
                )
            })?;
            let preserved = preserve_database_files(database_path, &quarantine_dir, "corrupt")?;
            if let Err(error) = restore_backup(&backup, database_path) {
                write_recovery_marker(&recovery_marker, &error)?;
                return Err(format!(
                    "数据库损坏现场已保留在 {}，但从备份 {} 恢复失败：{error}",
                    preserved.display(),
                    backup.display()
                ));
            }
            recovery_source = Some(backup);
        }
    } else {
        let backups = backup_candidates(&backup_dir)?;
        if !backups.is_empty() || recovery_marker.is_file() {
            let backup =
                newest_recoverable_backup(&backup_dir, validate_schema)?.ok_or_else(|| {
                    format!(
                    "数据库主文件缺失，且没有可恢复的已验证备份；不会自动创建空库。请检查 {} 和 {}",
                    backup_dir.display(),
                    quarantine_dir.display()
                )
                })?;
            restore_backup(&backup, database_path).map_err(|error| {
                format!(
                    "数据库主文件缺失，从备份 {} 恢复失败：{error}",
                    backup.display()
                )
            })?;
            recovery_source = Some(backup);
        }
    }

    let existed_before_open = database_path.is_file();
    let connection = super::open_database(database_path)
        .map_err(|error| format!("无法打开数据库 {}：{error}", database_path.display()))?;
    let schema_version = read_schema_version(&connection)?;
    if schema_version > CURRENT_SCHEMA_VERSION {
        return Err(format!(
            "数据库架构版本 {schema_version} 高于此版本 Caevir 支持的 {CURRENT_SCHEMA_VERSION}；为避免降级损坏，已停止打开"
        ));
    }

    let migration_required = schema_version < CURRENT_SCHEMA_VERSION;
    let rollback_backup = if migration_required && existed_before_open {
        Some(create_snapshot(&connection, &backup_dir, "pre-migration")?)
    } else {
        None
    };

    let migration_result = if migration_required {
        migrate(&connection).and_then(|_| {
            connection
                .pragma_update(None, "user_version", CURRENT_SCHEMA_VERSION)
                .map_err(|error| format!("无法记录数据库架构版本：{error}"))
        })
    } else {
        Ok(())
    };
    let validation_result = migration_result.and_then(|_| {
        validate_connection_integrity(&connection)?;
        validate_schema(&connection)
    });

    if let Err(error) = validation_result {
        drop(connection);
        let preserved =
            preserve_database_files(database_path, &quarantine_dir, "migration-failed")?;
        let restore_source = rollback_backup.as_ref().or(recovery_source.as_ref());
        if let Some(backup) = restore_source {
            match restore_backup(backup, database_path) {
                Ok(()) => {
                    return Err(format!(
                        "数据库迁移或迁移后验证失败：{error}。失败现场已保留在 {}，原数据库已从备份 {} 回滚并验证；应用已停止启动以免继续写入",
                        preserved.display(),
                        backup.display()
                    ));
                }
                Err(restore_error) => {
                    write_recovery_marker(&recovery_marker, &restore_error)?;
                    return Err(format!(
                        "数据库迁移或迁移后验证失败：{error}。失败现场已保留在 {}，但从 {} 回滚失败：{restore_error}",
                        preserved.display(),
                        backup.display()
                    ));
                }
            }
        }
        write_recovery_marker(&recovery_marker, &error)?;
        return Err(format!(
            "数据库迁移或迁移后验证失败：{error}。失败现场已保留在 {}，没有可用备份，因此不会创建空库",
            preserved.display()
        ));
    }

    create_snapshot(&connection, &backup_dir, "startup")?;
    if recovery_marker.is_file() {
        fs::remove_file(&recovery_marker).map_err(|error| {
            format!(
                "数据库已恢复，但无法清除恢复标记 {}：{error}",
                recovery_marker.display()
            )
        })?;
    }
    Ok(connection)
}

fn read_schema_version(connection: &Connection) -> Result<i64, String> {
    connection
        .query_row("PRAGMA user_version", [], |row| row.get(0))
        .map_err(|error| format!("无法读取数据库架构版本：{error}"))
}

fn validate_working_database<V>(database_path: &Path, validate_schema: &V) -> Result<(), String>
where
    V: Fn(&Connection) -> Result<(), String>,
{
    let connection = open_read_only(database_path)?;
    validate_connection_integrity(&connection)?;
    let version = read_schema_version(&connection)?;
    if version > CURRENT_SCHEMA_VERSION {
        return Err(format!(
            "数据库架构版本 {version} 高于当前支持的 {CURRENT_SCHEMA_VERSION}"
        ));
    }
    if version == CURRENT_SCHEMA_VERSION {
        validate_schema(&connection)?;
    }
    Ok(())
}

fn validate_connection_integrity(connection: &Connection) -> Result<(), String> {
    let mut statement = connection
        .prepare("PRAGMA integrity_check")
        .map_err(|error| format!("无法执行数据库完整性检查：{error}"))?;
    let results = statement
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|error| format!("数据库完整性检查失败：{error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("数据库完整性检查失败：{error}"))?;
    if results.len() != 1 || results[0] != "ok" {
        return Err(format!("数据库完整性检查未通过：{}", results.join("；")));
    }
    let mut foreign_keys = connection
        .prepare("PRAGMA foreign_key_check")
        .map_err(|error| format!("无法执行外键检查：{error}"))?;
    let mut rows = foreign_keys
        .query([])
        .map_err(|error| format!("外键检查失败：{error}"))?;
    if rows
        .next()
        .map_err(|error| format!("外键检查失败：{error}"))?
        .is_some()
    {
        return Err("数据库外键检查未通过".to_string());
    }
    Ok(())
}

fn open_read_only(path: &Path) -> Result<Connection, String> {
    let connection = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|error| format!("无法以只读方式打开 {}：{error}", path.display()))?;
    connection
        .busy_timeout(Duration::from_secs(5))
        .map_err(|error| format!("无法设置数据库检查等待时间：{error}"))?;
    Ok(connection)
}

fn create_snapshot(
    source: &Connection,
    backup_dir: &Path,
    reason: &str,
) -> Result<PathBuf, String> {
    fs::create_dir_all(backup_dir)
        .map_err(|error| format!("无法创建备份目录 {}：{error}", backup_dir.display()))?;
    let stamp = unique_stamp();
    let final_path = backup_dir.join(format!(
        "{BACKUP_PREFIX}{stamp:020}-{reason}{BACKUP_SUFFIX}"
    ));
    let temp_path = backup_dir.join(format!(
        "{BACKUP_PREFIX}{stamp:020}-{reason}{BACKUP_SUFFIX}{TEMP_SUFFIX}"
    ));
    let result = (|| -> Result<(), String> {
        let mut destination = Connection::open(&temp_path)
            .map_err(|error| format!("无法创建临时备份 {}：{error}", temp_path.display()))?;
        {
            let backup = Backup::new(source, &mut destination)
                .map_err(|error| format!("无法启动 SQLite 一致性备份：{error}"))?;
            backup
                .run_to_completion(128, Duration::from_millis(5), None)
                .map_err(|error| format!("SQLite 一致性备份失败：{error}"))?;
        }
        drop(destination);
        validate_backup_file(&temp_path)?;
        sync_file(&temp_path)?;
        fs::rename(&temp_path, &final_path).map_err(|error| {
            format!(
                "无法原子完成数据库备份 {} -> {}：{error}",
                temp_path.display(),
                final_path.display()
            )
        })?;
        Ok(())
    })();
    if let Err(error) = result {
        let _ = fs::remove_file(&temp_path);
        return Err(error);
    }
    rotate_backups(backup_dir)?;
    Ok(final_path)
}

fn validate_backup_file(path: &Path) -> Result<(), String> {
    let validation = {
        let connection = open_read_only(path)?;
        validate_connection_integrity(&connection)
            .map_err(|error| format!("备份 {} 验证失败：{error}", path.display()))
    };
    remove_sidecars(path)?;
    validation
}

fn newest_recoverable_backup<V>(
    backup_dir: &Path,
    validate_schema: &V,
) -> Result<Option<PathBuf>, String>
where
    V: Fn(&Connection) -> Result<(), String>,
{
    for candidate in backup_candidates(backup_dir)? {
        let recoverable = (|| -> Result<(), String> {
            let connection = open_read_only(&candidate)?;
            validate_connection_integrity(&connection)?;
            let version = read_schema_version(&connection)?;
            if version > CURRENT_SCHEMA_VERSION {
                return Err("备份来自更高版本数据库".to_string());
            }
            if version == CURRENT_SCHEMA_VERSION {
                validate_schema(&connection)?;
            }
            Ok(())
        })();
        remove_sidecars(&candidate)?;
        if recoverable.is_ok() {
            return Ok(Some(candidate));
        }
    }
    Ok(None)
}

fn backup_candidates(backup_dir: &Path) -> Result<Vec<PathBuf>, String> {
    if !backup_dir.is_dir() {
        return Ok(Vec::new());
    }
    let mut backups = fs::read_dir(backup_dir)
        .map_err(|error| format!("无法读取备份目录 {}：{error}", backup_dir.display()))?
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| {
            path.file_name()
                .and_then(|name| name.to_str())
                .is_some_and(|name| {
                    name.starts_with(BACKUP_PREFIX)
                        && name.ends_with(BACKUP_SUFFIX)
                        && !name.ends_with(&format!("{BACKUP_SUFFIX}{TEMP_SUFFIX}"))
                })
        })
        .collect::<Vec<_>>();
    backups.sort_by(|left, right| right.file_name().cmp(&left.file_name()));
    Ok(backups)
}

fn rotate_backups(backup_dir: &Path) -> Result<(), String> {
    for obsolete in backup_candidates(backup_dir)?
        .into_iter()
        .skip(BACKUP_RETENTION)
    {
        fs::remove_file(&obsolete)
            .map_err(|error| format!("无法轮转旧备份 {}：{error}", obsolete.display()))?;
        remove_sidecars(&obsolete)?;
    }
    Ok(())
}

fn restore_backup(backup_path: &Path, database_path: &Path) -> Result<(), String> {
    validate_backup_file(backup_path)?;
    let parent = database_path
        .parent()
        .ok_or_else(|| "数据库路径没有父目录".to_string())?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("无法创建数据库目录 {}：{error}", parent.display()))?;
    let temp_path = parent.join(format!(".caevir-index-restore-{}.tmp", unique_stamp()));
    let result = (|| -> Result<(), String> {
        fs::copy(backup_path, &temp_path).map_err(|error| {
            format!(
                "无法复制恢复文件 {} -> {}：{error}",
                backup_path.display(),
                temp_path.display()
            )
        })?;
        sync_file(&temp_path)?;
        validate_backup_file(&temp_path)?;
        if database_path.exists() {
            return Err(format!(
                "恢复目标 {} 仍然存在，拒绝覆盖",
                database_path.display()
            ));
        }
        fs::rename(&temp_path, database_path).map_err(|error| {
            format!(
                "无法原子启用恢复数据库 {} -> {}：{error}",
                temp_path.display(),
                database_path.display()
            )
        })?;
        let restored = open_read_only(database_path)?;
        validate_connection_integrity(&restored)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temp_path);
    }
    result
}

fn preserve_database_files(
    database_path: &Path,
    quarantine_root: &Path,
    reason: &str,
) -> Result<PathBuf, String> {
    let destination = quarantine_root.join(format!("{}-{reason}", unique_stamp()));
    fs::create_dir_all(&destination).map_err(|error| {
        format!(
            "无法创建数据库现场保留目录 {}：{error}",
            destination.display()
        )
    })?;
    for source in [
        database_path.to_path_buf(),
        sidecar_path(database_path, "-wal"),
        sidecar_path(database_path, "-shm"),
    ] {
        if source.exists() {
            let name = source
                .file_name()
                .ok_or_else(|| format!("无法确定数据库文件名：{}", source.display()))?;
            let target = destination.join(name);
            fs::rename(&source, &target).map_err(|error| {
                format!(
                    "无法保留数据库现场 {} -> {}：{error}",
                    source.display(),
                    target.display()
                )
            })?;
        }
    }
    Ok(destination)
}

fn sidecar_path(database_path: &Path, suffix: &str) -> PathBuf {
    let mut value: OsString = database_path.as_os_str().to_os_string();
    value.push(suffix);
    PathBuf::from(value)
}

fn cleanup_stale_temporary_files(backup_dir: &Path) -> Result<(), String> {
    for entry in fs::read_dir(backup_dir)
        .map_err(|error| format!("无法清理备份临时文件：{error}"))?
        .filter_map(Result::ok)
    {
        let path = entry.path();
        if path
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.ends_with(TEMP_SUFFIX))
        {
            fs::remove_file(&path)
                .map_err(|error| format!("无法清理临时文件 {}：{error}", path.display()))?;
        }
    }
    Ok(())
}

fn cleanup_backup_sidecars(backup_dir: &Path) -> Result<(), String> {
    for entry in fs::read_dir(backup_dir)
        .map_err(|error| format!("无法清理备份辅助文件：{error}"))?
        .filter_map(Result::ok)
    {
        let path = entry.path();
        if path
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| {
                name.starts_with(BACKUP_PREFIX)
                    && (name.ends_with(".sqlite3-wal")
                        || name.ends_with(".sqlite3-shm")
                        || name.ends_with(".sqlite3.tmp-wal")
                        || name.ends_with(".sqlite3.tmp-shm"))
            })
        {
            fs::remove_file(&path)
                .map_err(|error| format!("无法清理备份辅助文件 {}：{error}", path.display()))?;
        }
    }
    Ok(())
}

fn remove_sidecars(database_path: &Path) -> Result<(), String> {
    for sidecar in [
        sidecar_path(database_path, "-wal"),
        sidecar_path(database_path, "-shm"),
    ] {
        if sidecar.is_file() {
            fs::remove_file(&sidecar).map_err(|error| {
                format!("无法清理数据库辅助文件 {}：{error}", sidecar.display())
            })?;
        }
    }
    Ok(())
}

fn write_recovery_marker(path: &Path, detail: &str) -> Result<(), String> {
    fs::write(path, detail)
        .map_err(|error| format!("无法写入数据库恢复标记 {}：{error}", path.display()))
}

fn sync_file(path: &Path) -> Result<(), String> {
    OpenOptions::new()
        .write(true)
        .open(path)
        .and_then(|file| file.sync_all())
        .map_err(|error| format!("无法将数据库文件同步到磁盘 {}：{error}", path.display()))
}

fn unique_stamp() -> u64 {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(u64::MAX as u128) as u64;
    millis
        .saturating_mul(1_000)
        .saturating_add(UNIQUE_SEQUENCE.fetch_add(1, Ordering::Relaxed) % 1_000)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn workspace(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "caevir-database-lifecycle-{name}-{}-{}",
            std::process::id(),
            unique_stamp()
        ))
    }

    fn migrate_fixture(connection: &Connection) -> Result<(), String> {
        connection
            .execute_batch(
                "CREATE TABLE IF NOT EXISTS fixture (
                   id INTEGER PRIMARY KEY,
                   value TEXT NOT NULL
                 );",
            )
            .map_err(|error| error.to_string())
    }

    fn validate_fixture(connection: &Connection) -> Result<(), String> {
        let exists: bool = connection
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'fixture')",
                [],
                |row| row.get(0),
            )
            .map_err(|error| error.to_string())?;
        if exists {
            Ok(())
        } else {
            Err("fixture table missing".to_string())
        }
    }

    fn create_fixture_database(path: &Path, value: &str) -> Connection {
        let connection = Connection::open(path).unwrap();
        migrate_fixture(&connection).unwrap();
        connection
            .pragma_update(None, "user_version", CURRENT_SCHEMA_VERSION)
            .unwrap();
        connection
            .execute("INSERT INTO fixture (id, value) VALUES (1, ?1)", [value])
            .unwrap();
        connection
    }

    #[test]
    fn backup_rotation_keeps_only_the_newest_verified_snapshots() {
        let root = workspace("rotation");
        let backup_dir = root.join(BACKUP_DIR_NAME);
        fs::create_dir_all(&backup_dir).unwrap();
        let database = root.join("caevir-index.sqlite3");
        let connection = create_fixture_database(&database, "kept");
        for _ in 0..(BACKUP_RETENTION + 3) {
            create_snapshot(&connection, &backup_dir, "test").unwrap();
        }
        let backups = backup_candidates(&backup_dir).unwrap();
        assert_eq!(backups.len(), BACKUP_RETENTION);
        for backup in backups {
            validate_backup_file(&backup).unwrap();
        }
        assert_eq!(fs::read_dir(&backup_dir).unwrap().count(), BACKUP_RETENTION);
        drop(connection);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn recovery_restores_the_latest_verified_backup() {
        let root = workspace("restore");
        fs::create_dir_all(&root).unwrap();
        let database = root.join("caevir-index.sqlite3");
        let connection = prepare_database(&database, migrate_fixture, validate_fixture).unwrap();
        connection
            .execute("INSERT INTO fixture (id, value) VALUES (1, 'restored')", [])
            .unwrap();
        create_snapshot(&connection, &root.join(BACKUP_DIR_NAME), "manual-test").unwrap();
        drop(connection);
        fs::write(&database, b"not a sqlite database").unwrap();

        let recovered = prepare_database(&database, migrate_fixture, validate_fixture).unwrap();
        let value: String = recovered
            .query_row("SELECT value FROM fixture WHERE id = 1", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(value, "restored");
        assert!(root
            .join(QUARANTINE_DIR_NAME)
            .read_dir()
            .unwrap()
            .next()
            .is_some());
        drop(recovered);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn recovery_skips_a_newer_corrupt_backup() {
        let root = workspace("skip-corrupt-backup");
        fs::create_dir_all(&root).unwrap();
        let database = root.join("caevir-index.sqlite3");
        let connection = create_fixture_database(&database, "older-valid");
        let backup_dir = root.join(BACKUP_DIR_NAME);
        fs::create_dir_all(&backup_dir).unwrap();
        create_snapshot(&connection, &backup_dir, "valid").unwrap();
        drop(connection);
        let corrupt = backup_dir.join(format!(
            "{BACKUP_PREFIX}{:020}-corrupt{BACKUP_SUFFIX}",
            u64::MAX
        ));
        fs::write(corrupt, b"broken backup").unwrap();
        fs::write(&database, b"broken database").unwrap();

        let recovered = prepare_database(&database, migrate_fixture, validate_fixture).unwrap();
        let value: String = recovered
            .query_row("SELECT value FROM fixture WHERE id = 1", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(value, "older-valid");
        drop(recovered);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn migration_failure_restores_pre_migration_snapshot_and_reports_error() {
        let root = workspace("migration-rollback");
        fs::create_dir_all(&root).unwrap();
        let database = root.join("caevir-index.sqlite3");
        let connection = Connection::open(&database).unwrap();
        connection
            .execute_batch(
                "CREATE TABLE fixture (id INTEGER PRIMARY KEY, value TEXT NOT NULL);
                 INSERT INTO fixture (id, value) VALUES (1, 'before');",
            )
            .unwrap();
        drop(connection);

        let error = prepare_database(
            &database,
            |connection| {
                connection
                    .execute_batch("CREATE TABLE partial_change (id INTEGER PRIMARY KEY);")
                    .map_err(|error| error.to_string())?;
                Err("injected migration failure".to_string())
            },
            validate_fixture,
        )
        .unwrap_err();
        assert!(error.contains("injected migration failure"));
        assert!(error.contains("已从备份"));

        let restored = Connection::open(&database).unwrap();
        let value: String = restored
            .query_row("SELECT value FROM fixture WHERE id = 1", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(value, "before");
        let partial_exists: bool = restored
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE name = 'partial_change')",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert!(!partial_exists);
        drop(restored);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn sqlite_backup_includes_committed_wal_content() {
        let root = workspace("wal");
        let backup_dir = root.join(BACKUP_DIR_NAME);
        fs::create_dir_all(&backup_dir).unwrap();
        let database = root.join("caevir-index.sqlite3");
        let connection = create_fixture_database(&database, "initial");
        connection
            .pragma_update(None, "journal_mode", "WAL")
            .unwrap();
        connection
            .pragma_update(None, "wal_autocheckpoint", 0)
            .unwrap();
        connection
            .execute("UPDATE fixture SET value = 'from-wal' WHERE id = 1", [])
            .unwrap();
        assert!(sidecar_path(&database, "-wal").is_file());
        let backup = create_snapshot(&connection, &backup_dir, "wal-test").unwrap();
        let snapshot = Connection::open(backup).unwrap();
        let value: String = snapshot
            .query_row("SELECT value FROM fixture WHERE id = 1", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(value, "from-wal");
        drop(snapshot);
        drop(connection);
        fs::remove_dir_all(root).unwrap();
    }
}
