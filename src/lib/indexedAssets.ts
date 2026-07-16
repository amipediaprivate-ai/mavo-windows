import { Channel, convertFileSrc, invoke } from "@tauri-apps/api/core";
import type { Asset, AssetKind, AssetTag, Filters } from "../types";

export interface IndexedAssetRecord {
  id: number;
  assetUid: string;
  path: string;
  name: string;
  format: string;
  kind: AssetKind;
  sizeBytes: number;
  modifiedMs: number;
  indexedAtMs: number;
  folder: string;
  width?: number | null;
  height?: number | null;
  durationMs?: number | null;
  thumbnailPath?: string;
  metadataStatus: "pending" | "ready" | "unsupported";
  integratedLufs?: number | null;
  truePeakDbtp?: number | null;
  loudnessRangeLu?: number | null;
  loudnessStatus: "pending" | "ready" | "silent" | "unsupported";
  availability: "available" | "missing";
  tags: AssetTag[];
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
  minDurationMs?: number;
  maxDurationMs?: number;
  audioDirectoryPath?: string;
  tagIds?: number[];
}

export interface TagGroup {
  id: number;
  name: string;
  sortOrder: number;
  tagCount: number;
}

export interface TagDefinition extends AssetTag {
  description: string;
  scopes: AssetKind[];
  usageCount: number;
  archived: boolean;
  updatedAtMs: number;
}

export interface TagCatalog {
  groups: TagGroup[];
  tags: TagDefinition[];
}

export interface TagInput {
  name: string;
  groupId: number;
  color: string;
  description?: string;
  scopes: AssetKind[];
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

export interface DirectoryNode {
  path: string;
  name: string;
  directCount: number;
  subtreeCount: number;
  children: DirectoryNode[];
}

export interface AssetDirectoryTree {
  roots: DirectoryNode[];
  totalCount: number;
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

export interface RenameAssetResult {
  name: string;
  path: string;
}

export interface BackgroundTask {
  id: string;
  taskType: "index" | "analysis" | "thumbnail" | "loudness";
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

export function formatIndexedAssetDimensions(record: IndexedAssetRecord) {
  const { width, height, durationMs } = record;
  const hasDuration = typeof durationMs === "number" && Number.isFinite(durationMs);
  if (record.kind === "音频") {
    if (hasDuration) return formatDuration(durationMs);
    if (record.metadataStatus === "unsupported") return "无法分析";
    if (record.metadataStatus === "ready") return "无可用时长信息";
    return "时长待分析";
  }
  const hasDimensions = typeof width === "number" && Number.isFinite(width)
    && typeof height === "number" && Number.isFinite(height);
  if (hasDimensions) {
    return `${width} × ${height}${hasDuration ? ` · ${formatDuration(durationMs)}` : ""}`;
  }
  if (hasDuration) return formatDuration(durationMs);
  if (record.metadataStatus === "unsupported") return "无法分析";
  if (record.metadataStatus === "ready") return "无可用媒体信息";
  return "尺寸待分析";
}

export function toAsset(record: IndexedAssetRecord): Asset {
  return {
    id: `indexed-${record.id}`,
    name: record.name,
    format: record.format,
    kind: record.kind,
    dimensions: formatIndexedAssetDimensions(record),
    weight: formatBytes(record.sizeBytes),
    folder: record.folder,
    tags: record.tags.map((tag) => tag.name),
    tagItems: record.tags,
    assetUid: record.assetUid,
    source: "本地导入",
    importedAt: formatDate(record.indexedAtMs),
    modifiedAt: formatDate(record.modifiedMs),
    palette: ["#26324a", "#42658a", "#182033"],
    motif: motifFor(record.kind),
    localPath: record.path,
    thumbnailUrl: record.thumbnailPath ? convertFileSrc(record.thumbnailPath) : undefined,
    sizeBytes: record.sizeBytes,
    width: record.width ?? undefined,
    height: record.height ?? undefined,
    durationMs: record.durationMs ?? undefined,
    metadataStatus: record.metadataStatus,
    integratedLufs: record.integratedLufs ?? undefined,
    truePeakDbtp: record.truePeakDbtp ?? undefined,
    loudnessRangeLu: record.loudnessRangeLu ?? undefined,
    loudnessStatus: record.loudnessStatus,
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
    minDurationMs: options.filters?.minDurationMs,
    maxDurationMs: options.filters?.maxDurationMs,
    audioDirectoryPath: options.filters?.audioDirectoryPath,
    tagIds: options.filters?.tags.length ? options.filters.tags : undefined,
  };
}

export async function loadIndexedAssets(options: LoadIndexedAssetsOptions = {}) {
  const page = await invoke<IndexedAssetPage>("list_indexed_assets", { query: buildAssetQuery(options) });
  return { ...page, items: page.items.map(toAsset) };
}

export async function loadAssetFacets(options: LoadIndexedAssetsOptions = {}) {
  return invoke<AssetFacets>("get_asset_facets", { query: buildAssetQuery(options) });
}

export async function loadAssetDirectoryTree(options: LoadIndexedAssetsOptions = {}) {
  return invoke<AssetDirectoryTree>("get_asset_directory_tree", { query: buildAssetQuery(options) });
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

export async function renameIndexedAsset(asset: Asset, newStem: string) {
  return invoke<RenameAssetResult>("rename_asset", {
    assetId: Number(asset.id.replace("indexed-", "")),
    newStem,
  });
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

export async function loadTagCatalog(includeArchived = false) {
  return invoke<TagCatalog>("get_tag_catalog", { includeArchived });
}

export async function saveTagGroup(name: string, groupId?: number) {
  return invoke<number>("save_tag_group", { name, groupId });
}

export async function deleteTagGroup(groupId: number) {
  await invoke("delete_tag_group", { groupId });
}

export async function createTag(input: TagInput) {
  return invoke<number>("create_tag", { input });
}

export async function updateTag(tagId: number, input: TagInput) {
  await invoke("update_tag", { tagId, input });
}

export async function setTagArchived(tagId: number, archived: boolean) {
  await invoke("set_tag_archived", { tagId, archived });
}

export async function deleteTag(tagId: number) {
  await invoke("delete_tag", { tagId });
}

export async function mergeTags(sourceTagId: number, targetTagId: number) {
  await invoke("merge_tags", { sourceTagId, targetTagId });
}

function indexedAssetIds(assets: Asset[]) {
  return assets.map((asset) => Number(asset.id.replace("indexed-", ""))).filter(Number.isFinite);
}

export async function setAssetTags(assets: Asset[], tagIds: number[]) {
  await invoke("set_asset_tags", { assetIds: indexedAssetIds(assets), tagIds });
}

export async function mutateAssetTags(assets: Asset[], tagIds: number[], operation: "add" | "remove") {
  await invoke("mutate_asset_tags", { assetIds: indexedAssetIds(assets), tagIds, operation });
}
