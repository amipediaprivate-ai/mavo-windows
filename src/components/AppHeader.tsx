import {
  Activity,
  Bell,
  CheckCircle2,
  ChevronDown,
  CircleAlert,
  Database,
  FolderSearch,
  HardDrive,
  Image,
  ImagePlay,
  Images,
  Import,
  LayoutGrid,
  LibraryBig,
  LoaderCircle,
  Music2,
  Plus,
  RefreshCw,
  Search,
  Settings2,
  Sparkles,
  Trash2,
  Video,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { BackgroundTask, SmartView } from "../lib/indexedAssets";
import type { ScanScope } from "../types";

interface AppHeaderProps {
  activeSection: "资产" | "工具";
  onSectionChange: (section: "资产" | "工具") => void;
  query: string;
  onQueryChange: (value: string) => void;
  activeModule: string;
  onModuleChange: (module: string) => void;
  categoryCounts: Partial<Record<string, number>>;
  onAction: (message: string) => void;
  onOpenScan: (scope: ScanScope) => void;
  onRefresh: () => void;
  smartViews: SmartView[];
  activeSmartViewId?: number;
  onSmartViewSelect: (viewId: number) => void;
  onDeleteSmartView: (viewId: number) => void;
  backgroundTasks: BackgroundTask[];
}

const globalNav = ["资产", "项目", "工具"] as const;
const categoryNav = [
  { label: "全部", icon: LayoutGrid },
  { label: "图片", icon: Images },
  { label: "动图", icon: ImagePlay },
  { label: "音频", icon: Music2 },
  { label: "视频", icon: Video },
];

const managementViews = ["智能视图", "标签管理", "重复文件", "缺失文件"];

export function AppHeader({
  activeSection,
  onSectionChange,
  query,
  onQueryChange,
  activeModule,
  onModuleChange,
  categoryCounts,
  onAction,
  onOpenScan,
  onRefresh,
  smartViews,
  activeSmartViewId,
  onSmartViewSelect,
  onDeleteSmartView,
  backgroundTasks,
}: AppHeaderProps) {
  const [tasksOpen, setTasksOpen] = useState(false);
  const tasksRef = useRef<HTMLDivElement>(null);
  const runningTasks = backgroundTasks.filter((task) => task.status === "running");
  const visibleTasks = useMemo(() => {
    const ordered = [...backgroundTasks].sort((left, right) => {
      const statusDifference = Number(right.status === "running") - Number(left.status === "running");
      return statusDifference || right.updatedAtMs - left.updatedAtMs;
    });
    return ordered.slice(0, 8);
  }, [backgroundTasks]);
  const knownProgress = runningTasks.filter((task) => task.total !== undefined && task.total > 0);
  const overallProgress = knownProgress.length
    ? knownProgress.reduce((sum, task) => sum + Math.min(task.completed / (task.total ?? 1), 1), 0) / knownProgress.length
    : runningTasks.length ? undefined : 1;

  useEffect(() => {
    if (!tasksOpen) return;
    const closePanel = (event: MouseEvent) => {
      if (!tasksRef.current?.contains(event.target as Node)) setTasksOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setTasksOpen(false);
    };
    document.addEventListener("mousedown", closePanel);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("mousedown", closePanel);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [tasksOpen]);

  const taskIcon = (task: BackgroundTask) => {
    if (task.status === "failed" || task.status === "cancelled") return <CircleAlert size={15} />;
    if (task.status === "completed") return <CheckCircle2 size={15} />;
    if (task.taskType === "index") return <Database size={15} />;
    if (task.taskType === "thumbnail") return <Image size={15} />;
    if (task.taskType === "loudness") return <Music2 size={15} />;
    return <Activity size={15} />;
  };

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
            <button
              key={item}
              className={item === activeSection ? "active" : ""}
              onClick={() => item === "项目" ? onAction("项目模块正在建设中") : onSectionChange(item)}
              aria-current={item === activeSection ? "page" : undefined}
            >
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
            placeholder={activeSection === "工具" ? "搜索工具…" : "搜索名称、标签或文件夹…"}
            aria-label={activeSection === "工具" ? "搜索工具" : "搜索所有资源"}
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

      {activeSection === "资产" && <div className="module-bar">
        <nav className="module-nav" aria-label="资产模块导航">
          <div className="asset-category-nav" aria-label="按媒体类型浏览">
            {categoryNav.map(({ label, icon: Icon }) => (
              <button
                key={label}
                className={activeModule === label ? "active" : ""}
                onClick={() => onModuleChange(label)}
                aria-current={activeModule === label ? "page" : undefined}
              >
                <Icon size={14} strokeWidth={1.8} />
                <span>{label}</span>
                {categoryCounts[label] !== undefined && (
                  <small>{categoryCounts[label]?.toLocaleString("zh-CN")}</small>
                )}
              </button>
            ))}
          </div>
          <label className={`management-view-select ${managementViews.includes(activeModule) ? "active" : ""}`}>
            <Sparkles size={13} />
            <select
              value={managementViews.includes(activeModule) ? activeModule : ""}
              onChange={(event) => event.target.value && onModuleChange(event.target.value)}
              aria-label="选择管理视图"
            >
              <option value="">管理视图</option>
              {managementViews.map((item) => <option value={item} key={item}>{item}</option>)}
            </select>
            <ChevronDown size={12} />
          </label>
          <div className="background-tasks" ref={tasksRef}>
            <button
              className={`background-task-trigger ${tasksOpen ? "open" : ""} ${runningTasks.length ? "running" : ""}`}
              onClick={() => setTasksOpen((open) => !open)}
              aria-expanded={tasksOpen}
              aria-haspopup="dialog"
            >
              <span className="task-trigger-icon">
                {runningTasks.length ? <LoaderCircle size={14} /> : <CheckCircle2 size={14} />}
              </span>
              后台任务
              {runningTasks.length > 0 && <strong>{runningTasks.length}</strong>}
            </button>
            {tasksOpen && (
              <section className="background-task-panel" role="dialog" aria-label="后台任务进度">
                <header>
                  <div>
                    <strong>后台任务</strong>
                    <span>{runningTasks.length ? `${runningTasks.length} 项正在进行` : "当前没有运行中的任务"}</span>
                  </div>
                  {runningTasks.length > 0 && overallProgress !== undefined && (
                    <b>{Math.round(overallProgress * 100)}%</b>
                  )}
                </header>
                <div className="background-task-list">
                  {visibleTasks.length === 0 ? (
                    <div className="background-task-empty">
                      <CheckCircle2 size={22} />
                      <strong>后台已就绪</strong>
                      <span>扫描、分析和缩略图任务会显示在这里</span>
                    </div>
                  ) : visibleTasks.map((task) => {
                    const progress = task.total === undefined
                      ? undefined
                      : task.total === 0
                        ? Number(task.status === "completed")
                        : Math.min(task.completed / task.total, 1);
                    const statusLabel = task.status === "running" ? "进行中" : task.status === "completed" ? "已完成" : task.status === "cancelled" ? "已取消" : "失败";
                    return (
                      <article className={`background-task-item ${task.status}`} key={task.id}>
                        <span className="background-task-icon">{taskIcon(task)}</span>
                        <div className="background-task-content">
                          <div className="background-task-title">
                            <strong>{task.title}</strong>
                            <span>{statusLabel}</span>
                          </div>
                          <p title={task.currentItem || task.message}>{task.currentItem || task.message}</p>
                          <div className={`background-task-track ${progress === undefined && task.status === "running" ? "indeterminate" : ""}`}>
                            <span style={progress === undefined ? undefined : { width: `${progress * 100}%` }} />
                          </div>
                          <div className="background-task-meta">
                            <span>{task.total !== undefined ? `${task.completed.toLocaleString("zh-CN")} / ${task.total.toLocaleString("zh-CN")}` : `已检查 ${task.completed.toLocaleString("zh-CN")} 项`}</span>
                            {progress !== undefined && <strong>{Math.round(progress * 100)}%</strong>}
                          </div>
                        </div>
                      </article>
                    );
                  })}
                </div>
              </section>
            )}
          </div>
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
      </div>}
    </>
  );
}
