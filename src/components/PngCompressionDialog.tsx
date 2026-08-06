import { open } from "@tauri-apps/plugin-dialog";
import { Check, FolderOpen, Layers3, Minimize2, ShieldCheck, Sparkles, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  compressPng,
  discardPngCompression,
  loadPngCompressionPreview,
  savePngCompression,
  type PngCompressionResult,
  type PngCompressionSaveMode,
  type SavePngCompressionResult,
} from "../lib/pngCompression";
import { loadOriginalAsset } from "../lib/desktopAssets";
import type { Asset } from "../types";

interface PngCompressionDialogProps {
  asset: Asset;
  onClose: () => void;
  onSaved: (result: SavePngCompressionResult) => void;
}

function defaultStem(name: string) {
  const extensionIndex = name.lastIndexOf(".");
  const stem = extensionIndex > 0 ? name.slice(0, extensionIndex) : name;
  return `${stem}-压缩`;
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

export function PngCompressionDialog({ asset, onClose, onSaved }: PngCompressionDialogProps) {
  const [originalUrl, setOriginalUrl] = useState("");
  const [resultUrl, setResultUrl] = useState("");
  const [result, setResult] = useState<PngCompressionResult>();
  const [usePngquant, setUsePngquant] = useState(true);
  const [useOxipng, setUseOxipng] = useState(true);
  const [preservePixels, setPreservePixels] = useState(false);
  const [lossyStrength, setLossyStrength] = useState(55);
  const [losslessLevel, setLosslessLevel] = useState(4);
  const [resultSignature, setResultSignature] = useState("");
  const [processing, setProcessing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [saveMode, setSaveMode] = useState<PngCompressionSaveMode>("sourceDirectory");
  const [directory, setDirectory] = useState("");
  const [fileStem, setFileStem] = useState(() => defaultStem(asset.name));
  const resultRef = useRef<PngCompressionResult | undefined>(undefined);
  const resultUrlRef = useRef("");

  const busy = processing || saving;
  const hasTechnique = usePngquant || useOxipng;
  const settingsSignature = `${usePngquant}:${useOxipng}:${preservePixels}:${lossyStrength}:${losslessLevel}`;
  const stale = Boolean(result && resultSignature !== settingsSignature);
  const savings = useMemo(() => {
    if (!result || result.originalBytes <= 0) return 0;
    return Math.max(0, (1 - result.resultBytes / result.originalBytes) * 100);
  }, [result]);

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
      if (!disposed) setError(reason instanceof Error ? reason.message : "无法加载原 PNG");
    });
    return () => {
      disposed = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [asset]);

  useEffect(() => () => {
    if (resultUrlRef.current) URL.revokeObjectURL(resultUrlRef.current);
    if (resultRef.current) void discardPngCompression(asset, resultRef.current.jobId).catch(() => undefined);
  }, [asset]);

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy) onClose();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [busy, onClose]);

  const replaceResult = (nextResult?: PngCompressionResult, nextUrl = "") => {
    if (resultUrlRef.current) URL.revokeObjectURL(resultUrlRef.current);
    resultUrlRef.current = nextUrl;
    resultRef.current = nextResult;
    setResultUrl(nextUrl);
    setResult(nextResult);
  };

  const processImage = async () => {
    if (busy || !hasTechnique) return;
    setProcessing(true);
    setError("");
    const signature = settingsSignature;
    const previous = resultRef.current;
    if (previous) {
      await discardPngCompression(asset, previous.jobId).catch(() => undefined);
      replaceResult();
    }
    let createdResult: PngCompressionResult | undefined;
    try {
      const nextResult = await compressPng(asset, {
        usePngquant,
        useOxipng,
        preservePixels,
        lossyStrength,
        losslessLevel,
      });
      createdResult = nextResult;
      const nextUrl = await loadPngCompressionPreview(asset, nextResult.jobId);
      replaceResult(nextResult, nextUrl);
      createdResult = undefined;
      setResultSignature(signature);
    } catch (reason) {
      if (createdResult) await discardPngCompression(asset, createdResult.jobId).catch(() => undefined);
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setProcessing(false);
    }
  };

  const chooseDirectory = async () => {
    const selected = await open({ title: "选择 PNG 压缩结果保存文件夹", directory: true, multiple: false });
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
    if (saveMode === "overwrite" && !window.confirm(`确定用压缩结果覆盖「${asset.name}」吗？此操作不能撤销。`)) return;
    setSaving(true);
    setError("");
    try {
      const saved = await savePngCompression(asset, {
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

  const togglePreservePixels = (checked: boolean) => {
    setPreservePixels(checked);
    if (checked) {
      setUsePngquant(false);
      setUseOxipng(true);
    }
  };

  const close = () => {
    if (!busy) onClose();
  };

  return (
    <div className="background-removal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && close()}>
      <section className="background-removal-dialog png-compression-dialog" role="dialog" aria-modal="true" aria-labelledby="png-compression-title">
        <header>
          <div><span className="background-removal-icon png-compression-icon"><Minimize2 size={18} /></span><span><strong id="png-compression-title">一键压缩（PNG 专属）</strong><small>{asset.name}</small></span></div>
          <button type="button" className="asset-preview-close" disabled={busy} onClick={close} aria-label="关闭 PNG 压缩窗口"><X size={18} /></button>
        </header>

        <div className="background-removal-body">
          <div className="background-removal-stage">
            {(resultUrl || originalUrl) ? <img src={resultUrl || originalUrl} alt={resultUrl ? "PNG 压缩结果" : asset.name} /> : <span>正在加载 PNG…</span>}
            <div className={`background-removal-status ${result && !stale ? "done" : processing ? "working" : ""}`}>
              {processing ? <><Sparkles size={14} /> 正在执行 PNG 压缩…</> : result && stale ? "压缩参数已更改，请重新压缩" : result ? <><Check size={14} /> {result.usedOriginal ? "原图已经更小，保留原始数据" : `已节省 ${savings.toFixed(1)}%`}</> : "原图预览"}
            </div>
          </div>

          <aside className="background-removal-controls png-compression-controls">
            <section>
              <h3>技术方案</h3>
              <label className={`png-compression-technique ${usePngquant ? "selected" : ""} ${preservePixels ? "disabled" : ""}`}>
                <input type="checkbox" checked={usePngquant} disabled={busy || preservePixels} onChange={(event) => setUsePngquant(event.target.checked)} />
                <span><strong>pngquant</strong><small>有损量化 · 显著减小体积</small></span>
                <Layers3 size={16} />
              </label>
              <label className={`png-compression-technique ${useOxipng ? "selected" : ""}`}>
                <input type="checkbox" checked={useOxipng} disabled={busy || preservePixels} onChange={(event) => setUseOxipng(event.target.checked)} />
                <span><strong>OxiPNG</strong><small>无损重编码 · 不改变像素</small></span>
                <ShieldCheck size={16} />
              </label>
              <p>同时选择时固定先运行 pngquant，再用 OxiPNG 优化量化结果。</p>
              {!hasTechnique && <p className="background-removal-inline-error">请至少选择一种技术方案</p>}
            </section>

            <section>
              <h3>压缩强度</h3>
              <div className="background-removal-sliders">
                <label><span>pngquant 有损强度 <strong>{lossyStrength}</strong></span><input type="range" min="1" max="100" value={lossyStrength} disabled={busy || !usePngquant || preservePixels} onChange={(event) => setLossyStrength(Number(event.target.value))} /><small>越高文件通常越小，颜色近似程度也越高。</small></label>
                <label><span>OxiPNG 优化级别 <strong>{losslessLevel} / 6</strong></span><input type="range" min="1" max="6" value={losslessLevel} disabled={busy || !useOxipng} onChange={(event) => setLosslessLevel(Number(event.target.value))} /><small>级别越高耗时越久，像素始终保持不变。</small></label>
              </div>
              <label className="png-compression-preserve"><input type="checkbox" checked={preservePixels} disabled={busy} onChange={(event) => togglePreservePixels(event.target.checked)} /><span><strong>不允许任何像素变化</strong><small>强制仅使用 OxiPNG，并禁用会改变量化颜色的 pngquant。</small></span></label>
            </section>

            {result && !stale && (
              <section className="png-compression-summary">
                <h3>压缩结果</h3>
                <div><span>原始大小</span><strong>{formatBytes(result.originalBytes)}</strong></div>
                <div><span>结果大小</span><strong>{formatBytes(result.resultBytes)}</strong></div>
                <div><span>处理步骤</span><strong>{result.usedOriginal ? "原始数据回退" : result.techniques.join(" → ")}</strong></div>
              </section>
            )}

            {result && !stale && (
              <section className="background-removal-save">
                <h3>保存结果</h3>
                <div className="background-removal-save-modes">
                  <label><input type="radio" name="png-save-mode" checked={saveMode === "saveAs"} disabled={busy} onChange={() => setSaveMode("saveAs")} /><span>另存为</span></label>
                  <label><input type="radio" name="png-save-mode" checked={saveMode === "sourceDirectory"} disabled={busy} onChange={() => setSaveMode("sourceDirectory")} /><span>原图目录</span></label>
                  <label><input type="radio" name="png-save-mode" checked={saveMode === "overwrite"} disabled={busy} onChange={() => setSaveMode("overwrite")} /><span>覆盖原图</span></label>
                </div>
                {saveMode === "saveAs" && <button type="button" className="background-removal-folder" disabled={busy} onClick={() => void chooseDirectory()}><FolderOpen size={14} /><span title={directory}>{directory || "选择文件夹"}</span></button>}
                {saveMode !== "overwrite" ? <label className="background-removal-name"><span>结果名称</span><div><input value={fileStem} maxLength={200} disabled={busy} onChange={(event) => setFileStem(event.target.value)} /><strong>.png</strong></div></label> : <p className="background-removal-overwrite-note">将安全替换原 PNG，并刷新资源索引与预览。</p>}
              </section>
            )}

            {error && <div className="background-removal-error" role="alert">{error}</div>}
          </aside>
        </div>

        <footer>
          <span>{result && !stale ? "预览已切换为压缩后的 PNG，结果尚未写入磁盘" : "所有压缩均在本机完成"}</span>
          <div>
            <button type="button" className="secondary-button" disabled={busy} onClick={close}>取消</button>
            {result && !stale ? <button type="button" className="primary-button" disabled={busy} onClick={() => void save()}>{saving ? "保存中…" : "保存结果"}</button> : <button type="button" className="primary-button" disabled={busy || !originalUrl || !hasTechnique} onClick={() => void processImage()}>{processing ? "压缩中…" : result ? "重新压缩" : "开始压缩"}</button>}
          </div>
        </footer>
      </section>
    </div>
  );
}
