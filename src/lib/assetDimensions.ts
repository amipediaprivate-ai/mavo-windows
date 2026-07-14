import type { Asset } from "../types";

const DEFAULT_ASPECT_RATIO = 1.48;
const MIN_ASPECT_RATIO = 0.28;
const MAX_ASPECT_RATIO = 5;

export function assetAspectRatio(asset: Asset) {
  let width = asset.width;
  let height = asset.height;

  if (!width || !height) {
    const dimensions = asset.dimensions.match(/\d+/g)?.map(Number);
    if (dimensions && dimensions.length >= 2) {
      [width, height] = dimensions;
    }
  }

  if (!width || !height || width <= 0 || height <= 0) return DEFAULT_ASPECT_RATIO;
  return Math.min(MAX_ASPECT_RATIO, Math.max(MIN_ASPECT_RATIO, width / height));
}
