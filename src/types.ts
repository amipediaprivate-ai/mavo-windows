export type AssetKind = "图片" | "动图" | "视频" | "音频" | "设计文件" | "3D 模型" | "字体" | "文档";
export type AssetSource = "本地导入" | "平台下载" | "浏览器采集" | "剪贴板";
export type AssetView = "grid" | "masonry" | "list";
export type ScanScope = "computer" | "folder";
export type ScanSpeed = "slow" | "fast";

export interface Asset {
  id: string;
  name: string;
  format: string;
  kind: AssetKind;
  dimensions: string;
  weight: string;
  folder: string;
  tags: string[];
  source: AssetSource;
  importedAt: string;
  modifiedAt: string;
  palette: [string, string, string];
  motif: "character" | "landscape" | "ui" | "icon" | "audio" | "video";
  hasUpdate?: boolean;
  localPath?: string;
  thumbnailUrl?: string;
  sizeBytes?: number;
  width?: number;
  height?: number;
  durationMs?: number;
  metadataStatus?: "pending" | "ready" | "unsupported";
  availability?: "available" | "missing";
}

export interface Filters {
  source: string[];
  kind: string[];
  format: string[];
  folder: string[];
  tags: string[];
  minWidth?: number;
  maxWidth?: number;
  orientation?: "square" | "landscape" | "portrait" | "wide";
}
