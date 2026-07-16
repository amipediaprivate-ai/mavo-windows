import { Check, Plus, X } from "lucide-react";
import { useState, type FormEvent } from "react";
import type { TagGroup } from "../lib/indexedAssets";

interface TagGroupFieldProps {
  groups: TagGroup[];
  value: number;
  onChange: (groupId: number) => void;
  onCreate: (name: string) => Promise<number>;
  disabled?: boolean;
}

export function TagGroupField({ groups, value, onChange, onCreate, disabled = false }: TagGroupFieldProps) {
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const nextName = name.trim();
    if (!nextName || saving) return;
    setSaving(true);
    setError("");
    try {
      const groupId = await onCreate(nextName);
      onChange(groupId);
      setName("");
      setCreating(false);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="tag-group-field">
      <span>所属分组</span>
      <div className="tag-group-select-row">
        <select value={value || ""} disabled={disabled || saving} onChange={(event) => onChange(Number(event.target.value))}>
          {groups.length === 0 && <option value="">暂无分组，请先新建</option>}
          {groups.map((group) => <option key={group.id} value={group.id}>{group.name}</option>)}
        </select>
        <button type="button" className="secondary-button compact" disabled={disabled || saving} onClick={() => { setCreating(true); setError(""); }}>
          <Plus size={13} /> 新建分组
        </button>
      </div>
      {creating && (
        <form className="tag-group-create-row" onSubmit={(event) => void submit(event)}>
          <input autoFocus value={name} maxLength={24} disabled={saving} onChange={(event) => setName(event.target.value)} placeholder="输入新分组名称" aria-label="新分组名称" />
          <button type="submit" className="icon-button small confirm" disabled={saving || !name.trim()} aria-label="创建分组" title="创建分组"><Check size={14} /></button>
          <button type="button" className="icon-button small" disabled={saving} onClick={() => { setCreating(false); setName(""); setError(""); }} aria-label="取消创建分组" title="取消"><X size={14} /></button>
        </form>
      )}
      {error && <small className="tag-group-error">{error}</small>}
    </div>
  );
}
