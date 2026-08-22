use rusqlite::params;
use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, HashSet},
    fs,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicU64, Ordering},
        Mutex, OnceLock,
    },
    time::{Duration, UNIX_EPOCH},
};
use tauri::{AppHandle, Emitter, Manager};

use super::{
    background_windowless_command, command_output_with_timeout, media_command,
    normalize_directory_key, now_ms, setup_database, validated_asset_stem,
};

const JOB_MAX_AGE_MS: u64 = 24 * 60 * 60 * 1_000;
const PROCESS_TIMEOUT: Duration = Duration::from_secs(30 * 60);
const SUPPORTED_FORMATS: &[&str] = &["mp3", "wav", "flac", "aac", "ogg", "m4a"];

static NEXT_JOB_ID: AtomicU64 = AtomicU64::new(1);
static JOBS: OnceLock<Mutex<HashMap<String, AudioJob>>> = OnceLock::new();

#[derive(Clone)]
struct JobOutput {
    id: String,
    path: PathBuf,
    file_name: String,
    extension: String,
    bytes: u64,
}

#[derive(Clone)]
struct AudioJob {
    asset_id: i64,
    source_path: PathBuf,
    source_stem: String,
    operation: String,
    outputs: Vec<JobOutput>,
    job_dir: PathBuf,
    created_at_ms: u64,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AudioProcessingOptions {
    operation: String,
    #[serde(default)]
    formats: Vec<String>,
    compression_strength: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AudioOutputResult {
    id: String,
    file_name: String,
    format: String,
    bytes: u64,
    mime_type: &'static str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AudioProcessingResult {
    job_id: String,
    operation: String,
    original_bytes: u64,
    outputs: Vec<AudioOutputResult>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SaveAudioProcessingRequest {
    job_id: String,
    asset_id: i64,
    mode: String,
    directory: Option<String>,
    file_stem: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SaveAudioProcessingResult {
    paths: Vec<String>,
    asset_name: Option<String>,
    overwrote_original: bool,
}

fn jobs() -> &'static Mutex<HashMap<String, AudioJob>> {
    JOBS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn remove_job_files(job: &AudioJob) {
    let _ = fs::remove_dir_all(&job.job_dir);
}

fn cleanup_expired_jobs() {
    let Ok(mut current) = jobs().lock() else {
        return;
    };
    let threshold = now_ms().saturating_sub(JOB_MAX_AGE_MS);
    current.retain(|_, job| {
        let keep = job.created_at_ms >= threshold;
        if !keep {
            remove_job_files(job);
        }
        keep
    });
}

fn indexed_audio_path(asset_id: i64, app: &AppHandle) -> Result<PathBuf, String> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?;
    let connection = setup_database(&app_data_dir.join("caevir-index.sqlite3"))?;
    let path: String = connection
        .query_row(
            "SELECT path FROM indexed_assets
             WHERE rowid = ?1 AND kind = '音频' AND availability = 'available'",
            params![asset_id],
            |row| row.get(0),
        )
        .map_err(|_| "该音频资源不存在或不可用".to_string())?;
    let path = PathBuf::from(path);
    if !path.is_file() {
        return Err("原音频不存在或无法访问".to_string());
    }
    Ok(path)
}

fn extension(path: &Path) -> String {
    path.extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase()
}

fn source_stem(path: &Path) -> String {
    path.file_stem()
        .and_then(|value| value.to_str())
        .filter(|value| !value.is_empty())
        .unwrap_or("audio")
        .to_string()
}

fn validate_options(source_path: &Path, options: &AudioProcessingOptions) -> Result<(), String> {
    match options.operation.as_str() {
        "fsbToWav" => {
            if !extension(source_path).eq_ignore_ascii_case("fsb") {
                return Err("只有 FSB 音频可以使用 FSB 转 WAV".to_string());
            }
        }
        "formatConversion" => {
            if extension(source_path) == "fsb" {
                return Err("请先使用 FSB 转 WAV，再进行常见格式转换".to_string());
            }
            if options.formats.is_empty() {
                return Err("请至少选择一种输出格式".to_string());
            }
            let mut unique = HashSet::new();
            for format in &options.formats {
                if !SUPPORTED_FORMATS.contains(&format.as_str()) {
                    return Err(format!("不支持的输出格式：{format}"));
                }
                if !unique.insert(format) {
                    return Err(format!("输出格式重复：{format}"));
                }
            }
        }
        "compression" => {
            if extension(source_path) == "fsb" {
                return Err("请先将 FSB 转为 WAV，再进行音频压缩".to_string());
            }
            if !matches!(
                options.compression_strength.as_deref(),
                Some("light" | "balanced" | "strong")
            ) {
                return Err("请选择有效的压缩强度".to_string());
            }
        }
        _ => return Err("不支持的音频处理操作".to_string()),
    }
    Ok(())
}

fn vgmstream_command(app: &AppHandle) -> Result<std::process::Command, String> {
    let resource_dir = app
        .path()
        .resource_dir()
        .map_err(|error| error.to_string())?;
    let development_dir = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("resources")
        .join("vgmstream");
    for directory in [resource_dir.join("vgmstream"), development_dir] {
        let executable = directory.join(if cfg!(windows) {
            "vgmstream-cli.exe"
        } else {
            "vgmstream-cli"
        });
        if executable.is_file() {
            return Ok(background_windowless_command(executable));
        }
    }
    Err("vgmstream-cli 运行时缺失，请重新安装或重新构建 Caevir".to_string())
}

fn output_error(prefix: &str, output: &std::process::Output) -> String {
    let stderr = String::from_utf8_lossy(&output.stderr);
    let stdout = String::from_utf8_lossy(&output.stdout);
    let detail = if stderr.trim().is_empty() {
        stdout.trim()
    } else {
        stderr.trim()
    };
    if detail.is_empty() {
        prefix.to_string()
    } else {
        format!("{prefix}：{detail}")
    }
}

fn collect_outputs(job_dir: &Path, wanted_extension: &str) -> Result<Vec<PathBuf>, String> {
    let mut paths = fs::read_dir(job_dir)
        .map_err(|error| format!("无法读取音频处理结果：{error}"))?
        .filter_map(Result::ok)
        .map(|entry| entry.path())
        .filter(|path| path.is_file() && extension(path) == wanted_extension)
        .collect::<Vec<_>>();
    paths.sort();
    if paths.is_empty() {
        return Err("音频处理未生成有效结果".to_string());
    }
    Ok(paths)
}

fn convert_fsb(
    source_path: &Path,
    job_dir: &Path,
    stem: &str,
    app: &AppHandle,
) -> Result<Vec<PathBuf>, String> {
    let mut command = vgmstream_command(app)?;
    command
        .current_dir(job_dir)
        .args(["-i", "-S", "0", "-o"])
        .arg(format!("{stem}-?04s-?n.wav"))
        .arg(source_path);
    let output = command_output_with_timeout(&mut command, PROCESS_TIMEOUT)
        .map_err(|error| format!("FSB 转 WAV 失败：{error}"))?;
    if !output.status.success() {
        return Err(output_error("FSB 转 WAV 失败", &output));
    }
    collect_outputs(job_dir, "wav")
}

fn add_format_arguments(command: &mut std::process::Command, format: &str) {
    match format {
        "mp3" => {
            command.args(["-c:a", "libmp3lame", "-q:a", "2", "-f", "mp3"]);
        }
        "wav" => {
            command.args(["-c:a", "pcm_s16le", "-f", "wav"]);
        }
        "flac" => {
            command.args(["-c:a", "flac", "-compression_level", "8", "-f", "flac"]);
        }
        "aac" => {
            command.args(["-c:a", "aac", "-b:a", "256k", "-f", "adts"]);
        }
        "ogg" => {
            command.args(["-c:a", "libvorbis", "-q:a", "6", "-f", "ogg"]);
        }
        "m4a" => {
            command.args([
                "-c:a",
                "aac",
                "-b:a",
                "256k",
                "-movflags",
                "+faststart",
                "-f",
                "mp4",
            ]);
        }
        _ => {}
    }
}

fn run_ffmpeg(
    source_path: &Path,
    output_path: &Path,
    configure: impl FnOnce(&mut std::process::Command),
) -> Result<(), String> {
    let mut command = media_command("ffmpeg");
    command
        .args(["-hide_banner", "-nostdin", "-v", "error", "-y", "-i"])
        .arg(source_path)
        .args(["-map", "0:a:0", "-vn", "-sn", "-dn", "-map_metadata", "-1"]);
    configure(&mut command);
    command.arg(output_path);
    let output = command_output_with_timeout(&mut command, PROCESS_TIMEOUT)
        .map_err(|error| format!("音频转换失败：{error}"))?;
    if !output.status.success() {
        return Err(output_error("音频转换失败", &output));
    }
    let bytes = output_path.metadata().map(|value| value.len()).unwrap_or(0);
    if bytes == 0 {
        return Err("音频转换未生成有效文件".to_string());
    }
    Ok(())
}

fn convert_formats(
    source_path: &Path,
    job_dir: &Path,
    stem: &str,
    formats: &[String],
) -> Result<Vec<PathBuf>, String> {
    let mut results = Vec::with_capacity(formats.len());
    for format in formats {
        let output_path = job_dir.join(format!("{stem}.{format}"));
        run_ffmpeg(source_path, &output_path, |command| {
            add_format_arguments(command, format)
        })?;
        results.push(output_path);
    }
    Ok(results)
}

fn compress_audio(
    source_path: &Path,
    job_dir: &Path,
    stem: &str,
    strength: &str,
) -> Result<Vec<PathBuf>, String> {
    let bitrate = match strength {
        "light" => "256k",
        "balanced" => "160k",
        "strong" => "96k",
        _ => return Err("请选择有效的压缩强度".to_string()),
    };
    let output_path = job_dir.join(format!("{stem}-compressed.mp3"));
    run_ffmpeg(source_path, &output_path, |command| {
        command.args(["-c:a", "libmp3lame", "-b:a", bitrate, "-f", "mp3"]);
    })?;
    Ok(vec![output_path])
}

fn mime_type(format: &str) -> &'static str {
    match format {
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "flac" => "audio/flac",
        "aac" => "audio/aac",
        "ogg" => "audio/ogg",
        "m4a" => "audio/mp4",
        _ => "application/octet-stream",
    }
}

fn process_audio_blocking(
    asset_id: i64,
    options: AudioProcessingOptions,
    app: AppHandle,
) -> Result<AudioProcessingResult, String> {
    cleanup_expired_jobs();
    let source_path = indexed_audio_path(asset_id, &app)?;
    validate_options(&source_path, &options)?;
    let original_bytes = source_path
        .metadata()
        .map_err(|error| format!("无法读取原音频信息：{error}"))?
        .len();
    let stem = source_stem(&source_path);
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?;
    let job_id = format!(
        "audio-{}-{}",
        now_ms(),
        NEXT_JOB_ID.fetch_add(1, Ordering::Relaxed)
    );
    let job_dir = app_data_dir.join("audio-processing").join(&job_id);
    fs::create_dir_all(&job_dir).map_err(|error| format!("无法创建音频处理缓存目录：{error}"))?;

    let processed = match options.operation.as_str() {
        "fsbToWav" => convert_fsb(&source_path, &job_dir, &stem, &app),
        "formatConversion" => convert_formats(&source_path, &job_dir, &stem, &options.formats),
        "compression" => compress_audio(
            &source_path,
            &job_dir,
            &stem,
            options.compression_strength.as_deref().unwrap_or_default(),
        ),
        _ => Err("不支持的音频处理操作".to_string()),
    };
    let paths = match processed {
        Ok(paths) => paths,
        Err(error) => {
            let _ = fs::remove_dir_all(&job_dir);
            return Err(error);
        }
    };

    let mut outputs = Vec::with_capacity(paths.len());
    for (index, path) in paths.into_iter().enumerate() {
        let bytes = path
            .metadata()
            .map_err(|error| format!("无法读取处理结果：{error}"))?
            .len();
        if bytes == 0 {
            let _ = fs::remove_dir_all(&job_dir);
            return Err("音频处理生成了空文件".to_string());
        }
        let file_name = path
            .file_name()
            .map(|value| value.to_string_lossy().into_owned())
            .unwrap_or_else(|| format!("output-{}", index + 1));
        outputs.push(JobOutput {
            id: format!("output-{}", index + 1),
            extension: extension(&path),
            path,
            file_name,
            bytes,
        });
    }
    let response_outputs = outputs
        .iter()
        .map(|output| AudioOutputResult {
            id: output.id.clone(),
            file_name: output.file_name.clone(),
            format: output.extension.to_ascii_uppercase(),
            bytes: output.bytes,
            mime_type: mime_type(&output.extension),
        })
        .collect();
    jobs()
        .lock()
        .map_err(|_| "音频处理任务状态不可用".to_string())?
        .insert(
            job_id.clone(),
            AudioJob {
                asset_id,
                source_path,
                source_stem: stem,
                operation: options.operation.clone(),
                outputs,
                job_dir,
                created_at_ms: now_ms(),
            },
        );
    Ok(AudioProcessingResult {
        job_id,
        operation: options.operation,
        original_bytes,
        outputs: response_outputs,
    })
}

#[tauri::command]
pub(crate) async fn process_audio(
    asset_id: i64,
    options: AudioProcessingOptions,
    app: AppHandle,
) -> Result<AudioProcessingResult, String> {
    tauri::async_runtime::spawn_blocking(move || process_audio_blocking(asset_id, options, app))
        .await
        .map_err(|error| error.to_string())?
}

fn job_for(job_id: &str, asset_id: i64) -> Result<AudioJob, String> {
    let job = jobs()
        .lock()
        .map_err(|_| "音频处理任务状态不可用".to_string())?
        .get(job_id)
        .cloned()
        .ok_or_else(|| "音频处理结果已过期，请重新处理".to_string())?;
    if job.asset_id != asset_id || job.outputs.iter().any(|output| !output.path.is_file()) {
        return Err("音频处理结果与当前资源不匹配或已失效".to_string());
    }
    Ok(job)
}

pub(crate) fn preview_output_path(
    job_id: &str,
    asset_id: i64,
    output_id: &str,
) -> Result<PathBuf, String> {
    let job = job_for(&job_id, asset_id)?;
    let output = job
        .outputs
        .iter()
        .find(|output| output.id == output_id)
        .ok_or_else(|| "指定的音频结果不存在".to_string())?;
    Ok(output.path.clone())
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

fn target_stem(job: &AudioJob, output: &JobOutput, base: &str) -> String {
    if job.outputs.len() == 1 || job.operation == "formatConversion" {
        return base.to_string();
    }
    let output_stem = Path::new(&output.file_name)
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or_default();
    let suffix = output_stem
        .strip_prefix(&job.source_stem)
        .filter(|value| !value.is_empty())
        .unwrap_or(output_stem);
    format!("{base}{suffix}")
}

fn save_new_results(
    job: &AudioJob,
    directory: &Path,
    base: &str,
    job_id: &str,
) -> Result<Vec<String>, String> {
    if !directory.is_dir() {
        return Err("保存文件夹不存在或无法访问".to_string());
    }
    let targets = job
        .outputs
        .iter()
        .map(|output| {
            directory.join(format!(
                "{}.{}",
                target_stem(job, output, base),
                output.extension
            ))
        })
        .collect::<Vec<_>>();
    let mut unique = HashSet::new();
    for target in &targets {
        let key = target.to_string_lossy().to_lowercase();
        if !unique.insert(key) {
            return Err("多个输出会生成相同文件名，请更换结果名称".to_string());
        }
        if target.exists() {
            return Err(format!("目标文件已存在：{}", target.display()));
        }
    }

    let mut temporaries = Vec::with_capacity(targets.len());
    for (output, target) in job.outputs.iter().zip(&targets) {
        let temporary = temporary_sibling(target, job_id)?;
        if let Err(error) = fs::copy(&output.path, &temporary) {
            for path in &temporaries {
                let _ = fs::remove_file(path);
            }
            return Err(format!("无法写入保存目录：{error}"));
        }
        temporaries.push(temporary);
    }

    let mut created = Vec::new();
    for (temporary, target) in temporaries.iter().zip(&targets) {
        if let Err(error) = fs::rename(temporary, target) {
            for path in &created {
                let _ = fs::remove_file(path);
            }
            for path in &temporaries {
                let _ = fs::remove_file(path);
            }
            return Err(format!("无法完成结果保存：{error}"));
        }
        created.push(target.clone());
    }
    Ok(created
        .into_iter()
        .map(|path| path.to_string_lossy().into_owned())
        .collect())
}

fn overwrite_original(
    job: &AudioJob,
    job_id: &str,
    app: &AppHandle,
) -> Result<SaveAudioProcessingResult, String> {
    if job.outputs.len() != 1 {
        return Err("多个音频结果不能覆盖原文件，请使用另存为或原文件目录".to_string());
    }
    if !job.source_path.is_file() {
        return Err("原音频已不存在，无法覆盖".to_string());
    }
    let output = &job.outputs[0];
    let target = job.source_path.with_extension(&output.extension);
    if target != job.source_path && target.exists() {
        return Err(format!("目标文件已存在，无法覆盖：{}", target.display()));
    }
    let temporary = temporary_sibling(&target, job_id)?;
    fs::copy(&output.path, &temporary)
        .map_err(|error| format!("无法在原音频目录写入临时结果：{error}"))?;
    let backup = job.source_path.with_file_name(format!(
        ".{}.{}.caevir-backup",
        job.source_path
            .file_name()
            .unwrap_or_default()
            .to_string_lossy(),
        job_id
    ));
    fs::rename(&job.source_path, &backup)
        .map_err(|error| format!("无法备份原音频，覆盖已取消：{error}"))?;
    if let Err(error) = fs::rename(&temporary, &target) {
        let _ = fs::rename(&backup, &job.source_path);
        let _ = fs::remove_file(&temporary);
        return Err(format!("无法替换原音频，已尝试恢复：{error}"));
    }

    let update_result = (|| -> Result<String, String> {
        let metadata = target
            .metadata()
            .map_err(|error| format!("无法读取处理后文件信息：{error}"))?;
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
            .map_err(|error| error.to_string())?;
        let changed = connection
            .execute(
                "UPDATE indexed_assets SET
                   path = ?1, name = ?2, extension = ?3, size_bytes = ?4,
                   modified_ms = ?5, directory_path = ?6, directory_key = ?7,
                   duration_ms = NULL, audio_sample_rate = NULL, audio_bit_depth = NULL,
                   audio_channels = NULL, audio_codec = NULL, audio_endianness = NULL,
                   audio_frame_size = NULL, integrated_lufs = NULL, true_peak_dbtp = NULL,
                   loudness_range_lu = NULL, loudness_status = 'pending',
                   thumbnail_path = NULL, metadata_status = 'pending', metadata_error = NULL,
                   content_hash = NULL, hash_modified_ms = NULL
                 WHERE rowid = ?8 AND path = ?9 AND kind = '音频' AND availability = 'available'",
                params![
                    target.to_string_lossy().into_owned(),
                    target_name,
                    output.extension,
                    metadata.len() as i64,
                    modified_ms,
                    directory.to_string_lossy().into_owned(),
                    normalize_directory_key(directory),
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
    })();

    let target_name = match update_result {
        Ok(name) => name,
        Err(error) => {
            let _ = fs::remove_file(&target);
            let rollback = fs::rename(&backup, &job.source_path);
            return if let Err(rollback_error) = rollback {
                Err(format!(
                    "覆盖后的索引更新失败（{error}），且原音频恢复失败：{rollback_error}"
                ))
            } else {
                Err(format!("索引更新失败，原音频已恢复：{error}"))
            };
        }
    };
    let _ = fs::remove_file(&backup);
    let _ = app.emit("asset-index-changed", ());
    Ok(SaveAudioProcessingResult {
        paths: vec![target.to_string_lossy().into_owned()],
        asset_name: Some(target_name),
        overwrote_original: true,
    })
}

fn save_audio_processing_blocking(
    request: SaveAudioProcessingRequest,
    app: AppHandle,
) -> Result<SaveAudioProcessingResult, String> {
    let job = job_for(&request.job_id, request.asset_id)?;
    let result = match request.mode.as_str() {
        "saveAs" | "sourceDirectory" => {
            let stem = validated_asset_stem(request.file_stem.as_deref().unwrap_or_default())?;
            let directory = if request.mode == "saveAs" {
                let value = request.directory.as_deref().unwrap_or_default().trim();
                if value.is_empty() {
                    return Err("请选择另存文件夹".to_string());
                }
                PathBuf::from(value)
            } else {
                job.source_path
                    .parent()
                    .ok_or_else(|| "无法确定原音频所在目录".to_string())?
                    .to_path_buf()
            };
            let paths = save_new_results(&job, &directory, &stem, &request.job_id)?;
            Ok(SaveAudioProcessingResult {
                paths,
                asset_name: None,
                overwrote_original: false,
            })
        }
        "overwrite" => overwrite_original(&job, &request.job_id, &app),
        _ => Err("不支持的保存方式".to_string()),
    }?;

    if let Ok(mut current) = jobs().lock() {
        current.remove(&request.job_id);
    }
    remove_job_files(&job);
    Ok(result)
}

#[tauri::command]
pub(crate) async fn save_audio_processing(
    request: SaveAudioProcessingRequest,
    app: AppHandle,
) -> Result<SaveAudioProcessingResult, String> {
    tauri::async_runtime::spawn_blocking(move || save_audio_processing_blocking(request, app))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
pub(crate) fn discard_audio_processing(job_id: String, asset_id: i64) -> Result<(), String> {
    let mut current = jobs()
        .lock()
        .map_err(|_| "音频处理任务状态不可用".to_string())?;
    if let Some(job) = current.get(&job_id) {
        if job.asset_id != asset_id {
            return Err("音频处理结果与当前资源不匹配".to_string());
        }
    }
    if let Some(job) = current.remove(&job_id) {
        remove_job_files(&job);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn options(operation: &str) -> AudioProcessingOptions {
        AudioProcessingOptions {
            operation: operation.to_string(),
            formats: Vec::new(),
            compression_strength: None,
        }
    }

    #[test]
    fn validates_fsb_and_multi_format_options() {
        assert!(validate_options(Path::new("bank.fsb"), &options("fsbToWav")).is_ok());
        assert!(validate_options(Path::new("track.wav"), &options("fsbToWav")).is_err());

        let mut conversion = options("formatConversion");
        conversion.formats = vec!["mp3".to_string(), "flac".to_string()];
        assert!(validate_options(Path::new("track.wav"), &conversion).is_ok());
        conversion.formats.push("mp3".to_string());
        assert!(validate_options(Path::new("track.wav"), &conversion).is_err());
    }

    #[test]
    fn validates_compression_strength() {
        let mut compression = options("compression");
        assert!(validate_options(Path::new("track.wav"), &compression).is_err());
        compression.compression_strength = Some("balanced".to_string());
        assert!(validate_options(Path::new("track.wav"), &compression).is_ok());
    }

    #[test]
    fn maps_supported_mime_types() {
        assert_eq!(mime_type("mp3"), "audio/mpeg");
        assert_eq!(mime_type("m4a"), "audio/mp4");
        assert_eq!(mime_type("wav"), "audio/wav");
    }
}
