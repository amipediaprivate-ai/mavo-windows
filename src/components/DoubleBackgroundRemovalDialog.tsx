import { open } from "@tauri-apps/plugin-dialog";
import { AlertTriangle, Check, FolderOpen, Image as ImageIcon, Sparkles, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import {
  discardDoubleBackgroundRemoval,
  loadDoubleBackgroundRemovalPreview,
  removeImageBackgroundByDoubleBackground,
  saveDoubleBackgroundRemoval,
  type BackgroundChangeScope,
  type DoubleBackgroundRemovalResult,
  type DoubleBackgroundSaveMode,
  type SaveDoubleBackgroundRemovalResult,
} from "../lib/doubleBackgroundRemoval";
import { loadOriginalAsset } from "../lib/desktopAssets";
import type { Asset } from "../types";

interface DoubleBackgroundRemovalDialogProps {
  asset: Asset;
  onClose: () => void;
  onSaved: (result: SaveDoubleBackgroundRemovalResult) => void;
}

type PreviewKind = "original" | "counterpart" | "result";
type ResultUrls = { counterpart: string; result: string };

function defaultStem(name: string) {
  const extensionIndex = name.lastIndexOf(".");
  const stem = extensionIndex > 0 ? name.slice(0, extensionIndex) : name;
  return `${stem}-去背景`;
}

function backgroundLabel(result: DoubleBackgroundRemovalResult) {
  if (result.detectedBackground === "black") return "黑色背景";
  if (result.detectedBackground === "white") return "白色背景";
  return "已有透明通道";
}

function counterpartLabel(result: DoubleBackgroundRemovalResult) {
  if (result.detectedBackground === "black") return "生成的白底图";
  if (result.detectedBackground === "white") return "生成的黑底图";
  return "白底检查图";
}

export function DoubleBackgroundRemovalDialog({ asset, onClose, onSaved }: DoubleBackgroundRemovalDialogProps) {
  const [originalUrl, setOriginalUrl] = useState("");
  const [result, setResult] = useState<DoubleBackgroundRemovalResult>();
  const [urls, setUrls] = useState<ResultUrls>({ counterpart: "", result: "" });
  const [preview, setPreview] = useState<PreviewKind>("original");
  const [previewBackground, setPreviewBackground] = useState("checker");
  const [customBackground, setCustomBackground] = useState("#37634d");
  const [backgroundScope, setBackgroundScope] = useState<BackgroundChangeScope>("all");
  const [backgroundTolerance, setBackgroundTolerance] = useState(18);
  const [softness, setSoftness] = useState(2);
  const [tolerance, setTolerance] = useState(70);
  const [edgeContrast, setEdgeContrast] = useState(53);
  const [postProcess, setPostProcess] = useState(true);
  const [erosion, setErosion] = useState(0);
  const [resultSignature, setResultSignature] = useState("");
  const [processing, setProcessing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [saveMode, setSaveMode] = useState<DoubleBackgroundSaveMode>("sourceDirectory");
  const [directory, setDirectory] = useState("");
  const [fileStem, setFileStem] = useState(() => defaultStem(asset.name));
  const resultRef = useRef<DoubleBackgroundRemovalResult | undefined>(undefined);
  const urlsRef = useRef<ResultUrls>({ counterpart: "", result: "" });
  const autoStartedRef = useRef(false);

  const busy = processing || saving;
  const settingsSignature = `${backgroundScope}:${backgroundTolerance}:${softness}:${tolerance}:${edgeContrast}:${postProcess}:${erosion}`;
  const stale = Boolean(result && settingsSignature !== resultSignature);
  const sourceExtension = asset.format.toUpperCase();

  useEffect(() => {
    let disposed = false;
    let url = "";
    void loadOriginalAsset(asset).then((loadedUrl) => {
      if (disposed) URL.revokeObjectURL(loadedUrl);
      else {
        url = loadedUrl;
        setOriginalUrl(loadedUrl);
      }
    }).catch((reason) => {
      if (!disposed) setError(reason instanceof Error ? reason.message : "无法加载原图");
    });
    return () => {
      disposed = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [asset]);

  useEffect(() => () => {
    if (urlsRef.current.counterpart) URL.revokeObjectURL(urlsRef.current.counterpart);
    if (urlsRef.current.result) URL.revokeObjectURL(urlsRef.current.result);
    if (resultRef.current) void discardDoubleBackgroundRemoval(asset, resultRef.current.jobId).catch(() => undefined);
  }, [asset]);

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy) onClose();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [busy, onClose]);

  const replaceResult = (nextResult?: DoubleBackgroundRemovalResult, nextUrls: ResultUrls = { counterpart: "", result: "" }) => {
    if (urlsRef.current.counterpart) URL.revokeObjectURL(urlsRef.current.counterpart);
    if (urlsRef.current.result) URL.revokeObjectURL(urlsRef.current.result);
    urlsRef.current = nextUrls;
    resultRef.current = nextResult;
    setUrls(nextUrls);
    setResult(nextResult);
  };

  const processImage = async () => {
    if (busy || !originalUrl) return;
    setProcessing(true);
    setError("");
    let created: DoubleBackgroundRemovalResult | undefined;
    let nextCounterpart = "";
    let nextResultUrl = "";
    try {
      const next = await removeImageBackgroundByDoubleBackground(asset, {
        backgroundScope,
        backgroundTolerance,
        softness,
        tolerance,
        edgeContrast,
        postProcess,
        erosion,
      });
      created = next;
      [nextCounterpart, nextResultUrl] = await Promise.all([
        loadDoubleBackgroundRemovalPreview(asset, next.jobId, "counterpart"),
        loadDoubleBackgroundRemovalPreview(asset, next.jobId, "result"),
      ]);
      const previous = resultRef.current;
      replaceResult(next, { counterpart: nextCounterpart, result: nextResultUrl });
      created = undefined;
      nextCounterpart = "";
      nextResultUrl = "";
      setResultSignature(settingsSignature);
      setPreview("result");
      if (previous) await discardDoubleBackgroundRemoval(asset, previous.jobId).catch(() => undefined);
    } catch (reason) {
      if (nextCounterpart) URL.revokeObjectURL(nextCounterpart);
      if (nextResultUrl) URL.revokeObjectURL(nextResultUrl);
      if (created) await discardDoubleBackgroundRemoval(asset, created.jobId).catch(() => undefined);
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setProcessing(false);
    }
  };

  useEffect(() => {
    if (!originalUrl || autoStartedRef.current) return;
    autoStartedRef.current = true;
    void processImage();
    // 首次加载原图后自动分析；参数变化只通过“重新处理”提交。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [originalUrl]);

  const chooseDirectory = async () => {
    const selected = await open({ title: "选择去背景结果保存文件夹", directory: true, multiple: false });
    if (typeof selected === "string") setDirectory(selected);
  };

  const save = async () => {
    if (!result || stale || busy) return;
    if (saveMode === "saveAs" && !directory) {
      setError("请先选择另存文件夹");
      return;
    }
    if (saveMode !== "overwrite" && !fileStem.trim()) {
      setError("请填写结果名称");
      return;
    }
    if (saveMode === "overwrite") {
      const conversion = sourceExtension === "PNG" ? "" : "\n原图将转换为同名 PNG，以保留透明通道。";
      if (!window.confirm(`确定用去背景结果覆盖「${asset.name}」吗？此操作不能撤销。${conversion}`)) return;
    }
    setSaving(true);
    setError("");
    try {
      const saved = await saveDoubleBackgroundRemoval(asset, {
        jobId: result.jobId,
        mode: saveMode,
        directory: saveMode === "saveAs" ? directory : undefined,
        fileStem: saveMode === "overwrite" ? undefined : fileStem.trim(),
      });
      resultRef.current = undefined;
      onSaved(saved);
      onClose();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSaving(false);
    }
  };

  const close = () => {
    if (!busy) onClose();
  };

  const previewUrl = preview === "original" ? originalUrl : preview === "counterpart" ? urls.counterpart : urls.result;
  const stageStyle = preview === "result" && previewBackground !== "checker"
    ? {
        backgroundColor: previewBackground === "custom" ? customBackground : previewBackground,
        backgroundImage: "none",
      }
    : undefined;

  return (
    <div className="background-removal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && close()}>
      <section className="background-removal-dialog double-background-removal-dialog" role="dialog" aria-modal="true" aria-labelledby="double-background-removal-title">
        <header>
          <div><span className="background-removal-icon double-background-removal-icon"><Sparkles size={18} /></span><span><strong id="double-background-removal-title">移除图片背景</strong><small>{asset.name}</small></span></div>
          <button type="button" className="asset-preview-close" disabled={busy} onClick={close} aria-label="关闭移除图片背景窗口"><X size={18} /></button>
        </header>

        <div className="background-removal-body">
          <div className="background-removal-stage double-background-removal-stage" style={stageStyle}>
            {previewUrl ? <img src={previewUrl} alt={preview === "original" ? asset.name : preview === "counterpart" ? "自动生成的配对图" : "透明去背结果"} /> : <span>{processing ? "正在识别背景并处理…" : "正在加载图片…"}</span>}
            <div className="double-background-preview-tabs">
              <button type="button" className={preview === "original" ? "active" : ""} onClick={() => setPreview("original")}>原图</button>
              <button type="button" className={preview === "counterpart" ? "active" : ""} disabled={!result || stale} onClick={() => setPreview("counterpart")}>{result ? counterpartLabel(result) : "配对图"}</button>
              <button type="button" className={preview === "result" ? "active" : ""} disabled={!result || stale} onClick={() => setPreview("result")}>透明结果</button>
            </div>
            <div className={`background-removal-status ${result && !stale ? "done" : processing ? "working" : ""}`}>
              {processing ? <><Sparkles size={14} /> 正在识别背景并生成透明结果…</> : result && stale ? "参数已更改，请重新处理" : result ? <><Check size={14} /> {backgroundLabel(result)} · 置信度 {Math.round(result.confidence * 100)}%</> : "原图预览"}
            </div>
          </div>

          <aside className="background-removal-controls double-background-removal-controls">
            {result && !stale && (
              <section className="double-background-analysis">
                <h3>识别结果</h3>
                <div><span>{backgroundLabel(result)}</span><strong>{Math.round(result.confidence * 100)}%</strong></div>
                <p>边缘背景匹配率 {Math.round(result.borderMatchRatio * 100)}% · {result.width} × {result.height}</p>
                {result.warnings.map((warning) => <p className="double-background-warning" key={warning}><AlertTriangle size={13} /> {warning}</p>)}
              </section>
            )}

            <section>
              <h3>配对图生成</h3>
              <div className="double-background-scope-options" role="radiogroup" aria-label="背景变更范围">
                <label className={backgroundScope === "edge" ? "selected" : ""}>
                  <input type="radio" name="background-change-scope" value="edge" checked={backgroundScope === "edge"} disabled={busy} onChange={() => setBackgroundScope("edge")} />
                  <span><strong>仅变更边缘背景</strong><small>只处理与图片边缘连通的背景区域。</small></span>
                </label>
                <label className={backgroundScope === "all" ? "selected" : ""}>
                  <input type="radio" name="background-change-scope" value="all" checked={backgroundScope === "all"} disabled={busy} onChange={() => setBackgroundScope("all")} />
                  <span><strong>全部背景变更</strong><small>处理全图中符合容差的背景，包括被线条包围的内部区域。</small></span>
                </label>
              </div>
              <div className="background-removal-sliders">
                <label><span>背景识别容差 <strong>{backgroundTolerance}</strong></span><input type="range" min="4" max="48" value={backgroundTolerance} disabled={busy} onChange={(event) => setBackgroundTolerance(Number(event.target.value))} /><small>越高越容易把近黑或近白像素识别为背景。</small></label>
                <label><span>蒙版柔化宽度 <strong>{softness} px</strong></span><input type="range" min="0" max="8" value={softness} disabled={busy} onChange={(event) => setSoftness(Number(event.target.value))} /><small>柔化已识别背景与前景之间的边界。</small></label>
              </div>
            </section>

            <section>
              <h3>双背景差分</h3>
              <div className="background-removal-sliders">
                <label><span>双背景容差 <strong>{tolerance}</strong></span><input type="range" min="50" max="100" value={tolerance} disabled={busy} onChange={(event) => setTolerance(Number(event.target.value))} /></label>
                <label><span>边缘对比 <strong>{edgeContrast}</strong></span><input type="range" min="50" max="100" value={edgeContrast} disabled={busy} onChange={(event) => setEdgeContrast(Number(event.target.value))} /></label>
                <label><span>边缘侵蚀 <strong>{erosion}</strong></span><input type="range" min="0" max="100" value={erosion} disabled={busy} onChange={(event) => setErosion(Number(event.target.value))} /></label>
              </div>
              <label className="background-removal-toggle"><input type="checkbox" checked={postProcess} disabled={busy} onChange={(event) => setPostProcess(event.target.checked)} /><span>清理低透明噪点和小连通块</span></label>
            </section>

            {result && !stale && (
              <section className="double-background-preview-background">
                <h3>透明结果检查背景</h3>
                <div>
                  <button type="button" className={previewBackground === "checker" ? "active" : ""} onClick={() => { setPreviewBackground("checker"); setPreview("result"); }}>棋盘格</button>
                  <button type="button" className={previewBackground === "black" ? "active" : ""} onClick={() => { setPreviewBackground("black"); setPreview("result"); }}>黑色</button>
                  <button type="button" className={previewBackground === "white" ? "active" : ""} onClick={() => { setPreviewBackground("white"); setPreview("result"); }}>白色</button>
                  <label className={previewBackground === "custom" ? "active" : ""}><input type="color" value={customBackground} onChange={(event) => { setCustomBackground(event.target.value); setPreviewBackground("custom"); setPreview("result"); }} /><span>自定义</span></label>
                </div>
              </section>
            )}

            {result && !stale && (
              <section className="background-removal-save">
                <h3>保存结果</h3>
                <div className="background-removal-save-modes">
                  <label><input type="radio" name="double-bg-save-mode" checked={saveMode === "saveAs"} disabled={busy} onChange={() => setSaveMode("saveAs")} /><span>另存为</span></label>
                  <label><input type="radio" name="double-bg-save-mode" checked={saveMode === "sourceDirectory"} disabled={busy} onChange={() => setSaveMode("sourceDirectory")} /><span>原图目录</span></label>
                  <label><input type="radio" name="double-bg-save-mode" checked={saveMode === "overwrite"} disabled={busy} onChange={() => setSaveMode("overwrite")} /><span>覆盖原图</span></label>
                </div>
                {saveMode === "saveAs" && <button type="button" className="background-removal-folder" disabled={busy} onClick={() => void chooseDirectory()}><FolderOpen size={14} /><span title={directory}>{directory || "选择文件夹"}</span></button>}
                {saveMode !== "overwrite" ? <label className="background-removal-name"><span>结果名称</span><div><input value={fileStem} maxLength={200} disabled={busy} onChange={(event) => setFileStem(event.target.value)} /><strong>.png</strong></div></label> : <p className="background-removal-overwrite-note">将替换原图。{sourceExtension === "PNG" ? "文件名保持不变。" : "为保留透明通道，文件会转换为同名 PNG。"}</p>}
              </section>
            )}

            {error && <div className="background-removal-error" role="alert">{error}</div>}
          </aside>
        </div>

        <footer>
          <span><ImageIcon size={13} /> {result && !stale ? "配对图和透明结果仅保存在临时缓存，保存前不会修改原图" : "仅支持纯黑或纯白背景；复杂背景请使用一键抠图"}</span>
          <div>
            <button type="button" className="secondary-button" disabled={busy} onClick={close}>取消</button>
            {result && !stale ? <><button type="button" className="secondary-button" disabled={busy} onClick={() => void processImage()}>重新处理</button><button type="button" className="primary-button" disabled={busy} onClick={() => void save()}>{saving ? "保存中…" : "保存结果"}</button></> : <button type="button" className="primary-button" disabled={busy || !originalUrl} onClick={() => void processImage()}>{processing ? "处理中…" : result ? "重新处理" : "开始处理"}</button>}
          </div>
        </footer>
      </section>
    </div>
  );
}
