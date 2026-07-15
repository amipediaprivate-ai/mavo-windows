import { useEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { open } from "@tauri-apps/plugin-dialog";
import {
  BookmarkPlus,
  ChevronDown,
  Columns3,
  Grid2X2,
  List,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightOpen,
  SlidersHorizontal,
  X,
} from "lucide-react";
import { AppHeader } from "./components/AppHeader";
import { AssetVirtualGrid } from "./components/AssetVirtualGrid";
import { AssetPreviewDialog } from "./components/AssetPreviewDialog";
import { DetailPanel } from "./components/DetailPanel";
import { FilterSidebar } from "./components/FilterSidebar";
import { ScanDialog } from "./components/ScanDialog";
import { assets as initialAssets } from "./data/assets";
import {
  deleteSmartView,
  enrichPendingPreviews,
  listBackgroundTasks,
  listSmartViews,
  loadAssetFacets,
  loadIndexedAssets,
  relinkIndexedAsset,
  removeIndexedAsset,
  saveSmartView,
  scanDuplicateAssets,
  type AssetFacets,
  type BackgroundTask,
  type SmartView,
} from "./lib/indexedAssets";
import { openAssetFolder, openOriginalAsset } from "./lib/desktopAssets";
import type { AssetKind, AssetView, Filters, ScanScope } from "./types";

const emptyFilters: Filters = {
  source: [],
  kind: [],
  format: [],
  folder: [],
  tags: [],
};

type ListFilterKey = "source" | "kind" | "format" | "folder" | "tags";

const categoryKinds: Partial<Record<string, AssetKind>> = {
  图片: "图片",
  动图: "动图",
  音频: "音频",
  视频: "视频",
};

export default function App() {
  const [libraryAssets, setLibraryAssets] = useState(initialAssets);
  const [query, setQuery] = useState("");
  const [filters, setFilters] = useState<Filters>(emptyFilters);
  const [activeModule, setActiveModule] = useState("全部");
  const [view, setView] = useState<AssetView>("grid");
  const [sort, setSort] = useState("newest");
  const [cardWidth, setCardWidth] = useState(178);
  const [filtersOpen, setFiltersOpen] = useState(true);
  const [detailOpen, setDetailOpen] = useState(true);
  const [selectedId, setSelectedId] = useState(initialAssets[0]?.id);
  const [toast, setToast] = useState("");
  const [scanScope, setScanScope] = useState<ScanScope | null>(null);
  const [indexedMode, setIndexedMode] = useState(false);
  const [indexedTotal, setIndexedTotal] = useState(0);
  const [nextOffset, setNextOffset] = useState<number | undefined>();
  const [loadingAssets, setLoadingAssets] = useState(false);
  const [indexRevision, setIndexRevision] = useState(0);
  const [previewAssetId, setPreviewAssetId] = useState<string>();
  const [facets, setFacets] = useState<AssetFacets>();
  const [smartViews, setSmartViews] = useState<SmartView[]>([]);
  const [activeSmartViewId, setActiveSmartViewId] = useState<number>();
  const [backgroundTasks, setBackgroundTasks] = useState<BackgroundTask[]>([]);
  const toastTimer = useRef<number | undefined>(undefined);
  const assetRequest = useRef(0);

  const showToast = (message: string) => {
    setToast(message);
    window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(""), 1800);
  };

  useEffect(() => {
    const handleShortcut = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        document.querySelector<HTMLInputElement>(".global-search input")?.focus();
      }
    };
    window.addEventListener("keydown", handleShortcut);
    return () => window.removeEventListener("keydown", handleShortcut);
  }, []);

  useEffect(() => () => window.clearTimeout(toastTimer.current), []);

  const activeCategoryKind = categoryKinds[activeModule];
  const effectiveFilters = activeCategoryKind
    ? { ...filters, kind: [activeCategoryKind] }
    : filters;
  const indexedQueryOptions = {
    query,
    filters: effectiveFilters,
    sort: activeModule === "重复文件" ? "duplicates" : sort,
    availability: activeModule === "缺失文件" ? "missing" as const : "available" as const,
    duplicateOnly: activeModule === "重复文件",
  };

  const refreshIndexedAssets = async (forceIndexedMode = false) => {
    const requestId = ++assetRequest.current;
    try {
      const page = await loadIndexedAssets({ ...indexedQueryOptions, limit: 200 });
      if (requestId !== assetRequest.current) return;
      if (page.total > 0 || forceIndexedMode || indexedMode) {
        setIndexedMode(true);
        setLibraryAssets(page.items);
        setIndexedTotal(page.total);
        setNextOffset(page.nextOffset);
      }
    } catch {
      // Running the React preview outside Tauri keeps the bundled demo library available.
    }
  };

  useEffect(() => {
    void refreshIndexedAssets(false);
    void listSmartViews().then(setSmartViews).catch(() => undefined);
    let disposed = false;
    let stop: (() => void) | undefined;
    void listen<BackgroundTask>("background-task-progress", ({ payload }) => {
      setBackgroundTasks((current) => {
        const next = current.filter((task) => task.id !== payload.id);
        return [payload, ...next].sort((left, right) => right.updatedAtMs - left.updatedAtMs).slice(0, 24);
      });
    }).then((unlisten) => {
      if (disposed) {
        unlisten();
        return;
      }
      stop = unlisten;
      void listBackgroundTasks().then((tasks) => {
        setBackgroundTasks((current) => {
          const byId = new Map(tasks.map((task) => [task.id, task]));
          current.forEach((task) => {
            if ((byId.get(task.id)?.updatedAtMs ?? 0) < task.updatedAtMs) byId.set(task.id, task);
          });
          return [...byId.values()].sort((left, right) => right.updatedAtMs - left.updatedAtMs).slice(0, 24);
        });
      }).catch(() => undefined);
      void enrichPendingPreviews(() => setIndexRevision((revision) => revision + 1))
        .then(() => refreshIndexedAssets(true))
        .catch(() => undefined);
    }).catch(() => undefined);
    // The first load deliberately uses the initial query state only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    return () => { disposed = true; stop?.(); };
  }, []);

  useEffect(() => {
    let disposed = false;
    let stop: (() => void) | undefined;
    void listen("asset-index-changed", () => setIndexRevision((revision) => revision + 1)).then((unlisten) => {
      if (disposed) unlisten(); else stop = unlisten;
    });
    return () => { disposed = true; stop?.(); };
  }, []);

  useEffect(() => {
    if (!indexedMode) return;
    const timer = window.setTimeout(() => void refreshIndexedAssets(true), 180);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeModule, filters.kind, filters.format, filters.folder, filters.minWidth, filters.maxWidth, filters.orientation, filters.minDurationMs, filters.maxDurationMs, indexedMode, query, sort]);

  useEffect(() => {
    if (!indexedMode) return;
    const timer = window.setTimeout(() => {
      void loadAssetFacets({ ...indexedQueryOptions, duplicateOnly: false, availability: "available" })
        .then(setFacets).catch(() => undefined);
    }, 220);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeModule, filters.kind, filters.format, filters.folder, filters.minWidth, filters.maxWidth, filters.orientation, filters.minDurationMs, filters.maxDurationMs, indexRevision, indexedMode, query]);

  useEffect(() => {
    if (indexRevision === 0) return;
    const timer = window.setTimeout(() => void refreshIndexedAssets(true), 240);
    return () => window.clearTimeout(timer);
    // Coalesce the scan writer and thumbnail worker's frequent commit notifications.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [indexRevision]);

  const loadMoreIndexedAssets = async () => {
    if (!indexedMode || nextOffset === undefined || loadingAssets) return;
    setLoadingAssets(true);
    const offset = nextOffset;
    try {
      const page = await loadIndexedAssets({ ...indexedQueryOptions, offset, limit: 200 });
      setLibraryAssets((current) => {
        const existing = new Set(current.map((asset) => asset.id));
        return [...current, ...page.items.filter((asset) => !existing.has(asset.id))];
      });
      setIndexedTotal(page.total);
      setNextOffset(page.nextOffset);
    } catch (error) {
      showToast(error instanceof Error ? error.message : "无法读取更多资源");
    } finally {
      setLoadingAssets(false);
    }
  };

  const filteredAssets = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase("zh-CN");
    const result = libraryAssets.filter((asset) => {
      if (indexedMode) {
        if (filters.source.length && !filters.source.includes(asset.source)) return false;
        if (filters.tags.length && !filters.tags.some((tag) => asset.tags.includes(tag))) return false;
        return true;
      }
      if (normalizedQuery) {
        const haystack = [asset.name, asset.folder, asset.format, asset.kind, ...asset.tags].join(" ").toLocaleLowerCase("zh-CN");
        if (!haystack.includes(normalizedQuery)) return false;
      }
      if (filters.source.length && !filters.source.includes(asset.source)) return false;
      if (filters.kind.length && !filters.kind.includes(asset.kind)) return false;
      if (filters.format.length && !filters.format.includes(asset.format)) return false;
      if (filters.folder.length && !filters.folder.includes(asset.folder)) return false;
      if (filters.tags.length && !filters.tags.some((tag) => asset.tags.includes(tag))) return false;
      if (activeCategoryKind && asset.kind !== activeCategoryKind) return false;
      if (activeModule === "最近使用" && asset.id > "asset-010") return false;
      if (activeModule === "重复文件") return false;
      if (activeModule === "缺失文件") return false;
      return true;
    });

    return [...result].sort((a, b) => {
      if (sort === "name") return a.name.localeCompare(b.name, "zh-CN");
      if (sort === "size") return Number.parseFloat(b.weight) - Number.parseFloat(a.weight);
      return b.importedAt.localeCompare(a.importedAt);
    });
  }, [activeCategoryKind, activeModule, filters, indexedMode, libraryAssets, query, sort]);

  useEffect(() => {
    if (filteredAssets.length > 0 && !filteredAssets.some((asset) => asset.id === selectedId)) {
      setSelectedId(filteredAssets[0].id);
    }
  }, [filteredAssets, selectedId]);

  const selectedAsset = libraryAssets.find((asset) => asset.id === selectedId);
  const categoryCounts = useMemo(() => {
    const counts: Record<string, number> = { 全部: 0, 图片: 0, 动图: 0, 音频: 0, 视频: 0 };
    if (facets) {
      facets.kinds.forEach(({ value, count }) => {
        counts.全部 += count;
        if (value in counts) counts[value] = count;
      });
      return counts;
    }
    if (indexedMode) return {};
    initialAssets.forEach((asset) => {
      counts.全部 += 1;
      if (asset.kind in counts) counts[asset.kind] += 1;
    });
    return counts;
  }, [facets, indexedMode]);
  const appliedFilterCount =
    filters.source.length + filters.kind.length + filters.format.length + filters.folder.length + filters.tags.length
    + Number(filters.minWidth !== undefined) + Number(filters.maxWidth !== undefined) + Number(filters.orientation !== undefined)
    + Number(filters.minDurationMs !== undefined || filters.maxDurationMs !== undefined);

  const filterChips = useMemo(() => {
    const chips: { key: ListFilterKey | "query"; value: string; label: string }[] = [];
    (["source", "kind", "format", "folder", "tags"] as ListFilterKey[]).forEach((key) => {
      filters[key].forEach((value) => chips.push({ key, value, label: value }));
    });
    if (query.trim()) chips.push({ key: "query", value: query, label: `搜索：${query}` });
    return chips;
  }, [filters, query]);

  const clearChip = (key: ListFilterKey | "query", value: string) => {
    if (key === "query") {
      setQuery("");
    } else {
      setFilters((current) => ({ ...current, [key]: current[key].filter((item) => item !== value) }));
    }
  };

  const handleFiltersChange = (nextFilters: Filters) => {
    if (activeCategoryKind && nextFilters.kind !== filters.kind) {
      setActiveModule("全部");
    }
    setFilters(nextFilters);
  };

  const handleModuleChange = async (module: string) => {
    setActiveModule(module);
    if (module === "全部" || categoryKinds[module]) {
      setFilters((current) => ({
        ...current,
        kind: [],
        format: [],
        minWidth: undefined,
        maxWidth: undefined,
        orientation: undefined,
        minDurationMs: undefined,
        maxDurationMs: undefined,
      }));
    }
    if (module !== "智能视图") setActiveSmartViewId(undefined);
    if (module === "重复文件") {
      showToast("正在检测完全重复的文件…");
      try {
        const result = await scanDuplicateAssets();
        setIndexRevision((revision) => revision + 1);
        showToast(`发现 ${result.duplicateGroups} 组、${result.duplicateFiles} 个重复文件`);
      } catch (error) {
        showToast(error instanceof Error ? error.message : "重复文件检测失败");
      }
    }
  };

  const refreshSmartViews = () => listSmartViews().then(setSmartViews).catch(() => undefined);

  const handleSaveSmartView = async () => {
    const name = window.prompt("为当前筛选命名", "新智能视图")?.trim();
    if (!name) return;
    try {
      await saveSmartView(name, indexedQueryOptions);
      await refreshSmartViews();
      showToast(`已保存智能视图「${name}」`);
    } catch (error) {
      showToast(error instanceof Error ? error.message : "无法保存智能视图");
    }
  };

  const handleSmartViewSelect = (viewId: number) => {
    const smartView = smartViews.find((item) => item.id === viewId);
    if (!smartView) return;
    setActiveSmartViewId(viewId);
    setActiveModule("智能视图");
    setQuery(smartView.query.query ?? "");
    setSort(smartView.query.sort ?? "newest");
    setFilters({
      ...emptyFilters,
      kind: smartView.query.kinds ?? [],
      format: smartView.query.extensions?.map((value) => value.toUpperCase()) ?? [],
      folder: smartView.query.folders ?? [],
      minWidth: smartView.query.minWidth,
      maxWidth: smartView.query.maxWidth,
      orientation: smartView.query.orientation,
      minDurationMs: smartView.query.minDurationMs,
      maxDurationMs: smartView.query.maxDurationMs,
    });
  };

  const handleDeleteSmartView = async (viewId: number) => {
    if (!window.confirm("确定删除当前智能视图？")) return;
    try {
      await deleteSmartView(viewId);
      setActiveSmartViewId(undefined);
      setActiveModule("全部");
      await refreshSmartViews();
      showToast("智能视图已删除");
    } catch (error) {
      showToast(error instanceof Error ? error.message : "无法删除智能视图");
    }
  };

  const handleRefresh = async () => {
    if (activeModule === "重复文件") {
      await handleModuleChange("重复文件");
    } else {
      setIndexRevision((revision) => revision + 1);
      showToast("资源索引已刷新");
    }
  };

  const handleRelink = async (asset: (typeof libraryAssets)[number]) => {
    const selected = await open({ title: `重新定位 ${asset.name}`, multiple: false, directory: false });
    if (typeof selected !== "string") return;
    try {
      await relinkIndexedAsset(asset, selected);
      setIndexRevision((revision) => revision + 1);
      showToast("文件已重新定位");
    } catch (error) {
      showToast(error instanceof Error ? error.message : "无法重新定位文件");
    }
  };

  const handleRemoveFromIndex = async (asset: (typeof libraryAssets)[number]) => {
    if (!window.confirm(`从索引中清理「${asset.name}」？原文件不会被删除。`)) return;
    try {
      await removeIndexedAsset(asset);
      setIndexRevision((revision) => revision + 1);
      showToast("已从索引清理");
    } catch (error) {
      showToast(error instanceof Error ? error.message : "无法清理索引");
    }
  };

  const handleOpenFolder = async (asset: (typeof libraryAssets)[number]) => {
    try {
      await openAssetFolder(asset);
    } catch (error) {
      showToast(error instanceof Error ? error.message : "无法打开所属文件夹");
    }
  };

  const handleViewOriginal = async (asset: (typeof libraryAssets)[number]) => {
    if (asset.kind === "音频") {
      setSelectedId(asset.id);
      setDetailOpen(true);
      return;
    }
    try {
      await openOriginalAsset(asset);
    } catch (error) {
      if (!asset.localPath) {
        setPreviewAssetId(asset.id);
        return;
      }
      showToast(error instanceof Error ? error.message : "无法调用系统查看器");
    }
  };

  return (
    <div className="app-shell">
      <AppHeader
        query={query}
        onQueryChange={setQuery}
        activeModule={activeModule}
        onModuleChange={handleModuleChange}
        categoryCounts={categoryCounts}
        onAction={showToast}
        onOpenScan={setScanScope}
        onRefresh={() => void handleRefresh()}
        smartViews={smartViews}
        activeSmartViewId={activeSmartViewId}
        onSmartViewSelect={handleSmartViewSelect}
        onDeleteSmartView={(viewId) => void handleDeleteSmartView(viewId)}
        backgroundTasks={backgroundTasks}
      />

      <section className={`workspace ${filtersOpen ? "" : "filters-hidden"} ${detailOpen ? "" : "detail-hidden"}`}>
        {filtersOpen && <FilterSidebar activeModule={activeModule} filters={filters} facets={facets} onChange={handleFiltersChange} onReset={() => setFilters(emptyFilters)} />}

        <main className="main-panel">
          <div className="asset-toolbar">
            <button
              className={`icon-button filter-toggle ${filtersOpen ? "active" : ""}`}
              onClick={() => setFiltersOpen((open) => !open)}
              aria-label={filtersOpen ? "收起筛选" : "展开筛选"}
              title={filtersOpen ? "收起筛选" : "展开筛选"}
            >
              {filtersOpen ? <PanelLeftClose size={16} /> : <PanelLeftOpen size={16} />}
            </button>
            <div className="toolbar-summary">
              <div>
                <h1>{activeModule}</h1>
                <span>{(indexedMode ? indexedTotal : filteredAssets.length).toLocaleString("zh-CN")} 个资源</span>
              </div>
              {appliedFilterCount > 0 && <span className="filter-count"><SlidersHorizontal size={12} /> {appliedFilterCount}</span>}
            </div>
            <div className="toolbar-spacer" />
            <label className="sort-select">
              <select value={sort} onChange={(event) => setSort(event.target.value)} aria-label="资源排序">
                <option value="newest">导入时间：从新到旧</option>
                <option value="name">名称：A 到 Z</option>
                <option value="size">文件大小：从大到小</option>
              </select>
              <ChevronDown size={14} />
            </label>
            <div className="view-toggle" aria-label="视图切换">
              <button className={view === "grid" ? "active" : ""} onClick={() => setView("grid")} aria-label="网格视图" title="网格视图">
                <Grid2X2 size={15} />
              </button>
              <button className={view === "masonry" ? "active" : ""} onClick={() => setView("masonry")} aria-label="全图瀑布流视图" title="全图瀑布流视图">
                <Columns3 size={16} />
              </button>
              <button className={view === "list" ? "active" : ""} onClick={() => setView("list")} aria-label="列表视图" title="列表视图">
                <List size={16} />
              </button>
            </div>
            {view !== "list" && (
              <label className="zoom-control" title="缩略图大小">
                <span />
                <input type="range" min="152" max="236" step="7" value={cardWidth} onChange={(event) => setCardWidth(Number(event.target.value))} />
                <Grid2X2 size={16} />
              </label>
            )}
            {!detailOpen && (
              <button className="icon-button" onClick={() => setDetailOpen(true)} aria-label="展开资源明细" title="展开资源明细">
                <PanelRightOpen size={16} />
              </button>
            )}
          </div>

          {(filterChips.length > 0 || appliedFilterCount > 0) && (
            <div className="active-filter-bar">
              <span className="active-filter-label">当前筛选</span>
              {filterChips.map((chip) => (
                <button key={`${chip.key}-${chip.value}`} className="filter-chip" onClick={() => clearChip(chip.key, chip.value)}>
                  {chip.label} <X size={12} />
                </button>
              ))}
              <button className="save-view-button" onClick={() => void handleSaveSmartView()}>
                <BookmarkPlus size={14} /> 保存视图
              </button>
            </div>
          )}

          <AssetVirtualGrid
            assets={filteredAssets}
            selectedId={selectedId}
            view={view}
            cardWidth={cardWidth}
            onSelect={(asset) => setSelectedId(asset.id)}
            onOpen={(asset) => void handleViewOriginal(asset)}
            hasMore={indexedMode && nextOffset !== undefined}
            loading={loadingAssets}
            onLoadMore={() => void loadMoreIndexedAssets()}
          />
        </main>

        {detailOpen && (
          <DetailPanel
            asset={selectedAsset}
            onClose={() => setDetailOpen(false)}
            onAction={showToast}
            onViewOriginal={(asset) => void handleViewOriginal(asset)}
            onOpenFolder={(asset) => void handleOpenFolder(asset)}
            onRelink={(asset) => void handleRelink(asset)}
            onRemoveFromIndex={(asset) => void handleRemoveFromIndex(asset)}
          />
        )}
      </section>

      <div className={`toast ${toast ? "show" : ""}`} role="status" aria-live="polite">{toast}</div>
      {scanScope && (
        <ScanDialog
          key={scanScope}
          scope={scanScope}
          onClose={() => setScanScope(null)}
          onAssetsCommitted={() => setIndexRevision((revision) => revision + 1)}
          onFinished={(matchedCount) => {
            setIndexRevision((revision) => revision + 1);
            showToast(`扫描完成，已索引 ${matchedCount.toLocaleString("zh-CN")} 个资源`);
          }}
          onCancelled={(matchedCount) => {
            setIndexRevision((revision) => revision + 1);
            showToast(`扫描已取消，已保留 ${matchedCount.toLocaleString("zh-CN")} 个资源`);
          }}
        />
      )}
      {previewAssetId && (
        <AssetPreviewDialog
          assets={filteredAssets}
          activeId={previewAssetId}
          onActiveChange={(id) => {
            setPreviewAssetId(id);
            setSelectedId(id);
          }}
          onClose={() => setPreviewAssetId(undefined)}
        />
      )}
      <div className="minimum-size-warning">
        <div className="brand-mark"><span>M</span></div>
        <h2>请放大窗口以使用 Mavo</h2>
        <p>资产管理工作区需要至少 920px 的显示宽度。</p>
      </div>
    </div>
  );
}
