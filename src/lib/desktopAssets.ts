import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import type { Asset } from "../types";

function indexedAssetId(asset: Asset) {
  if (!asset.id.startsWith("indexed-")) return undefined;
  const id = Number.parseInt(asset.id.slice("indexed-".length), 10);
  return Number.isSafeInteger(id) ? id : undefined;
}

export function canLoadOriginal(asset: Asset) {
  return indexedAssetId(asset) !== undefined && (asset.kind === "图片" || asset.kind === "动图" || asset.format === "PSD");
}

export function canPlayAudio(asset: Asset) {
  return asset.kind === "音频" && asset.availability !== "missing" && indexedAssetId(asset) !== undefined;
}

export function canPlayAnimatedImage(asset: Asset) {
  return asset.kind === "动图"
    && asset.format.toUpperCase() === "GIF"
    && asset.availability !== "missing"
    && indexedAssetId(asset) !== undefined;
}

export function audioPlaybackUrl(asset: Asset) {
  const assetId = indexedAssetId(asset);
  if (assetId === undefined || asset.kind !== "音频") throw new Error("该资源没有可播放的本地音频");
  return convertFileSrc(`indexed-${assetId}`, "mavo-media");
}

export async function loadOriginalAsset(asset: Asset) {
  const assetId = indexedAssetId(asset);
  if (assetId === undefined) throw new Error("该资源没有可读取的本地原图");
  const response = await invoke<ArrayBuffer | Uint8Array>("read_asset_preview", { assetId });
  const bytes = response instanceof ArrayBuffer ? new Uint8Array(response) : new Uint8Array(response);
  const transcoded = ["PSD", "TIF", "TIFF"].includes(asset.format.toUpperCase());
  const mimeTypes: Record<string, string> = {
    AVIF: "image/avif",
    BMP: "image/bmp",
    GIF: "image/gif",
    ICO: "image/x-icon",
    JPEG: "image/jpeg",
    JPG: "image/jpeg",
    PNG: "image/png",
    SVG: "image/svg+xml",
    WEBP: "image/webp",
  };
  return URL.createObjectURL(new Blob([bytes], { type: transcoded ? "image/png" : mimeTypes[asset.format.toUpperCase()] ?? "application/octet-stream" }));
}

export async function openAssetFolder(asset: Asset) {
  const assetId = indexedAssetId(asset);
  if (assetId === undefined) throw new Error("该资源没有可打开的本地文件夹");
  await invoke("open_asset_folder", { assetId });
}

export async function openOriginalAsset(asset: Asset) {
  const assetId = indexedAssetId(asset);
  if (assetId === undefined) throw new Error("该资源没有可调用系统查看器的本地原文件");
  await invoke("open_asset_original", { assetId });
}
