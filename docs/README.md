# Caevir Windows 文档

此目录只存放 Windows 桌面端专属的 Markdown 文档，包括架构设计、模块说明、构建发布、测试和排障资料。

跨 Windows 与 Web 的共用文档应放在父目录 `mavo/docs/`，不要提交到 Windows 仓库。

- [`project-module-requirements-and-technical-design.md`](project-module-requirements-and-technical-design.md)：项目模块的整体需求与技术设计。
- [`background-removal-design.md`](background-removal-design.md)：基于 rembg + BiRefNet 的“一键抠图”需求与技术设计。
- [`double-background-removal-design.md`](double-background-removal-design.md)：图片明细“移除图片背景”的纯色背景识别、配对图生成与黑白双背景差分方案。
- [`png-compression-design.md`](png-compression-design.md)：PNG 压缩功能的需求与技术设计。
- [`audio-processing-design.md`](audio-processing-design.md)：音频 FSB 转 WAV、格式转换与压缩的需求、交互、技术方案和验收标准。
- [`database-backup-and-recovery.md`](database-backup-and-recovery.md)：本地索引数据库的自动备份、迁移验证、损坏恢复与人工处理边界。
- [`visual-similarity-preview-and-scheduling.md`](visual-similarity-preview-and-scheduling.md)：dHash/调色板、PDF/字体/3D 预览适配器与自适应缩略图并发策略。
