import { Check, Plus, Search, Tag, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { TagCatalog, TagInput } from "../lib/indexedAssets";
import type { Asset, AssetKind } from "../types";
import { TagGroupField } from "./TagGroupField";

const assetKinds: AssetKind[] = ["图片", "动图", "视频", "音频", "设计文件", "3D 模型", "字体", "文档"];

interface TagPickerProps {
  asset: Asset;
  catalog: TagCatalog;
  onClose: () => void;
  onSave: (tagIds: number[]) => Promise<void>;
  onCreate: (input: TagInput) => Promise<number>;
  onCreateGroup: (name: string) => Promise<number>;
}

export function TagPicker({ asset, catalog, onClose, onSave, onCreate, onCreateGroup }: TagPickerProps) {
  const [selected, setSelected] = useState<number[]>(asset.tagItems?.map((tag) => tag.id) ?? []);
  const [query, setQuery] = useState("");
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [groupId, setGroupId] = useState(catalog.groups[0]?.id ?? 0);
  const [color, setColor] = useState("#6366f1");
  const [scopes, setScopes] = useState<AssetKind[]>([asset.kind]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [onClose]);

  const compatibleTags = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase("zh-CN");
    return catalog.tags.filter((tag) => (
      !tag.archived
      && (tag.scopes.length === 0 || tag.scopes.includes(asset.kind))
      && (!normalized || `${tag.name} ${tag.groupName}`.toLocaleLowerCase("zh-CN").includes(normalized))
    ));
  }, [asset.kind, catalog.tags, query]);

  const grouped = catalog.groups.map((group) => ({
    group,
    tags: compatibleTags.filter((tag) => tag.groupId === group.id),
  })).filter((entry) => entry.tags.length > 0);

  const toggle = (tagId: number) => {
    setSelected((current) => current.includes(tagId) ? current.filter((id) => id !== tagId) : [...current, tagId]);
  };

  const submit = async () => {
    setSaving(true);
    setError("");
    try {
      await onSave(selected);
      onClose();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSaving(false);
    }
  };

  const create = async () => {
    if (!name.trim() || !groupId) return;
    setSaving(true);
    setError("");
    try {
      const id = await onCreate({ name: name.trim(), groupId, color, scopes });
      setSelected((current) => [...current, id]);
      setName("");
      setCreating(false);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="tag-picker-backdrop" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <section className="tag-picker" role="dialog" aria-modal="true" aria-label={`编辑 ${asset.name} 的标签`}>
        <header>
          <div><Tag size={18} /><span><strong>编辑标签</strong><small>{asset.name} · {asset.kind}</small></span></div>
          <button className="icon-button small" onClick={onClose} aria-label="关闭"><X size={15} /></button>
        </header>

        {!creating ? (
          <>
            <label className="tag-search"><Search size={15} /><input autoFocus value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索标签或分组" /></label>
            <div className="tag-picker-selected">
              <span>已选择 {selected.length} 个</span>
              {selected.length > 0 && <button onClick={() => setSelected([])}>清空</button>}
            </div>
            <div className="tag-picker-groups">
              {grouped.map(({ group, tags }) => (
                <section key={group.id}>
                  <h4>{group.name}</h4>
                  <div>
                    {tags.map((tag) => (
                      <button key={tag.id} className={selected.includes(tag.id) ? "selected" : ""} onClick={() => toggle(tag.id)}>
                        <i style={{ background: tag.color }} /> {tag.name} {selected.includes(tag.id) && <Check size={12} />}
                      </button>
                    ))}
                  </div>
                </section>
              ))}
              {grouped.length === 0 && <p className="tag-picker-empty">没有适用于{asset.kind}的匹配标签</p>}
            </div>
            <button className="tag-create-trigger" onClick={() => { setCreating(true); setName(query); }}><Plus size={14} /> 新建标签</button>
          </>
        ) : (
          <div className="tag-create-form">
            <label><span>标签名称</span><input autoFocus value={name} maxLength={40} onChange={(event) => setName(event.target.value)} /></label>
            <TagGroupField groups={catalog.groups} value={groupId} onChange={setGroupId} onCreate={onCreateGroup} disabled={saving} />
            <label><span>标签颜色</span><input type="color" value={color} onChange={(event) => setColor(event.target.value)} /></label>
            <fieldset>
              <legend>适用类型（不选表示全部）</legend>
              <div className="tag-scope-grid">{assetKinds.map((kind) => <label key={kind}><input type="checkbox" checked={scopes.includes(kind)} onChange={() => setScopes((current) => current.includes(kind) ? current.filter((item) => item !== kind) : [...current, kind])} /> {kind}</label>)}</div>
            </fieldset>
            <div className="tag-form-actions"><button className="secondary-button" onClick={() => setCreating(false)}>返回</button><button className="primary-button" disabled={saving || !name.trim() || !groupId} onClick={() => void create()}>创建并选择</button></div>
          </div>
        )}
        {error && <p className="tag-picker-error">{error}</p>}
        {!creating && <footer><button className="secondary-button" onClick={onClose}>取消</button><button className="primary-button" disabled={saving} onClick={() => void submit()}>{saving ? "保存中…" : "保存标签"}</button></footer>}
      </section>
    </div>
  );
}
