import {
  Bell,
  ChevronDown,
  FolderSearch,
  HardDrive,
  Import,
  LibraryBig,
  Plus,
  RefreshCw,
  Search,
  Settings2,
  Sparkles,
  Trash2,
} from "lucide-react";
import type { SmartView } from "../lib/indexedAssets";
import type { ScanScope } from "../types";

interface AppHeaderProps {
  query: string;
  onQueryChange: (value: string) => void;
  activeModule: string;
  onModuleChange: (module: string) => void;
  onAction: (message: string) => void;
  onOpenScan: (scope: ScanScope) => void;
  onRefresh: () => void;
  smartViews: SmartView[];
  activeSmartViewId?: number;
  onSmartViewSelect: (viewId: number) => void;
  onDeleteSmartView: (viewId: number) => void;
}

const globalNav = ["资产", "收藏", "项目"];
const moduleNav = ["全部资源", "智能视图", "重复文件", "缺失文件"];

export function AppHeader({
  query,
  onQueryChange,
  activeModule,
  onModuleChange,
  onAction,
  onOpenScan,
  onRefresh,
  smartViews,
  activeSmartViewId,
  onSmartViewSelect,
  onDeleteSmartView,
}: AppHeaderProps) {
  return (
    <>
      <header className="topbar">
        <div className="brand" aria-label="Mavo 首页">
          <div className="brand-mark" aria-hidden="true">
            <span className="brand-orbit" />
            <span>M</span>
          </div>
          <div className="brand-copy">
            <strong>Mavo</strong>
            <span>管理每一项数字资产</span>
          </div>
        </div>

        <nav className="global-nav" aria-label="全局导航">
          {globalNav.map((item) => (
            <button key={item} className={item === "资产" ? "active" : ""} onClick={() => onAction(`${item}模块正在建设中`)}>
              {item}
            </button>
          ))}
        </nav>

        <label className="global-search">
          <Search size={16} />
          <input
            type="search"
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
            placeholder="搜索名称、标签或文件夹…"
            aria-label="搜索所有资源"
          />
          <span className="shortcut">Ctrl K</span>
        </label>

        <div className="top-actions">
          <button className="icon-button" aria-label="新建" title="新建" onClick={() => onAction("新建菜单已打开")}>
            <Plus size={18} />
          </button>
          <button className="icon-button" aria-label="通知" title="通知" onClick={() => onAction("暂无新通知")}>
            <Bell size={17} />
            <span className="notification-dot" />
          </button>
          <button className="icon-button" aria-label="设置" title="设置" onClick={() => onAction("设置面板正在建设中")}>
            <Settings2 size={17} />
          </button>
          <button className="profile-button" aria-label="用户菜单" onClick={() => onAction("用户菜单已打开")}>
            <span className="avatar">林</span>
            <ChevronDown size={14} />
          </button>
        </div>
      </header>

      <div className="module-bar">
        <nav className="module-nav" aria-label="资产模块导航">
          {moduleNav.map((item) => (
            <button
              key={item}
              className={activeModule === item ? "active" : ""}
              onClick={() => onModuleChange(item)}
            >
              {item === "智能视图" && <Sparkles size={14} />}
              {item}
            </button>
          ))}
        </nav>
        <div className="module-actions">
          {smartViews.length > 0 && (
            <div className="smart-view-picker">
              <select value={activeSmartViewId ?? ""} onChange={(event) => onSmartViewSelect(Number(event.target.value))} aria-label="选择智能视图">
                <option value="">智能视图…</option>
                {smartViews.map((view) => <option key={view.id} value={view.id}>{view.name}</option>)}
              </select>
              {activeSmartViewId !== undefined && (
                <button className="icon-button small" onClick={() => onDeleteSmartView(activeSmartViewId)} aria-label="删除当前智能视图" title="删除当前智能视图"><Trash2 size={13} /></button>
              )}
            </div>
          )}
          <button className="secondary-button compact" onClick={onRefresh}>
            <RefreshCw size={14} /> 刷新
          </button>
          <button className="secondary-button compact" onClick={() => onOpenScan("folder")}>
            <FolderSearch size={14} /> 扫描文件夹
          </button>
          <button className="secondary-button compact" onClick={() => onOpenScan("computer")}>
            <HardDrive size={14} /> 扫描电脑
          </button>
          <button className="primary-button compact" onClick={() => onAction("导入面板已打开")}>
            <Import size={14} /> 导入资源
          </button>
          <button className="library-switch" onClick={() => onAction("资源库切换器已打开")}>
            <LibraryBig size={14} /> 游戏美术资源库 <ChevronDown size={13} />
          </button>
        </div>
      </div>
    </>
  );
}
