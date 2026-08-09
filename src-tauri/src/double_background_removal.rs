use image::{DynamicImage, Rgba, RgbaImage};
use rusqlite::params;
use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, VecDeque},
    fs,
    path::PathBuf,
    sync::{
        atomic::{AtomicU64, Ordering},
        Mutex, OnceLock,
    },
};
use tauri::{ipc::Response, AppHandle, Manager};

use super::{
    background_removal::{save_transparent_image_result, SaveBackgroundRemovalResult},
    decode_preview, setup_database,
};

const JOB_MAX_AGE_MS: u64 = 24 * 60 * 60 * 1_000;
const MAX_PROCESS_PIXELS: u64 = 12 * 1024 * 1024;
const ALPHA_NOISE_THRESHOLD: u8 = 51;
const FRONTIER_BACKGROUND_ALPHA: u8 = 10;
const FRONTIER_SHAVE: u8 = 22;
const MAX_EROSION_PASSES: usize = 56;
const SUPPORTED_EXTENSIONS: &[&str] = &["png", "jpg", "jpeg", "webp", "bmp", "tif", "tiff"];

static NEXT_JOB_ID: AtomicU64 = AtomicU64::new(1);
static JOBS: OnceLock<Mutex<HashMap<String, DoubleBackgroundJob>>> = OnceLock::new();

#[derive(Clone)]
struct DoubleBackgroundJob {
    asset_id: i64,
    source_path: PathBuf,
    counterpart_path: PathBuf,
    result_path: PathBuf,
    width: u32,
    height: u32,
    created_at_ms: u64,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DoubleBackgroundRemovalOptions {
    background_scope: BackgroundScope,
    background_tolerance: u8,
    softness: u8,
    tolerance: u8,
    edge_contrast: u8,
    post_process: bool,
    erosion: u8,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
enum BackgroundScope {
    Edge,
    All,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DoubleBackgroundRemovalResult {
    job_id: String,
    width: u32,
    height: u32,
    detected_background: &'static str,
    confidence: f64,
    border_match_ratio: f64,
    warnings: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SaveDoubleBackgroundRemovalRequest {
    job_id: String,
    asset_id: i64,
    mode: String,
    directory: Option<String>,
    file_stem: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum BackgroundKind {
    Black,
    White,
}

impl BackgroundKind {
    fn label(self) -> &'static str {
        match self {
            Self::Black => "black",
            Self::White => "white",
        }
    }
}

#[derive(Debug)]
struct BackgroundAnalysis {
    kind: BackgroundKind,
    confidence: f64,
    border_match_ratio: f64,
    warnings: Vec<String>,
}

fn jobs() -> &'static Mutex<HashMap<String, DoubleBackgroundJob>> {
    JOBS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn now_ms() -> u64 {
    super::now_ms()
}

fn validate_options(options: &DoubleBackgroundRemovalOptions) -> Result<(), String> {
    if !(4..=48).contains(&options.background_tolerance) {
        return Err("背景识别容差必须在 4 到 48 之间".to_string());
    }
    if options.softness > 8 {
        return Err("蒙版柔化宽度必须在 0 到 8 之间".to_string());
    }
    if !(50..=100).contains(&options.tolerance) {
        return Err("双背景容差必须在 50 到 100 之间".to_string());
    }
    if !(50..=100).contains(&options.edge_contrast) {
        return Err("边缘对比必须在 50 到 100 之间".to_string());
    }
    if options.erosion > 100 {
        return Err("边缘侵蚀必须在 0 到 100 之间".to_string());
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
            let _ = fs::remove_file(&job.counterpart_path);
            let _ = fs::remove_file(&job.result_path);
        }
        keep
    });
}

fn indexed_image_path(asset_id: i64, app: &AppHandle) -> Result<PathBuf, String> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?;
    let connection = setup_database(&app_data_dir.join("caevir-index.sqlite3"))?;
    let (path, extension): (String, String) = connection
        .query_row(
            "SELECT path, lower(extension) FROM indexed_assets
             WHERE rowid = ?1 AND kind = '图片' AND availability = 'available'",
            params![asset_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .map_err(|_| "图片资源不存在、不可用或不支持移除背景".to_string())?;
    if !SUPPORTED_EXTENSIONS.contains(&extension.as_str()) {
        return Err("该图片格式暂不支持移除背景".to_string());
    }
    let path = PathBuf::from(path);
    if !path.is_file() {
        return Err("原图不存在或无法访问".to_string());
    }
    Ok(path)
}

fn channel_distance(pixel: &Rgba<u8>, kind: BackgroundKind) -> u8 {
    match kind {
        BackgroundKind::Black => pixel[0].max(pixel[1]).max(pixel[2]),
        BackgroundKind::White => (255 - pixel[0]).max(255 - pixel[1]).max(255 - pixel[2]),
    }
}

fn matches_background(pixel: &Rgba<u8>, kind: BackgroundKind, tolerance: u8) -> bool {
    channel_distance(pixel, kind) <= tolerance
}

fn edge_ring_width(width: u32, height: u32) -> u32 {
    let minimum = width.min(height);
    if minimum <= 2 {
        1
    } else {
        ((minimum as f64 * 0.01).round() as u32)
            .clamp(2, 32)
            .min((minimum / 2).max(1))
    }
}

fn is_ring_pixel(x: u32, y: u32, width: u32, height: u32, ring: u32) -> bool {
    x < ring || y < ring || x >= width - ring || y >= height - ring
}

fn analyze_background(image: &RgbaImage, tolerance: u8) -> Result<BackgroundAnalysis, String> {
    let (width, height) = image.dimensions();
    if width == 0 || height == 0 {
        return Err("图片尺寸无效".to_string());
    }
    let ring = edge_ring_width(width, height);
    let mut luminances = Vec::new();
    let mut black_matches = 0usize;
    let mut white_matches = 0usize;
    let mut total = 0usize;
    let mut side_totals = [0usize; 4];
    let mut black_sides = [0usize; 4];
    let mut white_sides = [0usize; 4];

    for y in 0..height {
        for x in 0..width {
            if !is_ring_pixel(x, y, width, height, ring) {
                continue;
            }
            let pixel = image.get_pixel(x, y);
            let black = matches_background(pixel, BackgroundKind::Black, tolerance);
            let white = matches_background(pixel, BackgroundKind::White, tolerance);
            let luminance =
                (u32::from(pixel[0]) * 54 + u32::from(pixel[1]) * 183 + u32::from(pixel[2]) * 19)
                    / 256;
            luminances.push(luminance as u8);
            black_matches += usize::from(black);
            white_matches += usize::from(white);
            total += 1;

            let sides = [y < ring, x >= width - ring, y >= height - ring, x < ring];
            for (index, included) in sides.into_iter().enumerate() {
                if included {
                    side_totals[index] += 1;
                    black_sides[index] += usize::from(black);
                    white_sides[index] += usize::from(white);
                }
            }
        }
    }

    if total == 0 {
        return Err("无法采集图片边缘背景".to_string());
    }
    luminances.sort_unstable();
    let median_luminance = luminances[luminances.len() / 2];
    let black_ratio = black_matches as f64 / total as f64;
    let white_ratio = white_matches as f64 / total as f64;
    let black_candidate = median_luminance <= 24 && black_ratio >= 0.85;
    let white_candidate = median_luminance >= 231 && white_ratio >= 0.85;
    let (kind, match_ratio, matches_by_side) = match (black_candidate, white_candidate) {
        (true, false) => (BackgroundKind::Black, black_ratio, black_sides),
        (false, true) => (BackgroundKind::White, white_ratio, white_sides),
        _ => {
            return Err(
                "无法可靠识别纯黑或纯白背景，请调整背景识别容差，或改用“一键抠图”".to_string(),
            )
        }
    };
    let side_ratios = matches_by_side
        .into_iter()
        .zip(side_totals)
        .map(|(matched, count)| {
            if count == 0 {
                0.0
            } else {
                matched as f64 / count as f64
            }
        })
        .collect::<Vec<_>>();
    let minimum_side_ratio = side_ratios.iter().copied().fold(1.0, f64::min);
    let side_average = side_ratios.iter().sum::<f64>() / side_ratios.len() as f64;
    let confidence = (match_ratio * 0.75 + side_average * 0.25).clamp(0.0, 1.0);
    let mut warnings = Vec::new();
    if minimum_side_ratio < 0.55 {
        warnings.push("主体可能接触图片边缘，请重点检查接触区域".to_string());
    }
    if match_ratio < 0.92 {
        warnings.push("背景存在轻微噪点或压缩色块，结果边缘可能需要调节".to_string());
    }
    Ok(BackgroundAnalysis {
        kind,
        confidence,
        border_match_ratio: match_ratio,
        warnings,
    })
}

fn neighbors8(index: usize, width: usize, height: usize, output: &mut [usize; 8]) -> usize {
    let x = index % width;
    let y = index / width;
    let mut count = 0;
    for dy in -1isize..=1 {
        for dx in -1isize..=1 {
            if dx == 0 && dy == 0 {
                continue;
            }
            let nx = x as isize + dx;
            let ny = y as isize + dy;
            if nx >= 0 && ny >= 0 && nx < width as isize && ny < height as isize {
                output[count] = ny as usize * width + nx as usize;
                count += 1;
            }
        }
    }
    count
}

fn connected_background_mask(image: &RgbaImage, kind: BackgroundKind, tolerance: u8) -> Vec<bool> {
    let (width_u32, height_u32) = image.dimensions();
    let width = width_u32 as usize;
    let height = height_u32 as usize;
    let mut background = vec![false; width * height];
    let mut queue = VecDeque::new();
    let seed = |x: usize, y: usize, background: &mut Vec<bool>, queue: &mut VecDeque<usize>| {
        let index = y * width + x;
        if !background[index]
            && matches_background(image.get_pixel(x as u32, y as u32), kind, tolerance)
        {
            background[index] = true;
            queue.push_back(index);
        }
    };
    for x in 0..width {
        seed(x, 0, &mut background, &mut queue);
        if height > 1 {
            seed(x, height - 1, &mut background, &mut queue);
        }
    }
    for y in 0..height {
        seed(0, y, &mut background, &mut queue);
        if width > 1 {
            seed(width - 1, y, &mut background, &mut queue);
        }
    }

    let mut neighbors = [0usize; 8];
    while let Some(index) = queue.pop_front() {
        let count = neighbors8(index, width, height, &mut neighbors);
        for &next in &neighbors[..count] {
            if background[next] {
                continue;
            }
            let x = next % width;
            let y = next / width;
            if matches_background(image.get_pixel(x as u32, y as u32), kind, tolerance) {
                background[next] = true;
                queue.push_back(next);
            }
        }
    }
    background
}

fn all_background_mask(image: &RgbaImage, kind: BackgroundKind, tolerance: u8) -> Vec<bool> {
    image
        .pixels()
        .map(|pixel| matches_background(pixel, kind, tolerance))
        .collect()
}

fn background_mask(
    image: &RgbaImage,
    kind: BackgroundKind,
    tolerance: u8,
    scope: BackgroundScope,
) -> Vec<bool> {
    match scope {
        BackgroundScope::Edge => connected_background_mask(image, kind, tolerance),
        BackgroundScope::All => all_background_mask(image, kind, tolerance),
    }
}

fn alpha_from_background(
    background: &[bool],
    width: usize,
    height: usize,
    softness: u8,
) -> Vec<u8> {
    let mut alpha = vec![255u8; background.len()];
    let mut distances = vec![u8::MAX; background.len()];
    let mut queue = VecDeque::new();
    for (index, is_background) in background.iter().copied().enumerate() {
        if is_background {
            alpha[index] = 0;
            distances[index] = 0;
            if softness > 0 {
                queue.push_back(index);
            }
        }
    }
    if softness == 0 {
        return alpha;
    }

    let mut neighbors = [0usize; 8];
    while let Some(index) = queue.pop_front() {
        let distance = distances[index];
        if distance >= softness {
            continue;
        }
        let count = neighbors8(index, width, height, &mut neighbors);
        for &next in &neighbors[..count] {
            if distances[next] != u8::MAX {
                continue;
            }
            let next_distance = distance + 1;
            distances[next] = next_distance;
            alpha[next] = ((u16::from(next_distance) * 255) / u16::from(softness + 1)) as u8;
            queue.push_back(next);
        }
    }
    alpha
}

fn opposite_background_pair(
    source: &RgbaImage,
    alpha: &[u8],
    kind: BackgroundKind,
) -> (RgbaImage, RgbaImage, RgbaImage) {
    let (width, height) = source.dimensions();
    let mut black = RgbaImage::new(width, height);
    let mut white = RgbaImage::new(width, height);
    let mut counterpart = RgbaImage::new(width, height);
    for (index, pixel) in source.pixels().enumerate() {
        let alpha_u8 = alpha[index];
        let a = f64::from(alpha_u8) / 255.0;
        let mut foreground = [0.0f64; 3];
        if a > 0.0 {
            for channel in 0..3 {
                foreground[channel] = match kind {
                    BackgroundKind::Black => f64::from(pixel[channel]) / a,
                    BackgroundKind::White => (f64::from(pixel[channel]) - (1.0 - a) * 255.0) / a,
                }
                .clamp(0.0, 255.0);
            }
        }
        let black_pixel = Rgba([
            (foreground[0] * a).round().clamp(0.0, 255.0) as u8,
            (foreground[1] * a).round().clamp(0.0, 255.0) as u8,
            (foreground[2] * a).round().clamp(0.0, 255.0) as u8,
            255,
        ]);
        let white_pixel = Rgba([
            (foreground[0] * a + (1.0 - a) * 255.0)
                .round()
                .clamp(0.0, 255.0) as u8,
            (foreground[1] * a + (1.0 - a) * 255.0)
                .round()
                .clamp(0.0, 255.0) as u8,
            (foreground[2] * a + (1.0 - a) * 255.0)
                .round()
                .clamp(0.0, 255.0) as u8,
            255,
        ]);
        let x = index as u32 % width;
        let y = index as u32 / width;
        black.put_pixel(x, y, black_pixel);
        white.put_pixel(x, y, white_pixel);
        counterpart.put_pixel(
            x,
            y,
            if kind == BackgroundKind::Black {
                white_pixel
            } else {
                black_pixel
            },
        );
    }
    (black, white, counterpart)
}

fn double_background_matte(
    black: &RgbaImage,
    white: &RgbaImage,
    tolerance: u8,
    edge_contrast: u8,
) -> RgbaImage {
    let (width, height) = black.dimensions();
    let tolerance_scale = 0.5 + f64::from(tolerance) / 100.0;
    let gamma = 0.5 + f64::from(edge_contrast) / 100.0;
    let mut result = RgbaImage::new(width, height);
    for y in 0..height {
        for x in 0..width {
            let black_pixel = black.get_pixel(x, y);
            let white_pixel = white.get_pixel(x, y);
            let difference = (f64::from(white_pixel[0]) - f64::from(black_pixel[0])
                + f64::from(white_pixel[1])
                - f64::from(black_pixel[1])
                + f64::from(white_pixel[2])
                - f64::from(black_pixel[2]))
                / 3.0;
            let linear_alpha = (255.0 - difference * tolerance_scale).clamp(0.0, 255.0);
            let alpha = (255.0 * (linear_alpha / 255.0).powf(gamma))
                .round()
                .clamp(0.0, 255.0) as u8;
            let mut output = [0u8; 4];
            if alpha > 0 {
                for channel in 0..3 {
                    output[channel] = (f64::from(black_pixel[channel]) * 255.0 / f64::from(alpha))
                        .round()
                        .clamp(0.0, 255.0) as u8;
                }
            }
            output[3] = alpha;
            result.put_pixel(x, y, Rgba(output));
        }
    }
    result
}

fn remove_small_alpha_islands(image: &mut RgbaImage, minimum_area: usize) {
    let (width_u32, height_u32) = image.dimensions();
    let width = width_u32 as usize;
    let height = height_u32 as usize;
    let mut visited = vec![false; width * height];
    let mut neighbors = [0usize; 8];
    for start in 0..visited.len() {
        if visited[start] || image.as_raw()[start * 4 + 3] < ALPHA_NOISE_THRESHOLD {
            continue;
        }
        let mut component = Vec::new();
        let mut queue = VecDeque::from([start]);
        visited[start] = true;
        while let Some(index) = queue.pop_front() {
            component.push(index);
            let count = neighbors8(index, width, height, &mut neighbors);
            for &next in &neighbors[..count] {
                if !visited[next] && image.as_raw()[next * 4 + 3] >= ALPHA_NOISE_THRESHOLD {
                    visited[next] = true;
                    queue.push_back(next);
                }
            }
        }
        if component.len() < minimum_area {
            for index in component {
                let x = index % width;
                let y = index / width;
                *image.get_pixel_mut(x as u32, y as u32) = Rgba([0, 0, 0, 0]);
            }
        }
    }
}

fn post_process_matte(image: &mut RgbaImage) {
    for pixel in image.pixels_mut() {
        let alpha = f64::from(pixel[3]) / 255.0;
        pixel[3] = (255.0 * (1.0 - (1.0 - alpha).powi(4)))
            .round()
            .clamp(0.0, 255.0) as u8;
        if pixel[3] < ALPHA_NOISE_THRESHOLD {
            *pixel = Rgba([0, 0, 0, 0]);
        }
    }
    let pixels = u64::from(image.width()) * u64::from(image.height());
    let minimum_area = if pixels > 2_000_000 {
        20
    } else if pixels > 800_000 {
        16
    } else {
        12
    };
    remove_small_alpha_islands(image, minimum_area);
}

fn erode_alpha_frontier(image: &mut RgbaImage, erosion: u8) {
    let passes = ((usize::from(erosion) * MAX_EROSION_PASSES) as f64 / 100.0).round() as usize;
    if passes == 0 {
        return;
    }
    let width = image.width() as usize;
    let height = image.height() as usize;
    let mut frontier = vec![false; width * height];
    for _ in 0..passes {
        frontier.fill(false);
        for y in 0..height {
            for x in 0..width {
                let index = y * width + x;
                let alpha = image.as_raw()[index * 4 + 3];
                if alpha <= FRONTIER_BACKGROUND_ALPHA {
                    continue;
                }
                let at_edge = x == 0 || y == 0 || x + 1 == width || y + 1 == height;
                let touches_background = at_edge
                    || image.as_raw()[((y - 1) * width + x) * 4 + 3] <= FRONTIER_BACKGROUND_ALPHA
                    || image.as_raw()[((y + 1) * width + x) * 4 + 3] <= FRONTIER_BACKGROUND_ALPHA
                    || image.as_raw()[(y * width + x - 1) * 4 + 3] <= FRONTIER_BACKGROUND_ALPHA
                    || image.as_raw()[(y * width + x + 1) * 4 + 3] <= FRONTIER_BACKGROUND_ALPHA;
                if touches_background {
                    frontier[index] = true;
                }
            }
        }
        for (index, selected) in frontier.iter().copied().enumerate() {
            if !selected {
                continue;
            }
            let offset = index * 4;
            let old_alpha = image.as_raw()[offset + 3];
            let new_alpha = old_alpha.saturating_sub(FRONTIER_SHAVE);
            let x = index % width;
            let y = index / width;
            let pixel = image.get_pixel_mut(x as u32, y as u32);
            if new_alpha == 0 {
                *pixel = Rgba([0, 0, 0, 0]);
            } else {
                let scale = f64::from(new_alpha) / f64::from(old_alpha);
                pixel[0] = (f64::from(pixel[0]) * scale).round() as u8;
                pixel[1] = (f64::from(pixel[1]) * scale).round() as u8;
                pixel[2] = (f64::from(pixel[2]) * scale).round() as u8;
                pixel[3] = new_alpha;
            }
        }
    }
}

fn composite_on_white(source: &RgbaImage) -> RgbaImage {
    let mut output = RgbaImage::new(source.width(), source.height());
    for (target, source_pixel) in output.pixels_mut().zip(source.pixels()) {
        let alpha = f64::from(source_pixel[3]) / 255.0;
        for channel in 0..3 {
            target[channel] = (f64::from(source_pixel[channel]) * alpha + 255.0 * (1.0 - alpha))
                .round()
                .clamp(0.0, 255.0) as u8;
        }
        target[3] = 255;
    }
    output
}

fn save_png(image: &RgbaImage, path: &PathBuf, label: &str) -> Result<(), String> {
    DynamicImage::ImageRgba8(image.clone())
        .save_with_format(path, image::ImageFormat::Png)
        .map_err(|error| format!("无法写入{label}：{error}"))
}

fn remove_background_blocking(
    asset_id: i64,
    options: DoubleBackgroundRemovalOptions,
    app: AppHandle,
) -> Result<DoubleBackgroundRemovalResult, String> {
    validate_options(&options)?;
    cleanup_expired_jobs();
    let source_path = indexed_image_path(asset_id, &app)?;
    let source = decode_preview(&source_path)?.to_rgba8();
    let (width, height) = source.dimensions();
    let pixels = u64::from(width) * u64::from(height);
    if pixels > MAX_PROCESS_PIXELS {
        return Err(format!(
            "图片尺寸过大，移除背景当前最多处理 {} 百万像素",
            MAX_PROCESS_PIXELS / 1_000_000
        ));
    }

    let has_transparency = source.pixels().any(|pixel| pixel[3] < 255);
    let (
        mut result,
        counterpart,
        detected_background,
        confidence,
        border_match_ratio,
        mut warnings,
    ) = if has_transparency {
        (
            source.clone(),
            composite_on_white(&source),
            "transparent",
            1.0,
            1.0,
            vec!["图片已包含透明通道，已跳过纯色背景识别".to_string()],
        )
    } else {
        let analysis = analyze_background(&source, options.background_tolerance)?;
        let background = background_mask(
            &source,
            analysis.kind,
            options.background_tolerance,
            options.background_scope,
        );
        let background_pixels = background.iter().filter(|value| **value).count();
        let background_ratio = background_pixels as f64 / background.len() as f64;
        if background_ratio < 0.01 {
            return Err("识别到的连通背景区域过小，请调整背景识别容差或改用“一键抠图”".to_string());
        }
        let mut analysis_warnings = analysis.warnings;
        if background_ratio > 0.995 {
            analysis_warnings
                .push("图片几乎全部被识别为背景，请确认素材中存在可见主体".to_string());
        }
        let alpha = alpha_from_background(
            &background,
            width as usize,
            height as usize,
            options.softness,
        );
        let (black, white, counterpart) = opposite_background_pair(&source, &alpha, analysis.kind);
        (
            double_background_matte(&black, &white, options.tolerance, options.edge_contrast),
            counterpart,
            analysis.kind.label(),
            analysis.confidence,
            analysis.border_match_ratio,
            analysis_warnings,
        )
    };

    if options.post_process {
        post_process_matte(&mut result);
    }
    if options.erosion > 0 {
        erode_alpha_frontier(&mut result, options.erosion);
    }
    if result.pixels().all(|pixel| pixel[3] == 0) {
        warnings.push("结果完全透明，请降低背景容差、关闭后处理或减小边缘侵蚀".to_string());
    }

    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| error.to_string())?;
    let result_dir = app_data_dir.join("double-background-removal");
    fs::create_dir_all(&result_dir).map_err(|error| format!("无法创建去背缓存目录：{error}"))?;
    let job_id = format!(
        "double-bg-remove-{}-{}",
        now_ms(),
        NEXT_JOB_ID.fetch_add(1, Ordering::Relaxed)
    );
    let counterpart_path = result_dir.join(format!("{job_id}-counterpart.png"));
    let result_path = result_dir.join(format!("{job_id}-result.png"));
    save_png(&counterpart, &counterpart_path, "配对图")?;
    if let Err(error) = save_png(&result, &result_path, "透明结果") {
        let _ = fs::remove_file(&counterpart_path);
        return Err(error);
    }
    jobs()
        .lock()
        .map_err(|_| "移除背景任务状态不可用".to_string())?
        .insert(
            job_id.clone(),
            DoubleBackgroundJob {
                asset_id,
                source_path,
                counterpart_path,
                result_path,
                width,
                height,
                created_at_ms: now_ms(),
            },
        );
    Ok(DoubleBackgroundRemovalResult {
        job_id,
        width,
        height,
        detected_background,
        confidence,
        border_match_ratio,
        warnings,
    })
}

#[tauri::command]
pub(crate) async fn remove_image_background_by_double_background(
    asset_id: i64,
    options: DoubleBackgroundRemovalOptions,
    app: AppHandle,
) -> Result<DoubleBackgroundRemovalResult, String> {
    tauri::async_runtime::spawn_blocking(move || remove_background_blocking(asset_id, options, app))
        .await
        .map_err(|error| error.to_string())?
}

fn job_for(job_id: &str, asset_id: i64) -> Result<DoubleBackgroundJob, String> {
    let job = jobs()
        .lock()
        .map_err(|_| "移除背景任务状态不可用".to_string())?
        .get(job_id)
        .cloned()
        .ok_or_else(|| "移除背景结果已过期，请重新处理".to_string())?;
    if job.asset_id != asset_id || !job.result_path.is_file() || !job.counterpart_path.is_file() {
        return Err("移除背景结果与当前资源不匹配或已失效".to_string());
    }
    Ok(job)
}

#[tauri::command]
pub(crate) fn read_double_background_removal_preview(
    job_id: String,
    asset_id: i64,
    variant: String,
) -> Result<Response, String> {
    let job = job_for(&job_id, asset_id)?;
    let path = match variant.as_str() {
        "counterpart" => job.counterpart_path,
        "result" => job.result_path,
        _ => return Err("不支持的移除背景预览类型".to_string()),
    };
    let bytes = fs::read(path).map_err(|error| format!("无法读取移除背景预览：{error}"))?;
    Ok(Response::new(bytes))
}

fn save_double_background_removal_blocking(
    request: SaveDoubleBackgroundRemovalRequest,
    app: AppHandle,
) -> Result<SaveBackgroundRemovalResult, String> {
    let job = job_for(&request.job_id, request.asset_id)?;
    let saved = save_transparent_image_result(
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
    let _ = fs::remove_file(&job.counterpart_path);
    let _ = fs::remove_file(&job.result_path);
    Ok(saved)
}

#[tauri::command]
pub(crate) async fn save_double_background_removal(
    request: SaveDoubleBackgroundRemovalRequest,
    app: AppHandle,
) -> Result<SaveBackgroundRemovalResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        save_double_background_removal_blocking(request, app)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub(crate) fn discard_double_background_removal(
    job_id: String,
    asset_id: i64,
) -> Result<(), String> {
    let mut current = jobs()
        .lock()
        .map_err(|_| "移除背景任务状态不可用".to_string())?;
    if let Some(job) = current.get(&job_id) {
        if job.asset_id != asset_id {
            return Err("移除背景结果与当前资源不匹配".to_string());
        }
    }
    if let Some(job) = current.remove(&job_id) {
        let _ = fs::remove_file(job.counterpart_path);
        let _ = fs::remove_file(job.result_path);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn options() -> DoubleBackgroundRemovalOptions {
        DoubleBackgroundRemovalOptions {
            background_scope: BackgroundScope::All,
            background_tolerance: 18,
            softness: 0,
            tolerance: 50,
            edge_contrast: 50,
            post_process: false,
            erosion: 0,
        }
    }

    #[test]
    fn validates_parameter_ranges() {
        let mut value = options();
        assert!(validate_options(&value).is_ok());
        value.background_tolerance = 3;
        assert!(validate_options(&value).is_err());
        value.background_tolerance = 18;
        value.softness = 9;
        assert!(validate_options(&value).is_err());
        value.softness = 2;
        value.tolerance = 49;
        assert!(validate_options(&value).is_err());
    }

    #[test]
    fn recognizes_black_and_white_edge_backgrounds() {
        let mut black = RgbaImage::from_pixel(20, 20, Rgba([0, 0, 0, 255]));
        let mut white = RgbaImage::from_pixel(20, 20, Rgba([255, 255, 255, 255]));
        for y in 5..15 {
            for x in 5..15 {
                black.put_pixel(x, y, Rgba([180, 60, 40, 255]));
                white.put_pixel(x, y, Rgba([180, 60, 40, 255]));
            }
        }
        assert_eq!(
            analyze_background(&black, 18).unwrap().kind,
            BackgroundKind::Black
        );
        assert_eq!(
            analyze_background(&white, 18).unwrap().kind,
            BackgroundKind::White
        );
    }

    #[test]
    fn rejects_non_uniform_background() {
        let mut image = RgbaImage::new(20, 20);
        for y in 0..20 {
            for x in 0..20 {
                image.put_pixel(x, y, Rgba([(x * 12) as u8, (y * 12) as u8, 80, 255]));
            }
        }
        assert!(analyze_background(&image, 18).is_err());
    }

    #[test]
    fn connected_mask_preserves_isolated_black_subject_detail() {
        let mut image = RgbaImage::from_pixel(9, 9, Rgba([0, 0, 0, 255]));
        for y in 2..7 {
            for x in 2..7 {
                image.put_pixel(x, y, Rgba([220, 80, 40, 255]));
            }
        }
        image.put_pixel(4, 4, Rgba([0, 0, 0, 255]));
        let mask = connected_background_mask(&image, BackgroundKind::Black, 18);
        assert!(mask[0]);
        assert!(!mask[4 * 9 + 4]);
    }

    #[test]
    fn all_background_mask_includes_isolated_matching_regions() {
        let mut image = RgbaImage::from_pixel(9, 9, Rgba([0, 0, 0, 255]));
        for y in 2..7 {
            for x in 2..7 {
                image.put_pixel(x, y, Rgba([220, 80, 40, 255]));
            }
        }
        image.put_pixel(4, 4, Rgba([0, 0, 0, 255]));
        let mask = all_background_mask(&image, BackgroundKind::Black, 18);
        assert!(mask[0]);
        assert!(mask[4 * 9 + 4]);
    }

    #[test]
    fn background_scope_selects_edge_or_all_matching_pixels() {
        let mut image = RgbaImage::from_pixel(9, 9, Rgba([0, 0, 0, 255]));
        for y in 2..7 {
            for x in 2..7 {
                image.put_pixel(x, y, Rgba([220, 80, 40, 255]));
            }
        }
        image.put_pixel(4, 4, Rgba([0, 0, 0, 255]));
        let edge = background_mask(&image, BackgroundKind::Black, 18, BackgroundScope::Edge);
        let all = background_mask(&image, BackgroundKind::Black, 18, BackgroundScope::All);
        assert!(!edge[4 * 9 + 4]);
        assert!(all[4 * 9 + 4]);
    }

    #[test]
    fn double_background_pair_recovers_known_alpha() {
        let mut black = RgbaImage::new(3, 1);
        let mut white = RgbaImage::new(3, 1);
        let foreground = [[200u8, 80, 40], [20, 180, 240], [90, 30, 220]];
        let alphas = [255u8, 128, 64];
        for x in 0..3 {
            let a = f64::from(alphas[x]) / 255.0;
            let black_rgb = foreground[x].map(|channel| (f64::from(channel) * a).round() as u8);
            let white_rgb = foreground[x]
                .map(|channel| (f64::from(channel) * a + 255.0 * (1.0 - a)).round() as u8);
            black.put_pixel(
                x as u32,
                0,
                Rgba([black_rgb[0], black_rgb[1], black_rgb[2], 255]),
            );
            white.put_pixel(
                x as u32,
                0,
                Rgba([white_rgb[0], white_rgb[1], white_rgb[2], 255]),
            );
        }
        let result = double_background_matte(&black, &white, 50, 50);
        for x in 0..3 {
            let pixel = result.get_pixel(x as u32, 0);
            assert!((i16::from(pixel[3]) - i16::from(alphas[x])).abs() <= 1);
            for channel in 0..3 {
                assert!((i16::from(pixel[channel]) - i16::from(foreground[x][channel])).abs() <= 3);
            }
        }
    }

    #[test]
    fn post_process_removes_low_alpha_noise() {
        let mut image = RgbaImage::from_pixel(8, 8, Rgba([120, 80, 40, 10]));
        image.put_pixel(4, 4, Rgba([200, 100, 50, 255]));
        post_process_matte(&mut image);
        assert_eq!(image.get_pixel(0, 0), &Rgba([0, 0, 0, 0]));
        assert_eq!(image.get_pixel(4, 4)[3], 0);
    }
}
