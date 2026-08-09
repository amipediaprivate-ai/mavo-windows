use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashMap,
    fs,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicU64, Ordering},
        Mutex, OnceLock,
    },
    time::{Duration, UNIX_EPOCH},
};
use tauri::{ipc::Response, AppHandle, Emitter, Manager};

use super::{
    command_output_with_timeout, normalize_directory_key, setup_database, validated_asset_stem,
    windowless_command,
};

const REMBG_RUNNER: &str = include_str!("../python/background_remove.py");
const REMOVAL_TIMEOUT: Duration = Duration::from_secs(20 * 60);
const JOB_MAX_AGE_MS: u64 = 24 * 60 * 60 * 1_000;
const ALLOWED_MODELS: &[&str] = &[
    "birefnet-general",
    "birefnet-general-lite",
    "birefnet-portrait",
];

static NEXT_JOB_ID: AtomicU64 = AtomicU64::new(1);
static JOBS: OnceLock<Mutex<HashMap<String, RemovalJob>>> = OnceLock::new();

#[derive(Clone)]
struct RemovalJob {
    asset_id: i64,
    source_path: PathBuf,
    result_path: PathBuf,
    width: u32,
    height: u32,
    created_at_ms: u64,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BackgroundRemovalOptions {
    model: String,
    alpha_matting: bool,
    foreground_threshold: u8,
    background_threshold: u8,
    erode_size: u8,
    post_process_mask: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BackgroundRemovalResult {
    job_id: String,
    width: u32,
    height: u32,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SaveBackgroundRemovalRequest {
    job_id: String,
    asset_id: i64,
    mode: String,
    directory: Option<String>,
    file_stem: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SaveBackgroundRemovalResult {
    path: String,
    asset_name: Option<String>,
    overwrote_original: bool,
}

fn jobs() -> &'static Mutex<HashMap<String, RemovalJob>> {
    JOBS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn now_ms() -> u64 {
    super::now_ms()
}

fn validate_options(options: &BackgroundRemovalOptions) -> Result<(), String> {
    if !ALLOWED_MODELS.contains(&options.model.as_str()) {
        return Err("不支持的抠图模型".to_string());
    }
    if options.background_threshold >= options.foreground_threshold {
        return Err("背景阈值必须小于前景阈值".to_string());
    }
    if options.erode_size > 40 {
        return Err("边缘收缩范围必须在 0 到 40 之间".to_string());
    }
    Ok(())
}

fn cleanup_expired_jobs() {
    let Ok(mut current) = jobs().lock() else {
        return;
    };
    let threshold = now_ms().saturating_sub(JOB_MAX_AGE_MS);
    current.retain(|_, job| {
        let keep = job.created_at_ms >= threshold;
        if !keep {
            let _ = fs::remove_file(&job.result_path);
        }
        keep
    });
}

fn runtime_path(app: &AppHandle) -> Result<PathBuf, String> {
    let packaged = app
        .path()
        .resource_dir()
        .map_err(|error| error.to_string())?
        .join("rembg-runtime")
        .join("python.exe");
    let development = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("resources")
        .join("rembg-runtime")
        .join("python.exe");
    [packaged, development]
        .into_iter()
        .find(|candidate| candidate.is_file())
        .ok_or_else(|| "抠图运行时缺失，请重新安装应用或执行 pnpm prepare:rembg".to_string())
}

fn indexed_image_path(asset_id: i64, app: &AppHandle) -> Result<PathBuf, String> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?;
    let connection = setup_database(&app_data_dir.join("caevir-index.sqlite3"))?;
    let path: String = connection
        .query_row(
            "SELECT path FROM indexed_assets
             WHERE rowid = ?1 AND kind = '图片' AND availability = 'available'",
            params![asset_id],
            |row| row.get(0),
        )
        .map_err(|_| "图片资源不存在、不可用或不支持抠图".to_string())?;
    let path = PathBuf::from(path);
    if !path.is_file() {
        return Err("原图不存在或无法访问".to_string());
    }
    Ok(path)
}

fn concise_process_error(stderr: &[u8]) -> String {
    let message = String::from_utf8_lossy(stderr);
    let message = message.trim();
    let message = if message.chars().count() > 1_500 {
        message
            .chars()
            .rev()
            .take(1_500)
            .collect::<String>()
            .chars()
            .rev()
            .collect()
    } else {
        message.to_string()
    };
    if message.is_empty() {
        "rembg 未返回可用的错误信息".to_string()
    } else {
        message
    }
}

fn remove_image_background_blocking(
    asset_id: i64,
    options: BackgroundRemovalOptions,
    app: AppHandle,
) -> Result<BackgroundRemovalResult, String> {
    validate_options(&options)?;
    cleanup_expired_jobs();
    let source_path = indexed_image_path(asset_id, &app)?;
    let runtime = runtime_path(&app)?;
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?;
    let result_dir = app_data_dir.join("background-removal");
    let model_dir = app_data_dir.join("models").join("rembg");
    fs::create_dir_all(&result_dir).map_err(|error| format!("无法创建抠图缓存目录：{error}"))?;
    fs::create_dir_all(&model_dir).map_err(|error| format!("无法创建模型目录：{error}"))?;

    let job_id = format!(
        "remove-{}-{}",
        now_ms(),
        NEXT_JOB_ID.fetch_add(1, Ordering::Relaxed)
    );
    let result_path = result_dir.join(format!("{job_id}.png"));
    let mut command = windowless_command(runtime);
    command
        .arg("-c")
        .arg(REMBG_RUNNER)
        .arg(&source_path)
        .arg(&result_path)
        .arg(&options.model)
        .arg(if options.alpha_matting { "1" } else { "0" })
        .arg(options.foreground_threshold.to_string())
        .arg(options.background_threshold.to_string())
        .arg(options.erode_size.to_string())
        .arg(if options.post_process_mask { "1" } else { "0" })
        .env("U2NET_HOME", &model_dir)
        .env("PYTHONUTF8", "1")
        .env("PYTHONNOUSERSITE", "1")
        .env("OMP_NUM_THREADS", "4");

    let output = command_output_with_timeout(&mut command, REMOVAL_TIMEOUT)
        .map_err(|error| error.replace("媒体处理", "抠图处理"))?;
    if !output.status.success() {
        let _ = fs::remove_file(&result_path);
        return Err(format!(
            "抠图失败：{}",
            concise_process_error(&output.stderr)
        ));
    }
    if !result_path.is_file() {
        return Err("抠图完成但未生成结果文件".to_string());
    }
    let (width, height) = image::image_dimensions(&result_path)
        .map_err(|error| format!("无法读取抠图结果：{error}"))?;
    let job = RemovalJob {
        asset_id,
        source_path,
        result_path,
        width,
        height,
        created_at_ms: now_ms(),
    };
    jobs()
        .lock()
        .map_err(|_| "抠图任务状态不可用".to_string())?
        .insert(job_id.clone(), job);
    Ok(BackgroundRemovalResult {
        job_id,
        width,
        height,
    })
}

#[tauri::command]
pub(crate) async fn remove_image_background(
    asset_id: i64,
    options: BackgroundRemovalOptions,
    app: AppHandle,
) -> Result<BackgroundRemovalResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        remove_image_background_blocking(asset_id, options, app)
    })
    .await
    .map_err(|error| error.to_string())?
}

fn job_for(job_id: &str, asset_id: i64) -> Result<RemovalJob, String> {
    let job = jobs()
        .lock()
        .map_err(|_| "抠图任务状态不可用".to_string())?
        .get(job_id)
        .cloned()
        .ok_or_else(|| "抠图结果已过期，请重新处理".to_string())?;
    if job.asset_id != asset_id || !job.result_path.is_file() {
        return Err("抠图结果与当前资源不匹配或已失效".to_string());
    }
    Ok(job)
}

#[tauri::command]
pub(crate) fn read_background_removal_preview(
    job_id: String,
    asset_id: i64,
) -> Result<Response, String> {
    let job = job_for(&job_id, asset_id)?;
    let bytes = fs::read(job.result_path).map_err(|error| format!("无法读取抠图结果：{error}"))?;
    Ok(Response::new(bytes))
}

fn temporary_sibling(target: &Path, job_id: &str) -> Result<PathBuf, String> {
    let parent = target
        .parent()
        .ok_or_else(|| "无法确定保存目录".to_string())?;
    let name = target
        .file_name()
        .map(|value| value.to_string_lossy().into_owned())
        .ok_or_else(|| "保存文件名无效".to_string())?;
    Ok(parent.join(format!(".{name}.{job_id}.tmp")))
}

fn copy_new_result(job: &RemovalJob, target: &Path, job_id: &str) -> Result<(), String> {
    if target.exists() {
        return Err(format!("目标文件已存在：{}", target.display()));
    }
    let temporary = temporary_sibling(target, job_id)?;
    fs::copy(&job.result_path, &temporary).map_err(|error| format!("无法写入保存目录：{error}"))?;
    if let Err(error) = fs::rename(&temporary, target) {
        let _ = fs::remove_file(&temporary);
        return Err(format!("无法完成结果保存：{error}"));
    }
    Ok(())
}

fn overwrite_original(
    job: &RemovalJob,
    job_id: &str,
    app: &AppHandle,
) -> Result<SaveBackgroundRemovalResult, String> {
    if !job.source_path.is_file() {
        return Err("原图已不存在，无法覆盖".to_string());
    }
    let original_is_png = job
        .source_path
        .extension()
        .and_then(|value| value.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case("png"));
    let target = if original_is_png {
        job.source_path.clone()
    } else {
        job.source_path.with_extension("png")
    };
    if target != job.source_path && target.exists() {
        return Err(format!(
            "同目录中已存在同名 PNG，无法覆盖：{}",
            target.display()
        ));
    }

    let temporary = temporary_sibling(&target, job_id)?;
    fs::copy(&job.result_path, &temporary)
        .map_err(|error| format!("无法在原图目录写入临时结果：{error}"))?;
    let backup = job.source_path.with_file_name(format!(
        ".{}.{}.caevir-backup",
        job.source_path
            .file_name()
            .unwrap_or_default()
            .to_string_lossy(),
        job_id
    ));
    fs::rename(&job.source_path, &backup)
        .map_err(|error| format!("无法备份原图，覆盖已取消：{error}"))?;
    if let Err(error) = fs::rename(&temporary, &target) {
        let _ = fs::rename(&backup, &job.source_path);
        let _ = fs::remove_file(&temporary);
        return Err(format!("无法替换原图，已尝试恢复：{error}"));
    }

    let metadata = target
        .metadata()
        .map_err(|error| format!("无法读取新文件信息：{error}"));
    let update_result = metadata.and_then(|metadata| {
        let modified_ms = metadata
            .modified()
            .ok()
            .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
            .map(|duration| duration.as_millis() as i64)
            .unwrap_or_default();
        let target_name = target
            .file_name()
            .map(|value| value.to_string_lossy().into_owned())
            .unwrap_or_default();
        let directory = target.parent().unwrap_or(Path::new(""));
        let directory_path = directory.to_string_lossy().into_owned();
        let directory_key = normalize_directory_key(directory);
        let app_data_dir = app
            .path()
            .app_data_dir()
            .map_err(|error| error.to_string())?;
        let connection = setup_database(&app_data_dir.join("caevir-index.sqlite3"))?;
        let old_thumbnail: Option<String> = connection
            .query_row(
                "SELECT thumbnail_path FROM indexed_assets WHERE rowid = ?1",
                params![job.asset_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(|error| error.to_string())?
            .flatten();
        let changed = connection
            .execute(
                "UPDATE indexed_assets SET
                   path = ?1, name = ?2, extension = 'png', kind = '图片',
                   size_bytes = ?3, modified_ms = ?4, directory_path = ?5, directory_key = ?6,
                   width = ?7, height = ?8, duration_ms = NULL, thumbnail_path = NULL,
                   metadata_status = 'pending', metadata_error = NULL,
                   content_hash = NULL, hash_modified_ms = NULL
                 WHERE rowid = ?9 AND path = ?10 AND availability = 'available'",
                params![
                    target.to_string_lossy().into_owned(),
                    target_name,
                    metadata.len() as i64,
                    modified_ms,
                    directory_path,
                    directory_key,
                    job.width as i64,
                    job.height as i64,
                    job.asset_id,
                    job.source_path.to_string_lossy().into_owned(),
                ],
            )
            .map_err(|error| error.to_string())?;
        if changed != 1 {
            return Err("资源索引已变化，无法安全覆盖".to_string());
        }
        if let Some(thumbnail) = old_thumbnail {
            let _ = fs::remove_file(thumbnail);
        }
        Ok(target_name)
    });

    let target_name = match update_result {
        Ok(name) => name,
        Err(error) => {
            let _ = fs::remove_file(&target);
            let rollback = fs::rename(&backup, &job.source_path);
            return if let Err(rollback_error) = rollback {
                Err(format!(
                    "覆盖后的索引更新失败（{error}），且原图恢复失败：{rollback_error}"
                ))
            } else {
                Err(format!("索引更新失败，原图已恢复：{error}"))
            };
        }
    };
    let _ = fs::remove_file(&backup);
    let _ = app.emit("asset-index-changed", ());
    Ok(SaveBackgroundRemovalResult {
        path: target.to_string_lossy().into_owned(),
        asset_name: Some(target_name),
        overwrote_original: true,
    })
}

fn save_background_removal_blocking(
    request: SaveBackgroundRemovalRequest,
    app: AppHandle,
) -> Result<SaveBackgroundRemovalResult, String> {
    let job = job_for(&request.job_id, request.asset_id)?;
    let result = save_transparent_image_result(
        request.asset_id,
        &job.source_path,
        &job.result_path,
        job.width,
        job.height,
        &request.job_id,
        &request.mode,
        request.directory.as_deref(),
        request.file_stem.as_deref(),
        &app,
    )?;

    if let Ok(mut current) = jobs().lock() {
        current.remove(&request.job_id);
    }
    let _ = fs::remove_file(&job.result_path);
    Ok(result)
}

#[allow(clippy::too_many_arguments)]
pub(crate) fn save_transparent_image_result(
    asset_id: i64,
    source_path: &Path,
    result_path: &Path,
    width: u32,
    height: u32,
    job_id: &str,
    mode: &str,
    directory: Option<&str>,
    file_stem: Option<&str>,
    app: &AppHandle,
) -> Result<SaveBackgroundRemovalResult, String> {
    let job = RemovalJob {
        asset_id,
        source_path: source_path.to_path_buf(),
        result_path: result_path.to_path_buf(),
        width,
        height,
        created_at_ms: now_ms(),
    };
    match mode {
        "saveAs" | "sourceDirectory" => {
            let stem = validated_asset_stem(file_stem.unwrap_or_default())?;
            let directory = if mode == "saveAs" {
                let value = directory.unwrap_or_default().trim();
                if value.is_empty() {
                    return Err("请选择另存文件夹".to_string());
                }
                PathBuf::from(value)
            } else {
                job.source_path
                    .parent()
                    .ok_or_else(|| "无法确定原图所在目录".to_string())?
                    .to_path_buf()
            };
            if !directory.is_dir() {
                return Err("保存文件夹不存在或无法访问".to_string());
            }
            let target = directory.join(format!("{stem}.png"));
            copy_new_result(&job, &target, job_id)?;
            Ok(SaveBackgroundRemovalResult {
                path: target.to_string_lossy().into_owned(),
                asset_name: None,
                overwrote_original: false,
            })
        }
        "overwrite" => overwrite_original(&job, job_id, app),
        _ => Err("不支持的保存方式".to_string()),
    }
}

#[tauri::command]
pub(crate) async fn save_background_removal(
    request: SaveBackgroundRemovalRequest,
    app: AppHandle,
) -> Result<SaveBackgroundRemovalResult, String> {
    tauri::async_runtime::spawn_blocking(move || save_background_removal_blocking(request, app))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
pub(crate) fn discard_background_removal(job_id: String, asset_id: i64) -> Result<(), String> {
    let mut current = jobs()
        .lock()
        .map_err(|_| "抠图任务状态不可用".to_string())?;
    if let Some(job) = current.get(&job_id) {
        if job.asset_id != asset_id {
            return Err("抠图结果与当前资源不匹配".to_string());
        }
    }
    if let Some(job) = current.remove(&job_id) {
        let _ = fs::remove_file(job.result_path);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_supported_models_and_threshold_order() {
        let mut options = BackgroundRemovalOptions {
            model: "birefnet-general".to_string(),
            alpha_matting: true,
            foreground_threshold: 240,
            background_threshold: 10,
            erode_size: 10,
            post_process_mask: false,
        };
        assert!(validate_options(&options).is_ok());
        options.model = "u2net".to_string();
        assert!(validate_options(&options).is_err());
        options.model = "birefnet-general-lite".to_string();
        options.background_threshold = 240;
        assert!(validate_options(&options).is_err());
    }
}
