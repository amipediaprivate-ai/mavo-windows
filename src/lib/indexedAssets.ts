import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import type { Asset, AssetKind, Filters } from "../types";

export interface IndexedAssetRecord {
  id: number;
  path: string;
  name: string;
  format: string;
  kind: AssetKind;
  sizeBytes: number;
  modifiedMs: number;
  indexedAtMs: number;
  folder: string;
  width?: number;
  height?: number;
  durationMs?: number;
  thumbnailPath?: string;
  metadataStatus: "pending" | "ready" | "unsupported";
  availability: "available" | "missing";
}

export interface IndexedAssetPage {
  items: IndexedAssetRecord[];
  nextOffset?: number;
  total: number;
}

export interface LoadIndexedAssetsOptions {
  offset?: number;
  limit?: number;
  query?: string;
  filters?: Filters;
  sort?: string;
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

function formatDate(milliseconds: number) {
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(milliseconds));
}

function motifFor(kind: AssetKind): Asset["motif"] {
  if (kind === "音频") return "audio";
  if (kind === "视频" || kind === "动图") return "video";
  if (kind === "图片") return "landscape";
  if (kind === "设计文件") return "ui";
  return "icon";
}

export function toAsset(record: IndexedAssetRecord): Asset {
  return {
    id: `indexed-${record.id}`,
    name: record.name,
    format: record.format,
    kind: record.kind,
    dimensions: record.width && record.height ? `${record.width} × ${record.height}` : "尺寸待分析",
    weight: formatBytes(record.sizeBytes),
    folder: record.folder,
    tags: [],
    source: "本地导入",
    favorite: false,
    importedAt: formatDate(record.indexedAtMs),
    modifiedAt: formatDate(record.modifiedMs),
    palette: ["#26324a", "#42658a", "#182033"],
    motif: motifFor(record.kind),
    localPath: record.path,
    thumbnailUrl: record.thumbnailPath ? convertFileSrc(record.thumbnailPath) : undefined,
    sizeBytes: record.sizeBytes,
    width: record.width,
    height: record.height,
    durationMs: record.durationMs,
    metadataStatus: record.metadataStatus,
    availability: record.availability,
  };
}

export async function loadIndexedAssets(options: LoadIndexedAssetsOptions = {}) {
  const page = await invoke<IndexedAssetPage>("list_indexed_assets", {
    query: {
      offset: options.offset ?? 0,
      limit: options.limit ?? 200,
      query: options.query?.trim() || undefined,
      kinds: options.filters?.kind.length ? options.filters.kind : undefined,
      extensions: options.filters?.format.length ? options.filters.format : undefined,
      folders: options.filters?.folder.length ? options.filters.folder : undefined,
      sort: options.sort ?? "newest",
    },
  });
  return { ...page, items: page.items.map(toAsset) };
}

export async function enrichPendingPreviews() {
  await invoke("enrich_pending_previews");
}
