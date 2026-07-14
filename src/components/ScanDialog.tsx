import { Channel, invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import {
  CheckCircle2,
  CircleAlert,
  FolderOpen,
  FolderSearch,
  Gauge,
  HardDrive,
  LoaderCircle,
  Rabbit,
  ShieldCheck,
  Snail,
  X,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { ScanScope, ScanSpeed } from "../types";

interface ScanRoot {
  path: string;
  label: string;
}

interface ScanEvent {
  eventType: "started" | "progress" | "assetsCommitted" | "finished" | "cancelled" | "failed";
  scanId: string;
  scannedCount: number;
  matchedCount: number;
  errorCount: number;
  currentPath?: string;
  elapsedMs: number;
  message?: string;
}

type ScanPhase = "config" | "starting" | "running" | "finished" | "cancelled" | "failed";

interface ScanDialogProps {
  scope: ScanScope;
  onClose: () => void;
  onFinished: (matchedCount: number) => void;
  onCancelled: (matchedCount: number) => void;
  onAssetsCommitted?: () => void;
}

const emptyEvent: ScanEvent = {
  eventType: "started",
  scanId: "",
  scannedCount: 0,
  matchedCount: 0,
  errorCount: 0,
  elapsedMs: 0,
};

function formatElapsed(milliseconds: number) {
  const seconds = Math.floor(milliseconds / 1000);
  const minutes = Math.floor(seconds / 60);
  return minutes > 0 ? `${minutes} 分 ${seconds % 60} 秒` : `${seconds} 秒`;
}

export function ScanDialog({ scope, onClose, onFinished, onCancelled, onAssetsCommitted }: ScanDialogProps) {
  const [speed, setSpeed] = useState<ScanSpeed>("slow");
  const [folder, setFolder] = useState("");
  const [roots, setRoots] = useState<ScanRoot[]>([]);
  const [phase, setPhase] = useState<ScanPhase>("config");
  const [scanId, setScanId] = useState("");
  const [scanEvent, setScanEvent] = useState<ScanEvent>(emptyEvent);
  const [error, setError] = useState("");

  const isActive = phase === "starting" || phase === "running";
  const title = scope === "computer" ? "扫描整个电脑" : "扫描指定文件夹";

  useEffect(() => {
    if (scope !== "computer") return;
    invoke<ScanRoot[]>("list_scan_roots")
      .then(setRoots)
      .catch(() => setRoots([]));
  }, [scope]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !isActive) onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [isActive, onClose]);

  const targetDescription = useMemo(() => {
    if (scope === "folder") return folder || "尚未选择文件夹";
    if (roots.length === 0) return "本机所有可用的固定磁盘";
    return roots.map((root) => root.path).join("、");
  }, [folder, roots, scope]);

  const chooseFolder = async () => {
    try {
      const selection = await open({
        title: "选择要扫描的文件夹",
        directory: true,
        multiple: false,
        recursive: true,
        defaultPath: folder || undefined,
      });
      if (typeof selection === "string") {
        setFolder(selection);
        setError("");
      }
    } catch (dialogError) {
      setError(dialogError instanceof Error ? dialogError.message : "无法打开文件夹选择器");
    }
  };

  const startScan = async () => {
    if (scope === "folder" && !folder.trim()) {
      setError("请先选择需要扫描的文件夹");
      return;
    }

    setError("");
    setPhase("starting");
    setScanEvent(emptyEvent);

    const onEvent = new Channel<ScanEvent>((event) => {
      setScanEvent(event);
      if (event.scanId) setScanId(event.scanId);
      if (event.eventType === "assetsCommitted") {
        onAssetsCommitted?.();
      } else if (event.eventType === "started" || event.eventType === "progress") {
        setPhase("running");
      } else if (event.eventType === "finished") {
        setPhase("finished");
        onFinished(event.matchedCount);
      } else if (event.eventType === "cancelled") {
        setPhase("cancelled");
        onCancelled(event.matchedCount);
      } else if (event.eventType === "failed") {
        setPhase("failed");
        setError(event.message || "扫描失败");
      }
    });

    try {
      const id = await invoke<string>("start_scan", {
        request: {
          scope,
          paths: scope === "folder" ? [folder.trim()] : [],
          speed,
        },
        onEvent,
      });
      setScanId(id);
    } catch (scanError) {
      setPhase("failed");
      setError(scanError instanceof Error ? scanError.message : String(scanError));
    }
  };

  const cancelScan = async () => {
    if (!scanId) return;
    try {
      await invoke("cancel_scan", { scanId });
    } catch (cancelError) {
      setError(cancelError instanceof Error ? cancelError.message : String(cancelError));
    }
  };

  const reset = () => {
    setPhase("config");
    setScanId("");
    setScanEvent(emptyEvent);
    setError("");
  };

  return (
    <div className="scan-dialog-backdrop" onMouseDown={(event) => {
      if (event.target === event.currentTarget && !isActive) onClose();
    }}>
      <section className="scan-dialog" role="dialog" aria-modal="true" aria-labelledby="scan-dialog-title">
        <header className="scan-dialog-header">
          <div className="scan-dialog-icon">
            {scope === "computer" ? <HardDrive size={20} /> : <FolderSearch size={20} />}
          </div>
          <div>
            <h2 id="scan-dialog-title">{title}</h2>
            <p>建立本地资源索引，不会修改或上传文件</p>
          </div>
          <button className="scan-dialog-close" onClick={onClose} disabled={isActive} aria-label="关闭扫描设置">
            <X size={17} />
          </button>
        </header>

        {phase === "config" ? (
          <div className="scan-dialog-body">
            <div className="scan-setting-group">
              <div className="scan-setting-label">
                <span>扫描位置</span>
                <small>{scope === "computer" ? "固定磁盘" : "指定目录"}</small>
              </div>
              {scope === "folder" ? (
                <div className="scan-folder-picker">
                  <FolderOpen size={16} />
                  <input
                    value={folder}
                    onChange={(event) => {
                      setFolder(event.target.value);
                      setError("");
                    }}
                    placeholder="选择文件夹或输入完整路径"
                    aria-label="扫描文件夹路径"
                  />
                  <button onClick={chooseFolder}>浏览…</button>
                </div>
              ) : (
                <div className="scan-drive-list">
                  {(roots.length ? roots : [{ path: "…", label: "正在读取本机磁盘" }]).map((root) => (
                    <div className="scan-drive-chip" key={root.path}>
                      <HardDrive size={14} />
                      <span>{root.label}</span>
                      <strong>{root.path}</strong>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="scan-setting-group">
              <div className="scan-setting-label">
                <span>扫描速度</span>
                <small>可在扫描前选择</small>
              </div>
              <div className="scan-speed-options" role="radiogroup" aria-label="扫描速度">
                <button
                  className={speed === "slow" ? "selected" : ""}
                  role="radio"
                  aria-checked={speed === "slow"}
                  onClick={() => setSpeed("slow")}
                >
                  <span className="scan-speed-icon slow"><Snail size={18} /></span>
                  <span>
                    <strong>缓慢</strong>
                    <small>后台低优先级 · 单线程 · 最小化系统影响</small>
                  </span>
                  <i />
                </button>
                <button
                  className={speed === "fast" ? "selected" : ""}
                  role="radio"
                  aria-checked={speed === "fast"}
                  onClick={() => setSpeed("fast")}
                >
                  <span className="scan-speed-icon fast"><Rabbit size={18} /></span>
                  <span>
                    <strong>高速</strong>
                    <small>最多 8 个遍历线程 · 更快完成扫描</small>
                  </span>
                  <i />
                </button>
              </div>
            </div>

            <div className="scan-impact-note">
              <ShieldCheck size={16} />
              <span>
                <strong>{speed === "slow" ? "低影响模式" : "高速模式"}</strong>
                {speed === "slow"
                  ? "扫描任务将使用 Windows 后台调度优先级，并主动让出 CPU 和磁盘 I/O。"
                  : "适合电脑空闲时使用，扫描期间磁盘活动可能明显增加。"}
              </span>
            </div>

            {error && <div className="scan-error"><CircleAlert size={14} /> {error}</div>}

            <footer className="scan-dialog-footer">
              <span className="scan-target-summary" title={targetDescription}>{targetDescription}</span>
              <button className="secondary-button" onClick={onClose}>取消</button>
              <button className="primary-button scan-start-button" onClick={startScan}>
                <Gauge size={15} /> 开始扫描
              </button>
            </footer>
          </div>
        ) : (
          <div className="scan-dialog-body scan-progress-body">
            <div className={`scan-progress-hero ${phase}`}>
              {isActive ? <LoaderCircle size={28} className="scan-spinner" /> : phase === "finished" ? <CheckCircle2 size={28} /> : <CircleAlert size={28} />}
              <div>
                <strong>
                  {phase === "starting" && "正在启动扫描…"}
                  {phase === "running" && "正在建立资源索引"}
                  {phase === "finished" && "扫描完成"}
                  {phase === "cancelled" && "扫描已取消"}
                  {phase === "failed" && "扫描失败"}
                </strong>
                <span>{scanEvent.message || (isActive ? `${speed === "slow" ? "低影响" : "高速"}模式正在运行` : error)}</span>
              </div>
            </div>

            {isActive && <div className="scan-progress-track"><span /></div>}

            <div className="scan-progress-stats">
              <div><span>已检查文件</span><strong>{scanEvent.scannedCount.toLocaleString("zh-CN")}</strong></div>
              <div><span>已发现资源</span><strong>{scanEvent.matchedCount.toLocaleString("zh-CN")}</strong></div>
              <div><span>访问错误</span><strong>{scanEvent.errorCount.toLocaleString("zh-CN")}</strong></div>
              <div><span>已用时间</span><strong>{formatElapsed(scanEvent.elapsedMs)}</strong></div>
            </div>

            <div className="scan-current-path">
              <span>当前位置</span>
              <strong title={scanEvent.currentPath || targetDescription}>{scanEvent.currentPath || targetDescription}</strong>
            </div>

            {error && <div className="scan-error"><CircleAlert size={14} /> {error}</div>}

            <footer className="scan-dialog-footer progress-footer">
              {isActive ? (
                <>
                  <span>可以取消，已写入的索引会保留</span>
                  <button className="secondary-button" onClick={cancelScan} disabled={!scanId}>取消扫描</button>
                </>
              ) : (
                <>
                  <button className="secondary-button" onClick={reset}>返回设置</button>
                  <button className="primary-button" onClick={onClose}>完成</button>
                </>
              )}
            </footer>
          </div>
        )}
      </section>
    </div>
  );
}
