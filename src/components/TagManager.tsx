import { Archive, Combine, Edit3, Plus, Search, Tag, Trash2, Undo2 } from "lucide-react";
import { useMemo, useState } from "react";
import {
  createTag,
  deleteTag,
  deleteTagGroup,
  mergeTags,
  saveTagGroup,
  setTagArchived,
  updateTag,
  type TagCatalog,
  type TagDefinition,
  type TagInput,
} from "../lib/indexedAssets";
import type { AssetKind } from "../types";
import { TagGroupField } from "./TagGroupField";

const assetKinds: AssetKind[] = ["图片", "动图", "视频", "音频", "设计文件", "3D 模型", "字体", "文档"];

interface TagManagerProps {
  catalog: TagCatalog;
  onChanged: () => Promise<void>;
  onAction: (message: string) => void;
}

const emptyInput = (groupId = 0): TagInput => ({ name: "", groupId, color: "#6366f1", description: "", scopes: [] });

export function TagManager({ catalog, onChanged, onAction }: TagManagerProps) {
  const [query, setQuery] = useState("");
  const [groupFilter, setGroupFilter] = useState<number>();
  const [includeArchived, setIncludeArchived] = useState(false);
  const [editingId, setEditingId] = useState<number>();
  const [form, setForm] = useState<TagInput>(() => emptyInput(catalog.groups[0]?.id));
  const [formOpen, setFormOpen] = useState(false);
  const [saving, setSaving] = useState(false);

  const visibleTags = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase("zh-CN");
    return catalog.tags.filter((tag) => (
      (includeArchived || !tag.archived)
      && (!groupFilter || tag.groupId === groupFilter)
      && (!normalized || `${tag.name} ${tag.groupName} ${tag.description}`.toLocaleLowerCase("zh-CN").includes(normalized))
    ));
  }, [catalog.tags, groupFilter, includeArchived, query]);

  const activeTags = catalog.tags.filter((tag) => !tag.archived);
  const usedTags = activeTags.filter((tag) => tag.usageCount > 0).length;
  const coveredAssets = new Set(activeTags.flatMap((tag) => tag.usageCount ? [tag.id] : [])).size;

  const beginCreate = () => {
    setEditingId(undefined);
    setForm(emptyInput(groupFilter ?? catalog.groups[0]?.id));
    setFormOpen(true);
  };

  const beginEdit = (tag: TagDefinition) => {
    setEditingId(tag.id);
    setForm({ name: tag.name, groupId: tag.groupId, color: tag.color, description: tag.description, scopes: tag.scopes });
    setFormOpen(true);
  };

  const submit = async () => {
    if (!form.name.trim() || !form.groupId) return;
    setSaving(true);
    try {
      if (editingId) await updateTag(editingId, form); else await createTag(form);
      await onChanged();
      setFormOpen(false);
      onAction(editingId ? "标签已更新" : "标签已创建");
    } catch (error) {
      onAction(error instanceof Error ? error.message : String(error));
    } finally {
      setSaving(false);
    }
  };

  const addGroup = async () => {
    const name = window.prompt("新标签分组名称")?.trim();
    if (!name) return;
    try {
      const id = await saveTagGroup(name);
      await onChanged();
      setGroupFilter(id);
      onAction(`已创建分组「${name}」`);
    } catch (error) {
      onAction(error instanceof Error ? error.message : String(error));
    }
  };

  const createGroupForForm = async (name: string) => {
    const id = await saveTagGroup(name);
    await onChanged();
    onAction(`已创建分组「${name}」`);
    return id;
  };

  const renameGroup = async () => {
    const group = catalog.groups.find((item) => item.id === groupFilter);
    if (!group) return;
    const name = window.prompt("重命名标签分组", group.name)?.trim();
    if (!name || name === group.name) return;
    try {
      await saveTagGroup(name, group.id);
      await onChanged();
      onAction("分组已重命名");
    } catch (error) {
      onAction(error instanceof Error ? error.message : String(error));
    }
  };

  const removeGroup = async () => {
    const group = catalog.groups.find((item) => item.id === groupFilter);
    if (!group || !window.confirm(`删除空分组「${group.name}」？`)) return;
    try {
      await deleteTagGroup(group.id);
      setGroupFilter(undefined);
      await onChanged();
      onAction("分组已删除");
    } catch (error) {
      onAction(error instanceof Error ? error.message : String(error));
    }
  };

  const toggleArchived = async (tag: TagDefinition) => {
    try {
      await setTagArchived(tag.id, !tag.archived);
      await onChanged();
      onAction(tag.archived ? "标签已恢复" : "标签已归档");
    } catch (error) {
      onAction(error instanceof Error ? error.message : String(error));
    }
  };

  const remove = async (tag: TagDefinition) => {
    if (!window.confirm(`永久删除「${tag.name}」？将移除 ${tag.usageCount} 个文件上的关联。`)) return;
    try {
      await deleteTag(tag.id);
      await onChanged();
      onAction("标签已永久删除");
    } catch (error) {
      onAction(error instanceof Error ? error.message : String(error));
    }
  };

  const merge = async (tag: TagDefinition) => {
    const targetName = window.prompt(`将「${tag.name}」合并到哪个标签？请输入目标标签名称`)?.trim();
    if (!targetName) return;
    const target = catalog.tags.find((item) => !item.archived && item.name.toLocaleLowerCase("zh-CN") === targetName.toLocaleLowerCase("zh-CN"));
    if (!target || target.id === tag.id) {
      onAction("未找到有效的目标标签");
      return;
    }
    try {
      await mergeTags(tag.id, target.id);
      await onChanged();
      onAction(`已合并到「${target.name}」`);
    } catch (error) {
      onAction(error instanceof Error ? error.message : String(error));
    }
  };

  return (
    <main className="tag-manager">
      <header className="tag-manager-hero">
        <div><span className="tag-manager-icon"><Tag size={24} /></span><div><small>TAG LIBRARY</small><h1>标签管理</h1><p>统一维护标签、适用文件类型和资源关系。</p></div></div>
        <button className="primary-button" onClick={beginCreate}><Plus size={15} /> 新建标签</button>
      </header>

      <section className="tag-stats">
        <article><span>标签总数</span><strong>{activeTags.length}</strong></article>
        <article><span>已使用</span><strong>{usedTags}</strong></article>
        <article><span>未使用</span><strong>{activeTags.length - usedTags}</strong></article>
        <article><span>有效关联</span><strong>{activeTags.reduce((sum, tag) => sum + tag.usageCount, 0)}</strong><small>{coveredAssets} 个标签有资源</small></article>
      </section>

      <section className="tag-manager-card">
        <div className="tag-manager-toolbar">
          <label><Search size={15} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索名称、分组或描述" /></label>
          <select value={groupFilter ?? ""} onChange={(event) => setGroupFilter(event.target.value ? Number(event.target.value) : undefined)}><option value="">全部分组</option>{catalog.groups.map((group) => <option key={group.id} value={group.id}>{group.name}（{group.tagCount}）</option>)}</select>
          <label className="archived-toggle"><input type="checkbox" checked={includeArchived} onChange={(event) => setIncludeArchived(event.target.checked)} /> 显示已归档</label>
          <button className="secondary-button compact" onClick={() => void addGroup()}><Plus size={13} /> 新建分组</button>
          {groupFilter && <button className="secondary-button compact" onClick={() => void renameGroup()}>重命名分组</button>}
          {groupFilter && <button className="secondary-button compact" onClick={() => void removeGroup()}>删除空分组</button>}
        </div>
        <div className="tag-table-head"><span>标签</span><span>分组</span><span>适用类型</span><span>文件数量</span><span>操作</span></div>
        <div className="tag-table-body">
          {visibleTags.map((tag) => (
            <article className={tag.archived ? "archived" : ""} key={tag.id}>
              <div className="tag-identity"><i style={{ background: tag.color }} /><span><strong>{tag.name}</strong><small>{tag.description || "暂无描述"}</small></span></div>
              <span>{tag.groupName}</span>
              <div className="tag-scope-list">{tag.scopes.length ? tag.scopes.map((scope) => <small key={scope}>{scope}</small>) : <small>全部类型</small>}</div>
              <strong>{tag.usageCount.toLocaleString("zh-CN")}</strong>
              <div className="tag-row-actions">
                <button onClick={() => beginEdit(tag)} title="编辑"><Edit3 size={14} /></button>
                <button onClick={() => void merge(tag)} title="合并"><Combine size={14} /></button>
                <button onClick={() => void toggleArchived(tag)} title={tag.archived ? "恢复" : "归档"}>{tag.archived ? <Undo2 size={14} /> : <Archive size={14} />}</button>
                <button className="danger" onClick={() => void remove(tag)} title="永久删除"><Trash2 size={14} /></button>
              </div>
            </article>
          ))}
          {visibleTags.length === 0 && <div className="tag-manager-empty">没有符合条件的标签</div>}
        </div>
      </section>

      {formOpen && (
        <div className="tag-picker-backdrop" onMouseDown={(event) => event.target === event.currentTarget && setFormOpen(false)}>
          <section className="tag-editor-dialog" role="dialog" aria-modal="true">
            <header><div><Tag size={18} /><strong>{editingId ? "编辑标签" : "新建标签"}</strong></div><button className="icon-button small" onClick={() => setFormOpen(false)}>×</button></header>
            <div className="tag-create-form">
              <label><span>名称</span><input autoFocus maxLength={40} value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} /></label>
              <TagGroupField groups={catalog.groups} value={form.groupId} onChange={(groupId) => setForm((current) => ({ ...current, groupId }))} onCreate={createGroupForForm} disabled={saving} />
              <label><span>颜色</span><input type="color" value={form.color} onChange={(event) => setForm({ ...form, color: event.target.value })} /></label>
              <label><span>描述</span><textarea rows={3} value={form.description} onChange={(event) => setForm({ ...form, description: event.target.value })} /></label>
              <fieldset><legend>适用类型（不选表示全部）</legend><div className="tag-scope-grid">{assetKinds.map((kind) => <label key={kind}><input type="checkbox" checked={form.scopes.includes(kind)} onChange={() => setForm({ ...form, scopes: form.scopes.includes(kind) ? form.scopes.filter((item) => item !== kind) : [...form.scopes, kind] })} /> {kind}</label>)}</div></fieldset>
              <div className="tag-form-actions"><button className="secondary-button" onClick={() => setFormOpen(false)}>取消</button><button className="primary-button" disabled={saving || !form.name.trim() || !form.groupId} onClick={() => void submit()}>{saving ? "保存中…" : "保存"}</button></div>
            </div>
          </section>
        </div>
      )}
    </main>
  );
}
