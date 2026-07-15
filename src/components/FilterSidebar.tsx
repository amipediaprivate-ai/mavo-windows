import { ChevronDown, SlidersHorizontal } from "lucide-react";
import type { AssetFacets, FacetOption } from "../lib/indexedAssets";
import type { Filters } from "../types";

interface FilterSidebarProps {
  filters: Filters;
  facets?: AssetFacets;
  onChange: (filters: Filters) => void;
  onReset: () => void;
}

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

export function FilterSidebar({ filters, facets, onChange, onReset }: FilterSidebarProps) {
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

  return (
    <aside className="filters-panel">
      <div className="sidebar-heading">
        <div><SlidersHorizontal size={15} /><strong>筛选</strong></div>
        <button onClick={onReset}>重置</button>
      </div>

      <FilterGroup title="文件类型" selected={filters.kind} onToggle={(value) => updateList("kind", value)} options={facets?.kinds ?? []} />
      <FilterGroup
        title="文件格式"
        selected={filters.format}
        onToggle={(value) => updateList("format", value)}
        options={(facets?.extensions ?? []).map((option) => ({ ...option, value: option.value.toUpperCase() }))}
      />
      <FilterGroup title="索引目录" selected={filters.folder} onToggle={(value) => updateList("folder", value)} options={facets?.folders ?? []} />

      <section className="filter-group">
        <div className="filter-title"><span>图片尺寸</span><ChevronDown size={14} /></div>
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
