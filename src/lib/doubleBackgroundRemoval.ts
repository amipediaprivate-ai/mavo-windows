import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import type { Asset } from "../types";

export type DoubleBackgroundSaveMode = "saveAs" | "sourceDirectory" | "overwrite";
export type DoubleBackgroundPreviewVariant = "counterpart" | "result";
export type DetectedImageBackground = "black" | "white" | "transparent";
export type BackgroundChangeScope = "edge" | "all";

export interface DoubleBackgroundRemovalOptions {
  backgroundScope: BackgroundChangeScope;
  backgroundTolerance: number;
  softness: number;
  tolerance: number;
  edgeContrast: number;
  postProcess: boolean;
  erosion: number;
}

export interface DoubleBackgroundRemovalResult {
  jobId: string;
  width: number;
  height: number;
  detectedBackground: DetectedImageBackground;
  confidence: number;
  borderMatchRatio: number;
  warnings: string[];
}

export interface SaveDoubleBackgroundRemovalResult {
  path: string;
  assetName?: string;
  overwroteOriginal: boolean;
}

const supportedExtensions = new Set(["png", "jpg", "jpeg", "webp", "bmp", "tif", "tiff"]);

function indexedAssetId(asset: Asset) {
  if (!asset.id.startsWith("indexed-")) throw new Error("该资源不是可处理的本地图片");
  const assetId = Number.parseInt(asset.id.slice("indexed-".length), 10);
  if (!Number.isSafeInteger(assetId)) throw new Error("图片资源 ID 无效");
  return assetId;
}

function assetExtension(asset: Asset) {
  const nameExtension = asset.name.includes(".") ? asset.name.split(".").pop()?.toLowerCase() : undefined;
  return nameExtension || asset.format.toLowerCase();
}

export function canUseDoubleBackgroundRemoval(asset: Asset) {
  return asset.kind === "图片"
    && asset.availability !== "missing"
    && asset.id.startsWith("indexed-")
    && supportedExtensions.has(assetExtension(asset));
}

export async function removeImageBackgroundByDoubleBackground(
  asset: Asset,
  options: DoubleBackgroundRemovalOptions,
) {
  return invoke<DoubleBackgroundRemovalResult>("remove_image_background_by_double_background", {
    assetId: indexedAssetId(asset),
    options,
  });
}

export async function loadDoubleBackgroundRemovalPreview(
  asset: Asset,
  jobId: string,
  variant: DoubleBackgroundPreviewVariant,
) {
  return convertFileSrc(`preview.double.${indexedAssetId(asset)}.${jobId}.${variant}`, "caevir-media");
}

export async function saveDoubleBackgroundRemoval(
  asset: Asset,
  request: { jobId: string; mode: DoubleBackgroundSaveMode; directory?: string; fileStem?: string },
) {
  return invoke<SaveDoubleBackgroundRemovalResult>("save_double_background_removal", {
    request: {
      ...request,
      assetId: indexedAssetId(asset),
    },
  });
}

export async function discardDoubleBackgroundRemoval(asset: Asset, jobId: string) {
  await invoke("discard_double_background_removal", { assetId: indexedAssetId(asset), jobId });
}
