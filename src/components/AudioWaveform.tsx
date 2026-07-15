import { useId, useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import type { Asset } from "../types";
import { useAudioPlayer } from "../audio/AudioPlayerContext";
import { canPlayAudio } from "../lib/desktopAssets";

interface AudioWaveformProps {
  asset: Asset;
  variant: "card" | "detail";
}

const fallbackBars = [18, 34, 57, 27, 76, 48, 31, 68, 42, 22, 54, 82, 46, 29, 64, 38, 72, 44, 25, 51, 34, 62, 40, 19];

export function formatAudioTime(seconds: number) {
  const safeSeconds = Number.isFinite(seconds) ? Math.max(0, Math.floor(seconds)) : 0;
  const hours = Math.floor(safeSeconds / 3600);
  const minutes = Math.floor((safeSeconds % 3600) / 60);
  const remainder = safeSeconds % 60;
  if (hours > 0) return `${hours}:${minutes.toString().padStart(2, "0")}:${remainder.toString().padStart(2, "0")}`;
  return `${minutes.toString().padStart(2, "0")}:${remainder.toString().padStart(2, "0")}`;
}

function FallbackWaveform({ color }: { color: string }) {
  return (
    <svg viewBox="0 0 240 90" preserveAspectRatio="none" aria-hidden="true">
      {fallbackBars.map((height, index) => (
        <rect
          key={index}
          x={index * 10 + 2}
          y={(90 - height) / 2}
          width="5"
          height={height}
          rx="2.5"
          fill={color}
        />
      ))}
    </svg>
  );
}

export function AudioWaveform({ asset, variant }: AudioWaveformProps) {
  const player = useAudioPlayer();
  const waveformRef = useRef<HTMLDivElement>(null);
  const draggingRef = useRef(false);
  const [hoverRatio, setHoverRatio] = useState<number>();
  const hintId = useId();
  const active = player.isActive(asset);
  const playable = canPlayAudio(asset);
  const duration = active && player.duration > 0 ? player.duration : (asset.durationMs ?? 0) / 1000;
  const currentTime = active ? player.currentTime : 0;
  const progress = duration > 0 ? Math.min(Math.max(currentTime / duration, 0), 1) : 0;

  const ratioFromPointer = (event: PointerEvent<HTMLDivElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    return Math.min(Math.max((event.clientX - bounds.left) / Math.max(bounds.width, 1), 0), 1);
  };

  const seekFromPointer = (event: PointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
    if (!playable) return;
    const ratio = ratioFromPointer(event);
    setHoverRatio(ratio);
    player.seekAndPlay(asset, ratio * duration);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    let target: number | undefined;
    if (event.key === "ArrowLeft") target = currentTime - 5;
    if (event.key === "ArrowRight") target = currentTime + 5;
    if (event.key === "Home") target = 0;
    if (event.key === "End") target = duration;
    if (target !== undefined) {
      event.preventDefault();
      event.stopPropagation();
      if (playable) player.seekAndPlay(asset, Math.min(Math.max(target, 0), duration));
    }
    if (event.key === " " || event.key === "Enter") {
      event.preventDefault();
      event.stopPropagation();
      if (playable) player.toggle(asset);
    }
  };

  return (
    <div
      ref={waveformRef}
      className={`audio-waveform ${variant}`}
      role="slider"
      tabIndex={0}
      aria-label={`${asset.name} 播放进度`}
      aria-describedby={hintId}
      aria-valuemin={0}
      aria-valuemax={Math.round(duration)}
      aria-valuenow={Math.round(currentTime)}
      aria-valuetext={`${formatAudioTime(currentTime)} / ${formatAudioTime(duration)}`}
      aria-disabled={!playable}
      onPointerDown={(event) => {
        draggingRef.current = variant === "detail";
        event.currentTarget.setPointerCapture(event.pointerId);
        seekFromPointer(event);
      }}
      onPointerMove={(event) => {
        setHoverRatio(ratioFromPointer(event));
        if (draggingRef.current) seekFromPointer(event);
      }}
      onPointerUp={(event) => {
        draggingRef.current = false;
        if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
      }}
      onPointerCancel={() => { draggingRef.current = false; }}
      onPointerLeave={() => {
        if (!draggingRef.current) setHoverRatio(undefined);
      }}
      onKeyDown={handleKeyDown}
    >
      <span id={hintId} className="sr-only">点击任意位置跳转并播放，左右方向键每次移动五秒</span>
      <div className="audio-waveform-base">
        {asset.thumbnailUrl ? <img src={asset.thumbnailUrl} alt="" draggable={false} /> : <FallbackWaveform color="#94a0b4" />}
      </div>
      <div className="audio-waveform-progress" style={{ clipPath: `inset(0 ${(1 - progress) * 100}% 0 0)` }}>
        <div className="audio-waveform-progress-inner">
          {asset.thumbnailUrl ? <img src={asset.thumbnailUrl} alt="" draggable={false} /> : <FallbackWaveform color="#3f64e8" />}
        </div>
      </div>
      {active && <span className="audio-playhead" style={{ left: `${progress * 100}%` }} />}
      {hoverRatio !== undefined && duration > 0 && (
        <span className="audio-waveform-tooltip" style={{ left: `${hoverRatio * 100}%` }}>
          {formatAudioTime(hoverRatio * duration)}
        </span>
      )}
    </div>
  );
}
