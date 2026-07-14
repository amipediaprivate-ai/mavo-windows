# Mavo Windows

Mavo 是一个基于 Tauri 2 的本地数字资产管理桌面应用。当前阶段完成桌面资产库布局和前端交互原型。

## 技术栈

- Tauri 2 + Rust
- React 19.2 + Vite 8.1 + TypeScript
- TanStack Virtual
- 规划中的本地能力：SQLite + FTS5、Rust 原生文件元数据解析、ExifTool、FFmpeg

## 本地运行

```bash
pnpm install
pnpm dev
```

安装 Rust 与 Tauri 系统依赖后，可运行 `pnpm tauri dev`。
