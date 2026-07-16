import {
  ChevronDown,
  Image,
  ImagePlay,
  Layers3,
  Music2,
  SlidersHorizontal,
  Video,
  type LucideIcon,
} from "lucide-react";
import type { AssetDirectoryTree, AssetFacets, FacetOption } from "../lib/indexedAssets";
import type { Filters } from "../types";
import { AudioDirectoryTree } from "./AudioDirectoryTree";

type FilterMode = "全部" | "图片" | "动图" | "音频" | "视频";

interface FilterSidebarProps {
  activeModule: string;
  filters: Filters;
  facets?: AssetFacets;
  audioDirectoryTree?: AssetDirectoryTree;
  audioDirectoryTreeLoading?: boolean;
  onChange: (filters: Filters) => void;
  onReset: () => void;
}

interface FilterContext {
  icon: LucideIcon;
  title: string;
  description: string;
  formatTitle: string;
}

interface DurationPreset {
  label: string;
  min?: number;
  max?: number;
}

const filterContexts: Record<FilterMode, FilterContext> = {
  全部: {
    icon: Layers3,
    title: "全部资源",
    description: "按类型、格式和位置缩小范围",
    formatTitle: "文件格式",
  },
  图片: {
    icon: Image,
    title: "图片参数",
    description: "格式、像素尺寸与画面方向",
    formatTitle: "图片格式",
  },
  动图: {
    icon: ImagePlay,
    title: "动图参数",
    description: "格式、画布尺寸与画面方向",
    formatTitle: "动图格式",
  },
  音频: {
    icon: Music2,
    title: "音频参数",
    description: "按音频格式与播放时长筛选",
    formatTitle: "音频格式",
  },
  视频: {
    icon: Video,
    title: "视频参数",
    description: "格式、画面规格与播放时长",
    formatTitle: "视频格式",
  },
};

const audioDurations: DurationPreset[] = [
  { label: "1 分钟内", max: 59_999 },
  { label: "1–5 分钟", min: 60_000, max: 299_999 },
  { label: "5–30 分钟", min: 300_000, max: 1_799_999 },
  { label: "30 分钟以上", min: 1_800_000 },
];

const videoDurations: DurationPreset[] = [
  { label: "30 秒内", max: 29_999 },
  { label: "30 秒–5 分钟", min: 30_000, max: 299_999 },
  { label: "5–30 分钟", min: 300_000, max: 1_799_999 },
  { label: "30 分钟以上", min: 1_800_000 },
];

function FilterGroup({ title, options, selected, onToggle }: {
  title: string;
  options: FacetOption[];
  selected: string[];
  onToggle: (value: string) => void;
}) {
  return (
    <section className="filter-group">
      <div className="filter-title"><span>{title}</span><ChevronDown size={14} /></div>
      <div className="check-list">
        {options.length === 0 && <span className="filter-empty">暂无可用项</span>}
        {options.map((option) => (
          <label className="check-row" key={option.value} title={option.value}>
            <input type="checkbox" checked={selected.includes(option.value)} onChange={() => onToggle(option.value)} />
            <span className="custom-check" aria-hidden="true" />
            <span>{option.value}</span>
            <span className="check-count">{option.count.toLocaleString("zh-CN")}</span>
          </label>
        ))}
      </div>
    </section>
  );
}

function toggleValue(values: string[], value: string) {
  return values.includes(value) ? values.filter((item) => item !== value) : [...values, value];
}

export function FilterSidebar({ activeModule, filters, facets, audioDirectoryTree, audioDirectoryTreeLoading, onChange, onReset }: FilterSidebarProps) {
  const mode: FilterMode = activeModule in filterContexts ? activeModule as FilterMode : "全部";
  const context = filterContexts[mode];
  const ContextIcon = context.icon;
  const hasDimensions = mode === "图片" || mode === "动图" || mode === "视频";
  const durationPresets = mode === "音频" ? audioDurations : mode === "视频" ? videoDurations : undefined;
  const formatOptions = (facets?.extensions ?? []).map((option) => ({ ...option, value: option.value.toUpperCase() }));

  const updateList = (key: "kind" | "format" | "folder", value: string) => {
    onChange({ ...filters, [key]: toggleValue(filters[key], value) });
  };
  const updateWidth = (key: "minWidth" | "maxWidth", value: string) => {
    const parsed = Number.parseInt(value, 10);
    onChange({ ...filters, [key]: Number.isFinite(parsed) && parsed > 0 ? parsed : undefined });
  };
  const setOrientation = (orientation: Filters["orientation"]) => {
    onChange({ ...filters, orientation: filters.orientation === orientation ? undefined : orientation });
  };
  const setDuration = (preset: DurationPreset) => {
    const isActive = filters.minDurationMs === preset.min && filters.maxDurationMs === preset.max;
    onChange({
      ...filters,
      minDurationMs: isActive ? undefined : preset.min,
      maxDurationMs: isActive ? undefined : preset.max,
    });
  };

  return (
    <aside className="filters-panel">
      <div className="sidebar-heading">
        <div><SlidersHorizontal size={15} /><strong>筛选</strong></div>
        <button onClick={onReset}>重置</button>
      </div>

      <div className={`filter-context mode-${mode}`}>
        <span className="filter-context-icon"><ContextIcon size={16} strokeWidth={1.8} /></span>
        <span>
          <strong>{context.title}</strong>
          <small>{context.description}</small>
        </span>
      </div>

      {mode === "全部" && (
        <FilterGroup title="文件类型" selected={filters.kind} onToggle={(value) => updateList("kind", value)} options={facets?.kinds ?? []} />
      )}

      <FilterGroup
        title={context.formatTitle}
        selected={filters.format}
        onToggle={(value) => updateList("format", value)}
        options={formatOptions}
      />

      {hasDimensions && (
        <section className="filter-group">
          <div className="filter-title">
            <span>{mode === "动图" ? "画布尺寸" : mode === "视频" ? "画面尺寸" : "图片尺寸"}</span>
            <ChevronDown size={14} />
          </div>
          <div className="range-row">
            <input type="number" min="1" value={filters.minWidth ?? ""} onChange={(event) => updateWidth("minWidth", event.target.value)} placeholder="最小宽度" aria-label="最小宽度" />
            <span>—</span>
            <input type="number" min="1" value={filters.maxWidth ?? ""} onChange={(event) => updateWidth("maxWidth", event.target.value)} placeholder="最大宽度" aria-label="最大宽度" />
          </div>
          <div className="segment-grid">
            <button className={filters.orientation === "square" ? "active" : ""} onClick={() => setOrientation("square")}>1:1</button>
            <button className={filters.orientation === "landscape" ? "active" : ""} onClick={() => setOrientation("landscape")}>横向</button>
            <button className={filters.orientation === "portrait" ? "active" : ""} onClick={() => setOrientation("portrait")}>纵向</button>
            <button className={filters.orientation === "wide" ? "active" : ""} onClick={() => setOrientation("wide")}>超宽</button>
          </div>
        </section>
      )}

      {durationPresets && (
        <section className="filter-group">
          <div className="filter-title"><span>播放时长</span><ChevronDown size={14} /></div>
          <div className="duration-grid">
            {durationPresets.map((preset) => {
              const isActive = filters.minDurationMs === preset.min && filters.maxDurationMs === preset.max;
              return (
                <button key={preset.label} className={isActive ? "active" : ""} onClick={() => setDuration(preset)}>
                  {preset.label}
                </button>
              );
            })}
          </div>
        </section>
      )}

      {mode === "音频" ? (
        <AudioDirectoryTree
          tree={audioDirectoryTree}
          loading={audioDirectoryTreeLoading}
          selectedPath={filters.audioDirectoryPath}
          onSelect={(audioDirectoryPath) => onChange({ ...filters, audioDirectoryPath })}
        />
      ) : (
        <FilterGroup title="索引目录" selected={filters.folder} onToggle={(value) => updateList("folder", value)} options={facets?.folders ?? []} />
      )}

      <section className="filter-group compact-section">
        <div className="filter-title"><span>索引状态</span><ChevronDown size={14} /></div>
        <div className="facet-summary">
          <span>可用 <strong>{(facets?.availableCount ?? 0).toLocaleString("zh-CN")}</strong></span>
          <span>缺失 <strong>{(facets?.missingCount ?? 0).toLocaleString("zh-CN")}</strong></span>
        </div>
      </section>
    </aside>
  );
}
