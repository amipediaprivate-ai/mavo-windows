import { Check, Tag, X } from "lucide-react";
import { useMemo, useState } from "react";
import type { TagCatalog } from "../lib/indexedAssets";
import type { Asset } from "../types";

interface BatchTagToolbarProps {
  assets: Asset[];
  catalog: TagCatalog;
  onClear: () => void;
  onApply: (tagIds: number[], operation: "add" | "remove") => Promise<void>;
}

export function BatchTagToolbar({ assets, catalog, onClear, onApply }: BatchTagToolbarProps) {
  const [operation, setOperation] = useState<"add" | "remove">();
  const [selected, setSelected] = useState<number[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const tags = useMemo(() => catalog.tags.filter((tag) => (
    !tag.archived && (operation === "remove" || tag.scopes.length === 0 || assets.every((asset) => tag.scopes.includes(asset.kind)))
  )), [assets, catalog.tags, operation]);

  const apply = async () => {
    if (!operation || selected.length === 0) return;
    setSaving(true);
    setError("");
    try {
      await onApply(selected, operation);
      setOperation(undefined);
      setSelected([]);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <div className="batch-tag-toolbar">
        <span><Check size={14} /> 已选择 <strong>{assets.length}</strong> 个资源</span>
        <button onClick={() => setOperation("add")}><Tag size={14} /> 添加标签</button>
        <button onClick={() => setOperation("remove")}>移除标签</button>
        <button className="batch-clear" onClick={onClear}><X size={14} /> 取消选择</button>
      </div>
      {operation && (
        <div className="tag-picker-backdrop" onMouseDown={(event) => event.target === event.currentTarget && setOperation(undefined)}>
          <section className="batch-tag-dialog" role="dialog" aria-modal="true">
            <header><div><Tag size={18} /><strong>批量{operation === "add" ? "添加" : "移除"}标签</strong></div><button className="icon-button small" onClick={() => setOperation(undefined)}><X size={15} /></button></header>
            <p>将对 {assets.length} 个资源执行操作。添加时仅显示与全部所选文件兼容的标签。</p>
            <div className="batch-tag-options">{tags.map((tag) => <button key={tag.id} className={selected.includes(tag.id) ? "selected" : ""} onClick={() => setSelected((current) => current.includes(tag.id) ? current.filter((id) => id !== tag.id) : [...current, tag.id])}><i style={{ background: tag.color }} />{tag.name}{selected.includes(tag.id) && <Check size={12} />}</button>)}</div>
            {error && <p className="tag-picker-error">{error}</p>}
            <footer><button className="secondary-button" onClick={() => setOperation(undefined)}>取消</button><button className="primary-button" disabled={saving || selected.length === 0} onClick={() => void apply()}>{saving ? "处理中…" : `应用到 ${assets.length} 个资源`}</button></footer>
          </section>
        </div>
      )}
    </>
  );
}
