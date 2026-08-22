import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import type { Asset } from "../types";

export type PngCompressionSaveMode = "saveAs" | "sourceDirectory" | "overwrite";

export interface PngCompressionOptions {
  usePngquant: boolean;
  useOxipng: boolean;
  preservePixels: boolean;
  lossyStrength: number;
  losslessLevel: number;
}

export interface PngCompressionResult {
  jobId: string;
  width: number;
  height: number;
  originalBytes: number;
  resultBytes: number;
  usedOriginal: boolean;
  techniques: string[];
}

export interface SavePngCompressionResult {
  path: string;
  assetName?: string;
  overwroteOriginal: boolean;
}

function indexedAssetId(asset: Asset) {
  if (!asset.id.startsWith("indexed-")) throw new Error("该资源不是可处理的本地 PNG");
  const assetId = Number.parseInt(asset.id.slice("indexed-".length), 10);
  if (!Number.isSafeInteger(assetId)) throw new Error("PNG 资源 ID 无效");
  return assetId;
}

export function canCompressPng(asset: Asset) {
  return asset.kind === "图片"
    && asset.availability !== "missing"
    && asset.id.startsWith("indexed-")
    && (asset.format.toLowerCase() === "png" || asset.name.toLowerCase().endsWith(".png"));
}

export async function compressPng(asset: Asset, options: PngCompressionOptions) {
  return invoke<PngCompressionResult>("compress_png", {
    assetId: indexedAssetId(asset),
    options,
  });
}

export async function loadPngCompressionPreview(asset: Asset, jobId: string) {
  return convertFileSrc(`preview.png.${indexedAssetId(asset)}.${jobId}`, "caevir-media");
}

export async function savePngCompression(
  asset: Asset,
  request: { jobId: string; mode: PngCompressionSaveMode; directory?: string; fileStem?: string },
) {
  return invoke<SavePngCompressionResult>("save_png_compression", {
    request: {
      ...request,
      assetId: indexedAssetId(asset),
    },
  });
}

export async function discardPngCompression(asset: Asset, jobId: string) {
  await invoke("discard_png_compression", { assetId: indexedAssetId(asset), jobId });
}
