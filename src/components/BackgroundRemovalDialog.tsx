import { open } from "@tauri-apps/plugin-dialog";
import { Check, FolderOpen, Scissors, Sparkles, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  discardBackgroundRemoval,
  loadBackgroundRemovalPreview,
  removeImageBackground,
  saveBackgroundRemoval,
  type BackgroundRemovalModel,
  type BackgroundRemovalResult,
  type BackgroundRemovalSaveMode,
  type SaveBackgroundRemovalResult,
} from "../lib/backgroundRemoval";
import { loadOriginalAsset } from "../lib/desktopAssets";
import type { Asset } from "../types";

interface BackgroundRemovalDialogProps {
  asset: Asset;
  onClose: () => void;
  onSaved: (result: SaveBackgroundRemovalResult) => void;
}

const models: Array<{ id: BackgroundRemovalModel; name: string; description: string }> = [
  { id: "birefnet-general", name: "BiRefNet 通用（高质量）", description: "默认，适合商品、角色与一般素材" },
  { id: "birefnet-general-lite", name: "BiRefNet 通用轻量", description: "模型更小，CPU 处理速度更快" },
  { id: "birefnet-portrait", name: "BiRefNet 人像", description: "针对人物、头发和人像边缘" },
];

function defaultStem(name: string) {
  const extensionIndex = name.lastIndexOf(".");
  const stem = extensionIndex > 0 ? name.slice(0, extensionIndex) : name;
  return `${stem}-抠图`;
}

export function BackgroundRemovalDialog({ asset, onClose, onSaved }: BackgroundRemovalDialogProps) {
  const [originalUrl, setOriginalUrl] = useState("");
  const [resultUrl, setResultUrl] = useState("");
  const [result, setResult] = useState<BackgroundRemovalResult>();
  const [model, setModel] = useState<BackgroundRemovalModel>("birefnet-general");
  const [alphaMatting, setAlphaMatting] = useState(false);
  const [foregroundThreshold, setForegroundThreshold] = useState(240);
  const [backgroundThreshold, setBackgroundThreshold] = useState(10);
  const [erodeSize, setErodeSize] = useState(10);
  const [postProcessMask, setPostProcessMask] = useState(false);
  const [processing, setProcessing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [saveMode, setSaveMode] = useState<BackgroundRemovalSaveMode>("sourceDirectory");
  const [directory, setDirectory] = useState("");
  const [fileStem, setFileStem] = useState(() => defaultStem(asset.name));
  const resultRef = useRef<BackgroundRemovalResult | undefined>(undefined);
  const resultUrlRef = useRef("");

  const sourceExtension = asset.format.toUpperCase();
  const busy = processing || saving;
  const alphaParametersInvalid = backgroundThreshold >= foregroundThreshold;
  const selectedModel = useMemo(() => models.find((item) => item.id === model), [model]);

  useEffect(() => {
    let disposed = false;
    let url = "";
    void loadOriginalAsset(asset).then((loadedUrl) => {
      if (disposed) {
        URL.revokeObjectURL(loadedUrl);
      } else {
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
    if (resultUrlRef.current) URL.revokeObjectURL(resultUrlRef.current);
    if (resultRef.current) void discardBackgroundRemoval(asset, resultRef.current.jobId).catch(() => undefined);
  }, [asset]);

  const replaceResult = (nextResult?: BackgroundRemovalResult, nextUrl = "") => {
    if (resultUrlRef.current) URL.revokeObjectURL(resultUrlRef.current);
    resultUrlRef.current = nextUrl;
    resultRef.current = nextResult;
    setResultUrl(nextUrl);
    setResult(nextResult);
  };

  const processImage = async () => {
    if (busy || alphaParametersInvalid) return;
    setProcessing(true);
    setError("");
    const previous = resultRef.current;
    if (previous) {
      await discardBackgroundRemoval(asset, previous.jobId).catch(() => undefined);
      replaceResult();
    }
    try {
      const nextResult = await removeImageBackground(asset, {
        model,
        alphaMatting,
        foregroundThreshold,
        backgroundThreshold,
        erodeSize,
        postProcessMask,
      });
      const nextUrl = await loadBackgroundRemovalPreview(asset, nextResult.jobId);
      replaceResult(nextResult, nextUrl);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setProcessing(false);
    }
  };

  const chooseDirectory = async () => {
    const selected = await open({ title: "选择抠图结果保存文件夹", directory: true, multiple: false });
    if (typeof selected === "string") setDirectory(selected);
  };

  const save = async () => {
    if (!result || busy) return;
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
      if (!window.confirm(`确定用抠图结果覆盖「${asset.name}」吗？此操作不能撤销。${conversion}`)) return;
    }
    setSaving(true);
    setError("");
    try {
      const saved = await saveBackgroundRemoval(asset, {
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
    if (busy) return;
    onClose();
  };

  return (
    <div className="background-removal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && close()}>
      <section className="background-removal-dialog" role="dialog" aria-modal="true" aria-labelledby="background-removal-title">
        <header>
          <div><span className="background-removal-icon"><Scissors size={18} /></span><span><strong id="background-removal-title">一键抠图</strong><small>{asset.name}</small></span></div>
          <button type="button" className="asset-preview-close" disabled={busy} onClick={close} aria-label="关闭抠图窗口"><X size={18} /></button>
        </header>

        <div className="background-removal-body">
          <div className="background-removal-stage">
            {(resultUrl || originalUrl) ? <img src={resultUrl || originalUrl} alt={resultUrl ? "抠图结果" : asset.name} onError={() => setError("无法生成安全图片预览")} /> : <span>正在加载图片…</span>}
            <div className={`background-removal-status ${result ? "done" : processing ? "working" : ""}`}>
              {result ? <><Check size={14} /> 抠图完成 · {result.width} × {result.height}</> : processing ? <><Sparkles size={14} /> 正在下载模型或处理图片…</> : "原图预览"}
            </div>
          </div>

          <aside className="background-removal-controls">
            <section>
              <h3>模型</h3>
              <select value={model} disabled={busy} onChange={(event) => setModel(event.target.value as BackgroundRemovalModel)}>
                {models.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
              </select>
              <p>{selectedModel?.description}。首次使用会下载模型并缓存到本机。</p>
            </section>

            <section>
              <h3>边缘参数</h3>
              <label className="background-removal-toggle"><input type="checkbox" checked={alphaMatting} disabled={busy} onChange={(event) => setAlphaMatting(event.target.checked)} /><span>Alpha Matting 精细边缘</span></label>
              <div className="background-removal-sliders">
                <label><span>前景阈值 <strong>{foregroundThreshold}</strong></span><input type="range" min="1" max="255" value={foregroundThreshold} disabled={busy || !alphaMatting} onChange={(event) => setForegroundThreshold(Number(event.target.value))} /></label>
                <label><span>背景阈值 <strong>{backgroundThreshold}</strong></span><input type="range" min="0" max="254" value={backgroundThreshold} disabled={busy || !alphaMatting} onChange={(event) => setBackgroundThreshold(Number(event.target.value))} /></label>
                <label><span>边缘收缩 <strong>{erodeSize}</strong></span><input type="range" min="0" max="40" value={erodeSize} disabled={busy || !alphaMatting} onChange={(event) => setErodeSize(Number(event.target.value))} /></label>
              </div>
              {alphaParametersInvalid && <p className="background-removal-inline-error">背景阈值必须小于前景阈值</p>}
              <label className="background-removal-toggle"><input type="checkbox" checked={postProcessMask} disabled={busy} onChange={(event) => setPostProcessMask(event.target.checked)} /><span>清理蒙版小孔和噪点</span></label>
            </section>

            {result && (
              <section className="background-removal-save">
                <h3>保存结果</h3>
                <div className="background-removal-save-modes">
                  <label><input type="radio" name="save-mode" checked={saveMode === "saveAs"} disabled={busy} onChange={() => setSaveMode("saveAs")} /><span>另存为</span></label>
                  <label><input type="radio" name="save-mode" checked={saveMode === "sourceDirectory"} disabled={busy} onChange={() => setSaveMode("sourceDirectory")} /><span>原图目录</span></label>
                  <label><input type="radio" name="save-mode" checked={saveMode === "overwrite"} disabled={busy} onChange={() => setSaveMode("overwrite")} /><span>覆盖原图</span></label>
                </div>
                {saveMode === "saveAs" && <button type="button" className="background-removal-folder" disabled={busy} onClick={() => void chooseDirectory()}><FolderOpen size={14} /><span title={directory}>{directory || "选择文件夹"}</span></button>}
                {saveMode !== "overwrite" ? (
                  <label className="background-removal-name"><span>结果名称</span><div><input value={fileStem} maxLength={200} disabled={busy} onChange={(event) => setFileStem(event.target.value)} /><strong>.png</strong></div></label>
                ) : (
                  <p className="background-removal-overwrite-note">将替换原图。{sourceExtension === "PNG" ? "文件名保持不变。" : "为保留透明通道，文件会转换为同名 PNG。"}</p>
                )}
              </section>
            )}

            {error && <div className="background-removal-error" role="alert">{error}</div>}
          </aside>
        </div>

        <footer>
          <span>{processing ? "高质量模型首次下载可能需要几分钟，请保持网络连接" : result ? "结果尚未写入磁盘" : "所有处理均在本机完成"}</span>
          <div>
            <button type="button" className="secondary-button" disabled={busy} onClick={close}>取消</button>
            {result ? <button type="button" className="primary-button" disabled={busy} onClick={() => void save()}>{saving ? "保存中…" : "保存结果"}</button> : <button type="button" className="primary-button" disabled={busy || !originalUrl || alphaParametersInvalid} onClick={() => void processImage()}>{processing ? "抠图中…" : "开始抠图"}</button>}
          </div>
        </footer>
      </section>
    </div>
  );
}
