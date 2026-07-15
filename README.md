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

视频和音频分析使用随 Mavo 安装包分发的 FFmpeg 8.1 LGPL static runtime。用户无需另外安装或配置环境变量，新扫描的媒体会在后台生成时长、尺寸和缩略图；文件损坏时，资源仍会保留在索引中并标记为暂不支持。静态运行时不依赖安装目录中的 FFmpeg DLL，可避免媒体后台进程因动态库初始化失败而弹出 Windows `0xc0000142` 错误。第三方软件归属和源码信息见 [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md)。

首次在开发环境执行 `pnpm tauri build` 或 `pnpm tauri dev` 时，构建流程会下载 FFmpeg Windows x64 LGPL static 包、验证发布方提供的 SHA-256，再将其放入本地忽略目录并打包进 NSIS 安装程序。终端用户不需要执行此步骤。

## 本地运行

```bash
pnpm install
pnpm dev
```

安装 Rust 与 Tauri 系统依赖后，可运行 `pnpm tauri dev`。
