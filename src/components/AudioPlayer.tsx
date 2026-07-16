import { LoaderCircle, Pause, Play, Repeat1, RotateCcw, RotateCw, Volume2, VolumeX } from "lucide-react";
import type { Asset } from "../types";
import { canPlayAudio } from "../lib/desktopAssets";
import { useAudioPlayer } from "../audio/AudioPlayerContext";
import { AudioWaveform, formatAudioTime } from "./AudioWaveform";

function PlayIcon({ loading, playing, size }: { loading: boolean; playing: boolean; size: number }) {
  if (loading) return <LoaderCircle className="audio-spinner" size={size} />;
  if (playing) return <Pause size={size} fill="currentColor" />;
  return <Play size={size} fill="currentColor" />;
}

function VolumeControl({ variant }: { variant: "card" | "detail" }) {
  const player = useAudioPlayer();
  const percentage = Math.round(player.volume * 100);
  return (
    <div className={`audio-${variant}-volume`} onClick={(event) => event.stopPropagation()}>
      <button
        type="button"
        onClick={player.toggleMute}
        aria-label={player.volume === 0 ? "恢复音量" : "静音"}
        title={player.volume === 0 ? "恢复音量" : "静音"}
      >
        {player.volume === 0 ? <VolumeX size={14} /> : <Volume2 size={14} />}
      </button>
      <input
        type="range"
        min="0"
        max="1"
        step="0.05"
        value={player.volume}
        onChange={(event) => player.setVolume(Number(event.target.value))}
        aria-label="音量"
      />
      <output>{percentage}%</output>
    </div>
  );
}

function originalLoudnessLabel(asset: Asset) {
  if (asset.loudnessStatus === "silent") return "静音";
  if (asset.loudnessStatus === "unsupported") return "无法分析";
  if (asset.loudnessStatus !== "ready" || asset.integratedLufs === undefined) return "分析中";
  return `${asset.integratedLufs.toFixed(1)} LUFS`;
}

function OriginalLoudness({ asset, variant }: { asset: Asset; variant: "card" | "detail" }) {
  const label = originalLoudnessLabel(asset);
  if (variant === "card") {
    return <span className="audio-card-loudness" title={`原始响度：${label}`}>原始响度 {label}</span>;
  }
  const integratedLufs = asset.integratedLufs;
  const ready = asset.loudnessStatus === "ready" && integratedLufs !== undefined;
  return (
    <section className={`audio-source-metrics ${ready ? "ready" : ""}`} aria-label="原始音频参数">
      <div className="audio-source-metrics-heading">
        <span>原始音频参数</span>
        <strong>{label}</strong>
      </div>
      {ready && (
        <div className="audio-source-metrics-grid">
          <span><small>综合响度</small><strong>{integratedLufs?.toFixed(1)} LUFS</strong></span>
          <span><small>真峰值</small><strong>{asset.truePeakDbtp !== undefined ? `${asset.truePeakDbtp.toFixed(1)} dBTP` : "—"}</strong></span>
          <span><small>响度范围</small><strong>{asset.loudnessRangeLu !== undefined ? `${asset.loudnessRangeLu.toFixed(1)} LU` : "—"}</strong></span>
        </div>
      )}
    </section>
  );
}

export function AudioCardPlayer({ asset }: { asset: Asset }) {
  const player = useAudioPlayer();
  const active = player.isActive(asset);
  const playing = active && player.status === "playing";
  const loading = active && player.status === "loading";
  const playable = canPlayAudio(asset);
  const duration = active && player.duration > 0 ? player.duration : (asset.durationMs ?? 0) / 1000;
  const currentTime = active ? player.currentTime : 0;

  return (
    <div className={`audio-card-player ${active ? "active" : ""}`} onDoubleClick={(event) => event.stopPropagation()}>
      <AudioWaveform asset={asset} variant="card" />
      <OriginalLoudness asset={asset} variant="card" />
      <div className="audio-card-controls">
        <button
          className="audio-card-play"
          type="button"
          disabled={!playable}
          onClick={(event) => {
            event.stopPropagation();
            player.toggle(asset);
          }}
          aria-label={playing ? "暂停" : "播放"}
          title={playable ? (playing ? "暂停" : "播放") : "该资源没有可播放的本地音频"}
        >
          <PlayIcon loading={loading} playing={playing} size={13} />
        </button>
        <span className="audio-card-time">{formatAudioTime(currentTime)} / {formatAudioTime(duration)}</span>
        <button
          className={`audio-card-loop ${player.mode === "loop" ? "active" : ""}`}
          type="button"
          onClick={(event) => {
            event.stopPropagation();
            player.setMode(player.mode === "loop" ? "once" : "loop");
          }}
          aria-label={player.mode === "loop" ? "切换为单次播放" : "切换为循环播放"}
          aria-pressed={player.mode === "loop"}
          title={player.mode === "loop" ? "循环播放" : "单次播放"}
        >
          <Repeat1 size={13} />
        </button>
        <VolumeControl variant="card" />
      </div>
      {active && player.status === "error" && <span className="audio-card-error" title={player.error}>播放失败</span>}
    </div>
  );
}

export function AudioDetailPlayer({ asset }: { asset: Asset }) {
  const player = useAudioPlayer();
  const active = player.isActive(asset);
  const playing = active && player.status === "playing";
  const loading = active && player.status === "loading";
  const playable = canPlayAudio(asset);
  const duration = active && player.duration > 0 ? player.duration : (asset.durationMs ?? 0) / 1000;
  const currentTime = active ? player.currentTime : 0;

  return (
    <section className={`audio-detail-player ${active ? "active" : ""}`} aria-label="音频播放器">
      <AudioWaveform asset={asset} variant="detail" />
      <div className="audio-detail-time">
        <strong>{formatAudioTime(currentTime)}</strong>
        <span>{formatAudioTime(duration)}</span>
      </div>
      <div className="audio-detail-transport">
        <button
          type="button"
          disabled={!active || !playable}
          onClick={() => player.skip(-5)}
          aria-label="后退五秒"
          title="后退 5 秒"
        >
          <RotateCcw size={16} />
          <small>5</small>
        </button>
        <button
          className="audio-detail-main-play"
          type="button"
          disabled={!playable}
          onClick={() => player.toggle(asset)}
          aria-label={playing ? "暂停" : "播放"}
          title={playable ? (playing ? "暂停" : "播放") : "该资源没有可播放的本地音频"}
        >
          <PlayIcon loading={loading} playing={playing} size={19} />
        </button>
        <button
          type="button"
          disabled={!active || !playable}
          onClick={() => player.skip(5)}
          aria-label="前进五秒"
          title="前进 5 秒"
        >
          <RotateCw size={16} />
          <small>5</small>
        </button>
      </div>
      <VolumeControl variant="detail" />
      <div className="audio-playback-mode" aria-label="播放模式">
        <button
          type="button"
          className={player.mode === "once" ? "active" : ""}
          onClick={() => player.setMode("once")}
          aria-pressed={player.mode === "once"}
        >
          单次播放
        </button>
        <button
          type="button"
          className={player.mode === "loop" ? "active" : ""}
          onClick={() => player.setMode("loop")}
          aria-pressed={player.mode === "loop"}
        >
          <Repeat1 size={12} /> 循环播放
        </button>
      </div>
      <OriginalLoudness asset={asset} variant="detail" />
      {!playable && <p className="audio-player-message">{asset.availability === "missing" ? "原始音频文件已缺失" : "该资源没有可播放的本地音频"}</p>}
      {active && player.status === "error" && playable && <p className="audio-player-message error">{player.error}</p>}
    </section>
  );
}
