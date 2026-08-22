import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { open, save } from "@tauri-apps/plugin-dialog";
import {
  BookmarkPlus,
  ChevronDown,
  Columns3,
  Grid2X2,
  List,
  Pause,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightOpen,
  Play,
  SlidersHorizontal,
  Square,
  X,
} from "lucide-react";
import { useAudioSequence } from "./audio/AudioPlayerContext";
import { AppHeader } from "./components/AppHeader";
import { AssetPagedGrid } from "./components/AssetVirtualGrid";
import { AssetPreviewDialog } from "./components/AssetPreviewDialog";
import { BatchTagToolbar } from "./components/BatchTagToolbar";
import { DetailPanel } from "./components/DetailPanel";
import { FilterSidebar } from "./components/FilterSidebar";
import { ScanDialog } from "./components/ScanDialog";
import { ToolsWorkspace } from "./components/ToolsWorkspace";
import { TagManager } from "./components/TagManager";
import { ProjectWorkspace } from "./components/ProjectWorkspace";
import { PackageTransferDialog } from "./components/PackageTransferDialog";
import { assets as initialAssets } from "./data/assets";
import {
  deleteSmartView,
  enrichPendingPreviews,
  getBackgroundTasksPaused,
  listBackgroundTasks,
  listSmartViews,
  loadAssetDirectoryTree,
  loadAssetFacets,
  loadIndexedAssets,
  loadTagCatalog,
  createTag,
  setAssetTags,
  mutateAssetTags,
  noteUserInteraction,
  renameIndexedAsset,
  updateIndexedAssetMetadata,
  relinkIndexedAsset,
  removeIndexedAsset,
  deleteIndexedAsset,
  type AssetDeletionMode,
  saveTagGroup,
  saveSmartView,
  scanDuplicateAssets,
  setBackgroundTasksPaused,
  type AssetDirectoryTree,
  type AssetMetadata,
  type AssetMetadataInput,
  type AssetFacets,
  type BackgroundTask,
  type LoadIndexedAssetsOptions,
  type SmartView,
  type TagCatalog,
  type TagInput,
} from "./lib/indexedAssets";
import { openAssetFolder, openOriginalAsset } from "./lib/desktopAssets";
import type { Asset, AssetKind, AssetView, Filters, ScanScope } from "./types";
import type { SaveBackgroundRemovalResult } from "./lib/backgroundRemoval";
import type { SaveDoubleBackgroundRemovalResult } from "./lib/doubleBackgroundRemoval";
import type { SavePngCompressionResult } from "./lib/pngCompression";
import type { SaveAudioProcessingResult } from "./lib/audioProcessing";
import { exportAssetPackage, importAssetPackage, type PackageProgress, type PackageSummary } from "./lib/portablePackages";

const emptyFilters: Filters = {
  source: [],
  kind: [],
  format: [],
  folder: [],
  tags: [],
};

type ListFilterKey = "source" | "kind" | "format" | "folder";

interface PackageDialogState {
  title: string;
  description: string;
  run: (onProgress: (progress: PackageProgress) => void, operationId: string) => Promise<PackageSummary>;
}
type FilterChipKey = ListFilterKey | "tags" | "audioDirectoryPath" | "query";

function directoryLabel(path: string) {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
}

function hasFailedMetadata(asset: (typeof initialAssets)[number]) {
  return asset.metadataStatus === "unsupported";
}

const categoryKinds: Partial<Record<string, AssetKind>> = {
  图片: "图片",
  动图: "动图",
  音频: "音频",
  视频: "视频",
};

const ASSET_PAGE_SIZE = 60;
const INDEXED_SEARCH_DEBOUNCE_MS = 250;
const INDEXED_TOTAL_CACHE_LIMIT = 32;

const initialAssetPages: Record<AssetView, number> = {
  grid: 0,
  masonry: 0,
  list: 0,
};

interface AudioSequenceCursor {
  indexed: boolean;
  options: LoadIndexedAssetsOptions;
  nextIndex: number;
  fallbackAssets: Asset[];
}

export default function App() {
  const audioSequence = useAudioSequence();
  const [activeSection, setActiveSection] = useState<"资产" | "项目" | "工具">("资产");
  const [libraryAssets, setLibraryAssets] = useState(initialAssets);
  const [query, setQuery] = useState("");
  const [indexedSearchQuery, setIndexedSearchQuery] = useState("");
  const [toolQuery, setToolQuery] = useState("");
  const [projectQuery, setProjectQuery] = useState("");
  const [projectRevision, setProjectRevision] = useState(0);
  const [filters, setFilters] = useState<Filters>(emptyFilters);
  const [activeModule, setActiveModule] = useState("全部");
  const [view, setView] = useState<AssetView>("grid");
  const [sort, setSort] = useState("newest");
  const [cardWidth, setCardWidth] = useState(178);
  const [filtersOpen, setFiltersOpen] = useState(true);
  const [detailOpen, setDetailOpen] = useState(true);
  const [selectedId, setSelectedId] = useState(initialAssets[0]?.id);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [toast, setToast] = useState("");
  const [scanScope, setScanScope] = useState<ScanScope | null>(null);
  const [indexedMode, setIndexedMode] = useState(false);
  const [indexedTotal, setIndexedTotal] = useState(0);
  const [assetPages, setAssetPages] = useState(initialAssetPages);
  const [loadingAssets, setLoadingAssets] = useState(false);
  const [indexRevision, setIndexRevision] = useState(0);
  const [previewAssetId, setPreviewAssetId] = useState<string>();
  const [packageDialog, setPackageDialog] = useState<PackageDialogState>();
  const [facets, setFacets] = useState<AssetFacets>();
  const [audioDirectoryTree, setAudioDirectoryTree] = useState<AssetDirectoryTree>();
  const [audioDirectoryTreeLoading, setAudioDirectoryTreeLoading] = useState(false);
  const [smartViews, setSmartViews] = useState<SmartView[]>([]);
  const [activeSmartViewId, setActiveSmartViewId] = useState<number>();
  const [backgroundTasks, setBackgroundTasks] = useState<BackgroundTask[]>([]);
  const [backgroundPaused, setBackgroundPaused] = useState(false);
  const [tagCatalog, setTagCatalog] = useState<TagCatalog>({ groups: [], tags: [] });
  const toastTimer = useRef<number | undefined>(undefined);
  const assetRequest = useRef(0);
  const indexedModeRef = useRef(indexedMode);
  const indexedTotalRef = useRef(indexedTotal);
  const indexedQueryOptionsRef = useRef<LoadIndexedAssetsOptions>({});
  const indexedQueryKeyRef = useRef("");
  const indexedTotalCacheRef = useRef(new Map<string, number>());
  const activeAssetPageRef = useRef(0);
  const successfulAssetPagesRef = useRef(initialAssetPages);
  const lastSelectedId = useRef<string | undefined>(undefined);
  const selectedAssetCache = useRef(new Map(initialAssets.map((asset) => [asset.id, asset])));
  const filteredAssetsRef = useRef<Asset[]>(initialAssets);
  const audioSequenceCursorRef = useRef<AudioSequenceCursor | undefined>(undefined);

  const showToast = useCallback((message: string) => {
    setToast(message);
    window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(""), 1800);
  }, []);

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

  useEffect(() => {
    const timer = window.setTimeout(() => setIndexedSearchQuery(query), INDEXED_SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [query]);

  useEffect(() => {
    let lastSignal = 0;
    const signalInteraction = () => {
      const timestamp = performance.now();
      if (timestamp - lastSignal < 250) return;
      lastSignal = timestamp;
      void noteUserInteraction().catch(() => undefined);
    };
    const passiveCapture = { capture: true, passive: true } as const;
    window.addEventListener("pointerdown", signalInteraction, passiveCapture);
    window.addEventListener("pointermove", signalInteraction, passiveCapture);
    window.addEventListener("keydown", signalInteraction, true);
    window.addEventListener("wheel", signalInteraction, passiveCapture);
    window.addEventListener("scroll", signalInteraction, passiveCapture);
    return () => {
      window.removeEventListener("pointerdown", signalInteraction, true);
      window.removeEventListener("pointermove", signalInteraction, true);
      window.removeEventListener("keydown", signalInteraction, true);
      window.removeEventListener("wheel", signalInteraction, true);
      window.removeEventListener("scroll", signalInteraction, true);
    };
  }, []);

  const activeCategoryKind = categoryKinds[activeModule];
  const canSortByDuration = activeCategoryKind === "音频";
  useEffect(() => {
    if (sort === "duration" && !canSortByDuration) setSort("newest");
  }, [canSortByDuration, sort]);
  const effectiveFilters = useMemo(() => activeCategoryKind
    ? {
        ...filters,
        kind: [activeCategoryKind],
        audioDirectoryPath: activeCategoryKind === "音频" ? filters.audioDirectoryPath : undefined,
      }
    : activeModule === "智能视图" ? filters : { ...filters, audioDirectoryPath: undefined }, [activeCategoryKind, activeModule, filters]);
  const indexedQueryOptions = useMemo<LoadIndexedAssetsOptions>(() => ({
    query: indexedSearchQuery,
    filters: effectiveFilters,
    sort: activeModule === "重复文件" ? "duplicates" : sort,
    availability: activeModule === "缺失文件" ? "missing" : "available",
    duplicateOnly: activeModule === "重复文件",
  }), [activeModule, effectiveFilters, indexedSearchQuery, sort]);
  const backgroundHeavyWorkRunning = backgroundTasks.some((task) =>
    task.status === "running" && ["analysis", "thumbnail", "loudness"].includes(task.taskType));
  indexedModeRef.current = indexedMode;
  indexedTotalRef.current = indexedTotal;
  indexedQueryOptionsRef.current = indexedQueryOptions;
  const activeAssetPage = assetPages[view];
  activeAssetPageRef.current = activeAssetPage;
  const assetPageCount = indexedMode ? Math.max(1, Math.ceil(indexedTotal / ASSET_PAGE_SIZE)) : 1;
  const assetBrowseKey = useMemo(() => JSON.stringify(indexedQueryOptions), [indexedQueryOptions]);
  indexedQueryKeyRef.current = assetBrowseKey;

  const refreshIndexedAssets = async (forceIndexedMode = false, requestedPage = activeAssetPageRef.current) => {
    const requestId = ++assetRequest.current;
    const queryKey = indexedQueryKeyRef.current;
    const cachedTotal = indexedTotalCacheRef.current.get(queryKey);
    setLoadingAssets(true);
    try {
      const page = await loadIndexedAssets({
        ...indexedQueryOptionsRef.current,
        offset: requestedPage * ASSET_PAGE_SIZE,
        limit: ASSET_PAGE_SIZE,
        includeTotal: cachedTotal === undefined,
      });
      if (requestId !== assetRequest.current) return;
      if (page.total != null) {
        const cache = indexedTotalCacheRef.current;
        cache.set(queryKey, page.total);
        if (cache.size > INDEXED_TOTAL_CACHE_LIMIT) cache.delete(cache.keys().next().value!);
      }
      const total = page.total ?? cachedTotal ?? indexedTotalRef.current;
      if (total > 0 || forceIndexedMode || indexedModeRef.current) {
        const lastPage = Math.max(0, Math.ceil(total / ASSET_PAGE_SIZE) - 1);
        setIndexedMode(true);
        if (requestedPage > lastPage) {
          setAssetPages((current) => ({ ...current, [view]: lastPage }));
          return;
        }
        successfulAssetPagesRef.current = { ...successfulAssetPagesRef.current, [view]: requestedPage };
        setLibraryAssets(page.items);
        page.items.forEach((asset) => {
          if (selectedIds.has(asset.id)) selectedAssetCache.current.set(asset.id, asset);
        });
        if (page.total != null) setIndexedTotal(page.total);
      }
    } catch (error) {
      // Running the React preview outside Tauri keeps the bundled demo library available.
      if (forceIndexedMode || indexedModeRef.current) {
        const fallbackPage = successfulAssetPagesRef.current[view];
        setAssetPages((current) => ({ ...current, [view]: fallbackPage }));
        showToast(error instanceof Error ? error.message : "无法读取资源页");
      }
    } finally {
      if (requestId === assetRequest.current) setLoadingAssets(false);
    }
  };

  useEffect(() => {
    void refreshIndexedAssets(false);
    void listSmartViews().then(setSmartViews).catch(() => undefined);
    void loadTagCatalog(true).then(setTagCatalog).catch(() => undefined);
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
      void getBackgroundTasksPaused().then(setBackgroundPaused).catch(() => undefined);
      void enrichPendingPreviews(() => undefined)
        .then(() => setIndexRevision((revision) => revision + 1))
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
    let disposed = false;
    let stop: (() => void) | undefined;
    void listen("tags-changed", () => {
      void loadTagCatalog(true).then((catalog) => {
        if (!disposed) setTagCatalog(catalog);
      }).catch(() => undefined);
    }).then((unlisten) => {
      if (disposed) unlisten(); else stop = unlisten;
    });
    return () => { disposed = true; stop?.(); };
  }, []);

  useEffect(() => {
    if (!indexedMode) return;
    // Cancel the previous query immediately and reset every layout to its first page.
    assetRequest.current += 1;
    successfulAssetPagesRef.current = initialAssetPages;
    setLoadingAssets(true);
    setAssetPages(initialAssetPages);
  }, [indexedMode, indexedQueryOptions]);

  useEffect(() => {
    if (!indexedMode) return;
    const timer = window.setTimeout(() => void refreshIndexedAssets(true, activeAssetPage), 100);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeAssetPage, activeModule, filters.kind, filters.format, filters.folder, filters.tags, filters.audioDirectoryPath, filters.minWidth, filters.maxWidth, filters.orientation, filters.minDurationMs, filters.maxDurationMs, indexedMode, indexedSearchQuery, sort, view]);

  useEffect(() => {
    if (!indexedMode || backgroundHeavyWorkRunning) return;
    const timer = window.setTimeout(() => {
      void loadAssetFacets({ ...indexedQueryOptions, duplicateOnly: false, availability: "available" })
        .then(setFacets).catch(() => undefined);
    }, 220);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeModule, backgroundHeavyWorkRunning, filters.kind, filters.format, filters.folder, filters.tags, filters.audioDirectoryPath, filters.minWidth, filters.maxWidth, filters.orientation, filters.minDurationMs, filters.maxDurationMs, indexRevision, indexedMode, indexedSearchQuery]);

  useEffect(() => {
    if (!indexedMode || activeModule !== "音频") {
      setAudioDirectoryTree(undefined);
      setAudioDirectoryTreeLoading(false);
      return;
    }
    if (backgroundHeavyWorkRunning) return;
    let disposed = false;
    setAudioDirectoryTreeLoading(true);
    const timer = window.setTimeout(() => {
      void loadAssetDirectoryTree({
        ...indexedQueryOptions,
        filters: { ...effectiveFilters, audioDirectoryPath: undefined },
        duplicateOnly: false,
        availability: "available",
      }).then((tree) => {
        if (!disposed) setAudioDirectoryTree(tree);
      }).catch(() => undefined).finally(() => {
        if (!disposed) setAudioDirectoryTreeLoading(false);
      });
    }, 180);
    return () => {
      disposed = true;
      window.clearTimeout(timer);
    };
    // Directory selection is deliberately excluded so the tree remains stable while navigating.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeModule, backgroundHeavyWorkRunning, filters.kind, filters.format, filters.folder, filters.minWidth, filters.maxWidth, filters.orientation, filters.minDurationMs, filters.maxDurationMs, indexRevision, indexedMode, indexedSearchQuery]);

  useEffect(() => {
    if (indexRevision === 0 || backgroundHeavyWorkRunning) return;
    const timer = window.setTimeout(() => {
      indexedTotalCacheRef.current.clear();
      void refreshIndexedAssets(true, activeAssetPageRef.current);
    }, 500);
    return () => window.clearTimeout(timer);
    // Coalesce the scan writer and thumbnail worker's frequent commit notifications.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [backgroundHeavyWorkRunning, indexRevision]);

  const changeAssetPage = useCallback((page: number) => {
    if (!indexedMode || loadingAssets) return;
    const bounded = Math.min(Math.max(page, 0), Math.max(assetPageCount - 1, 0));
    if (bounded === activeAssetPage) return;
    setLoadingAssets(true);
    setAssetPages((current) => current[view] === bounded ? current : { ...current, [view]: bounded });
  }, [activeAssetPage, assetPageCount, indexedMode, loadingAssets, view]);

  const changeAssetView = useCallback((nextView: AssetView) => {
    if (nextView === view) return;
    if (indexedMode) {
      assetRequest.current += 1;
      setLoadingAssets(true);
    }
    setView(nextView);
  }, [indexedMode, view]);

  const filteredAssets = useMemo(() => {
    const normalizedQuery = query.trim().toLocaleLowerCase("zh-CN");
    const result = libraryAssets.filter((asset) => {
      if (indexedMode) {
        if (filters.source.length && !filters.source.includes(asset.source)) return false;
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
      if (filters.tags.length && !filters.tags.some((tagId) => asset.tagItems?.some((tag) => tag.id === tagId))) return false;
      if (activeCategoryKind && asset.kind !== activeCategoryKind) return false;
      if (activeModule === "最近使用" && asset.id > "asset-010") return false;
      if (activeModule === "重复文件") return false;
      if (activeModule === "缺失文件") return false;
      return true;
    });

    if (indexedMode) return result;

    return [...result].sort((a, b) => {
      const failedMetadataOrder = Number(hasFailedMetadata(a)) - Number(hasFailedMetadata(b));
      if (failedMetadataOrder !== 0) return failedMetadataOrder;
      if (sort === "name") return a.name.localeCompare(b.name, "zh-CN");
      if (sort === "size") return Number.parseFloat(b.weight) - Number.parseFloat(a.weight);
      if (sort === "duration") return (b.durationMs ?? -1) - (a.durationMs ?? -1);
      return b.importedAt.localeCompare(a.importedAt);
    });
  }, [activeCategoryKind, activeModule, filters, indexedMode, libraryAssets, query, sort]);
  filteredAssetsRef.current = filteredAssets;

  useEffect(() => {
    if (filteredAssets.length === 0 || filteredAssets.some((asset) => asset.id === selectedId)) return;
    const keepsCrossPageSelection = Boolean(selectedId && selectedIds.has(selectedId) && selectedAssetCache.current.has(selectedId));
    if (!keepsCrossPageSelection) setSelectedId(filteredAssets[0].id);
  }, [filteredAssets, selectedId, selectedIds]);

  const selectedAsset = libraryAssets.find((asset) => asset.id === selectedId)
    ?? (selectedId ? selectedAssetCache.current.get(selectedId) : undefined);

  const followAudioSequenceAsset = useCallback((asset: Asset) => {
    setLibraryAssets((current) => current.some((item) => item.id === asset.id) ? current : [...current, asset]);
    setSelectedId(asset.id);
    setSelectedIds(new Set([asset.id]));
    selectedAssetCache.current.clear();
    selectedAssetCache.current.set(asset.id, asset);
    const cursor = audioSequenceCursorRef.current;
    if (cursor?.indexed) {
      const targetPage = Math.floor(Math.max(0, cursor.nextIndex - 1) / ASSET_PAGE_SIZE);
      setAssetPages((current) => ({ ...current, [view]: targetPage }));
    }
    lastSelectedId.current = asset.id;
  }, [view]);

  const handleStartAudioSequence = useCallback(() => {
    const audioAssets = filteredAssetsRef.current.filter((asset) => asset.kind === "音频");
    if (audioAssets.length === 0) {
      showToast("当前排序中没有可播放的音频");
      return;
    }
    const selectedIndex = selectedId ? audioAssets.findIndex((asset) => asset.id === selectedId) : -1;
    const startIndex = selectedIndex >= 0 ? selectedIndex : 0;
    const startAsset = audioAssets[startIndex];
    audioSequenceCursorRef.current = {
      indexed: indexedMode,
      options: { ...indexedQueryOptions, filters: { ...effectiveFilters } },
      nextIndex: (indexedMode ? activeAssetPage * ASSET_PAGE_SIZE : 0) + startIndex + 1,
      fallbackAssets: audioAssets,
    };
    audioSequence.startSequence(startAsset, {
      getNext: async () => {
        const cursor = audioSequenceCursorRef.current;
        if (!cursor) return undefined;
        if (!cursor.indexed) {
          const next = cursor.fallbackAssets[cursor.nextIndex];
          cursor.nextIndex += 1;
          return next;
        }
        const pageOffset = activeAssetPageRef.current * ASSET_PAGE_SIZE;
        const loadedNext = filteredAssetsRef.current[cursor.nextIndex - pageOffset];
        if (loadedNext?.kind === "音频") {
          cursor.nextIndex += 1;
          return loadedNext;
        }
        const page = await loadIndexedAssets({
          ...cursor.options,
          offset: cursor.nextIndex,
          limit: 1,
          includeTotal: false,
        });
        cursor.nextIndex += 1;
        return page.items[0];
      },
      onAssetChange: followAudioSequenceAsset,
      onFinished: () => {
        audioSequenceCursorRef.current = undefined;
        showToast("已播放完当前排序中的全部音频");
      },
      onError: (message) => {
        audioSequenceCursorRef.current = undefined;
        showToast(message);
      },
    });
  }, [activeAssetPage, audioSequence, effectiveFilters, followAudioSequenceAsset, indexedMode, indexedQueryOptions, selectedId, showToast]);

  useEffect(() => {
    if (audioSequence.sequenceStatus === "idle" || (activeSection === "资产" && activeModule === "音频")) return;
    audioSequenceCursorRef.current = undefined;
    audioSequence.stopSequence();
  }, [activeModule, activeSection, audioSequence]);
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
    + Number(filters.minDurationMs !== undefined || filters.maxDurationMs !== undefined)
    + Number(filters.audioDirectoryPath !== undefined);

  const filterChips = useMemo(() => {
    const chips: { key: FilterChipKey; value: string; label: string; title?: string }[] = [];
    (["source", "kind", "format", "folder"] as ListFilterKey[]).forEach((key) => {
      filters[key].forEach((value) => chips.push({ key, value, label: value }));
    });
    filters.tags.forEach((tagId) => {
      const tag = tagCatalog.tags.find((item) => item.id === tagId);
      chips.push({ key: "tags", value: String(tagId), label: tag ? `标签：${tag.name}` : `标签 #${tagId}` });
    });
    if (filters.audioDirectoryPath) {
      chips.push({
        key: "audioDirectoryPath",
        value: filters.audioDirectoryPath,
        label: `目录：${directoryLabel(filters.audioDirectoryPath)}`,
        title: filters.audioDirectoryPath,
      });
    }
    if (query.trim()) chips.push({ key: "query", value: query, label: `搜索：${query}` });
    return chips;
  }, [filters, query, tagCatalog.tags]);

  const clearChip = (key: FilterChipKey, value: string) => {
    if (key === "query") {
      setQuery("");
    } else if (key === "audioDirectoryPath") {
      setFilters((current) => ({ ...current, audioDirectoryPath: undefined }));
    } else if (key === "tags") {
      setFilters((current) => ({ ...current, tags: current.tags.filter((item) => item !== Number(value)) }));
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
    setSelectedIds(new Set());
    selectedAssetCache.current.clear();
    if (module === "全部" || categoryKinds[module]) {
      setFilters((current) => ({
        ...current,
        kind: [],
        format: [],
        folder: module === "音频" ? [] : current.folder,
        minWidth: undefined,
        maxWidth: undefined,
        orientation: undefined,
        minDurationMs: undefined,
        maxDurationMs: undefined,
        audioDirectoryPath: module === "音频" ? current.audioDirectoryPath : undefined,
      }));
    } else {
      setFilters((current) => ({ ...current, audioDirectoryPath: undefined }));
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
  const refreshTags = async () => {
    const catalog = await loadTagCatalog(true);
    setTagCatalog(catalog);
  };

  const handleCreateTag = async (input: TagInput) => {
    const id = await createTag(input);
    await refreshTags();
    return id;
  };

  const handleCreateTagGroup = async (name: string) => {
    const id = await saveTagGroup(name);
    await refreshTags();
    return id;
  };

  const handleSetAssetTags = async (asset: (typeof libraryAssets)[number], tagIds: number[]) => {
    await setAssetTags([asset], tagIds);
    await refreshTags();
    setIndexRevision((revision) => revision + 1);
    showToast("标签已保存");
  };

  const handleBatchTags = async (tagIds: number[], operation: "add" | "remove") => {
    const assets = [...selectedAssetCache.current.values()].filter((asset) => selectedIds.has(asset.id));
    await mutateAssetTags(assets, tagIds, operation);
    await refreshTags();
    setIndexRevision((revision) => revision + 1);
    showToast(`已为 ${assets.length} 个资源${operation === "add" ? "添加" : "移除"}标签`);
  };

  const handleAssetSelect = useCallback((asset: (typeof libraryAssets)[number], mode: "replace" | "toggle" | "range") => {
    setSelectedId(asset.id);
    setSelectedIds((current) => {
      if (mode === "replace") {
        selectedAssetCache.current.clear();
        selectedAssetCache.current.set(asset.id, asset);
        lastSelectedId.current = asset.id;
        return new Set([asset.id]);
      }
      if (mode === "range" && lastSelectedId.current) {
        const from = filteredAssets.findIndex((item) => item.id === lastSelectedId.current);
        const to = filteredAssets.findIndex((item) => item.id === asset.id);
        if (from >= 0 && to >= 0) {
          const next = new Set(current);
          filteredAssets.slice(Math.min(from, to), Math.max(from, to) + 1).forEach((item) => {
            next.add(item.id);
            selectedAssetCache.current.set(item.id, item);
          });
          return next;
        }
      }
      const next = new Set(current);
      if (next.has(asset.id)) {
        next.delete(asset.id);
        selectedAssetCache.current.delete(asset.id);
      } else {
        next.add(asset.id);
        selectedAssetCache.current.set(asset.id, asset);
      }
      lastSelectedId.current = asset.id;
      return next;
    });
  }, [filteredAssets]);

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
      audioDirectoryPath: smartView.query.audioDirectoryPath,
      tags: smartView.query.tagIds ?? [],
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
      void enrichPendingPreviews(() => undefined)
        .then(() => setIndexRevision((revision) => revision + 1))
        .catch(() => undefined);
      showToast("文件已重新定位");
    } catch (error) {
      showToast(error instanceof Error ? error.message : "无法重新定位文件");
    }
  };

  const handleRename = async (asset: (typeof libraryAssets)[number], newStem: string) => {
    const renamed = await renameIndexedAsset(asset, newStem);
    setLibraryAssets((current) => current.map((item) => item.id === asset.id
      ? { ...item, name: renamed.name, localPath: renamed.path }
      : item));
    const cached = selectedAssetCache.current.get(asset.id);
    if (cached) selectedAssetCache.current.set(asset.id, { ...cached, name: renamed.name, localPath: renamed.path });
    showToast(`已重命名为「${renamed.name}」`);
  };

  const handleBackgroundRemoved = (asset: Asset, result: SaveBackgroundRemovalResult) => {
    if (result.overwroteOriginal && result.assetName) {
      const patch = { name: result.assetName, format: "PNG", localPath: result.path, thumbnailUrl: undefined };
      setLibraryAssets((current) => current.map((item) => item.id === asset.id ? { ...item, ...patch } : item));
      const cached = selectedAssetCache.current.get(asset.id);
      if (cached) selectedAssetCache.current.set(asset.id, { ...cached, ...patch });
    }
    setIndexRevision((revision) => revision + 1);
    void enrichPendingPreviews(() => undefined)
      .then(() => setIndexRevision((revision) => revision + 1))
      .catch(() => undefined);
    showToast(`抠图结果已保存到 ${result.path}`);
  };

  const handleDoubleBackgroundRemoved = (asset: Asset, result: SaveDoubleBackgroundRemovalResult) => {
    if (result.overwroteOriginal && result.assetName) {
      const patch = { name: result.assetName, format: "PNG", localPath: result.path, thumbnailUrl: undefined };
      setLibraryAssets((current) => current.map((item) => item.id === asset.id ? { ...item, ...patch } : item));
      const cached = selectedAssetCache.current.get(asset.id);
      if (cached) selectedAssetCache.current.set(asset.id, { ...cached, ...patch });
    }
    setIndexRevision((revision) => revision + 1);
    void enrichPendingPreviews(() => undefined)
      .then(() => setIndexRevision((revision) => revision + 1))
      .catch(() => undefined);
    showToast(`去背景结果已保存到 ${result.path}`);
  };

  const handlePngCompressed = (asset: Asset, result: SavePngCompressionResult) => {
    if (result.overwroteOriginal) {
      const patch = { name: result.assetName || asset.name, localPath: result.path, thumbnailUrl: undefined };
      setLibraryAssets((current) => current.map((item) => item.id === asset.id ? { ...item, ...patch } : item));
      const cached = selectedAssetCache.current.get(asset.id);
      if (cached) selectedAssetCache.current.set(asset.id, { ...cached, ...patch });
    }
    setIndexRevision((revision) => revision + 1);
    void enrichPendingPreviews(() => undefined)
      .then(() => setIndexRevision((revision) => revision + 1))
      .catch(() => undefined);
    showToast(`PNG 压缩结果已保存到 ${result.path}`);
  };

  const handleAudioProcessed = (asset: Asset, result: SaveAudioProcessingResult) => {
    if (result.overwroteOriginal && result.assetName && result.paths[0]) {
      const extension = result.assetName.includes(".") ? result.assetName.split(".").pop()?.toUpperCase() : asset.format;
      const patch = { name: result.assetName, format: extension || asset.format, localPath: result.paths[0], thumbnailUrl: undefined };
      setLibraryAssets((current) => current.map((item) => item.id === asset.id ? { ...item, ...patch } : item));
      const cached = selectedAssetCache.current.get(asset.id);
      if (cached) selectedAssetCache.current.set(asset.id, { ...cached, ...patch });
    }
    setIndexRevision((revision) => revision + 1);
    void enrichPendingPreviews(() => undefined)
      .then(() => setIndexRevision((revision) => revision + 1))
      .catch(() => undefined);
    showToast(result.paths.length === 1
      ? `音频结果已保存到 ${result.paths[0]}`
      : `已保存 ${result.paths.length} 个音频结果`);
  };

  const applyAssetMetadata = useCallback((asset: Asset, metadata: AssetMetadata) => {
    const patch = {
      originalSourceMethod: metadata.originalSourceMethod,
      originalSourceUrl: metadata.originalSourceUrl,
      author: metadata.author,
      authorStatus: metadata.authorStatus,
      chineseName: metadata.chineseName,
      pinyin: metadata.pinyin,
      aiPromptEnglish: metadata.aiPromptEnglish,
      aiPromptChinese: metadata.aiPromptChinese,
    };
    setLibraryAssets((current) => current.map((item) => item.id === asset.id ? { ...item, ...patch } : item));
    const cached = selectedAssetCache.current.get(asset.id);
    if (cached) selectedAssetCache.current.set(asset.id, { ...cached, ...patch });
  }, []);

  const handleUpdateAssetMetadata = useCallback(async (asset: Asset, input: AssetMetadataInput) => {
    const metadata = await updateIndexedAssetMetadata(asset, input);
    applyAssetMetadata(asset, metadata);
    return metadata;
  }, [applyAssetMetadata]);

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

  const handleExportAssetPackage = async () => {
    const selected = [...selectedAssetCache.current.values()].filter((asset) => selectedIds.has(asset.id));
    if (selected.some((asset) => !asset.id.startsWith("indexed-"))) {
      showToast("演示资源不能导出；请先扫描并选择真实资产库文件");
      return;
    }
    const ids = selected.map((asset) => Number.parseInt(asset.id.slice("indexed-".length), 10));
    if (!ids.length || ids.some((id) => !Number.isSafeInteger(id))) {
      showToast("请选择真实资产库中的资源");
      return;
    }
    let outputPath: string | null;
    try {
      outputPath = await save({ title: "导出 Caevir 资产包", defaultPath: "Caevir Assets.caepack", filters: [{ name: "Caevir 资产包", extensions: ["caepack"] }] });
    } catch (error) {
      showToast(error instanceof Error ? error.message : "无法打开保存对话框");
      return;
    }
    if (!outputPath) return;
    const finalPath = outputPath.toLowerCase().endsWith(".caepack") ? outputPath : `${outputPath}.caepack`;
    setPackageDialog({
      title: "导出资产包",
      description: `正在打包 ${ids.length} 个真实资产及其可迁移元数据`,
      run: (onProgress, operationId) => exportAssetPackage(ids, finalPath, onProgress, operationId),
    });
  };

  const handleImportAssetPackage = async () => {
    const packagePath = await open({ title: "选择 Caevir 资产包", multiple: false, directory: false, filters: [{ name: "Caevir 资产包", extensions: ["caepack"] }] });
    if (typeof packagePath !== "string") return;
    const destinationParent = await open({ title: "选择资产包落地位置", multiple: false, directory: true });
    if (typeof destinationParent !== "string") return;
    setPackageDialog({
      title: "导入资产包",
      description: "将资产恢复到所选位置，并与本机资产库执行 BLAKE3 去重",
      run: (onProgress, operationId) => importAssetPackage(packagePath, destinationParent, onProgress, operationId),
    });
  };

  const handleDeleteAsset = async (asset: (typeof libraryAssets)[number], deletionMode: AssetDeletionMode) => {
    try {
      await deleteIndexedAsset(asset, deletionMode);
      setLibraryAssets((current) => current.filter((item) => item.id !== asset.id));
      selectedAssetCache.current.delete(asset.id);
      setSelectedIds((current) => {
        const next = new Set(current);
        next.delete(asset.id);
        return next;
      });
      setSelectedId((current) => current === asset.id ? "" : current);
      setIndexRevision((revision) => revision + 1);
      setProjectRevision((revision) => revision + 1);
      showToast(deletionMode === "permanent" ? "资源已永久删除" : "资源已删除，本地文件已移入回收站");
    } catch (error) {
      const message = error instanceof Error ? error.message : "无法删除资源";
      showToast(message);
      throw error instanceof Error ? error : new Error(message);
    }
  };

  const handleOpenFolder = async (asset: (typeof libraryAssets)[number]) => {
    try {
      await openAssetFolder(asset);
    } catch (error) {
      showToast(error instanceof Error ? error.message : "无法打开所属文件夹");
    }
  };

  const handleViewOriginal = useCallback(async (asset: (typeof libraryAssets)[number]) => {
    if (asset.kind === "音频" || asset.kind === "视频") {
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
  }, [showToast]);

  return (
    <div className={`app-shell ${activeSection !== "资产" ? "tools-active" : ""}`}>
      <AppHeader
        activeSection={activeSection}
        onSectionChange={setActiveSection}
        query={activeSection === "工具" ? toolQuery : activeSection === "项目" ? projectQuery : query}
        onQueryChange={activeSection === "工具" ? setToolQuery : activeSection === "项目" ? setProjectQuery : setQuery}
        activeModule={activeModule}
        onModuleChange={handleModuleChange}
        categoryCounts={categoryCounts}
        onAction={showToast}
        onOpenScan={setScanScope}
        onRefresh={() => void handleRefresh()}
        onImportPackage={() => void handleImportAssetPackage()}
        smartViews={smartViews}
        activeSmartViewId={activeSmartViewId}
        onSmartViewSelect={handleSmartViewSelect}
        onDeleteSmartView={(viewId) => void handleDeleteSmartView(viewId)}
        backgroundTasks={backgroundTasks}
        backgroundPaused={backgroundPaused}
        onBackgroundPausedChange={(paused) => {
          setBackgroundPaused(paused);
          void setBackgroundTasksPaused(paused).catch(() => setBackgroundPaused(!paused));
        }}
      />

      {activeSection === "工具" ? (
        <ToolsWorkspace query={toolQuery} onAction={showToast} />
      ) : activeSection === "项目" ? (
        <ProjectWorkspace query={projectQuery} onAction={showToast} onProjectsChanged={() => {
          setProjectRevision((revision) => revision + 1);
          setIndexRevision((revision) => revision + 1);
          void refreshTags();
        }} />
      ) : activeModule === "标签管理" ? (
        <TagManager
          catalog={tagCatalog}
          onChanged={async () => { await refreshTags(); setIndexRevision((revision) => revision + 1); }}
          onAction={showToast}
        />
      ) : <section className={`workspace ${filtersOpen ? "" : "filters-hidden"} ${detailOpen ? "" : "detail-hidden"}`}>
        {filtersOpen && (
          <FilterSidebar
            activeModule={activeModule}
            filters={filters}
            facets={facets}
            audioDirectoryTree={audioDirectoryTree}
            audioDirectoryTreeLoading={audioDirectoryTreeLoading}
            tags={tagCatalog.tags.filter((tag) => !tag.archived)}
            onChange={handleFiltersChange}
            onReset={() => setFilters(emptyFilters)}
          />
        )}

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
            {activeModule === "音频" && (
              <div className="audio-sequence-controls" aria-label="顺序播放控制">
                {audioSequence.sequenceStatus === "idle" ? (
                  <button type="button" className="audio-sequence-primary" onClick={handleStartAudioSequence}>
                    <Play size={13} fill="currentColor" /> 顺序播放
                  </button>
                ) : (
                  <>
                    <button
                      type="button"
                      className="audio-sequence-primary active"
                      onClick={audioSequence.sequenceStatus === "playing" ? audioSequence.pauseSequence : audioSequence.resumeSequence}
                    >
                      {audioSequence.sequenceStatus === "playing"
                        ? <><Pause size={13} fill="currentColor" /> 暂停</>
                        : <><Play size={13} fill="currentColor" /> 继续</>}
                    </button>
                    <button type="button" className="audio-sequence-stop" onClick={audioSequence.stopSequence} title="停止顺序播放">
                      <Square size={11} fill="currentColor" /> 停止
                    </button>
                  </>
                )}
              </div>
            )}
            <label className="sort-select">
              <select value={sort} onChange={(event) => setSort(event.target.value)} aria-label="资源排序">
                <option value="newest">导入时间：从新到旧</option>
                <option value="name">名称：A 到 Z</option>
                <option value="size">文件大小：从大到小</option>
                {canSortByDuration && <option value="duration">时长：从长到短</option>}
              </select>
              <ChevronDown size={14} />
            </label>
            <div className="view-toggle" aria-label="视图切换">
              <button className={view === "grid" ? "active" : ""} onClick={() => changeAssetView("grid")} aria-label="网格视图" title="网格视图">
                <Grid2X2 size={15} />
              </button>
              <button className={view === "masonry" ? "active" : ""} onClick={() => changeAssetView("masonry")} aria-label="全图瀑布流视图" title="全图瀑布流视图">
                <Columns3 size={16} />
              </button>
              <button className={view === "list" ? "active" : ""} onClick={() => changeAssetView("list")} aria-label="列表视图" title="列表视图">
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
                <button key={`${chip.key}-${chip.value}`} className="filter-chip" title={chip.title} onClick={() => clearChip(chip.key, chip.value)}>
                  {chip.label} <X size={12} />
                </button>
              ))}
              <button className="save-view-button" onClick={() => void handleSaveSmartView()}>
                <BookmarkPlus size={14} /> 保存视图
              </button>
            </div>
          )}

          {selectedIds.size > 1 && (
            <BatchTagToolbar
              assets={[...selectedAssetCache.current.values()].filter((asset) => selectedIds.has(asset.id))}
              catalog={tagCatalog}
              onClear={() => {
                selectedAssetCache.current.clear();
                setSelectedIds(new Set());
              }}
              onApply={handleBatchTags}
              onExport={() => void handleExportAssetPackage()}
            />
          )}

          <AssetPagedGrid
            assets={filteredAssets}
            selectedId={selectedId}
            selectedIds={selectedIds}
            view={view}
            cardWidth={cardWidth}
            onSelect={handleAssetSelect}
            onOpen={handleViewOriginal}
            browseKey={assetBrowseKey}
            pageIndex={activeAssetPage}
            pageCount={assetPageCount}
            loading={loadingAssets}
            onPageChange={changeAssetPage}
            followAssetId={audioSequence.sequenceStatus !== "idle" ? audioSequence.activeAsset?.id : undefined}
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
            onRename={handleRename}
            onBackgroundRemoved={handleBackgroundRemoved}
            onDoubleBackgroundRemoved={handleDoubleBackgroundRemoved}
            onPngCompressed={handlePngCompressed}
            onUpdateMetadata={handleUpdateAssetMetadata}
            onMetadataResolved={applyAssetMetadata}
            onRemoveFromIndex={(asset) => void handleRemoveFromIndex(asset)}
            onDeleteAsset={handleDeleteAsset}
            tagCatalog={tagCatalog}
            onAudioProcessed={handleAudioProcessed}
            onSetTags={handleSetAssetTags}
            onCreateTag={handleCreateTag}
            onCreateTagGroup={handleCreateTagGroup}
            onFilterTag={(tagId) => setFilters((current) => ({ ...current, tags: current.tags.includes(tagId) ? current.tags : [...current.tags, tagId] }))}
            projectRevision={projectRevision}
            onProjectsChanged={() => setProjectRevision((revision) => revision + 1)}
          />
        )}
      </section>}

      <div className={`toast ${toast ? "show" : ""}`} role="status" aria-live="polite">{toast}</div>
      {scanScope && (
        <ScanDialog
          key={scanScope}
          scope={scanScope}
          onClose={() => setScanScope(null)}
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
      {packageDialog && (
        <PackageTransferDialog
          title={packageDialog.title}
          description={packageDialog.description}
          run={packageDialog.run}
          onClose={() => setPackageDialog(undefined)}
          onCompleted={() => {
            setIndexRevision((revision) => revision + 1);
            void refreshTags();
            selectedAssetCache.current.clear();
            setSelectedIds(new Set());
          }}
        />
      )}
      <div className="minimum-size-warning">
        <div className="brand-mark"><span>C</span></div>
        <h2>请放大窗口以使用 Caevir</h2>
        <p>资产管理工作区需要至少 920px 的显示宽度。</p>
      </div>
    </div>
  );
}
