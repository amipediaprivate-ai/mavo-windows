use rusqlite::params;
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
use tauri::{AppHandle, Emitter, Manager};

use super::{
    normalize_directory_key, setup_database, validate_image_processing_input, validated_asset_stem,
    MAX_IMAGE_PREVIEW_ALLOC_BYTES, MAX_IMAGE_PREVIEW_DIMENSION, MAX_IMAGE_PREVIEW_PIXELS,
};

const PNG_SIGNATURE: &[u8; 8] = b"\x89PNG\r\n\x1a\n";
const JOB_MAX_AGE_MS: u64 = 24 * 60 * 60 * 1_000;

static NEXT_JOB_ID: AtomicU64 = AtomicU64::new(1);
static JOBS: OnceLock<Mutex<HashMap<String, CompressionJob>>> = OnceLock::new();

#[derive(Clone)]
struct CompressionJob {
    asset_id: i64,
    source_path: PathBuf,
    result_path: PathBuf,
    width: u32,
    height: u32,
    created_at_ms: u64,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PngCompressionOptions {
    use_pngquant: bool,
    use_oxipng: bool,
    preserve_pixels: bool,
    lossy_strength: u8,
    lossless_level: u8,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PngCompressionResult {
    job_id: String,
    width: u32,
    height: u32,
    original_bytes: u64,
    result_bytes: u64,
    used_original: bool,
    techniques: Vec<&'static str>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SavePngCompressionRequest {
    job_id: String,
    asset_id: i64,
    mode: String,
    directory: Option<String>,
    file_stem: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SavePngCompressionResult {
    path: String,
    asset_name: Option<String>,
    overwrote_original: bool,
}

fn jobs() -> &'static Mutex<HashMap<String, CompressionJob>> {
    JOBS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn now_ms() -> u64 {
    super::now_ms()
}

fn validate_options(options: &PngCompressionOptions) -> Result<(), String> {
    if !options.use_pngquant && !options.use_oxipng {
        return Err("请至少选择一种压缩技术".to_string());
    }
    if options.preserve_pixels && options.use_pngquant {
        return Err("不允许像素变化时不能使用 pngquant".to_string());
    }
    if options.preserve_pixels && !options.use_oxipng {
        return Err("不允许像素变化时必须使用 OxiPNG".to_string());
    }
    if !(1..=100).contains(&options.lossy_strength) {
        return Err("pngquant 压缩强度必须在 1 到 100 之间".to_string());
    }
    if !(1..=6).contains(&options.lossless_level) {
        return Err("OxiPNG 优化强度必须在 1 到 6 之间".to_string());
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

fn indexed_png_path(asset_id: i64, app: &AppHandle) -> Result<PathBuf, String> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?;
    let connection = setup_database(&app_data_dir.join("caevir-index.sqlite3"))?;
    let path: String = connection
        .query_row(
            "SELECT path FROM indexed_assets
             WHERE rowid = ?1 AND kind = '图片' AND lower(extension) = 'png'
               AND availability = 'available'",
            params![asset_id],
            |row| row.get(0),
        )
        .map_err(|_| "该资源不存在、不可用或不是 PNG 图片".to_string())?;
    let path = PathBuf::from(path);
    if !path.is_file()
        || !path
            .extension()
            .and_then(|extension| extension.to_str())
            .is_some_and(|extension| extension.eq_ignore_ascii_case("png"))
    {
        return Err("原 PNG 不存在或无法访问".to_string());
    }
    Ok(path)
}

fn validate_png_bytes(bytes: &[u8]) -> Result<(u32, u32), String> {
    if !bytes.starts_with(PNG_SIGNATURE)
        || bytes.len() < 24
        || bytes.get(12..16) != Some(b"IHDR".as_slice())
    {
        return Err("文件内容不是有效的 PNG 图片".to_string());
    }
    let width = u32::from_be_bytes(bytes[16..20].try_into().unwrap());
    let height = u32::from_be_bytes(bytes[20..24].try_into().unwrap());
    if width == 0 || height == 0 {
        return Err("PNG 尺寸无效".to_string());
    }
    let pixels = u64::from(width) * u64::from(height);
    if width > MAX_IMAGE_PREVIEW_DIMENSION
        || height > MAX_IMAGE_PREVIEW_DIMENSION
        || pixels > MAX_IMAGE_PREVIEW_PIXELS
        || pixels.saturating_mul(4) > MAX_IMAGE_PREVIEW_ALLOC_BYTES
    {
        return Err("PNG 尺寸过大，无法安全压缩".to_string());
    }
    Ok((width, height))
}

fn pngquant_quality(strength: u8) -> (u8, u8) {
    let target = 95u8.saturating_sub(((u16::from(strength) - 1) * 40 / 99) as u8);
    (target.saturating_sub(15).max(30), target)
}

fn encode_indexed_png(
    width: u32,
    height: u32,
    palette: &[imagequant::RGBA],
    indices: &[u8],
) -> Result<Vec<u8>, String> {
    let mut palette_rgb = Vec::with_capacity(palette.len() * 3);
    let mut transparency = Vec::with_capacity(palette.len());
    for color in palette {
        palette_rgb.extend_from_slice(&[color.r, color.g, color.b]);
        transparency.push(color.a);
    }
    while transparency.last() == Some(&255) {
        transparency.pop();
    }

    let mut output = Vec::new();
    {
        let mut encoder = png::Encoder::new(&mut output, width, height);
        encoder.set_color(png::ColorType::Indexed);
        encoder.set_depth(png::BitDepth::Eight);
        encoder.set_compression(png::Compression::High);
        encoder.set_palette(palette_rgb);
        if !transparency.is_empty() {
            encoder.set_trns(transparency);
        }
        let mut writer = encoder
            .write_header()
            .map_err(|error| format!("无法编码 pngquant 调色板：{error}"))?;
        writer
            .write_image_data(indices)
            .map_err(|error| format!("无法写入 pngquant 结果：{error}"))?;
    }
    Ok(output)
}

fn compress_with_pngquant(input: &[u8], strength: u8) -> Result<Vec<u8>, String> {
    let decoded = image::load_from_memory_with_format(input, image::ImageFormat::Png)
        .map_err(|error| format!("pngquant 无法解码 PNG：{error}"))?
        .to_rgba8();
    let (width, height) = decoded.dimensions();
    let pixels = decoded
        .pixels()
        .map(|pixel| imagequant::RGBA::new(pixel[0], pixel[1], pixel[2], pixel[3]))
        .collect::<Vec<_>>();

    let mut attributes = imagequant::new();
    let (minimum, target) = pngquant_quality(strength);
    attributes
        .set_quality(minimum, target)
        .map_err(|error| format!("pngquant 质量参数无效：{error}"))?;
    attributes
        .set_speed(4)
        .map_err(|error| format!("pngquant 速度参数无效：{error}"))?;
    let mut image = attributes
        .new_image(pixels, width as usize, height as usize, 0.0)
        .map_err(|error| format!("pngquant 无法创建量化图像：{error}"))?;
    let mut quantized = attributes
        .quantize(&mut image)
        .map_err(|error| format!("pngquant 量化失败：{error}"))?;
    quantized
        .set_dithering_level(1.0)
        .map_err(|error| format!("pngquant 抖动参数无效：{error}"))?;
    let (palette, indices) = quantized
        .remapped(&mut image)
        .map_err(|error| format!("pngquant 像素映射失败：{error}"))?;
    encode_indexed_png(width, height, &palette, &indices)
}

fn optimize_with_oxipng(input: &[u8], level: u8) -> Result<Vec<u8>, String> {
    let mut options = oxipng::Options::from_preset(level);
    options.optimize_alpha = false;
    options.scale_16 = false;
    options.strip = oxipng::StripChunks::None;
    options.max_decompressed_size = Some(MAX_IMAGE_PREVIEW_ALLOC_BYTES as usize);
    options.timeout = Some(Duration::from_secs(10 * 60));
    oxipng::optimize_from_memory(input, &options)
        .map_err(|error| format!("OxiPNG 优化失败：{error}"))
}

fn compress_bytes(input: &[u8], options: &PngCompressionOptions) -> Result<Vec<u8>, String> {
    validate_options(options)?;
    validate_png_bytes(input)?;
    let mut current = input.to_vec();
    if options.use_pngquant {
        current = compress_with_pngquant(&current, options.lossy_strength)?;
    }
    if options.use_oxipng {
        current = optimize_with_oxipng(&current, options.lossless_level)?;
    }
    if current.len() >= input.len() {
        Ok(input.to_vec())
    } else {
        Ok(current)
    }
}

fn compress_png_blocking(
    asset_id: i64,
    options: PngCompressionOptions,
    app: AppHandle,
) -> Result<PngCompressionResult, String> {
    validate_options(&options)?;
    cleanup_expired_jobs();
    let source_path = indexed_png_path(asset_id, &app)?;
    validate_image_processing_input(&source_path, MAX_IMAGE_PREVIEW_PIXELS)?;
    let original = fs::read(&source_path).map_err(|error| format!("无法读取原 PNG：{error}"))?;
    let (width, height) = validate_png_bytes(&original)?;
    let result = compress_bytes(&original, &options)?;
    let used_original = result.len() >= original.len();

    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?;
    let result_dir = app_data_dir.join("png-compression");
    fs::create_dir_all(&result_dir).map_err(|error| format!("无法创建压缩缓存目录：{error}"))?;
    let job_id = format!(
        "png-compress-{}-{}",
        now_ms(),
        NEXT_JOB_ID.fetch_add(1, Ordering::Relaxed)
    );
    let result_path = result_dir.join(format!("{job_id}.png"));
    fs::write(&result_path, &result).map_err(|error| format!("无法写入压缩结果：{error}"))?;

    let original_bytes = original.len() as u64;
    let result_bytes = result.len() as u64;
    jobs()
        .lock()
        .map_err(|_| "PNG 压缩任务状态不可用".to_string())?
        .insert(
            job_id.clone(),
            CompressionJob {
                asset_id,
                source_path,
                result_path,
                width,
                height,
                created_at_ms: now_ms(),
            },
        );
    let mut techniques = Vec::with_capacity(2);
    if options.use_pngquant {
        techniques.push("pngquant");
    }
    if options.use_oxipng {
        techniques.push("OxiPNG");
    }
    Ok(PngCompressionResult {
        job_id,
        width,
        height,
        original_bytes,
        result_bytes,
        used_original,
        techniques,
    })
}

#[tauri::command]
pub(crate) async fn compress_png(
    asset_id: i64,
    options: PngCompressionOptions,
    app: AppHandle,
) -> Result<PngCompressionResult, String> {
    tauri::async_runtime::spawn_blocking(move || compress_png_blocking(asset_id, options, app))
        .await
        .map_err(|error| error.to_string())?
}

fn job_for(job_id: &str, asset_id: i64) -> Result<CompressionJob, String> {
    let job = jobs()
        .lock()
        .map_err(|_| "PNG 压缩任务状态不可用".to_string())?
        .get(job_id)
        .cloned()
        .ok_or_else(|| "PNG 压缩结果已过期，请重新处理".to_string())?;
    if job.asset_id != asset_id || !job.result_path.is_file() {
        return Err("PNG 压缩结果与当前资源不匹配或已失效".to_string());
    }
    Ok(job)
}

pub(crate) fn preview_path(job_id: &str, asset_id: i64) -> Result<PathBuf, String> {
    let job = job_for(&job_id, asset_id)?;
    Ok(job.result_path)
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

fn copy_new_result(job: &CompressionJob, target: &Path, job_id: &str) -> Result<(), String> {
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
    job: &CompressionJob,
    job_id: &str,
    app: &AppHandle,
) -> Result<SavePngCompressionResult, String> {
    if !job.source_path.is_file() {
        return Err("原 PNG 已不存在，无法覆盖".to_string());
    }
    let target = job.source_path.clone();
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
        .map_err(|error| format!("无法备份原 PNG，覆盖已取消：{error}"))?;
    if let Err(error) = fs::rename(&temporary, &target) {
        let _ = fs::rename(&backup, &job.source_path);
        let _ = fs::remove_file(&temporary);
        return Err(format!("无法替换原 PNG，已尝试恢复：{error}"));
    }

    let update_result = (|| -> Result<String, String> {
        let metadata = target
            .metadata()
            .map_err(|error| format!("无法读取压缩后文件信息：{error}"))?;
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
                   size_bytes = ?1, modified_ms = ?2, directory_path = ?3, directory_key = ?4,
                   width = ?5, height = ?6, thumbnail_path = NULL,
                   metadata_status = 'pending', metadata_error = NULL,
                   content_hash = NULL, hash_modified_ms = NULL
                 WHERE rowid = ?7 AND path = ?8 AND kind = '图片'
                   AND lower(extension) = 'png' AND availability = 'available'",
                params![
                    metadata.len() as i64,
                    modified_ms,
                    directory.to_string_lossy().into_owned(),
                    normalize_directory_key(directory),
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
    })();

    let target_name = match update_result {
        Ok(name) => name,
        Err(error) => {
            let _ = fs::remove_file(&target);
            let rollback = fs::rename(&backup, &job.source_path);
            return if let Err(rollback_error) = rollback {
                Err(format!(
                    "覆盖后的索引更新失败（{error}），且原 PNG 恢复失败：{rollback_error}"
                ))
            } else {
                Err(format!("索引更新失败，原 PNG 已恢复：{error}"))
            };
        }
    };
    let _ = fs::remove_file(&backup);
    let _ = app.emit("asset-index-changed", ());
    Ok(SavePngCompressionResult {
        path: target.to_string_lossy().into_owned(),
        asset_name: Some(target_name),
        overwrote_original: true,
    })
}

fn save_png_compression_blocking(
    request: SavePngCompressionRequest,
    app: AppHandle,
) -> Result<SavePngCompressionResult, String> {
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
                    .ok_or_else(|| "无法确定原 PNG 所在目录".to_string())?
                    .to_path_buf()
            };
            if !directory.is_dir() {
                return Err("保存文件夹不存在或无法访问".to_string());
            }
            let target = directory.join(format!("{stem}.png"));
            copy_new_result(&job, &target, &request.job_id)?;
            Ok(SavePngCompressionResult {
                path: target.to_string_lossy().into_owned(),
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
    let _ = fs::remove_file(&job.result_path);
    Ok(result)
}

#[tauri::command]
pub(crate) async fn save_png_compression(
    request: SavePngCompressionRequest,
    app: AppHandle,
) -> Result<SavePngCompressionResult, String> {
    tauri::async_runtime::spawn_blocking(move || save_png_compression_blocking(request, app))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
pub(crate) fn discard_png_compression(job_id: String, asset_id: i64) -> Result<(), String> {
    let mut current = jobs()
        .lock()
        .map_err(|_| "PNG 压缩任务状态不可用".to_string())?;
    if let Some(job) = current.get(&job_id) {
        if job.asset_id != asset_id {
            return Err("PNG 压缩结果与当前资源不匹配".to_string());
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

    fn sample_png() -> Vec<u8> {
        let mut bytes = Vec::new();
        {
            let mut encoder = png::Encoder::new(&mut bytes, 4, 2);
            encoder.set_color(png::ColorType::Rgba);
            encoder.set_depth(png::BitDepth::Eight);
            let mut writer = encoder.write_header().unwrap();
            writer
                .write_image_data(&[
                    255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 9, 8, 7, 0, 255, 0, 0, 255, 0,
                    255, 0, 255, 0, 0, 255, 255, 6, 5, 4, 0,
                ])
                .unwrap();
        }
        bytes
    }

    #[test]
    fn validates_technology_selection_and_pixel_preservation() {
        let mut options = PngCompressionOptions {
            use_pngquant: false,
            use_oxipng: false,
            preserve_pixels: false,
            lossy_strength: 50,
            lossless_level: 4,
        };
        assert!(validate_options(&options).is_err());
        options.preserve_pixels = true;
        options.use_pngquant = true;
        assert!(validate_options(&options).is_err());
        options.use_pngquant = false;
        options.use_oxipng = true;
        assert!(validate_options(&options).is_ok());
    }

    #[test]
    fn maps_more_lossy_strength_to_lower_quality() {
        assert!(pngquant_quality(1).1 > pngquant_quality(100).1);
        assert!(pngquant_quality(100).0 <= pngquant_quality(100).1);
    }

    #[test]
    fn oxipng_only_preserves_decoded_rgba_pixels() {
        let input = sample_png();
        let output = optimize_with_oxipng(&input, 3).unwrap();
        let before = image::load_from_memory(&input).unwrap().to_rgba8();
        let after = image::load_from_memory(&output).unwrap().to_rgba8();
        assert_eq!(before.dimensions(), after.dimensions());
        assert_eq!(before.as_raw(), after.as_raw());
    }

    #[test]
    fn combined_pipeline_produces_valid_png_without_size_regression() {
        let input = sample_png();
        let output = compress_bytes(
            &input,
            &PngCompressionOptions {
                use_pngquant: true,
                use_oxipng: true,
                preserve_pixels: false,
                lossy_strength: 60,
                lossless_level: 2,
            },
        )
        .unwrap();
        assert!(output.starts_with(PNG_SIGNATURE));
        assert!(output.len() <= input.len());
        let decoded = image::load_from_memory(&output).unwrap();
        assert_eq!((decoded.width(), decoded.height()), (4, 2));
    }
}
