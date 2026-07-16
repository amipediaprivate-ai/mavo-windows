import { memo, useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { Clock3, FolderOpen } from "lucide-react";
import type { Asset, AssetView } from "../types";
import { assetAspectRatio } from "../lib/assetDimensions";
import { AudioCardPlayer } from "./AudioPlayer";
import { AnimatedImagePlayer } from "./AnimatedImagePlayer";
import { AssetThumbnail } from "./AssetThumbnail";
import { VideoCardPlayer } from "./VideoPlayer";

interface AssetVirtualGridProps {
  assets: Asset[];
  selectedId?: string;
  selectedIds?: Set<string>;
  view: AssetView;
  cardWidth: number;
  onSelect: (asset: Asset, mode: "replace" | "toggle" | "range") => void;
  onOpen: (asset: Asset) => void;
  hasMore?: boolean;
  loading?: boolean;
  onLoadMore?: () => void;
}

const GRID_ASPECT_RATIO = 1.48;
const GRID_CARD_BODY_HEIGHT = 78;
const MASONRY_CARD_BODY_HEIGHT = 58;
const LIST_ROW_HEIGHT = 72;
const AUDIO_LIST_ROW_HEIGHT = 192;

function listRowHeight(asset: Asset) {
  return asset.kind === "音频" ? AUDIO_LIST_ROW_HEIGHT : LIST_ROW_HEIGHT;
}

function masonryCardHeight(asset: Asset, columnWidth: number) {
  const contentWidth = Math.max(1, columnWidth - 2);
  return Math.round(contentWidth / assetAspectRatio(asset) + MASONRY_CARD_BODY_HEIGHT + 2);
}

function AssetCard({
  asset,
  selected,
  view,
  onSelect,
  onActivate,
  onOpen,
}: {
  asset: Asset;
  selected: boolean;
  view: AssetView;
  onSelect: (event: MouseEvent<HTMLElement>) => void;
  onActivate: () => void;
  onOpen: () => void;
}) {
  const showsCardMetadata = view !== "list";
  return (
    <article
      className={`asset-card ${selected ? "selected" : ""} ${view === "list" ? "list-card" : ""} ${view === "list" && asset.kind === "音频" ? "audio-list-card" : ""} ${view === "masonry" ? "masonry-card" : ""}`}
      tabIndex={0}
      onClick={onSelect}
      onDoubleClick={onOpen}
      onKeyDown={(event) => {
        if (event.key === "Enter") onSelect(event as unknown as MouseEvent<HTMLElement>);
      }}
    >
      {view === "masonry" && (
        <button
          className={`asset-select-check ${selected ? "checked" : ""}`}
          aria-label={selected ? "取消选择" : "选择资源"}
          onClick={(event) => {
            event.stopPropagation();
            onSelect(event);
          }}
        >{selected ? "✓" : ""}</button>
      )}
      <div
        className={`thumbnail-wrap ${asset.kind === "音频" ? "audio-thumbnail-wrap" : ""}`}
        style={view === "masonry" ? { aspectRatio: assetAspectRatio(asset) } : undefined}
      >
        {asset.kind === "音频" ? (
          <AudioCardPlayer asset={asset} onActivate={onActivate} />
        ) : asset.kind === "视频" ? (
          <VideoCardPlayer asset={asset} />
        ) : asset.kind === "动图" ? (
          <AnimatedImagePlayer asset={asset} variant="card" />
        ) : (
          <AssetThumbnail asset={asset} />
        )}
        {showsCardMetadata && (
          <>
            <span className="format-pill">{asset.format}</span>
            <span className="source-pill">{asset.source === "平台下载" ? "平台" : "本地"}</span>
          </>
        )}
      </div>
      <div className="asset-card-body">
        <div className="asset-name" title={asset.name}>{asset.name}</div>
        {showsCardMetadata ? (
          <div className="asset-subline">
            <span>{asset.dimensions.split("·")[0]}</span>
            <span>{asset.weight}</span>
          </div>
        ) : (
          <>
            <span className="list-format">{asset.format}</span>
            <span className="list-size">{asset.dimensions}</span>
            <span className="list-folder"><FolderOpen size={13} /> {asset.folder}</span>
            <span className="list-tags">{asset.tags.slice(0, 2).join("、")}</span>
            <span className="list-date"><Clock3 size={13} /> {asset.modifiedAt}</span>
          </>
        )}
      </div>
    </article>
  );
}

function AssetVirtualGridComponent({
  assets,
  selectedId,
  selectedIds = new Set<string>(),
  view,
  cardWidth,
  onSelect,
  onOpen,
  hasMore = false,
  loading = false,
  onLoadMore,
}: AssetVirtualGridProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = useState(900);

  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    const updateWidth = () => setContainerWidth(element.clientWidth - 28);
    updateWidth();
    const observer = new ResizeObserver(updateWidth);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const gap = 12;
  const columns = view === "list" ? 1 : Math.max(1, Math.floor((containerWidth + gap) / (cardWidth + gap)));
  const columnWidth = view === "list" ? containerWidth : (containerWidth - gap * (columns - 1)) / columns;
  const rowHeight = view === "list" ? LIST_ROW_HEIGHT : Math.round(columnWidth / GRID_ASPECT_RATIO + GRID_CARD_BODY_HEIGHT + gap);
  const rowCount = Math.ceil(assets.length / columns);
  const masonry = view === "masonry";
  const virtualCount = masonry ? assets.length : rowCount;
  const getScrollElement = useCallback(() => scrollRef.current, []);
  const assetsRef = useRef(assets);
  assetsRef.current = assets;

  const itemKeys = useMemo(() => Array.from({ length: virtualCount }, (_, index) => {
    if (masonry) {
      const asset = assets[index];
      return asset ? `${asset.id}:${assetAspectRatio(asset)}` : `${view}-${index}`;
    }
    const rowAssets = assets.slice(index * columns, (index + 1) * columns);
    return rowAssets.length
      ? `${view}:${rowAssets.map((asset) => `${asset.id}:${asset.kind}`).join("|")}`
      : `${view}-row-${index}`;
  }), [assets, columns, masonry, view, virtualCount]);
  const itemKeySignature = useMemo(() => itemKeys.join("\u001f"), [itemKeys]);
  const itemKeysRef = useRef(itemKeys);
  itemKeysRef.current = itemKeys;

  const estimateSize = useCallback((index: number) => masonry
    ? masonryCardHeight(assetsRef.current[index], columnWidth)
    : view === "list"
      ? listRowHeight(assetsRef.current[index])
      : rowHeight, [columnWidth, itemKeySignature, masonry, rowHeight, view]);
  const getItemKey = useCallback(
    (index: number) => itemKeysRef.current[index] ?? `${itemKeySignature}:${index}`,
    [itemKeySignature],
  );

  const virtualizer = useVirtualizer({
    count: virtualCount,
    getScrollElement,
    estimateSize,
    getItemKey,
    lanes: masonry ? columns : 1,
    laneAssignmentMode: "estimate",
    anchorTo: "end",
    gap: masonry ? gap : 0,
    overscan: 4,
  });

  useEffect(() => {
    virtualizer.measure();
  }, [cardWidth, columns, view, virtualizer]);

  const virtualRows = virtualizer.getVirtualItems();
  const lastVirtualIndex = virtualRows.reduce((last, item) => Math.max(last, item.index), -1);
  useEffect(() => {
    if (hasMore && !loading && lastVirtualIndex >= virtualCount - 3) {
      onLoadMore?.();
    }
  }, [hasMore, lastVirtualIndex, loading, onLoadMore, virtualCount]);
  const gridTemplate = useMemo(() => `repeat(${columns}, minmax(0, 1fr))`, [columns]);
  const [showLoading, setShowLoading] = useState(false);

  useEffect(() => {
    if (!loading) {
      setShowLoading(false);
      return;
    }
    const timer = window.setTimeout(() => setShowLoading(true), 280);
    return () => window.clearTimeout(timer);
  }, [loading]);

  return (
    <div className="asset-scroll" ref={scrollRef}>
      {assets.length === 0 ? (
        <div className="empty-state">
          <div className="empty-graphic"><FolderOpen size={28} /></div>
          <strong>没有符合条件的资源</strong>
          <span>尝试调整搜索词或清除筛选条件</span>
        </div>
      ) : (
        <div className="virtual-canvas" style={{ height: virtualizer.getTotalSize() }}>
          {masonry ? virtualRows.map((virtualItem) => {
            const asset = assets[virtualItem.index];
            return (
              <div
                className="masonry-item"
                key={virtualItem.key}
                style={{
                  width: columnWidth,
                  height: virtualItem.size,
                  transform: `translate3d(${virtualItem.lane * (columnWidth + gap)}px, ${virtualItem.start}px, 0)`,
                }}
              >
                <AssetCard
                  asset={asset}
                  selected={selectedIds.has(asset.id) || selectedId === asset.id}
                  view={view}
                  onSelect={(event) => onSelect(asset, event.shiftKey ? "range" : event.ctrlKey || event.metaKey || event.currentTarget.classList.contains("asset-select-check") ? "toggle" : "replace")}
                  onActivate={() => onSelect(asset, "replace")}
                  onOpen={() => onOpen(asset)}
                />
              </div>
            );
          }) : virtualRows.map((virtualRow) => {
            const start = virtualRow.index * columns;
            const rowAssets = assets.slice(start, start + columns);
            return (
              <div
                className={`virtual-row ${view === "list" ? "list-row" : ""}`}
                key={virtualRow.key}
                style={{
                  height: virtualRow.size - gap,
                  gridTemplateColumns: gridTemplate,
                  transform: `translateY(${virtualRow.start}px)`,
                }}
              >
                {rowAssets.map((asset) => (
                  <AssetCard
                    key={asset.id}
                    asset={asset}
                    selected={selectedIds.has(asset.id) || selectedId === asset.id}
                    view={view}
                    onSelect={(event) => onSelect(asset, event.shiftKey ? "range" : event.ctrlKey || event.metaKey || event.currentTarget.classList.contains("asset-select-check") ? "toggle" : "replace")}
                    onActivate={() => onSelect(asset, "replace")}
                    onOpen={() => onOpen(asset)}
                  />
                ))}
              </div>
            );
          })}
        </div>
      )}
      {showLoading && <div className="asset-loading-anchor"><div className="asset-page-loading">正在读取资源…</div></div>}
    </div>
  );
}

export const AssetVirtualGrid = memo(AssetVirtualGridComponent);
