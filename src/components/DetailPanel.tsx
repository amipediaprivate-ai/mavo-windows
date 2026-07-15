import {
  ChevronRight,
  CircleDot,
  ExternalLink,
  FolderOpen,
  Heart,
  MoreHorizontal,
  PanelRightClose,
  Sparkles,
  Tag,
} from "lucide-react";
import type { Asset } from "../types";
import { assetAspectRatio } from "../lib/assetDimensions";
import { AssetThumbnail } from "./AssetThumbnail";

interface DetailPanelProps {
  asset?: Asset;
  onClose: () => void;
  onAction: (message: string) => void;
  onViewOriginal: (asset: Asset) => void;
  onOpenFolder: (asset: Asset) => void;
  onRelink: (asset: Asset) => void;
  onRemoveFromIndex: (asset: Asset) => void;
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="detail-row">
      <span>{label}</span>
      <strong title={value}>{value}</strong>
    </div>
  );
}

export function DetailPanel({ asset, onClose, onAction, onViewOriginal, onOpenFolder, onRelink, onRemoveFromIndex }: DetailPanelProps) {
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
          <div className="detail-preview" style={{ aspectRatio: assetAspectRatio(asset) }}>
            <AssetThumbnail asset={asset} large />
            {asset.availability !== "missing" && (
              <button className="preview-expand" onClick={() => onViewOriginal(asset)} aria-label="查看原图" title="查看原图">
                <ExternalLink size={14} />
              </button>
            )}
          </div>
          <div className="detail-title-row">
            <div>
              <h2>{asset.name}</h2>
              <p>{asset.format} · {asset.dimensions} · {asset.weight}</p>
            </div>
            <button className={`icon-button small ${asset.favorite ? "favorite-active" : ""}`} aria-label="收藏">
              <Heart size={16} fill={asset.favorite ? "currentColor" : "none"} />
            </button>
          </div>

          <div className="detail-actions">
            {asset.availability === "missing" ? (
              <button className="primary-button" onClick={() => onRelink(asset)}>重新定位文件</button>
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
            <DetailRow label="尺寸 / 时长" value={asset.dimensions} />
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
              {asset.tags.map((tag) => <button key={tag} onClick={() => onAction(`已按「${tag}」筛选`)}>{tag}</button>)}
            </div>
            <button className="text-button" onClick={() => onAction("标签编辑器已打开")}>＋ 添加标签</button>
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
    </aside>
  );
}
