import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import type { Asset } from "../types";

export type BackgroundRemovalModel = "birefnet-general" | "birefnet-general-lite" | "birefnet-portrait";
export type BackgroundRemovalSaveMode = "saveAs" | "sourceDirectory" | "overwrite";

export interface BackgroundRemovalOptions {
  model: BackgroundRemovalModel;
  alphaMatting: boolean;
  foregroundThreshold: number;
  backgroundThreshold: number;
  erodeSize: number;
  postProcessMask: boolean;
}

export interface BackgroundRemovalResult {
  jobId: string;
  width: number;
  height: number;
}

export interface SaveBackgroundRemovalResult {
  path: string;
  assetName?: string;
  overwroteOriginal: boolean;
}

function indexedAssetId(asset: Asset) {
  if (!asset.id.startsWith("indexed-")) throw new Error("该资源不是可处理的本地图片");
  const assetId = Number.parseInt(asset.id.slice("indexed-".length), 10);
  if (!Number.isSafeInteger(assetId)) throw new Error("图片资源 ID 无效");
  return assetId;
}

export function canRemoveImageBackground(asset: Asset) {
  return asset.kind === "图片" && asset.availability !== "missing" && asset.id.startsWith("indexed-");
}

export async function removeImageBackground(asset: Asset, options: BackgroundRemovalOptions) {
  return invoke<BackgroundRemovalResult>("remove_image_background", {
    assetId: indexedAssetId(asset),
    options,
  });
}

export async function loadBackgroundRemovalPreview(asset: Asset, jobId: string) {
  return convertFileSrc(`preview.background.${indexedAssetId(asset)}.${jobId}`, "caevir-media");
}

export async function saveBackgroundRemoval(
  asset: Asset,
  request: { jobId: string; mode: BackgroundRemovalSaveMode; directory?: string; fileStem?: string },
) {
  return invoke<SaveBackgroundRemovalResult>("save_background_removal", {
    request: {
      ...request,
      assetId: indexedAssetId(asset),
    },
  });
}

export async function discardBackgroundRemoval(asset: Asset, jobId: string) {
  await invoke("discard_background_removal", { assetId: indexedAssetId(asset), jobId });
}
