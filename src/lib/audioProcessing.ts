import { convertFileSrc, invoke } from "@tauri-apps/api/core";
import type { Asset } from "../types";

export type AudioProcessingOperation = "fsbToWav" | "formatConversion" | "compression";
export type AudioCompressionStrength = "light" | "balanced" | "strong";
export type AudioProcessingSaveMode = "saveAs" | "sourceDirectory" | "overwrite";
export type AudioOutputFormat = "mp3" | "wav" | "flac" | "aac" | "ogg" | "m4a";

export interface AudioProcessingOptions {
  operation: AudioProcessingOperation;
  formats?: AudioOutputFormat[];
  compressionStrength?: AudioCompressionStrength;
}

export interface AudioProcessingOutput {
  id: string;
  fileName: string;
  format: string;
  bytes: number;
  mimeType: string;
}

export interface AudioProcessingResult {
  jobId: string;
  operation: AudioProcessingOperation;
  originalBytes: number;
  outputs: AudioProcessingOutput[];
}

export interface SaveAudioProcessingResult {
  paths: string[];
  assetName?: string;
  overwroteOriginal: boolean;
}

function indexedAssetId(asset: Asset) {
  if (!asset.id.startsWith("indexed-")) throw new Error("该资源不是可处理的本地音频");
  const assetId = Number.parseInt(asset.id.slice("indexed-".length), 10);
  if (!Number.isSafeInteger(assetId)) throw new Error("音频资源 ID 无效");
  return assetId;
}

export function canProcessAudio(asset: Asset) {
  return asset.kind === "音频" && asset.availability !== "missing" && asset.id.startsWith("indexed-");
}

export function isFsbAudio(asset: Asset) {
  return asset.format.toLowerCase() === "fsb" || asset.name.toLowerCase().endsWith(".fsb");
}

export function canConvertFsb(asset: Asset) {
  return canProcessAudio(asset) && isFsbAudio(asset);
}

export function canUseStandardAudioTools(asset: Asset) {
  return canProcessAudio(asset) && !isFsbAudio(asset);
}

export async function processAudio(asset: Asset, options: AudioProcessingOptions) {
  return invoke<AudioProcessingResult>("process_audio", {
    assetId: indexedAssetId(asset),
    options,
  });
}

export async function loadAudioProcessingPreview(
  asset: Asset,
  result: AudioProcessingResult,
  output: AudioProcessingOutput,
) {
  return convertFileSrc(
    `processed.audio.${indexedAssetId(asset)}.${result.jobId}.${output.id}`,
    "caevir-media",
  );
}

export async function saveAudioProcessing(
  asset: Asset,
  request: {
    jobId: string;
    mode: AudioProcessingSaveMode;
    directory?: string;
    fileStem?: string;
  },
) {
  return invoke<SaveAudioProcessingResult>("save_audio_processing", {
    request: {
      ...request,
      assetId: indexedAssetId(asset),
    },
  });
}

export async function discardAudioProcessing(asset: Asset, jobId: string) {
  await invoke("discard_audio_processing", { assetId: indexedAssetId(asset), jobId });
}
