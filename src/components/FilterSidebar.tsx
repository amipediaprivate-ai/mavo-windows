import { ChevronDown, Search, SlidersHorizontal } from "lucide-react";
import { formatCounts } from "../data/assets";
import type { Filters } from "../types";

interface FilterSidebarProps {
  filters: Filters;
  onChange: (filters: Filters) => void;
  onReset: () => void;
}

interface CheckOption {
  value: string;
  label?: string;
  count?: number;
}

function FilterGroup({
  title,
  options,
  selected,
  onToggle,
  searchable,
}: {
  title: string;
  options: CheckOption[];
  selected: string[];
  onToggle: (value: string) => void;
  searchable?: boolean;
}) {
  return (
    <section className="filter-group">
      <div className="filter-title">
        <span>{title}</span>
        <ChevronDown size={14} />
      </div>
      {searchable && (
        <label className="filter-search">
          <Search size={13} />
          <input placeholder={`搜索${title}`} aria-label={`搜索${title}`} />
        </label>
      )}
      <div className="check-list">
        {options.map((option) => (
          <label className="check-row" key={option.value}>
            <input
              type="checkbox"
              checked={selected.includes(option.value)}
              onChange={() => onToggle(option.value)}
            />
            <span className="custom-check" aria-hidden="true" />
            <span>{option.label ?? option.value}</span>
            {option.count !== undefined && <span className="check-count">{option.count}</span>}
          </label>
        ))}
      </div>
    </section>
  );
}

function toggleValue(values: string[], value: string) {
  return values.includes(value) ? values.filter((item) => item !== value) : [...values, value];
}

export function FilterSidebar({ filters, onChange, onReset }: FilterSidebarProps) {
  const updateList = (key: keyof Pick<Filters, "source" | "kind" | "format" | "folder" | "tags">, value: string) => {
    onChange({ ...filters, [key]: toggleValue(filters[key], value) });
  };

  return (
    <aside className="filters-panel">
      <div className="sidebar-heading">
        <div>
          <SlidersHorizontal size={15} />
          <strong>筛选</strong>
        </div>
        <button onClick={onReset}>重置</button>
      </div>

      <FilterGroup
        title="资源来源"
        selected={filters.source}
        onToggle={(value) => updateList("source", value)}
        options={[
          { value: "本地导入", count: 11 },
          { value: "平台下载", count: 7 },
          { value: "浏览器采集", count: 1 },
          { value: "剪贴板", count: 1 },
        ]}
      />
      <FilterGroup
        title="文件类型"
        selected={filters.kind}
        onToggle={(value) => updateList("kind", value)}
        options={[
          { value: "图片", count: 13 },
          { value: "动图", count: 2 },
          { value: "视频", count: 1 },
          { value: "音频", count: 2 },
          { value: "设计文件", count: 2 },
          { value: "3D 模型" },
          { value: "字体" },
          { value: "文档" },
        ]}
      />
      <FilterGroup
        title="文件格式"
        searchable
        selected={filters.format}
        onToggle={(value) => updateList("format", value)}
        options={["PNG", "JPG", "SVG", "PSD", "GIF", "MP4", "WAV"].map((value) => ({
          value,
          count: formatCounts[value] ?? 0,
        }))}
      />
      <FilterGroup
        title="所属文件夹"
        selected={filters.folder}
        onToggle={(value) => updateList("folder", value)}
        options={["角色", "场景", "UI", "图标", "特效", "音频", "视频"].map((value) => ({ value }))}
      />
      <FilterGroup
        title="标签"
        selected={filters.tags}
        onToggle={(value) => updateList("tags", value)}
        options={["Q版", "像素", "新国风", "角色", "UI", "特效"].map((value) => ({ value }))}
      />

      <section className="filter-group">
        <div className="filter-title">
          <span>状态</span>
          <ChevronDown size={14} />
        </div>
        <label className="check-row">
          <input
            type="checkbox"
            checked={filters.favorite}
            onChange={() => onChange({ ...filters, favorite: !filters.favorite })}
          />
          <span className="custom-check" aria-hidden="true" />
          <span>已收藏</span>
        </label>
      </section>

      <section className="filter-group">
        <div className="filter-title">
          <span>图片尺寸</span>
          <ChevronDown size={14} />
        </div>
        <div className="range-row">
          <input placeholder="最小宽度" aria-label="最小宽度" />
          <span>—</span>
          <input placeholder="最大宽度" aria-label="最大宽度" />
        </div>
        <div className="segment-grid">
          <button>1:1</button>
          <button>横向</button>
          <button>纵向</button>
          <button>超宽</button>
        </div>
      </section>
    </aside>
  );
}
