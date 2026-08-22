import { convertFileSrc } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import {
  ArrowLeft,
  Archive,
  ArchiveRestore,
  Box,
  CircleAlert,
  Copy,
  ExternalLink,
  File,
  Folder,
  FolderInput,
  FolderOpen,
  Image,
  Link2,
  MoreHorizontal,
  Music2,
  PencilLine,
  Plus,
  RefreshCw,
  Trash2,
  Video,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import {
  createProject,
  createProjectDirectory,
  listProjectAssets,
  listProjectDirectories,
  listProjects,
  moveProject,
  openProjectAsset,
  openProjectAssetFolder,
  openProjectFolder,
  relinkProject,
  removeAssetFromProject,
  renameProject,
  updateProjectAsset,
  type Project,
  type ProjectAsset,
  type ProjectDirectory,
  type ProjectStorageMode,
} from "../lib/projects";
import { enrichPendingPreviews } from "../lib/indexedAssets";
import { PackageTransferDialog } from "./PackageTransferDialog";
import { exportProjectArchive, importProjectArchive, type PackageProgress, type PackageSummary } from "../lib/portablePackages";

interface ProjectWorkspaceProps {
  query: string;
  onAction: (message: string) => void;
  onProjectsChanged: () => void;
}

interface TextDialogState {
  kind: "rename" | "directory";
  title: string;
  label: string;
  initialValue: string;
}

interface PackageDialogState {
  title: string;
  description: string;
  run: (onProgress: (progress: PackageProgress) => void, operationId: string) => Promise<PackageSummary>;
}

function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function formatDate(milliseconds: number) {
  return new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(milliseconds));
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

function kindIcon(kind: string) {
  if (kind === "图片" || kind === "动图") return <Image size={22} />;
  if (kind === "音频") return <Music2 size={22} />;
  if (kind === "视频") return <Video size={22} />;
  return <File size={22} />;
}

function CreateProjectDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (project: Project) => void }) {
  const [name, setName] = useState("");
  const [parentPath, setParentPath] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const chooseParent = async () => {
    const selected = await open({ directory: true, multiple: false, title: "选择项目所在位置" });
    if (typeof selected === "string") setParentPath(selected);
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!name.trim() || !parentPath || saving) return;
    setSaving(true);
    setError("");
    try {
      onCreated(await createProject(name, parentPath));
    } catch (reason) {
      setError(errorText(reason));
      setSaving(false);
    }
  };

  return (
    <div className="project-dialog-backdrop" onMouseDown={(event) => event.target === event.currentTarget && !saving && onClose()}>
      <section className="project-dialog" role="dialog" aria-modal="true" aria-label="新建项目">
        <header>
          <div><Box size={19} /><span><strong>新建项目</strong><small>创建项目文件夹和默认资源目录</small></span></div>
          <button className="icon-button small" disabled={saving} onClick={onClose} aria-label="关闭">×</button>
        </header>
        <form onSubmit={(event) => void submit(event)}>
          <label><span>项目名称</span><input autoFocus value={name} maxLength={100} disabled={saving} onChange={(event) => setName(event.target.value)} placeholder="例如：春季发布会" /></label>
          <label>
            <span>所在位置</span>
            <div className="project-path-input"><input value={parentPath} readOnly placeholder="选择父文件夹" /><button type="button" className="secondary-button" disabled={saving} onClick={() => void chooseParent()}><FolderOpen size={14} /> 选择</button></div>
          </label>
          <div className="project-final-path"><span>项目路径</span><strong>{parentPath && name.trim() ? `${parentPath}\\${name.trim()}` : "选择位置并输入名称后生成"}</strong></div>
          <p className="project-default-folders">创建后自动生成 image、audio、video、gif 文件夹。</p>
          {error && <p className="project-form-error">{error}</p>}
          <footer><button type="button" className="secondary-button" disabled={saving} onClick={onClose}>取消</button><button className="primary-button" disabled={saving || !name.trim() || !parentPath}>{saving ? "正在创建…" : "创建项目"}</button></footer>
        </form>
      </section>
    </div>
  );
}

function TextDialog({ state, onClose, onSubmit }: { state: TextDialogState; onClose: () => void; onSubmit: (value: string) => Promise<void> }) {
  const [value, setValue] = useState(state.initialValue);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!value.trim() || saving) return;
    setSaving(true);
    setError("");
    try {
      await onSubmit(value.trim());
      onClose();
    } catch (reason) {
      setError(errorText(reason));
      setSaving(false);
    }
  };
  return (
    <div className="project-dialog-backdrop" onMouseDown={(event) => event.target === event.currentTarget && !saving && onClose()}>
      <section className="project-dialog project-text-dialog" role="dialog" aria-modal="true" aria-label={state.title}>
        <header><div><PencilLine size={18} /><span><strong>{state.title}</strong></span></div><button className="icon-button small" onClick={onClose}>×</button></header>
        <form onSubmit={(event) => void submit(event)}>
          <label><span>{state.label}</span><input autoFocus value={value} maxLength={100} disabled={saving} onChange={(event) => setValue(event.target.value)} /></label>
          {error && <p className="project-form-error">{error}</p>}
          <footer><button type="button" className="secondary-button" disabled={saving} onClick={onClose}>取消</button><button className="primary-button" disabled={saving || !value.trim()}>{saving ? "正在保存…" : "保存"}</button></footer>
        </form>
      </section>
    </div>
  );
}

export function ProjectWorkspace({ query, onAction, onProjectsChanged }: ProjectWorkspaceProps) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [activeProjectId, setActiveProjectId] = useState<number>();
  const [directories, setDirectories] = useState<ProjectDirectory[]>([]);
  const [activeDirectory, setActiveDirectory] = useState<string>();
  const [assets, setAssets] = useState<ProjectAsset[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [textDialog, setTextDialog] = useState<TextDialogState>();
  const [packageDialog, setPackageDialog] = useState<PackageDialogState>();
  const activeProject = projects.find((project) => project.id === activeProjectId);

  const refreshProjects = useCallback(async () => {
    setLoading(true);
    try {
      setProjects(await listProjects(activeProjectId === undefined ? query : ""));
    } catch (error) {
      onAction(errorText(error));
    } finally {
      setLoading(false);
    }
  }, [activeProjectId, onAction, query]);

  const refreshProjectContent = useCallback(async (projectId: number, directory = activeDirectory) => {
    try {
      const [nextDirectories, nextAssets] = await Promise.all([
        listProjectDirectories(projectId),
        listProjectAssets(projectId, directory, query),
      ]);
      setDirectories(nextDirectories);
      setAssets(nextAssets);
    } catch (error) {
      onAction(errorText(error));
    }
  }, [activeDirectory, onAction, query]);

  useEffect(() => { void refreshProjects(); }, [refreshProjects]);
  useEffect(() => {
    if (activeProjectId !== undefined) void refreshProjectContent(activeProjectId);
  }, [activeProjectId, activeDirectory, query, refreshProjectContent]);
  useEffect(() => {
    if (activeProjectId === undefined) return;
    const timer = window.setInterval(() => void refreshProjectContent(activeProjectId), 4000);
    return () => window.clearInterval(timer);
  }, [activeProjectId, refreshProjectContent]);

  const handleCreate = (project: Project) => {
    setCreateOpen(false);
    setProjects((current) => [project, ...current]);
    setActiveProjectId(project.id);
    setActiveDirectory(undefined);
    onProjectsChanged();
    onAction(`项目“${project.name}”已创建`);
  };

  const mutateProject = async (operation: () => Promise<Project>, success: string) => {
    if (busy) return;
    setBusy(true);
    try {
      const project = await operation();
      setProjects((current) => current.map((item) => item.id === project.id ? project : item));
      onProjectsChanged();
      onAction(success);
    } catch (error) {
      onAction(errorText(error));
      throw error;
    } finally {
      setBusy(false);
    }
  };

  const chooseMoveLocation = async () => {
    if (!activeProject) return;
    const selected = await open({ directory: true, multiple: false, title: "选择新的项目所在位置" });
    if (typeof selected !== "string") return;
    try {
      await mutateProject(() => moveProject(activeProject.id, selected), "项目位置已调整");
    } catch {
      // mutateProject already surfaces the operation error in Caevir.
    }
  };

  const chooseRelinkLocation = async () => {
    if (!activeProject) return;
    const selected = await open({ directory: true, multiple: false, title: "重新定位项目文件夹" });
    if (typeof selected !== "string") return;
    try {
      await mutateProject(() => relinkProject(activeProject.id, selected), "项目已重新定位");
    } catch {
      // mutateProject already surfaces the operation error in Caevir.
    }
  };

  const updateAsset = async (asset: ProjectAsset, mode: ProjectStorageMode, directory: string) => {
    if (busy) return;
    if (asset.storageMode === "copy" && mode === "reference" && !window.confirm("切换为标记后，项目副本将移入回收站，资产库原文件不受影响。继续吗？")) return;
    setBusy(true);
    try {
      await updateProjectAsset(asset.membershipId, mode, directory);
      if (mode === "copy") void enrichPendingPreviews(() => void refreshProjectContent(asset.projectId, activeDirectory)).catch(() => undefined);
      await refreshProjectContent(asset.projectId, activeDirectory);
      await refreshProjects();
      onProjectsChanged();
      onAction("项目资源设置已更新");
    } catch (error) {
      onAction(errorText(error));
    } finally {
      setBusy(false);
    }
  };

  const removeAsset = async (asset: ProjectAsset) => {
    const message = asset.storageMode === "copy"
      ? "从项目移除后，项目副本将移入回收站，资产库原文件不受影响。继续吗？"
      : "确定从项目中移除这条标记吗？原文件不受影响。";
    if (!window.confirm(message)) return;
    setBusy(true);
    try {
      await removeAssetFromProject(asset.membershipId);
      await refreshProjectContent(asset.projectId, activeDirectory);
      await refreshProjects();
      onProjectsChanged();
      onAction("资源已从项目移除");
    } catch (error) {
      onAction(errorText(error));
    } finally {
      setBusy(false);
    }
  };

  const availableDirectories = useMemo(() => directories.filter((directory) => directory.exists), [directories]);

  const archiveProject = async () => {
    if (!activeProject) return;
    const selected = await save({
      title: "归档 Caevir 项目",
      defaultPath: `${activeProject.name}.caeproject`,
      filters: [{ name: "Caevir 项目归档", extensions: ["caeproject"] }],
    });
    if (!selected) return;
    const outputPath = selected.toLowerCase().endsWith(".caeproject") ? selected : `${selected}.caeproject`;
    setPackageDialog({
      title: `归档项目“${activeProject.name}”`,
      description: "正在收集项目副本与外部引用，归档不会依赖原机器绝对路径",
      run: (onProgress, operationId) => exportProjectArchive(activeProject.id, outputPath, onProgress, operationId),
    });
  };

  const importProject = async () => {
    const packagePath = await open({ title: "选择 Caevir 项目归档", multiple: false, directory: false, filters: [{ name: "Caevir 项目归档", extensions: ["caeproject"] }] });
    if (typeof packagePath !== "string") return;
    const destinationParent = await open({ title: "选择项目恢复位置", multiple: false, directory: true });
    if (typeof destinationParent !== "string") return;
    setPackageDialog({
      title: "导入项目归档",
      description: "将在所选位置恢复为独立、可用且不依赖原机器路径的项目",
      run: (onProgress, operationId) => importProjectArchive(packagePath, destinationParent, onProgress, operationId),
    });
  };

  if (activeProject) {
    return (
      <section className="project-workspace project-detail-workspace">
        <header className="project-detail-header">
          <button className="icon-button" onClick={() => { setActiveProjectId(undefined); setActiveDirectory(undefined); }} aria-label="返回项目列表"><ArrowLeft size={17} /></button>
          <div className="project-detail-title"><span className="project-icon"><Box size={20} /></span><div><h1>{activeProject.name}</h1><p title={activeProject.rootPath}>{activeProject.rootPath}</p></div></div>
          <span className={`project-status ${activeProject.status}`}>{activeProject.status === "ready" ? "正常" : activeProject.status === "missing" ? "文件夹缺失" : activeProject.status === "moving" ? "迁移中" : "操作失败"}</span>
          <div className="project-detail-actions">
            {activeProject.status === "missing" && <button className="secondary-button" disabled={busy} onClick={() => void chooseRelinkLocation()}><FolderInput size={14} /> 重新定位</button>}
            <button className="secondary-button" disabled={busy || activeProject.status !== "ready"} onClick={() => void openProjectFolder(activeProject.id).catch((error) => onAction(errorText(error)))}><FolderOpen size={14} /> 打开文件夹</button>
            <button className="secondary-button" disabled={busy || activeProject.status !== "ready"} onClick={() => setTextDialog({ kind: "rename", title: "重命名项目", label: "新项目名称", initialValue: activeProject.name })}><PencilLine size={14} /> 重命名</button>
            <button className="secondary-button" disabled={busy || activeProject.status !== "ready"} onClick={() => void chooseMoveLocation()}><FolderInput size={14} /> 调整位置</button>
            <button className="secondary-button" disabled={busy || activeProject.status !== "ready"} onClick={() => void archiveProject()} title="归档项目" aria-label="归档项目"><Archive size={14} /> 归档项目</button>
            <button className="icon-button" disabled={busy} onClick={() => { void refreshProjectContent(activeProject.id); void refreshProjects(); }} aria-label="刷新项目"><RefreshCw size={15} /></button>
          </div>
        </header>
        <div className="project-detail-body">
          <aside className="project-directory-panel">
            <header><strong>项目目录</strong><button className="icon-button small" disabled={busy || activeProject.status !== "ready"} onClick={() => setTextDialog({ kind: "directory", title: "新建子文件夹", label: "文件夹名称", initialValue: "" })} aria-label="新建子文件夹"><Plus size={15} /></button></header>
            <button className={activeDirectory === undefined ? "active" : ""} onClick={() => setActiveDirectory(undefined)}><Box size={15} /><span>全部资源</span><small>{activeProject.resourceCount}</small></button>
            {directories.map((directory) => (
              <button key={directory.relativePath || "root"} className={activeDirectory === directory.relativePath ? "active" : ""} style={{ paddingLeft: `${12 + directory.depth * 14}px` }} onClick={() => setActiveDirectory(directory.relativePath)} title={directory.exists ? directory.relativePath || "项目根目录" : "该目录在磁盘上已缺失"}>
                {directory.exists ? <Folder size={15} /> : <CircleAlert size={15} />}<span>{directory.name}</span>{directory.resourceCount > 0 && <small>{directory.resourceCount}</small>}
              </button>
            ))}
          </aside>
          <main className="project-assets-panel">
            <div className="project-assets-toolbar"><div><h2>{activeDirectory === undefined ? "全部资源" : activeDirectory || "项目根目录"}</h2><span>{assets.length} 个资源</span></div>{activeDirectory !== undefined && <button className="secondary-button compact" onClick={() => void openProjectFolder(activeProject.id, activeDirectory).catch((error) => onAction(errorText(error)))}><FolderOpen size={14} /> 打开当前目录</button>}</div>
            {assets.length === 0 ? (
              <div className="project-empty"><Box size={34} /><strong>当前范围没有项目资源</strong><span>在资产模块的资源明细中，将资源添加到这个项目。</span></div>
            ) : (
              <div className="project-asset-grid">
                {assets.map((asset) => (
                  <article className={`project-asset-card ${asset.status !== "ready" ? "unavailable" : ""}`} key={asset.membershipId}>
                    <button className="project-asset-preview" disabled={asset.status !== "ready"} onDoubleClick={() => void openProjectAsset(asset.membershipId).catch((error) => onAction(errorText(error)))}>
                      {asset.thumbnailPath ? <img src={convertFileSrc(asset.thumbnailPath)} alt="" /> : <span>{kindIcon(asset.kind)}</span>}
                      <i className={asset.storageMode}>{asset.storageMode === "copy" ? <Copy size={11} /> : <Link2 size={11} />}{asset.storageMode === "copy" ? "复制" : "标记"}</i>
                    </button>
                    <div className="project-asset-info"><strong title={asset.name}>{asset.name}</strong><span>{asset.format} · {formatBytes(asset.sizeBytes)}</span>{asset.status !== "ready" && <em>{asset.status === "copy_missing" ? "项目副本缺失" : "源文件缺失"}</em>}{asset.sourceChanged && <em>源文件有更新</em>}</div>
                    <div className="project-asset-controls">
                      <select value={asset.storageMode} disabled={busy} onChange={(event) => void updateAsset(asset, event.target.value as ProjectStorageMode, asset.relativeDirectory)} aria-label="存在方式"><option value="reference">标记</option><option value="copy">复制</option></select>
                      <select value={asset.relativeDirectory} disabled={busy} onChange={(event) => void updateAsset(asset, asset.storageMode, event.target.value)} aria-label="所属子目录">{availableDirectories.map((directory) => <option key={directory.relativePath || "root"} value={directory.relativePath}>{directory.relativePath || "项目根目录"}</option>)}</select>
                    </div>
                    <footer><button onClick={() => void openProjectAsset(asset.membershipId).catch((error) => onAction(errorText(error)))} disabled={asset.status !== "ready"} title="打开资源"><ExternalLink size={14} /></button><button onClick={() => void openProjectAssetFolder(asset.membershipId).catch((error) => onAction(errorText(error)))} disabled={asset.status !== "ready"} title="打开所在文件夹"><FolderOpen size={14} /></button><span /><button className="danger" onClick={() => void removeAsset(asset)} disabled={busy} title="从项目移除"><Trash2 size={14} /></button></footer>
                  </article>
                ))}
              </div>
            )}
          </main>
        </div>
        {textDialog && <TextDialog state={textDialog} onClose={() => setTextDialog(undefined)} onSubmit={async (value) => {
          if (textDialog.kind === "rename") {
            await mutateProject(() => renameProject(activeProject.id, value), "项目已重命名");
          } else {
            const next = await createProjectDirectory(activeProject.id, activeDirectory ?? "", value);
            setDirectories(next);
            onAction("项目子文件夹已创建");
          }
        }} />}
        {packageDialog && <PackageTransferDialog title={packageDialog.title} description={packageDialog.description} run={packageDialog.run} onClose={() => setPackageDialog(undefined)} onCompleted={() => onProjectsChanged()} />}
      </section>
    );
  }

  return (
    <section className="project-workspace">
      <header className="project-list-header"><div><h1>项目</h1><p>将同一工作使用的资源组织到项目文件夹中</p></div><button className="secondary-button" onClick={() => void importProject()}><ArchiveRestore size={15} /> 导入项目归档</button><button className="primary-button" onClick={() => setCreateOpen(true)}><Plus size={15} /> 新建项目</button></header>
      {loading ? <div className="project-empty"><RefreshCw className="spin" size={28} /><strong>正在加载项目…</strong></div> : projects.length === 0 ? (
        <div className="project-empty"><Box size={40} /><strong>{query ? "没有匹配的项目" : "还没有项目"}</strong><span>{query ? "请更换搜索内容" : "创建项目后，可通过标记或复制方式组织资产。"}</span>{!query && <button className="primary-button" onClick={() => setCreateOpen(true)}><Plus size={15} /> 创建第一个项目</button>}</div>
      ) : (
        <div className="project-list-grid">{projects.map((project) => (
          <article className="project-card" key={project.id} onDoubleClick={() => { setActiveProjectId(project.id); setActiveDirectory(undefined); }}>
            <header><span className="project-icon"><Box size={21} /></span><span className={`project-status ${project.status}`}>{project.status === "ready" ? "正常" : project.status === "missing" ? "缺失" : project.status === "moving" ? "迁移中" : "失败"}</span><button className="icon-button small" aria-label="项目操作" onClick={() => { setActiveProjectId(project.id); setActiveDirectory(undefined); }}><MoreHorizontal size={16} /></button></header>
            <button className="project-card-main" onClick={() => { setActiveProjectId(project.id); setActiveDirectory(undefined); }}><strong>{project.name}</strong><span title={project.rootPath}>{project.rootPath}</span></button>
            <div className="project-card-stats"><span><strong>{project.resourceCount}</strong>资源</span><span><strong>{project.referenceCount}</strong>标记</span><span><strong>{project.copyCount}</strong>复制</span></div>
            <footer><span>更新于 {formatDate(project.updatedAtMs)}</span><button onClick={() => void openProjectFolder(project.id).catch((error) => onAction(errorText(error)))} disabled={project.status !== "ready"}><FolderOpen size={13} /> 打开文件夹</button></footer>
          </article>
        ))}</div>
      )}
      {createOpen && <CreateProjectDialog onClose={() => setCreateOpen(false)} onCreated={handleCreate} />}
      {packageDialog && <PackageTransferDialog title={packageDialog.title} description={packageDialog.description} run={packageDialog.run} onClose={() => setPackageDialog(undefined)} onCompleted={(summary) => {
        void refreshProjects();
        if (summary.projectId !== undefined) setActiveProjectId(summary.projectId);
        onProjectsChanged();
        void enrichPendingPreviews(() => undefined).catch(() => undefined);
      }} />}
    </section>
  );
}
