import {
  ArrowLeftRight,
  ChevronRight,
  CircleDot,
  ExternalLink,
  FolderOpen,
  Gauge,
  MoreHorizontal,
  PanelRightClose,
  PencilLine,
  Scissors,
  Minimize2,
  FileAudio,
  Sparkles,
  Tag,
  Trash2,
  UserRound,
} from "lucide-react";
import { useEffect, useState, type FormEvent } from "react";
import { pinyin as convertToPinyin } from "pinyin-pro";
import {
  extractIndexedAssetAuthor,
  type AssetMetadata,
  type AssetMetadataInput,
  type TagCatalog,
  type TagInput,
} from "../lib/indexedAssets";
import type { Asset } from "../types";
import { assetAspectRatio } from "../lib/assetDimensions";
import { AudioDetailPlayer } from "./AudioPlayer";
import { AnimatedImagePlayer } from "./AnimatedImagePlayer";
import { AssetThumbnail } from "./AssetThumbnail";
import { VideoDetailPlayer } from "./VideoPlayer";
import { TagPicker } from "./TagPicker";
import { ProjectMembershipSection } from "./ProjectMembershipSection";
import { BackgroundRemovalDialog } from "./BackgroundRemovalDialog";
import { canRemoveImageBackground, type SaveBackgroundRemovalResult } from "../lib/backgroundRemoval";
import { DoubleBackgroundRemovalDialog } from "./DoubleBackgroundRemovalDialog";
import {
  canUseDoubleBackgroundRemoval,
  type SaveDoubleBackgroundRemovalResult,
} from "../lib/doubleBackgroundRemoval";
import { PngCompressionDialog } from "./PngCompressionDialog";
import { canCompressPng, type SavePngCompressionResult } from "../lib/pngCompression";

import { AudioProcessingDialog } from "./AudioProcessingDialog";
import {
  canConvertFsb,
  canUseStandardAudioTools,
  type AudioProcessingOperation,
  type SaveAudioProcessingResult,
} from "../lib/audioProcessing";
interface DetailPanelProps {
  asset?: Asset;
  onClose: () => void;
  onAction: (message: string) => void;
  onViewOriginal: (asset: Asset) => void;
  onOpenFolder: (asset: Asset) => void;
  onRelink: (asset: Asset) => void;
  onRename: (asset: Asset, newStem: string) => Promise<void>;
  onBackgroundRemoved: (asset: Asset, result: SaveBackgroundRemovalResult) => void;
  onDoubleBackgroundRemoved: (asset: Asset, result: SaveDoubleBackgroundRemovalResult) => void;
  onPngCompressed: (asset: Asset, result: SavePngCompressionResult) => void;
  onUpdateMetadata: (asset: Asset, input: AssetMetadataInput) => Promise<AssetMetadata>;
  onAudioProcessed: (asset: Asset, result: SaveAudioProcessingResult) => void;
  onMetadataResolved: (asset: Asset, metadata: AssetMetadata) => void;
  onRemoveFromIndex: (asset: Asset) => void;
  onDeleteAsset: (asset: Asset) => void;
  tagCatalog?: TagCatalog;
  onSetTags: (asset: Asset, tagIds: number[]) => Promise<void>;
  onCreateTag: (input: TagInput) => Promise<number>;
  onCreateTagGroup: (name: string) => Promise<number>;
  onFilterTag: (tagId: number) => void;
  projectRevision: number;
  onProjectsChanged: () => void;
}

function generatedPinyin(value: string) {
  const normalized = value.trim();
  return normalized ? convertToPinyin(normalized, { toneType: "none" }) : "";
}

function MetadataFields({ asset, onAction, onUpdate, onResolved }: {
  asset: Asset;
  onAction: (message: string) => void;
  onUpdate: (asset: Asset, input: AssetMetadataInput) => Promise<AssetMetadata>;
  onResolved: (asset: Asset, metadata: AssetMetadata) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [sourceMethod, setSourceMethod] = useState(asset.originalSourceMethod || asset.source);
  const [sourceUrl, setSourceUrl] = useState(asset.originalSourceUrl || "");
  const [author, setAuthor] = useState(asset.author || "");
  const [chineseName, setChineseName] = useState(asset.chineseName || "");
  const [pinyin, setPinyin] = useState(asset.pinyin || "");
  const [pinyinManuallyEdited, setPinyinManuallyEdited] = useState(
    Boolean(asset.pinyin && asset.pinyin !== generatedPinyin(asset.chineseName || "")),
  );
  const [aiPromptEnglish, setAiPromptEnglish] = useState(asset.aiPromptEnglish || "");
  const [aiPromptChinese, setAiPromptChinese] = useState(asset.aiPromptChinese || "");
  const [error, setError] = useState("");

  const unavailableAudioValue = asset.metadataStatus === "pending"
    ? "分析中…"
    : asset.metadataStatus === "unsupported"
      ? "无法分析"
      : "未提供";
  const sampleRate = asset.audioSampleRate === undefined
    ? unavailableAudioValue
    : `${(asset.audioSampleRate / 1000).toLocaleString("zh-CN", { maximumFractionDigits: 3 })} kHz`;
  const bitDepth = asset.audioBitDepth === undefined ? unavailableAudioValue : `${asset.audioBitDepth} 位`;
  const channels = asset.audioChannels === undefined
    ? unavailableAudioValue
    : asset.audioChannels === 1
      ? "1（单声道）"
      : asset.audioChannels === 2
        ? "2（立体声）"
        : `${asset.audioChannels} 声道`;
  const endianness = asset.audioEndianness === "little"
    ? "小端序（Little-endian）"
    : asset.audioEndianness === "big"
      ? "大端序（Big-endian）"
      : asset.audioEndianness === "not_applicable"
        ? "不适用"
        : asset.audioEndianness === "unknown"
          ? "未知"
          : unavailableAudioValue;

  useEffect(() => {
    if (editing) return;
    setSourceMethod(asset.originalSourceMethod || asset.source);
    setSourceUrl(asset.originalSourceUrl || "");
    setAuthor(asset.author || "");
    setChineseName(asset.chineseName || "");
    setPinyin(asset.pinyin || "");
    setPinyinManuallyEdited(Boolean(asset.pinyin && asset.pinyin !== generatedPinyin(asset.chineseName || "")));
    setAiPromptEnglish(asset.aiPromptEnglish || "");
    setAiPromptChinese(asset.aiPromptChinese || "");
  }, [asset.aiPromptChinese, asset.aiPromptEnglish, asset.author, asset.chineseName, asset.id, asset.originalSourceMethod, asset.originalSourceUrl, asset.pinyin, asset.source, editing]);

  useEffect(() => {
    if (!asset.id.startsWith("indexed-") || asset.authorStatus !== "pending") return;
    let cancelled = false;
    void extractIndexedAssetAuthor(asset)
      .then((metadata) => {
        if (!cancelled) onResolved(asset, metadata);
      })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, [asset, asset.authorStatus, asset.id, onResolved]);

  const cancel = () => {
    setEditing(false);
    setError("");
    setSourceMethod(asset.originalSourceMethod || asset.source);
    setSourceUrl(asset.originalSourceUrl || "");
    setAuthor(asset.author || "");
    setChineseName(asset.chineseName || "");
    setPinyin(asset.pinyin || "");
    setPinyinManuallyEdited(Boolean(asset.pinyin && asset.pinyin !== generatedPinyin(asset.chineseName || "")));
    setAiPromptEnglish(asset.aiPromptEnglish || "");
    setAiPromptChinese(asset.aiPromptChinese || "");
  };

  const updateChineseName = (value: string) => {
    setChineseName(value);
    if (!pinyinManuallyEdited) setPinyin(generatedPinyin(value));
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const method = sourceMethod.trim();
    const url = sourceUrl.trim();
    if (!method) {
      setError("请填写原始来源方式");
      return;
    }
    if (url) {
      try {
        const parsed = new URL(url);
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error();
      } catch {
        setError("请输入有效的 http 或 https 网址");
        return;
      }
    }
    setSaving(true);
    setError("");
    try {
      const metadata = await onUpdate(asset, {
        originalSourceMethod: method,
        originalSourceUrl: url,
        author: author.trim(),
        chineseName: chineseName.trim(),
        pinyin: pinyin.trim(),
        aiPromptEnglish: aiPromptEnglish.trim(),
        aiPromptChinese: aiPromptChinese.trim(),
      });
      onResolved(asset, metadata);
      setEditing(false);
      onAction("资源来源信息已保存");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSaving(false);
    }
  };

  return (
    <form className="asset-metadata-form" onSubmit={(event) => void submit(event)}>
      <section className="detail-section asset-metadata-section">
        <div className="detail-section-heading">
          <h3><CircleDot size={14} /> 基础信息</h3>
          {!editing && asset.id.startsWith("indexed-") && <button type="button" onClick={() => setEditing(true)}><PencilLine size={12} /> 编辑</button>}
        </div>
        <DetailRow label="文件类型" value={asset.kind} />
        <DetailRow label="文件格式" value={asset.format} />
        <DetailRow label={asset.kind === "音频" ? "时长" : "尺寸 / 时长"} value={asset.dimensions} />
        <DetailRow label="文件大小" value={asset.weight} />
        <DetailRow label="导入时间" value={asset.importedAt} />
        {editing ? (
          <div className="asset-metadata-editor">
            <label><span>原始来源方式</span><input value={sourceMethod} maxLength={100} disabled={saving} onChange={(event) => setSourceMethod(event.target.value)} placeholder="例如：官网、供应商、同事分享" /></label>
            <label><span>原始来源地址</span><input type="url" value={sourceUrl} maxLength={2048} disabled={saving} onChange={(event) => setSourceUrl(event.target.value)} placeholder="https://（可留空）" /></label>
          </div>
        ) : (
          <>
            <DetailRow label="原始来源方式" value={asset.originalSourceMethod || asset.source} />
            <div className="detail-row"><span>原始来源地址</span>{asset.originalSourceUrl ? <a href={asset.originalSourceUrl} target="_blank" rel="noreferrer" title={asset.originalSourceUrl}>{asset.originalSourceUrl}</a> : <strong className="empty-detail-value">未填写</strong>}</div>
          </>
        )}
      </section>

      <details className="asset-more-info" open={editing || undefined}>
        <summary><span><UserRound size={14} /> 更多信息</span><ChevronRight size={14} /></summary>
        <div className="asset-more-info-content">
          {editing ? <label><span>作者</span><input value={author} maxLength={200} disabled={saving} onChange={(event) => setAuthor(event.target.value)} placeholder="未获取到时可手动填写" /></label> : <DetailRow label="作者" value={asset.author || "未填写"} />}
          {editing ? (
            <>
              <label><span>中文名</span><input value={chineseName} maxLength={200} disabled={saving} onChange={(event) => updateChineseName(event.target.value)} placeholder="填写中文名称后自动生成拼音" /></label>
              <label><span>拼音</span><input value={pinyin} maxLength={500} disabled={saving} onChange={(event) => { setPinyin(event.target.value); setPinyinManuallyEdited(true); }} placeholder="由中文名自动生成，也可手动修改" /></label>
              <label><span>AI提示词-英文</span><textarea rows={5} value={aiPromptEnglish} maxLength={20000} disabled={saving} onChange={(event) => setAiPromptEnglish(event.target.value)} placeholder="输入英文 AI 提示词" /></label>
              <label><span>AI提示词-中文</span><textarea rows={5} value={aiPromptChinese} maxLength={20000} disabled={saving} onChange={(event) => setAiPromptChinese(event.target.value)} placeholder="输入中文 AI 提示词" /></label>
            </>
          ) : (
            <>
              <DetailRow label="中文名" value={asset.chineseName || "未填写"} />
              <DetailRow label="拼音" value={asset.pinyin || "未填写"} />
              <LongDetailRow label="AI提示词-英文" value={asset.aiPromptEnglish || "未填写"} />
              <LongDetailRow label="AI提示词-中文" value={asset.aiPromptChinese || "未填写"} />
            </>
          )}
          {!editing && asset.authorStatus === "pending" && <small>正在尝试从文件元数据获取作者…</small>}
          {asset.kind === "音频" && (
            <>
              <DetailRow label="采样率" value={sampleRate} />
              <DetailRow label="位深度" value={bitDepth} />
              <DetailRow label="声道" value={channels} />
              <DetailRow label="编码格式" value={asset.audioCodec || unavailableAudioValue} />
              <DetailRow label="字节序" value={endianness} />
              <DetailRow label="帧大小" value={asset.audioFrameSize === undefined ? unavailableAudioValue : `${asset.audioFrameSize} 字节/帧`} />
            </>
          )}
        </div>
      </details>

      {editing && (
        <div className="asset-metadata-actions">
          {error && <p>{error}</p>}
          <div><button type="button" disabled={saving} onClick={cancel}>取消</button><button type="submit" disabled={saving || !sourceMethod.trim()}>{saving ? "保存中…" : "保存"}</button></div>
        </div>
      )}
    </form>
  );
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="detail-row">
      <span>{label}</span>
      <strong title={value}>{value}</strong>
    </div>
  );
}

function LongDetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="detail-long-row">
      <span>{label}</span>
      <p className={value === "未填写" ? "empty-detail-value" : undefined}>{value}</p>
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

export function DetailPanel({ asset, onClose, onAction, onViewOriginal, onOpenFolder, onRelink, onRename, onBackgroundRemoved, onDoubleBackgroundRemoved, onPngCompressed, onAudioProcessed, onUpdateMetadata, onMetadataResolved, onRemoveFromIndex, onDeleteAsset, tagCatalog, onSetTags, onCreateTag, onCreateTagGroup, onFilterTag, projectRevision, onProjectsChanged }: DetailPanelProps) {
  const [tagPickerOpen, setTagPickerOpen] = useState(false);
  const [renameOpen, setRenameOpen] = useState(false);
  const [backgroundRemovalOpen, setBackgroundRemovalOpen] = useState(false);
  const [doubleBackgroundRemovalOpen, setDoubleBackgroundRemovalOpen] = useState(false);
  const [pngCompressionOpen, setPngCompressionOpen] = useState(false);
  const [audioProcessingOperation, setAudioProcessingOperation] = useState<AudioProcessingOperation>();
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

          <div className={`detail-actions ${canConvertFsb(asset) ? "with-audio-tools fsb-only" : canUseStandardAudioTools(asset) ? "with-audio-tools" : canUseDoubleBackgroundRemoval(asset) ? `with-image-tools ${canCompressPng(asset) ? "with-three-image-tools" : ""}` : canCompressPng(asset) ? "with-image-tools" : canRemoveImageBackground(asset) ? "with-background-removal" : ""}`}>
            {asset.availability === "missing" ? (
              <button className="primary-button" onClick={() => onRelink(asset)}>重新定位文件</button>
            ) : asset.kind === "音频" || asset.kind === "视频" ? (
              <button className="primary-button" onClick={() => onOpenFolder(asset)}>打开所在文件夹</button>
            ) : (
              <button className="primary-button" onClick={() => onViewOriginal(asset)}>查看原图</button>
            )}
            {canRemoveImageBackground(asset) && <button className="secondary-button background-removal-trigger" onClick={() => setBackgroundRemovalOpen(true)}><Scissors size={14} /> 一键抠图</button>}
            {canUseDoubleBackgroundRemoval(asset) && <button className="secondary-button double-background-removal-trigger" onClick={() => setDoubleBackgroundRemovalOpen(true)}><Sparkles size={14} /> 移除图片背景</button>}
            {canCompressPng(asset) && <button className="secondary-button png-compression-trigger" onClick={() => setPngCompressionOpen(true)}><Minimize2 size={14} /> 一键压缩</button>}
            {canConvertFsb(asset) && <button className="secondary-button audio-tool-trigger" onClick={() => setAudioProcessingOperation("fsbToWav")}><FileAudio size={14} /> FSB 转 WAV</button>}
            {canUseStandardAudioTools(asset) && <button className="secondary-button audio-tool-trigger" onClick={() => setAudioProcessingOperation("formatConversion")}><ArrowLeftRight size={14} /> 格式转换</button>}
            {canUseStandardAudioTools(asset) && <button className="secondary-button audio-tool-trigger" onClick={() => setAudioProcessingOperation("compression")}><Gauge size={14} /> 音频压缩</button>}
            <button className="icon-button" onClick={() => onAction("更多操作菜单已打开")} aria-label="更多操作"><MoreHorizontal size={17} /></button>
          </div>

          {asset.hasUpdate && (
            <button className="online-update" onClick={() => onAction("资源版本对比已打开")}>
              <span><Sparkles size={15} /> 在线资源有新版本</span>
              <ChevronRight size={15} />
            </button>
          )}

          <MetadataFields asset={asset} onAction={onAction} onUpdate={onUpdateMetadata} onResolved={onMetadataResolved} />

          <section className="detail-section">
            <h3><FolderOpen size={14} /> 所属文件夹</h3>
            <button className="folder-link" onClick={() => asset.availability === "missing" ? onRelink(asset) : onOpenFolder(asset)} title={asset.availability === "missing" ? "重新定位文件" : `打开 ${asset.folder}`}>
              <span className="folder-icon"><FolderOpen size={15} /></span>
              <span><strong>{asset.folder}</strong><small>游戏美术资源库</small></span>
              <ChevronRight size={15} />
            </button>
            <button className="text-button" onClick={() => onAction("文件夹选择器已打开")}>＋ 添加到其他文件夹</button>
          </section>

          {asset.id.startsWith("indexed-") && asset.assetUid && (
            <ProjectMembershipSection asset={asset} revision={projectRevision} onAction={onAction} onChanged={onProjectsChanged} />
          )}

          <section className="detail-section">
            <h3><Tag size={14} /> 标签</h3>
            <div className="tag-list">
              {asset.tagItems?.map((tag) => <button key={tag.id} style={{ borderColor: `${tag.color}66`, color: tag.color }} onClick={() => onFilterTag(tag.id)}><i style={{ background: tag.color }} />{tag.name}</button>)}
              {!asset.tagItems?.length && <span className="empty-tags">尚未填写标签</span>}
            </div>
            <button className="text-button" disabled={!asset.id.startsWith("indexed-") || !tagCatalog} onClick={() => setTagPickerOpen(true)}>＋ 添加或编辑标签</button>
          </section>

          <section className="detail-section compact-section">
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
          {asset.id.startsWith("indexed-") && (
            <section className="detail-section asset-delete-section">
              <h3><Trash2 size={14} /> 删除资源</h3>
              <p>删除软件内的资源信息，并将原文件及项目副本移入系统回收站。</p>
              <button className="asset-delete-button" onClick={() => onDeleteAsset(asset)}><Trash2 size={14} /> 删除资源</button>
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
      {asset && backgroundRemovalOpen && (
        <BackgroundRemovalDialog
          key={asset.id}
          asset={asset}
          onClose={() => setBackgroundRemovalOpen(false)}
          onSaved={(result) => onBackgroundRemoved(asset, result)}
        />
      )}
      {asset && pngCompressionOpen && (
        <PngCompressionDialog
          key={asset.id}
          asset={asset}
          onClose={() => setPngCompressionOpen(false)}
          onSaved={(result) => onPngCompressed(asset, result)}
        />
      )}
      {asset && doubleBackgroundRemovalOpen && (
        <DoubleBackgroundRemovalDialog
          key={asset.id}
          asset={asset}
          onClose={() => setDoubleBackgroundRemovalOpen(false)}
          onSaved={(result) => onDoubleBackgroundRemoved(asset, result)}
        />
      )}
      {asset && audioProcessingOperation && (
        <AudioProcessingDialog
          key={`${asset.id}-${audioProcessingOperation}`}
          asset={asset}
          operation={audioProcessingOperation}
          onClose={() => setAudioProcessingOperation(undefined)}
          onSaved={(result) => onAudioProcessed(asset, result)}
        />
      )}
    </aside>
  );
}
