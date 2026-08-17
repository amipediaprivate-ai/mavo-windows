import { lazy, Suspense, type ComponentType } from "react";
import { canLoadOriginal } from "../../lib/desktopAssets";
import type { Asset } from "../../types";
import { AssetThumbnail } from "../AssetThumbnail";
import { FontPreview } from "./FontPreview";
import { ImagePreview } from "./ImagePreview";

const ModelPreview = lazy(() => import("./ModelPreview").then((module) => ({ default: module.ModelPreview })));
const PdfPreview = lazy(() => import("./PdfPreview").then((module) => ({ default: module.PdfPreview })));

interface PreviewAdapter {
  id: string;
  supports: (asset: Asset) => boolean;
  component: ComponentType<{ asset: Asset }>;
}

const adapters: PreviewAdapter[] = [
  { id: "image", supports: canLoadOriginal, component: ImagePreview },
  { id: "pdf", supports: (asset) => asset.format.toUpperCase() === "PDF", component: PdfPreview },
  { id: "font", supports: (asset) => asset.kind === "字体", component: FontPreview },
  { id: "model", supports: (asset) => asset.kind === "3D 模型", component: ModelPreview },
];

function UnsupportedPreview({ asset }: { asset: Asset }) {
  return (
    <div className="asset-preview-fallback">
      <AssetThumbnail asset={asset} large />
      <span>{asset.localPath ? "该格式暂不支持内嵌预览，可使用系统查看器打开" : "演示资源暂无本地原文件"}</span>
    </div>
  );
}

export function PreviewAdapterView({ asset }: { asset: Asset }) {
  const adapter = adapters.find((candidate) => candidate.supports(asset));
  const Component = adapter?.component ?? UnsupportedPreview;
  return (
    <Suspense fallback={<div className="preview-adapter-message">正在加载预览器…</div>}>
      <Component asset={asset} />
    </Suspense>
  );
}

export function previewAdapterId(asset: Asset) {
  return adapters.find((candidate) => candidate.supports(asset))?.id ?? "unsupported";
}
