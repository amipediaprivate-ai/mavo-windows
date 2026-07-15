import { LoaderCircle, Pause, Play, Repeat1, RotateCcw, RotateCw } from "lucide-react";
import type { Asset } from "../types";
import { canPlayAudio } from "../lib/desktopAssets";
import { useAudioPlayer } from "../audio/AudioPlayerContext";
import { AudioWaveform, formatAudioTime } from "./AudioWaveform";

function PlayIcon({ loading, playing, size }: { loading: boolean; playing: boolean; size: number }) {
  if (loading) return <LoaderCircle className="audio-spinner" size={size} />;
  if (playing) return <Pause size={size} fill="currentColor" />;
  return <Play size={size} fill="currentColor" />;
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
      {!playable && <p className="audio-player-message">{asset.availability === "missing" ? "原始音频文件已缺失" : "该资源没有可播放的本地音频"}</p>}
      {active && player.status === "error" && playable && <p className="audio-player-message error">{player.error}</p>}
    </section>
  );
}
