# Mavo Windows

Mavo 是一个基于 Tauri 2 的本地数字资产管理桌面应用。应用会在本机建立 SQLite 索引，不上传或修改原始资产。

## 技术栈

- Tauri 2 + Rust
- React 19.2 + Vite 8.1 + TypeScript
- TanStack Virtual
- SQLite + FTS5 中文文件名和路径搜索
- 文件夹/整机扫描、文件变动自动监听、缺失文件恢复与索引清理
- 图片与 PSD 缩略图，视频/音频 FFmpeg 元数据和缩略图
- 动态筛选统计、持久化智能视图、BLAKE3 完全重复文件检测

## 媒体分析

视频和音频分析会调用 `ffprobe` 与 `ffmpeg`。将两个程序加入系统 `PATH` 后，新扫描的媒体会在后台生成时长、尺寸和缩略图；工具不可用或文件损坏时，资源仍会保留在索引中并标记为暂不支持。

## 本地运行

```bash
pnpm install
pnpm dev
```

安装 Rust 与 Tauri 系统依赖后，可运行 `pnpm tauri dev`。
