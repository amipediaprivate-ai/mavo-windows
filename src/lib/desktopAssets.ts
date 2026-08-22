import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import type { Asset } from "../types";

export function indexedAssetId(asset: Asset) {
  if (!asset.id.startsWith("indexed-")) return undefined;
  const id = Number.parseInt(asset.id.slice("indexed-".length), 10);
  return Number.isSafeInteger(id) ? id : undefined;
}


export function indexedAssetStreamUrl(asset: Asset) {
  const assetId = indexedAssetId(asset);
  if (assetId === undefined || asset.availability === "missing") {
    throw new Error("该资源没有可读取的本地文件");
  }
  return convertFileSrc(`indexed-${assetId}`, "caevir-media");
}

export function canLoadOriginal(asset: Asset) {
  return indexedAssetId(asset) !== undefined && (asset.kind === "图片" || asset.kind === "动图" || asset.format === "PSD");
}

export function canPlayAudio(asset: Asset) {
  return asset.kind === "音频" && asset.availability !== "missing" && indexedAssetId(asset) !== undefined;
}

export function canPlayVideo(asset: Asset) {
  return asset.kind === "视频" && asset.availability !== "missing" && indexedAssetId(asset) !== undefined;
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
  return indexedAssetStreamUrl(asset);
}

export function videoPlaybackUrl(asset: Asset) {
  const assetId = indexedAssetId(asset);
  if (assetId === undefined || asset.kind !== "视频") throw new Error("该资源没有可播放的本地视频");
  return indexedAssetStreamUrl(asset);
}

export async function loadOriginalAsset(asset: Asset) {
  const assetId = indexedAssetId(asset);
  if (assetId === undefined) throw new Error("该资源没有可读取的本地原图");
  return convertFileSrc(`preview.asset.${assetId}`, "caevir-media");
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
