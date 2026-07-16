import {
  ChevronRight,
  CircleDot,
  ExternalLink,
  FolderOpen,
  MoreHorizontal,
  PanelRightClose,
  PencilLine,
  Sparkles,
  Tag,
} from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import type { TagCatalog, TagInput } from "../lib/indexedAssets";
import type { Asset } from "../types";
import { assetAspectRatio } from "../lib/assetDimensions";
import { AudioDetailPlayer } from "./AudioPlayer";
import { AnimatedImagePlayer } from "./AnimatedImagePlayer";
import { AssetThumbnail } from "./AssetThumbnail";
import { VideoDetailPlayer } from "./VideoPlayer";
import { TagPicker } from "./TagPicker";

interface DetailPanelProps {
  asset?: Asset;
  onClose: () => void;
  onAction: (message: string) => void;
  onViewOriginal: (asset: Asset) => void;
  onOpenFolder: (asset: Asset) => void;
  onRelink: (asset: Asset) => void;
  onRename: (asset: Asset, newStem: string) => Promise<void>;
  onRemoveFromIndex: (asset: Asset) => void;
  tagCatalog?: TagCatalog;
  onSetTags: (asset: Asset, tagIds: number[]) => Promise<void>;
  onCreateTag: (input: TagInput) => Promise<number>;
  onCreateTagGroup: (name: string) => Promise<number>;
  onFilterTag: (tagId: number) => void;
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="detail-row">
      <span>{label}</span>
      <strong title={value}>{value}</strong>
    </div>
  );
}

function splitFileName(name: string) {
  const extensionIndex = name.lastIndexOf(".");
  return extensionIndex > 0 && extensionIndex < name.length - 1
    ? { stem: name.slice(0, extensionIndex), extension: name.slice(extensionIndex) }
    : { stem: name, extension: "" };
}

function AssetRenameDialog({ asset, onClose, onRename }: { asset: Asset; onClose: () => void; onRename: (asset: Asset, newStem: string) => Promise<void> }) {
  const current = splitFileName(asset.name);
  const [name, setName] = useState(current.stem);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !saving) onClose();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [onClose, saving]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const nextName = name.trim();
    if (!nextName || saving) return;
    setSaving(true);
    setError("");
    try {
      await onRename(asset, nextName);
      onClose();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="tag-picker-backdrop" onMouseDown={(event) => event.target === event.currentTarget && !saving && onClose()}>
      <section className="asset-rename-dialog" role="dialog" aria-modal="true" aria-label={`重命名 ${asset.name}`}>
        <header>
          <div><PencilLine size={18} /><span><strong>重命名资源</strong><small>将直接修改电脑上的文件名</small></span></div>
          <button className="icon-button small" disabled={saving} onClick={onClose} aria-label="关闭"><span aria-hidden="true">×</span></button>
        </header>
        <form className="asset-rename-form" onSubmit={(event) => void submit(event)}>
          <label>
            <span>新文件名</span>
            <div className="asset-rename-input">
              <input autoFocus value={name} maxLength={200} disabled={saving} onChange={(event) => setName(event.target.value)} />
              {current.extension && <strong>{current.extension}</strong>}
            </div>
          </label>
          <p>扩展名会保持不变。不能使用 <code>{'< > : " / \\ | ? *'}</code>，也不能与同一文件夹中的现有文件重名。</p>
          {error && <p className="asset-rename-error">{error}</p>}
          <footer>
            <button type="button" className="secondary-button" disabled={saving} onClick={onClose}>取消</button>
            <button type="submit" className="primary-button" disabled={saving || !name.trim() || name.trim() === current.stem}>{saving ? "正在重命名…" : "重命名文件"}</button>
          </footer>
        </form>
      </section>
    </div>
  );
}

export function DetailPanel({ asset, onClose, onAction, onViewOriginal, onOpenFolder, onRelink, onRename, onRemoveFromIndex, tagCatalog, onSetTags, onCreateTag, onCreateTagGroup, onFilterTag }: DetailPanelProps) {
  const [tagPickerOpen, setTagPickerOpen] = useState(false);
  const [renameOpen, setRenameOpen] = useState(false);
  return (
    <aside className="detail-panel">
      <div className="detail-heading">
        <strong>资源明细</strong>
        <button className="icon-button small" onClick={onClose} aria-label="收起资源明细" title="收起资源明细">
          <PanelRightClose size={16} />
        </button>
      </div>
      {!asset ? (
        <div className="empty-detail">请选择一个资源查看明细</div>
      ) : (
        <div className="detail-scroll">
          {asset.kind === "音频" ? (
            <AudioDetailPlayer asset={asset} />
          ) : asset.kind === "视频" ? (
            <VideoDetailPlayer asset={asset} />
          ) : (
            <div className="detail-preview" style={{ aspectRatio: assetAspectRatio(asset) }}>
              {asset.kind === "动图" ? (
                <AnimatedImagePlayer asset={asset} variant="detail" />
              ) : (
                <AssetThumbnail asset={asset} large />
              )}
              {asset.availability !== "missing" && (
                <button className="preview-expand" onClick={() => onViewOriginal(asset)} aria-label="查看原图" title="查看原图">
                  <ExternalLink size={14} />
                </button>
              )}
            </div>
          )}
          <div className="detail-title-row">
            <div>
              <h2>{asset.name}</h2>
              <p>{asset.format} · {asset.dimensions} · {asset.weight}</p>
            </div>
            {asset.id.startsWith("indexed-") && asset.availability !== "missing" && (
              <button className="icon-button small asset-rename-trigger" onClick={() => setRenameOpen(true)} aria-label="重命名文件" title="重命名电脑上的文件"><PencilLine size={14} /></button>
            )}
          </div>

          <div className="detail-actions">
            {asset.availability === "missing" ? (
              <button className="primary-button" onClick={() => onRelink(asset)}>重新定位文件</button>
            ) : asset.kind === "音频" || asset.kind === "视频" ? (
              <button className="primary-button" onClick={() => onOpenFolder(asset)}>打开所在文件夹</button>
            ) : (
              <button className="primary-button" onClick={() => onViewOriginal(asset)}>查看原图</button>
            )}
            <button className="icon-button" onClick={() => onAction("更多操作菜单已打开")} aria-label="更多操作"><MoreHorizontal size={17} /></button>
          </div>

          {asset.hasUpdate && (
            <button className="online-update" onClick={() => onAction("资源版本对比已打开")}>
              <span><Sparkles size={15} /> 在线资源有新版本</span>
              <ChevronRight size={15} />
            </button>
          )}

          <section className="detail-section">
            <h3><CircleDot size={14} /> 基础信息</h3>
            <DetailRow label="文件类型" value={asset.kind} />
            <DetailRow label="文件格式" value={asset.format} />
            <DetailRow label={asset.kind === "音频" ? "时长" : "尺寸 / 时长"} value={asset.dimensions} />
            <DetailRow label="文件大小" value={asset.weight} />
            <DetailRow label="导入时间" value={asset.importedAt} />
          </section>

          <section className="detail-section">
            <h3><FolderOpen size={14} /> 所属文件夹</h3>
            <button className="folder-link" onClick={() => asset.availability === "missing" ? onRelink(asset) : onOpenFolder(asset)} title={asset.availability === "missing" ? "重新定位文件" : `打开 ${asset.folder}`}>
              <span className="folder-icon"><FolderOpen size={15} /></span>
              <span><strong>{asset.folder}</strong><small>游戏美术资源库</small></span>
              <ChevronRight size={15} />
            </button>
            <button className="text-button" onClick={() => onAction("文件夹选择器已打开")}>＋ 添加到其他文件夹</button>
          </section>

          <section className="detail-section">
            <h3><Tag size={14} /> 标签</h3>
            <div className="tag-list">
              {asset.tagItems?.map((tag) => <button key={tag.id} style={{ borderColor: `${tag.color}66`, color: tag.color }} onClick={() => onFilterTag(tag.id)}><i style={{ background: tag.color }} />{tag.name}</button>)}
              {!asset.tagItems?.length && <span className="empty-tags">尚未填写标签</span>}
            </div>
            <button className="text-button" disabled={!asset.id.startsWith("indexed-") || !tagCatalog} onClick={() => setTagPickerOpen(true)}>＋ 添加或编辑标签</button>
          </section>

          <section className="detail-section compact-section">
            <DetailRow label="来源" value={asset.source} />
            <DetailRow label="状态" value={asset.availability === "missing" ? "文件缺失" : "可用"} />
            <DetailRow label="资源 ID" value={asset.id.toUpperCase()} />
          </section>
          {asset.availability === "missing" && (
            <section className="detail-section missing-actions">
              <h3>缺失文件处理</h3>
              <p>重新选择原文件可保留当前资产记录；清理只移除索引和缓存，不会删除磁盘文件。</p>
              <button className="secondary-button" onClick={() => onRelink(asset)}>重新定位</button>
              <button className="text-button danger" onClick={() => onRemoveFromIndex(asset)}>从索引清理</button>
            </section>
          )}
        </div>
      )}
      {asset && tagPickerOpen && tagCatalog && (
        <TagPicker
          asset={asset}
          catalog={tagCatalog}
          onClose={() => setTagPickerOpen(false)}
          onSave={(tagIds) => onSetTags(asset, tagIds)}
          onCreate={onCreateTag}
          onCreateGroup={onCreateTagGroup}
        />
      )}
      {asset && renameOpen && (
        <AssetRenameDialog asset={asset} onClose={() => setRenameOpen(false)} onRename={onRename} />
      )}
    </aside>
  );
}
