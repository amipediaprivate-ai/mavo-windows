import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import { ChevronLeft, ChevronRight, Clock3, FolderOpen } from "lucide-react";
import type { Asset, AssetView } from "../types";
import { assetAspectRatio } from "../lib/assetDimensions";
import { AudioCardPlayer } from "./AudioPlayer";
import { AnimatedImagePlayer } from "./AnimatedImagePlayer";
import { AssetThumbnail } from "./AssetThumbnail";
import { VideoCardPlayer } from "./VideoPlayer";

interface AssetPagedGridProps {
  assets: Asset[];
  selectedId?: string;
  selectedIds?: Set<string>;
  view: AssetView;
  cardWidth: number;
  onSelect: (asset: Asset, mode: "replace" | "toggle" | "range") => void;
  onOpen: (asset: Asset) => void;
  browseKey: string;
  pageIndex: number;
  pageCount: number;
  loading?: boolean;
  onPageChange: (page: number) => void;
  followAssetId?: string;
}

type PageDirection = "previous" | "next";

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
      data-asset-id={asset.id}
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

function AssetPagedGridComponent({
  assets,
  selectedId,
  selectedIds = new Set<string>(),
  view,
  cardWidth,
  onSelect,
  onOpen,
  browseKey,
  pageIndex,
  pageCount,
  loading = false,
  onPageChange,
  followAssetId,
}: AssetPagedGridProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const topSentinelRef = useRef<HTMLDivElement>(null);
  const bottomSentinelRef = useRef<HTMLDivElement>(null);
  const [containerWidth, setContainerWidth] = useState(900);
  const scrollDirectionRef = useRef<PageDirection | undefined>(undefined);
  const previousScrollTopRef = useRef(0);
  const pendingDirectionRef = useRef<PageDirection | undefined>(undefined);
  const lastRequestRef = useRef("");
  const positionsRef = useRef(new Map<string, number>());
  const previousBrowseKeyRef = useRef(browseKey);
  const positionKey = `${browseKey}:${view}:${pageIndex}`;

  useEffect(() => {
    if (previousBrowseKeyRef.current === browseKey) return;
    positionsRef.current.clear();
    previousBrowseKeyRef.current = browseKey;
  }, [browseKey]);

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
  const gridTemplate = useMemo(() => `repeat(${columns}, minmax(0, 1fr))`, [columns]);
  const masonryColumns = useMemo(() => {
    if (view !== "masonry") return [];
    const lanes = Array.from({ length: columns }, () => ({ assets: [] as Asset[], height: 0 }));
    assets.forEach((asset) => {
      let shortest = lanes[0];
      for (let index = 1; index < lanes.length; index += 1) {
        if (lanes[index].height < shortest.height) shortest = lanes[index];
      }
      shortest.assets.push(asset);
      shortest.height += 1 / assetAspectRatio(asset) + 0.24;
    });
    return lanes.map((lane) => lane.assets);
  }, [assets, columns, view]);

  const requestPage = useCallback((direction: PageDirection) => {
    if (loading) return;
    const target = direction === "next" ? pageIndex + 1 : pageIndex - 1;
    if (target < 0 || target >= pageCount) return;
    const requestKey = `${browseKey}:${view}:${pageIndex}:${target}`;
    if (lastRequestRef.current === requestKey) return;
    lastRequestRef.current = requestKey;
    pendingDirectionRef.current = direction;
    positionsRef.current.set(positionKey, scrollRef.current?.scrollTop ?? 0);
    onPageChange(target);
  }, [browseKey, loading, onPageChange, pageCount, pageIndex, positionKey, view]);

  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (!element || loading) return;
    const direction = pendingDirectionRef.current;
    if (direction === "next") {
      element.scrollTop = 0;
    } else if (direction === "previous") {
      element.scrollTop = Math.max(0, element.scrollHeight - element.clientHeight);
    } else {
      element.scrollTop = positionsRef.current.get(positionKey) ?? 0;
    }
    previousScrollTopRef.current = element.scrollTop;
    scrollDirectionRef.current = undefined;
    pendingDirectionRef.current = undefined;
    lastRequestRef.current = "";
  }, [assets, loading, positionKey]);

  useEffect(() => {
    const root = scrollRef.current;
    const top = topSentinelRef.current;
    const bottom = bottomSentinelRef.current;
    if (!root || !top || !bottom) return;
    const observer = new IntersectionObserver((entries) => {
      if (loading) return;
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        if (entry.target === bottom && scrollDirectionRef.current === "next") requestPage("next");
        if (entry.target === top && scrollDirectionRef.current === "previous") requestPage("previous");
      });
    }, { root, threshold: 0.75 });
    observer.observe(top);
    observer.observe(bottom);
    return () => observer.disconnect();
  }, [loading, requestPage]);

  useEffect(() => {
    if (!followAssetId) return;
    const element = scrollRef.current?.querySelector<HTMLElement>(`[data-asset-id="${CSS.escape(followAssetId)}"]`);
    element?.scrollIntoView({ block: "center" });
  }, [assets, followAssetId]);

  const [showLoading, setShowLoading] = useState(false);

  useEffect(() => {
    if (!loading) {
      setShowLoading(false);
      return;
    }
    const timer = window.setTimeout(() => setShowLoading(true), 280);
    return () => window.clearTimeout(timer);
  }, [loading]);

  const renderCard = (asset: Asset) => (
    <AssetCard
      key={asset.id}
      asset={asset}
      selected={selectedIds.has(asset.id) || selectedId === asset.id}
      view={view}
      onSelect={(event) => onSelect(asset, event.shiftKey ? "range" : event.ctrlKey || event.metaKey || event.currentTarget.classList.contains("asset-select-check") ? "toggle" : "replace")}
      onActivate={() => onSelect(asset, "replace")}
      onOpen={() => onOpen(asset)}
    />
  );

  return (
    <div
      className="asset-scroll"
      ref={scrollRef}
      onScroll={(event) => {
        const nextTop = event.currentTarget.scrollTop;
        if (Math.abs(nextTop - previousScrollTopRef.current) > 1) {
          scrollDirectionRef.current = nextTop > previousScrollTopRef.current ? "next" : "previous";
        }
        previousScrollTopRef.current = nextTop;
        positionsRef.current.set(positionKey, nextTop);
      }}
      onWheel={(event) => {
        if (event.deltaY === 0) return;
        scrollDirectionRef.current = event.deltaY > 0 ? "next" : "previous";
        const element = event.currentTarget;
        if (event.deltaY > 0 && element.scrollTop + element.clientHeight >= element.scrollHeight - 2) requestPage("next");
        if (event.deltaY < 0 && element.scrollTop <= 1) requestPage("previous");
      }}
    >
      <div ref={topSentinelRef} className="asset-page-sentinel" aria-hidden="true" />
      {assets.length === 0 ? (
        <div className="empty-state">
          <div className="empty-graphic"><FolderOpen size={28} /></div>
          <strong>没有符合条件的资源</strong>
          <span>尝试调整搜索词或清除筛选条件</span>
        </div>
      ) : view === "masonry" ? (
        <div className="asset-page-masonry" style={{ gridTemplateColumns: gridTemplate }}>
          {masonryColumns.map((column, index) => (
            <div className="asset-masonry-column" key={`column-${index}`}>{column.map(renderCard)}</div>
          ))}
        </div>
      ) : view === "list" ? (
        <div className="asset-page-list">{assets.map(renderCard)}</div>
      ) : (
        <div className="asset-page-grid" style={{ gridTemplateColumns: gridTemplate }}>{assets.map(renderCard)}</div>
      )}
      <div ref={bottomSentinelRef} className="asset-page-sentinel" aria-hidden="true" />
      {pageCount > 1 && (
        <nav className="asset-pagination" aria-label="资源分页">
          <button type="button" disabled={loading || pageIndex === 0} onClick={() => requestPage("previous")}>
            <ChevronLeft size={13} /> 上一页
          </button>
          <span>第 {(pageIndex + 1).toLocaleString("zh-CN")} / {pageCount.toLocaleString("zh-CN")} 页</span>
          <button type="button" disabled={loading || pageIndex >= pageCount - 1} onClick={() => requestPage("next")}>
            下一页 <ChevronRight size={13} />
          </button>
        </nav>
      )}
      {showLoading && <div className="asset-loading-anchor"><div className="asset-page-loading">正在读取资源…</div></div>}
    </div>
  );
}

export const AssetPagedGrid = memo(AssetPagedGridComponent);
