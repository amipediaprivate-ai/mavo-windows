import { useEffect, useMemo, useState } from "react";
import { ChevronLeft, ChevronRight, Search, X } from "lucide-react";
import { findSimilarAssets, type SimilarAssetMatch } from "../lib/indexedAssets";
import type { Asset } from "../types";
import { PreviewAdapterView } from "./previews/PreviewAdapter";

interface AssetPreviewDialogProps {
  assets: Asset[];
  activeId: string;
  onActiveChange: (id: string) => void;
  onClose: () => void;
}

export function AssetPreviewDialog({ assets, activeId, onActiveChange, onClose }: AssetPreviewDialogProps) {
  const activeIndex = assets.findIndex((asset) => asset.id === activeId);
  const asset = activeIndex >= 0 ? assets[activeIndex] : undefined;
  const [similar, setSimilar] = useState<(SimilarAssetMatch & { thumbnailUrl?: string })[]>();
  const [similarLoading, setSimilarLoading] = useState(false);
  const [similarError, setSimilarError] = useState("");

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
    setSimilar(undefined);
    setSimilarError("");
  }, [asset?.id]);

  const showSimilar = async () => {
    if (!asset) return;
    setSimilarLoading(true);
    setSimilarError("");
    try {
      setSimilar(await findSimilarAssets(asset));
    } catch (reason) {
      setSimilarError(reason instanceof Error ? reason.message : "无法查找相似资源");
    } finally {
      setSimilarLoading(false);
    }
  };

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
          {(asset.kind === "图片" || asset.kind === "动图" || asset.format.toUpperCase() === "PSD") && asset.id.startsWith("indexed-") && (
            <button className="asset-preview-similar-button" onClick={() => void showSimilar()} disabled={similarLoading}>
              <Search size={16} /> {similarLoading ? "分析中…" : "查找相似"}
            </button>
          )}
          <button className="asset-preview-close" onClick={onClose} aria-label="关闭原图预览" title="关闭">
            <X size={20} />
          </button>
        </header>
        <div className="asset-preview-stage">
          <PreviewAdapterView asset={asset} />
          <button className="asset-preview-nav previous" onClick={showPrevious} disabled={!canGoPrevious} aria-label="查看上一张">
            <ChevronLeft size={28} />
          </button>
          <button className="asset-preview-nav next" onClick={showNext} disabled={!canGoNext} aria-label="查看下一张">
            <ChevronRight size={28} />
          </button>
        </div>
        {(similar || similarError) && (
          <aside className="asset-similar-results" aria-label="相似资源">
            <div className="asset-similar-heading">
              <strong>相似资源</strong>
              <span>{similar?.length ?? 0} 项 · dHash 汉明距离</span>
            </div>
            {similarError ? <p>{similarError}</p> : similar?.length ? (
              <div className="asset-similar-strip">
                {similar.map((match) => (
                  <article key={match.id} title={`${match.name} · 距离 ${match.distance}`}>
                    <div style={{ background: `linear-gradient(135deg, ${match.palette[0] ?? "#26324a"}, ${match.palette[1] ?? "#42658a"})` }}>
                      {match.thumbnailUrl && <img src={match.thumbnailUrl} alt="" />}
                    </div>
                    <strong>{match.name}</strong>
                    <span>{Math.round(match.similarity * 100)}% · {match.format}</span>
                  </article>
                ))}
              </div>
            ) : <p>在当前视觉距离阈值内没有找到相似资源。</p>}
          </aside>
        )}
      </section>
    </div>
  );
}
