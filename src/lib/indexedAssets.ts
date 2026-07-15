import { Channel, convertFileSrc, invoke } from "@tauri-apps/api/core";
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
  availability?: "available" | "missing";
  duplicateOnly?: boolean;
}

export interface AssetQuerySpec {
  offset?: number;
  limit?: number;
  query?: string;
  kinds?: string[];
  extensions?: string[];
  folders?: string[];
  sort?: string;
  availability?: "available" | "missing";
  duplicateOnly?: boolean;
  minWidth?: number;
  maxWidth?: number;
  orientation?: Filters["orientation"];
}

export interface FacetOption {
  value: string;
  count: number;
}

export interface AssetFacets {
  kinds: FacetOption[];
  extensions: FacetOption[];
  folders: FacetOption[];
  availableCount: number;
  missingCount: number;
}

export interface SmartView {
  id: number;
  name: string;
  query: AssetQuerySpec;
  updatedAtMs: number;
}

export interface DuplicateScanSummary {
  hashedFiles: number;
  duplicateGroups: number;
  duplicateFiles: number;
}

export interface BackgroundTask {
  id: string;
  taskType: "index" | "analysis" | "thumbnail";
  title: string;
  status: "running" | "completed" | "cancelled" | "failed";
  completed: number;
  total?: number;
  currentItem?: string;
  message?: string;
  startedAtMs: number;
  updatedAtMs: number;
}

interface PreviewEnrichmentEvent {
  eventType: "assetsCommitted";
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

function formatDate(milliseconds: number) {
  return new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(milliseconds));
}

function formatDuration(milliseconds: number) {
  const totalSeconds = Math.round(milliseconds / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

function motifFor(kind: AssetKind): Asset["motif"] {
  if (kind === "音频") return "audio";
  if (kind === "视频" || kind === "动图") return "video";
  if (kind === "图片") return "landscape";
  if (kind === "设计文件") return "ui";
  return "icon";
}

export function toAsset(record: IndexedAssetRecord): Asset {
  const dimensions = record.width && record.height
    ? `${record.width} × ${record.height}${record.durationMs ? ` · ${formatDuration(record.durationMs)}` : ""}`
    : record.durationMs ? formatDuration(record.durationMs) : "尺寸待分析";
  return {
    id: `indexed-${record.id}`,
    name: record.name,
    format: record.format,
    kind: record.kind,
    dimensions,
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

export function buildAssetQuery(options: LoadIndexedAssetsOptions = {}): AssetQuerySpec {
  return {
    offset: options.offset ?? 0,
    limit: options.limit ?? 200,
    query: options.query?.trim() || undefined,
    kinds: options.filters?.kind.length ? options.filters.kind : undefined,
    extensions: options.filters?.format.length ? options.filters.format : undefined,
    folders: options.filters?.folder.length ? options.filters.folder : undefined,
    sort: options.sort ?? "newest",
    availability: options.availability ?? "available",
    duplicateOnly: options.duplicateOnly || undefined,
    minWidth: options.filters?.minWidth,
    maxWidth: options.filters?.maxWidth,
    orientation: options.filters?.orientation,
  };
}

export async function loadIndexedAssets(options: LoadIndexedAssetsOptions = {}) {
  const page = await invoke<IndexedAssetPage>("list_indexed_assets", { query: buildAssetQuery(options) });
  return { ...page, items: page.items.map(toAsset) };
}

export async function loadAssetFacets(options: LoadIndexedAssetsOptions = {}) {
  return invoke<AssetFacets>("get_asset_facets", { query: buildAssetQuery(options) });
}

export async function listSmartViews() {
  return invoke<SmartView[]>("list_smart_views");
}

export async function saveSmartView(name: string, options: LoadIndexedAssetsOptions) {
  await invoke("save_smart_view", { name, query: buildAssetQuery({ ...options, offset: 0 }) });
}

export async function deleteSmartView(viewId: number) {
  await invoke("delete_smart_view", { viewId });
}

export async function scanDuplicateAssets() {
  return invoke<DuplicateScanSummary>("scan_duplicates");
}

export async function listBackgroundTasks() {
  return invoke<BackgroundTask[]>("list_background_tasks");
}

export async function relinkIndexedAsset(asset: Asset, newPath: string) {
  await invoke("relink_asset", { assetId: Number(asset.id.replace("indexed-", "")), newPath });
}

export async function removeIndexedAsset(asset: Asset) {
  await invoke("remove_asset_from_index", { assetId: Number(asset.id.replace("indexed-", "")) });
}

export async function enrichPendingPreviews(onAssetsCommitted: () => void) {
  const onEvent = new Channel<PreviewEnrichmentEvent>((event) => {
    if (event.eventType === "assetsCommitted") onAssetsCommitted();
  });
  await invoke("enrich_pending_previews", { onEvent });
}
