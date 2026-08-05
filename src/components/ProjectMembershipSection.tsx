import { Box, ChevronRight, Copy, FolderOpen, Link2, Plus, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { Asset } from "../types";
import { enrichPendingPreviews } from "../lib/indexedAssets";
import {
  addAssetToProjects,
  listAssetProjects,
  listProjectDirectories,
  listProjects,
  openProjectFolder,
  removeAssetFromProject,
  updateProjectAsset,
  type AssetProjectMembership,
  type Project,
  type ProjectAssetAssignment,
  type ProjectDirectory,
  type ProjectStorageMode,
} from "../lib/projects";

interface ProjectMembershipSectionProps {
  asset: Asset;
  revision: number;
  onAction: (message: string) => void;
  onChanged: () => void;
}

interface DraftAssignment {
  selected: boolean;
  storageMode: ProjectStorageMode;
  relativeDirectory: string;
}

function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function defaultDirectory(asset: Asset) {
  if (asset.kind === "图片") return "image";
  if (asset.kind === "音频") return "audio";
  if (asset.kind === "视频") return "video";
  if (asset.kind === "动图") return "gif";
  return "";
}

function MembershipEditor({
  membership,
  directories,
  disabled,
  onChange,
  onRemove,
  onOpen,
}: {
  membership: AssetProjectMembership;
  directories: ProjectDirectory[];
  disabled: boolean;
  onChange: (mode: ProjectStorageMode, directory: string) => void;
  onRemove: () => void;
  onOpen: () => void;
}) {
  return (
    <article className="asset-project-row">
      <button className="asset-project-link" onClick={onOpen} title={`打开 ${membership.projectRootPath}`}>
        <span className="project-mini-icon"><Box size={14} /></span>
        <span><strong>{membership.projectName}</strong><small>{membership.status === "ready" ? (membership.sourceChanged ? "源文件有更新" : "可用") : membership.status === "copy_missing" ? "项目副本缺失" : "源文件缺失"}</small></span>
        <ChevronRight size={14} />
      </button>
      <div className="asset-project-fields">
        <label><span>存在方式</span><select value={membership.storageMode} disabled={disabled} onChange={(event) => onChange(event.target.value as ProjectStorageMode, membership.relativeDirectory)}><option value="reference">标记</option><option value="copy">复制</option></select></label>
        <label><span>所属子目录</span><select value={membership.relativeDirectory} disabled={disabled} onChange={(event) => onChange(membership.storageMode, event.target.value)}>{directories.filter((directory) => directory.exists).map((directory) => <option key={directory.relativePath || "root"} value={directory.relativePath}>{directory.relativePath || "项目根目录"}</option>)}{!directories.some((directory) => directory.relativePath === membership.relativeDirectory) && <option value={membership.relativeDirectory}>{membership.relativeDirectory || "项目根目录"}</option>}</select></label>
        <button className="asset-project-remove" disabled={disabled} onClick={onRemove} title="从项目移除"><Trash2 size={13} /></button>
      </div>
    </article>
  );
}

function AddToProjectDialog({
  asset,
  projects,
  existingProjectIds,
  onClose,
  onSaved,
}: {
  asset: Asset;
  projects: Project[];
  existingProjectIds: Set<number>;
  onClose: () => void;
  onSaved: () => void;
}) {
  const availableProjects = projects.filter((project) => !existingProjectIds.has(project.id) && project.status === "ready");
  const [drafts, setDrafts] = useState<Record<number, DraftAssignment>>(() => Object.fromEntries(availableProjects.map((project) => [project.id, { selected: false, storageMode: "reference", relativeDirectory: defaultDirectory(asset) }])));
  const [directories, setDirectories] = useState<Record<number, ProjectDirectory[]>>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    void Promise.all(availableProjects.map(async (project) => [project.id, await listProjectDirectories(project.id)] as const))
      .then((items) => setDirectories(Object.fromEntries(items)))
      .catch((reason) => setError(errorText(reason)));
  }, []); // available project set is fixed for the lifetime of this dialog

  const selectedCount = Object.values(drafts).filter((draft) => draft.selected).length;
  const save = async () => {
    if (!asset.assetUid || saving || selectedCount === 0) return;
    setSaving(true);
    setError("");
    const assignments: ProjectAssetAssignment[] = Object.entries(drafts)
      .filter(([, draft]) => draft.selected)
      .map(([projectId, draft]) => ({ projectId: Number(projectId), storageMode: draft.storageMode, relativeDirectory: draft.relativeDirectory }));
    try {
      await addAssetToProjects(asset.assetUid, assignments);
      onSaved();
    } catch (reason) {
      setError(errorText(reason));
      setSaving(false);
    }
  };

  return (
    <div className="project-dialog-backdrop" onMouseDown={(event) => event.target === event.currentTarget && !saving && onClose()}>
      <section className="project-dialog asset-project-dialog" role="dialog" aria-modal="true" aria-label="添加到项目">
        <header><div><Box size={18} /><span><strong>添加到项目</strong><small>{asset.name}</small></span></div><button className="icon-button small" disabled={saving} onClick={onClose}>×</button></header>
        <div className="asset-project-dialog-body">
          {availableProjects.length === 0 ? <div className="asset-project-empty"><Box size={27} /><strong>没有可添加的项目</strong><span>该资源已属于全部可用项目，或尚未创建项目。</span></div> : availableProjects.map((project) => {
            const draft = drafts[project.id];
            const projectDirectories = directories[project.id] ?? [];
            return (
              <article className={draft.selected ? "selected" : ""} key={project.id}>
                <label className="asset-project-choice"><input type="checkbox" checked={draft.selected} disabled={saving} onChange={(event) => setDrafts((current) => ({ ...current, [project.id]: { ...current[project.id], selected: event.target.checked } }))} /><span><strong>{project.name}</strong><small>{project.rootPath}</small></span></label>
                <div className="asset-project-choice-fields">
                  <label><span>存在方式</span><select value={draft.storageMode} disabled={saving || !draft.selected} onChange={(event) => setDrafts((current) => ({ ...current, [project.id]: { ...current[project.id], storageMode: event.target.value as ProjectStorageMode } }))}><option value="reference">标记</option><option value="copy">复制</option></select></label>
                  <label><span>所属子目录</span><select value={draft.relativeDirectory} disabled={saving || !draft.selected} onChange={(event) => setDrafts((current) => ({ ...current, [project.id]: { ...current[project.id], relativeDirectory: event.target.value } }))}>{projectDirectories.filter((directory) => directory.exists).map((directory) => <option value={directory.relativePath} key={directory.relativePath || "root"}>{directory.relativePath || "项目根目录"}</option>)}</select></label>
                </div>
              </article>
            );
          })}
        </div>
        {error && <p className="project-form-error">{error}</p>}
        <footer><button className="secondary-button" disabled={saving} onClick={onClose}>取消</button><button className="primary-button" disabled={saving || selectedCount === 0} onClick={() => void save()}>{saving ? "正在添加…" : `添加到 ${selectedCount || "所选"} 个项目`}</button></footer>
      </section>
    </div>
  );
}

export function ProjectMembershipSection({ asset, revision, onAction, onChanged }: ProjectMembershipSectionProps) {
  const [memberships, setMemberships] = useState<AssetProjectMembership[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [directories, setDirectories] = useState<Record<number, ProjectDirectory[]>>({});
  const [loading, setLoading] = useState(false);
  const [busyId, setBusyId] = useState<number>();
  const [addOpen, setAddOpen] = useState(false);

  const refresh = async () => {
    if (!asset.assetUid) return;
    setLoading(true);
    try {
      const [nextMemberships, nextProjects] = await Promise.all([listAssetProjects(asset.assetUid), listProjects()]);
      setMemberships(nextMemberships);
      setProjects(nextProjects);
      const directoryItems = await Promise.all(nextMemberships.map(async (membership) => [membership.projectId, await listProjectDirectories(membership.projectId)] as const));
      setDirectories(Object.fromEntries(directoryItems));
    } catch (error) {
      onAction(errorText(error));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void refresh(); }, [asset.assetUid, revision]);

  const update = async (membership: AssetProjectMembership, mode: ProjectStorageMode, directory: string) => {
    if (membership.storageMode === "copy" && mode === "reference" && !window.confirm("切换为标记后，项目副本将移入回收站，资产库原文件不受影响。继续吗？")) return;
    setBusyId(membership.id);
    try {
      await updateProjectAsset(membership.id, mode, directory);
      if (mode === "copy") void enrichPendingPreviews(() => void refresh()).catch(() => undefined);
      await refresh();
      onChanged();
      onAction("所属项目设置已更新");
    } catch (error) {
      onAction(errorText(error));
    } finally {
      setBusyId(undefined);
    }
  };

  const remove = async (membership: AssetProjectMembership) => {
    const message = membership.storageMode === "copy" ? "移除后，项目副本将进入回收站。资产库原文件不受影响。继续吗？" : "确定从该项目中移除资源标记吗？";
    if (!window.confirm(message)) return;
    setBusyId(membership.id);
    try {
      await removeAssetFromProject(membership.id);
      await refresh();
      onChanged();
      onAction("资源已从项目移除");
    } catch (error) {
      onAction(errorText(error));
    } finally {
      setBusyId(undefined);
    }
  };

  const existingProjectIds = useMemo(() => new Set(memberships.map((membership) => membership.projectId)), [memberships]);

  return (
    <section className="detail-section asset-project-section">
      <h3><Box size={14} /> 所属项目</h3>
      {loading && memberships.length === 0 ? <span className="asset-project-loading">正在加载项目归属…</span> : memberships.length === 0 ? <span className="asset-project-loading">尚未添加到项目</span> : memberships.map((membership) => (
        <MembershipEditor key={membership.id} membership={membership} directories={directories[membership.projectId] ?? []} disabled={busyId === membership.id} onChange={(mode, directory) => void update(membership, mode, directory)} onRemove={() => void remove(membership)} onOpen={() => void openProjectFolder(membership.projectId).catch((error) => onAction(errorText(error)))} />
      ))}
      <button className="text-button" disabled={!asset.assetUid || loading} onClick={() => setAddOpen(true)}><Plus size={13} /> 添加到项目</button>
      <div className="asset-project-legend"><span><Link2 size={11} /> 标记不移动原文件</span><span><Copy size={11} /> 复制会创建项目副本</span><button onClick={() => asset.assetUid && void openProjectFolder(memberships[0]?.projectId).catch(() => undefined)} disabled={!memberships.length} title="打开首个所属项目"><FolderOpen size={12} /></button></div>
      {addOpen && <AddToProjectDialog asset={asset} projects={projects} existingProjectIds={existingProjectIds} onClose={() => setAddOpen(false)} onSaved={() => { setAddOpen(false); void refresh(); void enrichPendingPreviews(() => void refresh()).catch(() => undefined); onChanged(); onAction("资源已添加到项目"); }} />}
    </section>
  );
}
