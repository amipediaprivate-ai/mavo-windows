import { open } from "@tauri-apps/plugin-dialog";
import {
  ArrowLeftRight,
  Check,
  FileAudio,
  FolderOpen,
  Gauge,
  LoaderCircle,
  Music2,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  discardAudioProcessing,
  loadAudioProcessingPreview,
  processAudio,
  saveAudioProcessing,
  type AudioCompressionStrength,
  type AudioOutputFormat,
  type AudioProcessingOperation,
  type AudioProcessingResult,
  type AudioProcessingSaveMode,
  type SaveAudioProcessingResult,
} from "../lib/audioProcessing";
import { audioPlaybackUrl } from "../lib/desktopAssets";
import { announceMediaPlayback } from "../lib/mediaPlayback";
import type { Asset } from "../types";

interface AudioProcessingDialogProps {
  asset: Asset;
  operation: AudioProcessingOperation;
  onClose: () => void;
  onSaved: (result: SaveAudioProcessingResult) => void;
}

const formatOptions: { id: AudioOutputFormat; name: string; detail: string }[] = [
  { id: "mp3", name: "MP3", detail: "高兼容 · 体积小" },
  { id: "wav", name: "WAV", detail: "PCM · 便于编辑" },
  { id: "flac", name: "FLAC", detail: "无损压缩" },
  { id: "aac", name: "AAC", detail: "高效有损编码" },
  { id: "ogg", name: "OGG", detail: "Vorbis 开放格式" },
  { id: "m4a", name: "M4A", detail: "AAC 容器 · 高兼容" },
];

const compressionOptions: { id: AudioCompressionStrength; name: string; detail: string }[] = [
  { id: "light", name: "轻度", detail: "256 kbps · 优先音质" },
  { id: "balanced", name: "均衡", detail: "160 kbps · 推荐" },
  { id: "strong", name: "强力", detail: "96 kbps · 优先体积" },
];

const operationCopy: Record<AudioProcessingOperation, { title: string; action: string; working: string; suffix: string }> = {
  fsbToWav: { title: "FSB 转 WAV", action: "开始转换", working: "正在解析 FSB 子音轨…", suffix: "转换" },
  formatConversion: { title: "音频格式转换", action: "开始转换", working: "正在转换所选格式…", suffix: "转换" },
  compression: { title: "音频压缩", action: "开始压缩", working: "正在压缩音频…", suffix: "压缩" },
};

function baseStem(name: string) {
  const extensionIndex = name.lastIndexOf(".");
  return extensionIndex > 0 ? name.slice(0, extensionIndex) : name;
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

export function AudioProcessingDialog({ asset, operation, onClose, onSaved }: AudioProcessingDialogProps) {
  const copy = operationCopy[operation];
  const [formats, setFormats] = useState<AudioOutputFormat[]>(["mp3", "wav"]);
  const [compressionStrength, setCompressionStrength] = useState<AudioCompressionStrength>("balanced");
  const [result, setResult] = useState<AudioProcessingResult>();
  const [resultSignature, setResultSignature] = useState("");
  const [activeOutputId, setActiveOutputId] = useState("");
  const [previewUrl, setPreviewUrl] = useState("");
  const [previewLoading, setPreviewLoading] = useState(false);
  const [processing, setProcessing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [saveMode, setSaveMode] = useState<AudioProcessingSaveMode>("sourceDirectory");
  const [directory, setDirectory] = useState("");
  const [fileStem, setFileStem] = useState(() => `${baseStem(asset.name)}-${copy.suffix}`);
  const resultRef = useRef<AudioProcessingResult | undefined>(undefined);
  const previewUrlRef = useRef("");

  const busy = processing || saving;
  const settingsSignature = operation === "formatConversion"
    ? [...formats].sort().join(":")
    : operation === "compression" ? compressionStrength : "fsb";
  const stale = Boolean(result && resultSignature !== settingsSignature);
  const activeOutput = result?.outputs.find((output) => output.id === activeOutputId) || result?.outputs[0];
  const canStart = operation !== "formatConversion" || formats.length > 0;
  const savings = useMemo(() => {
    const bytes = result?.outputs[0]?.bytes;
    if (!result || bytes === undefined || result.originalBytes <= 0) return 0;
    return (1 - bytes / result.originalBytes) * 100;
  }, [result]);

  useEffect(() => () => {
    if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
    if (resultRef.current) void discardAudioProcessing(asset, resultRef.current.jobId).catch(() => undefined);
  }, [asset]);

  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy) onClose();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [busy, onClose]);

  const clearPreview = () => {
    if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
    previewUrlRef.current = "";
    setPreviewUrl("");
  };

  const selectOutput = async (nextResult: AudioProcessingResult, outputId: string) => {
    const output = nextResult.outputs.find((item) => item.id === outputId);
    if (!output) return;
    setActiveOutputId(outputId);
    clearPreview();
    setPreviewLoading(true);
    try {
      const url = await loadAudioProcessingPreview(asset, nextResult, output);
      previewUrlRef.current = url;
      setPreviewUrl(url);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setPreviewLoading(false);
    }
  };

  const run = async () => {
    if (busy || !canStart) return;
    setProcessing(true);
    setError("");
    if (resultRef.current) {
      await discardAudioProcessing(asset, resultRef.current.jobId).catch(() => undefined);
      resultRef.current = undefined;
      setResult(undefined);
      clearPreview();
    }
    let created: AudioProcessingResult | undefined;
    try {
      const nextResult = await processAudio(asset, {
        operation,
        formats: operation === "formatConversion" ? formats : undefined,
        compressionStrength: operation === "compression" ? compressionStrength : undefined,
      });
      created = nextResult;
      resultRef.current = nextResult;
      setResult(nextResult);
      setResultSignature(settingsSignature);
      if (nextResult.outputs.length > 1 && saveMode === "overwrite") setSaveMode("sourceDirectory");
      if (nextResult.outputs[0]) await selectOutput(nextResult, nextResult.outputs[0].id);
      created = undefined;
    } catch (reason) {
      if (created) await discardAudioProcessing(asset, created.jobId).catch(() => undefined);
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setProcessing(false);
    }
  };

  const toggleFormat = (format: AudioOutputFormat) => {
    setFormats((current) => current.includes(format)
      ? current.filter((item) => item !== format)
      : [...current, format]);
  };

  const chooseDirectory = async () => {
    const selected = await open({ title: "选择音频处理结果保存文件夹", directory: true, multiple: false });
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
      const output = result.outputs[0];
      if (!output || result.outputs.length !== 1) return;
      if (!window.confirm(`确定用 ${output.format} 结果覆盖「${asset.name}」吗？原文件可能会更改扩展名，此操作不能撤销。`)) return;
    }
    setSaving(true);
    setError("");
    try {
      const saved = await saveAudioProcessing(asset, {
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

  const icon = operation === "fsbToWav" ? <FileAudio size={18} /> : operation === "formatConversion" ? <ArrowLeftRight size={18} /> : <Gauge size={18} />;
  const originalPlayable = operation !== "fsbToWav";

  return (
    <div className="background-removal-backdrop" onMouseDown={(event) => event.target === event.currentTarget && close()}>
      <section className="background-removal-dialog audio-processing-dialog" role="dialog" aria-modal="true" aria-labelledby="audio-processing-title">
        <header>
          <div><span className="background-removal-icon audio-processing-icon">{icon}</span><span><strong id="audio-processing-title">{copy.title}</strong><small>{asset.name}</small></span></div>
          <button type="button" className="asset-preview-close" disabled={busy} onClick={close} aria-label={`关闭${copy.title}窗口`}><X size={18} /></button>
        </header>

        <div className="background-removal-body audio-processing-body">
          <div className="audio-processing-stage">
            <section className="audio-processing-player source">
              <div className="audio-processing-player-heading"><span><Music2 size={14} /> 原文件</span><strong>{asset.format}</strong></div>
              <h3 title={asset.name}>{asset.name}</h3>
              <p>{asset.dimensions} · {asset.weight}</p>
              {originalPlayable
                ? <audio controls preload="metadata" src={audioPlaybackUrl(asset)} onPlay={() => announceMediaPlayback("audio-tool-original")} />
                : <div className="audio-processing-unavailable">FSB 是游戏音频库，转换后可逐条试听 WAV 子音轨。</div>}
            </section>

            <ArrowLeftRight className={`audio-processing-direction ${processing ? "working" : ""}`} size={22} />

            <section className={`audio-processing-player result ${result && !stale ? "ready" : ""}`}>
              <div className="audio-processing-player-heading"><span><Check size={14} /> 处理结果</span>{activeOutput && <strong>{activeOutput.format}</strong>}</div>
              {processing ? (
                <div className="audio-processing-placeholder"><LoaderCircle size={24} /><span>{copy.working}</span></div>
              ) : result && stale ? (
                <div className="audio-processing-placeholder"><span>参数已更改，请重新处理</span></div>
              ) : activeOutput ? (
                <>
                  <h3 title={activeOutput.fileName}>{activeOutput.fileName}</h3>
                  <p>{formatBytes(activeOutput.bytes)}{operation === "compression" ? ` · ${savings >= 0 ? `节省 ${savings.toFixed(1)}%` : `增加 ${Math.abs(savings).toFixed(1)}%`}` : ""}</p>
                  {previewLoading ? <div className="audio-processing-preview-loading"><LoaderCircle size={16} /> 正在准备试听…</div> : previewUrl ? <audio controls preload="metadata" src={previewUrl} onPlay={() => announceMediaPlayback("audio-tool-result")} /> : <div className="audio-processing-unavailable">该结果无法在窗口中试听，但仍可保存。</div>}
                </>
              ) : (
                <div className="audio-processing-placeholder"><span>完成处理后在这里试听结果</span></div>
              )}
            </section>
          </div>

          <aside className="background-removal-controls audio-processing-controls">
            {operation === "formatConversion" && (
              <section>
                <h3>输出格式（可多选）</h3>
                <div className="audio-format-grid">
                  {formatOptions.map((option) => (
                    <label key={option.id} className={formats.includes(option.id) ? "selected" : ""}>
                      <input type="checkbox" checked={formats.includes(option.id)} disabled={busy} onChange={() => toggleFormat(option.id)} />
                      <span><strong>{option.name}</strong><small>{option.detail}</small></span>
                    </label>
                  ))}
                </div>
                {formats.length === 0 && <p className="background-removal-inline-error">请至少选择一种输出格式</p>}
              </section>
            )}

            {operation === "compression" && (
              <section>
                <h3>压缩强度</h3>
                <div className="audio-compression-options">
                  {compressionOptions.map((option) => (
                    <label key={option.id} className={compressionStrength === option.id ? "selected" : ""}>
                      <input type="radio" name="compression-strength" checked={compressionStrength === option.id} disabled={busy} onChange={() => setCompressionStrength(option.id)} />
                      <span><strong>{option.name}</strong><small>{option.detail}</small></span>
                    </label>
                  ))}
                </div>
                <p>压缩统一输出 MP3。强度越高，文件通常越小，音质损失也越明显。</p>
              </section>
            )}

            {operation === "fsbToWav" && !result && (
              <section>
                <h3>转换方式</h3>
                <p>使用内置 vgmstream-cli 解码全部子音轨，忽略循环标记并输出标准 WAV。大型音频库可能需要较长时间和更多磁盘空间。</p>
              </section>
            )}

            {result && !stale && result.outputs.length > 0 && (
              <section>
                <h3>处理结果 · {result.outputs.length} 个文件</h3>
                <div className="audio-output-list">
                  {result.outputs.map((output) => (
                    <button key={output.id} type="button" className={activeOutput?.id === output.id ? "active" : ""} disabled={busy} onClick={() => void selectOutput(result, output.id)}>
                      <FileAudio size={14} /><span title={output.fileName}><strong>{output.fileName}</strong><small>{output.format} · {formatBytes(output.bytes)}</small></span>
                    </button>
                  ))}
                </div>
              </section>
            )}

            {result && !stale && (
              <section className="background-removal-save">
                <h3>保存结果</h3>
                <div className="background-removal-save-modes">
                  <label><input type="radio" name="audio-save-mode" checked={saveMode === "saveAs"} disabled={busy} onChange={() => setSaveMode("saveAs")} /><span>另存为</span></label>
                  <label><input type="radio" name="audio-save-mode" checked={saveMode === "sourceDirectory"} disabled={busy} onChange={() => setSaveMode("sourceDirectory")} /><span>原文件目录</span></label>
                  <label className={result.outputs.length > 1 ? "disabled" : ""}><input type="radio" name="audio-save-mode" checked={saveMode === "overwrite"} disabled={busy || result.outputs.length > 1} onChange={() => setSaveMode("overwrite")} /><span>覆盖原文件</span></label>
                </div>
                {result.outputs.length > 1 && <p>多个结果不能覆盖同一个原文件，请另存或保存到原文件目录。</p>}
                {saveMode === "saveAs" && <button type="button" className="background-removal-folder" disabled={busy} onClick={() => void chooseDirectory()}><FolderOpen size={14} /><span title={directory}>{directory || "选择文件夹"}</span></button>}
                {saveMode !== "overwrite" ? (
                  <label className="background-removal-name"><span>结果基础名称</span><div><input value={fileStem} maxLength={200} disabled={busy} onChange={(event) => setFileStem(event.target.value)} /><strong>{result.outputs.length === 1 ? `.${result.outputs[0].format.toLowerCase()}` : "多个文件"}</strong></div></label>
                ) : (
                  <p className="background-removal-overwrite-note">将安全替换原音频；格式变化时同步更新文件扩展名和资源索引。</p>
                )}
              </section>
            )}

            {error && <div className="background-removal-error" role="alert">{error}</div>}
          </aside>
        </div>

        <footer>
          <span>{result && !stale ? "结果位于临时缓存，保存前不会修改原文件" : "所有音频处理均在本机完成"}</span>
          <div>
            <button type="button" className="secondary-button" disabled={busy} onClick={close}>取消</button>
            {result && !stale
              ? <button type="button" className="primary-button" disabled={busy} onClick={() => void save()}>{saving ? "保存中…" : "保存结果"}</button>
              : <button type="button" className="primary-button" disabled={busy || !canStart} onClick={() => void run()}>{processing ? copy.working : result ? `重新${operation === "compression" ? "压缩" : "转换"}` : copy.action}</button>}
          </div>
        </footer>
      </section>
    </div>
  );
}
