import { Archive, CheckCircle2, CircleAlert, LoaderCircle, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { cancelPackageOperation, type PackageProgress, type PackageSummary } from "../lib/portablePackages";

interface PackageTransferDialogProps {
  title: string;
  description: string;
  run: (onProgress: (progress: PackageProgress) => void, operationId: string) => Promise<PackageSummary>;
  onClose: () => void;
  onCompleted?: (summary: PackageSummary) => void;
}

export function PackageTransferDialog({ title, description, run, onClose, onCompleted }: PackageTransferDialogProps) {
  const started = useRef(false);
  const operationId = useRef(crypto.randomUUID());
  const [cancelling, setCancelling] = useState(false);
  const [progress, setProgress] = useState<PackageProgress>({ stage: "starting", completed: 0, total: 1, currentItem: "", message: "正在准备…" });
  const [summary, setSummary] = useState<PackageSummary>();
  const [error, setError] = useState("");

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void run(setProgress, operationId.current).then((result) => {
      setSummary(result);
      onCompleted?.(result);
    }).catch((reason) => setError(reason instanceof Error ? reason.message : String(reason)));
  }, [onCompleted, run]);

  const running = !summary && !error;
  const ratio = progress.total > 0 ? Math.min(progress.completed / progress.total, 1) : 0;
  return (
    <div className="package-dialog-backdrop">
      <section className="package-dialog" role="dialog" aria-modal="true" aria-label={title}>
        <header>
          <span className={`package-dialog-icon ${error ? "failed" : summary ? "completed" : ""}`}>
            {error ? <CircleAlert size={22} /> : summary ? <CheckCircle2 size={22} /> : <Archive size={22} />}
          </span>
          <div><h2>{title}</h2><p>{description}</p></div>
          <button className="icon-button" disabled={running} onClick={onClose} aria-label="关闭"><X size={16} /></button>
        </header>
        <div className="package-dialog-body">
          {running && <>
            <div className="package-progress-copy"><LoaderCircle className="spin" size={16} /><strong>{progress.message}</strong><span>{progress.total > 0 ? `${progress.completed} / ${progress.total}` : "处理中"}</span></div>
            <div className="package-progress-track"><i style={{ width: `${Math.max(3, ratio * 100)}%` }} /></div>
            {progress.currentItem && <code title={progress.currentItem}>{progress.currentItem}</code>}
            <p className="package-atomic-note">文件会先写入同目录 staging；校验与数据库事务完成前不会留下半导入结果。</p>
          </>}
          {error && <div className="package-error"><strong>操作失败，已回滚</strong><p>{error}</p></div>}
          {summary && <>
            <div className="package-summary-grid">
              <span><strong>{summary.succeeded}</strong>成功</span>
              <span><strong>{summary.reused}</strong>复用</span>
              <span><strong>{summary.skipped}</strong>跳过</span>
              <span><strong>{summary.conflicts}</strong>冲突</span>
              <span><strong>{summary.failed}</strong>失败</span>
              <span><strong>{summary.missing}</strong>缺失</span>
            </div>
            {(summary.projectPath || summary.packagePath) && <div className="package-result-path"><span>{summary.projectPath ? "恢复位置" : "包文件"}</span><code>{summary.projectPath ?? summary.packagePath}</code></div>}
            {summary.messages.length > 0 && <details><summary>查看冲突与提示（{summary.messages.length}）</summary><ul>{summary.messages.map((message, index) => <li key={`${index}-${message}`}>{message}</li>)}</ul></details>}
          </>}
        </div>
        <footer>
          {running && <button className="secondary-button" disabled={cancelling} onClick={() => {
            setCancelling(true);
            setProgress((current) => ({ ...current, message: "正在取消并回滚…" }));
            void cancelPackageOperation(operationId.current).catch(() => setCancelling(false));
          }}>{cancelling ? "正在取消…" : "取消"}</button>}
          <button className="primary-button" disabled={running} onClick={onClose}>{error ? "关闭" : "完成"}</button>
        </footer>
      </section>
    </div>
  );
}
