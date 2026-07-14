import { useEffect, useMemo, useState } from "react";
import { ChevronLeft, ChevronRight, X } from "lucide-react";
import { canLoadOriginal, loadOriginalAsset } from "../lib/desktopAssets";
import type { Asset } from "../types";
import { AssetThumbnail } from "./AssetThumbnail";

interface AssetPreviewDialogProps {
  assets: Asset[];
  activeId: string;
  onActiveChange: (id: string) => void;
  onClose: () => void;
}

export function AssetPreviewDialog({ assets, activeId, onActiveChange, onClose }: AssetPreviewDialogProps) {
  const activeIndex = assets.findIndex((asset) => asset.id === activeId);
  const asset = activeIndex >= 0 ? assets[activeIndex] : undefined;
  const [originalUrl, setOriginalUrl] = useState<string>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  const canGoPrevious = assets.length > 1;
  const canGoNext = assets.length > 1;
  const showPrevious = () => {
    if (!canGoPrevious || activeIndex < 0) return;
    onActiveChange(assets[(activeIndex - 1 + assets.length) % assets.length].id);
  };
  const showNext = () => {
    if (!canGoNext || activeIndex < 0) return;
    onActiveChange(assets[(activeIndex + 1) % assets.length].id);
  };

  useEffect(() => {
    if (!asset || !canLoadOriginal(asset)) {
      setOriginalUrl(undefined);
      setLoading(false);
      setError(asset?.localPath ? "该格式暂不支持原图预览" : "演示资源暂无本地原图");
      return;
    }

    let disposed = false;
    let nextUrl: string | undefined;
    setOriginalUrl(undefined);
    setError("");
    setLoading(true);
    void loadOriginalAsset(asset)
      .then((url) => {
        nextUrl = url;
        if (disposed) {
          URL.revokeObjectURL(url);
          return;
        }
        setOriginalUrl(url);
      })
      .catch((loadError) => {
        if (!disposed) setError(loadError instanceof Error ? loadError.message : "无法读取原图");
      })
      .finally(() => {
        if (!disposed) setLoading(false);
      });
    return () => {
      disposed = true;
      if (nextUrl) URL.revokeObjectURL(nextUrl);
    };
  }, [asset]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
      if (event.key === "ArrowLeft") showPrevious();
      if (event.key === "ArrowRight") showNext();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  });

  const positionLabel = useMemo(
    () => activeIndex >= 0 ? `${activeIndex + 1} / ${assets.length}` : "",
    [activeIndex, assets.length],
  );

  if (!asset) return null;

  return (
    <div className="asset-preview-backdrop" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="asset-preview-dialog" role="dialog" aria-modal="true" aria-label={`${asset.name} 原图预览`}>
        <header className="asset-preview-header">
          <div>
            <strong title={asset.name}>{asset.name}</strong>
            <span>{asset.format} · {asset.dimensions} · {positionLabel}</span>
          </div>
          <button className="asset-preview-close" onClick={onClose} aria-label="关闭原图预览" title="关闭">
            <X size={20} />
          </button>
        </header>
        <div className="asset-preview-stage">
          {originalUrl ? (
            <img src={originalUrl} alt={`${asset.name} 原图`} />
          ) : (
            <div className="asset-preview-fallback">
              <AssetThumbnail asset={asset} large />
              {loading ? <span>正在读取原图…</span> : error && <span>{error}</span>}
            </div>
          )}
          <button className="asset-preview-nav previous" onClick={showPrevious} disabled={!canGoPrevious} aria-label="查看上一张">
            <ChevronLeft size={28} />
          </button>
          <button className="asset-preview-nav next" onClick={showNext} disabled={!canGoNext} aria-label="查看下一张">
            <ChevronRight size={28} />
          </button>
        </div>
      </section>
    </div>
  );
}
