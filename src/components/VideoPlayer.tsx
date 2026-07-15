import { useEffect, useId, useRef, useState, type CSSProperties, type MouseEvent, type RefObject } from "react";
import {
  LoaderCircle,
  Maximize2,
  Pause,
  Play,
  Repeat1,
  RotateCcw,
  RotateCw,
  Volume2,
  VolumeX,
} from "lucide-react";
import type { Asset } from "../types";
import { canPlayVideo, videoPlaybackUrl } from "../lib/desktopAssets";
import { assetAspectRatio } from "../lib/assetDimensions";
import { announceMediaPlayback, MEDIA_PLAYBACK_STARTED_EVENT, playbackOwner } from "../lib/mediaPlayback";
import { AssetThumbnail } from "./AssetThumbnail";

function formatVideoTime(seconds: number) {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const rounded = Math.floor(seconds);
  const hours = Math.floor(rounded / 3600);
  const minutes = Math.floor((rounded % 3600) / 60);
  const remainder = rounded % 60;
  return hours > 0
    ? `${hours}:${minutes.toString().padStart(2, "0")}:${remainder.toString().padStart(2, "0")}`
    : `${minutes}:${remainder.toString().padStart(2, "0")}`;
}

function videoErrorMessage(video: HTMLVideoElement) {
  switch (video.error?.code) {
    case MediaError.MEDIA_ERR_ABORTED:
      return "视频读取已中止";
    case MediaError.MEDIA_ERR_NETWORK:
      return "无法读取本地视频";
    case MediaError.MEDIA_ERR_DECODE:
      return "该视频编码暂不支持播放";
    case MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED:
      return "该视频格式暂不支持播放";
    default:
      return "视频播放失败";
  }
}

function useExclusiveVideo(videoRef: RefObject<HTMLVideoElement | null>) {
  const playerId = useId();

  useEffect(() => {
    const pauseForOtherMedia = (event: Event) => {
      if (playbackOwner(event) !== playerId) videoRef.current?.pause();
    };
    window.addEventListener(MEDIA_PLAYBACK_STARTED_EVENT, pauseForOtherMedia);
    return () => window.removeEventListener(MEDIA_PLAYBACK_STARTED_EVENT, pauseForOtherMedia);
  }, [playerId, videoRef]);

  return () => announceMediaPlayback(playerId);
}

interface PlayerState {
  currentTime: number;
  duration: number;
  loading: boolean;
  playing: boolean;
  error: string;
}

function initialState(asset: Asset): PlayerState {
  return {
    currentTime: 0,
    duration: (asset.durationMs ?? 0) / 1000,
    loading: false,
    playing: false,
    error: "",
  };
}

export function VideoCardPlayer({ asset }: { asset: Asset }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const announcePlayback = useExclusiveVideo(videoRef);
  const playable = canPlayVideo(asset);
  const [state, setState] = useState(() => initialState(asset));

  useEffect(() => setState(initialState(asset)), [asset]);

  const toggle = (event: MouseEvent) => {
    event.stopPropagation();
    const video = videoRef.current;
    if (!video || !playable) return;
    if (video.paused) {
      setState((current) => ({ ...current, loading: true, error: "" }));
      void video.play().catch(() => setState((current) => ({
        ...current,
        loading: false,
        error: videoErrorMessage(video),
      })));
    } else {
      video.pause();
    }
  };

  if (!playable) {
    return (
      <div className="video-card-player unavailable" onDoubleClick={(event) => event.stopPropagation()}>
        <AssetThumbnail asset={asset} />
        <button type="button" className="video-card-main-play" disabled title="该资源没有可播放的本地视频" aria-label="视频不可播放">
          <Play size={17} fill="currentColor" />
        </button>
      </div>
    );
  }

  return (
    <div className={`video-card-player ${state.playing ? "playing" : ""}`} onDoubleClick={(event) => event.stopPropagation()}>
      <video
        ref={videoRef}
        src={videoPlaybackUrl(asset)}
        poster={asset.thumbnailUrl}
        preload="none"
        muted
        playsInline
        onClick={toggle}
        onLoadStart={() => setState((current) => ({ ...current, loading: true }))}
        onLoadedMetadata={(event) => setState((current) => ({
          ...current,
          duration: Number.isFinite(event.currentTarget.duration) ? event.currentTarget.duration : current.duration,
          loading: false,
        }))}
        onTimeUpdate={(event) => setState((current) => ({ ...current, currentTime: event.currentTarget.currentTime }))}
        onPlaying={() => {
          announcePlayback();
          setState((current) => ({ ...current, playing: true, loading: false, error: "" }));
        }}
        onWaiting={() => setState((current) => ({ ...current, loading: true }))}
        onPause={() => setState((current) => ({ ...current, playing: false, loading: false }))}
        onEnded={() => setState((current) => ({ ...current, playing: false, currentTime: current.duration }))}
        onError={(event) => setState((current) => ({
          ...current,
          playing: false,
          loading: false,
          error: videoErrorMessage(event.currentTarget),
        }))}
      />
      <button className="video-card-main-play" type="button" onClick={toggle} aria-label={state.playing ? "暂停视频" : "播放视频"}>
        {state.loading ? <LoaderCircle className="video-spinner" size={17} /> : state.playing ? <Pause size={17} fill="currentColor" /> : <Play size={17} fill="currentColor" />}
      </button>
      {(state.playing || state.currentTime > 0) && (
        <div className="video-card-status">
          <span className="video-card-progress"><i style={{ width: `${state.duration > 0 ? state.currentTime / state.duration * 100 : 0}%` }} /></span>
          <time>{formatVideoTime(state.currentTime)} / {formatVideoTime(state.duration)}</time>
          <VolumeX size={12} />
        </div>
      )}
      {state.error && <span className="video-card-error" title={state.error}>{state.error}</span>}
    </div>
  );
}

export function VideoDetailPlayer({ asset }: { asset: Asset }) {
  const playerRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const announcePlayback = useExclusiveVideo(videoRef);
  const playable = canPlayVideo(asset);
  const [state, setState] = useState(() => initialState(asset));
  const [muted, setMuted] = useState(false);
  const [volume, setVolume] = useState(1);
  const [loop, setLoop] = useState(false);

  useEffect(() => {
    setState(initialState(asset));
    setMuted(false);
    setVolume(1);
    setLoop(false);
  }, [asset]);

  const toggle = () => {
    const video = videoRef.current;
    if (!video || !playable) return;
    if (video.paused) {
      setState((current) => ({ ...current, loading: true, error: "" }));
      void video.play().catch(() => setState((current) => ({ ...current, loading: false, error: videoErrorMessage(video) })));
    } else {
      video.pause();
    }
  };

  const seek = (time: number) => {
    const video = videoRef.current;
    if (!video) return;
    video.currentTime = Math.min(Math.max(time, 0), Math.max(state.duration, 0));
    setState((current) => ({ ...current, currentTime: video.currentTime }));
  };

  const changeVolume = (next: number) => {
    const video = videoRef.current;
    if (!video) return;
    video.volume = next;
    video.muted = next === 0;
    setVolume(next);
    setMuted(next === 0);
  };

  if (!playable) {
    return (
      <section className="video-detail-player unavailable" aria-label="视频播放器">
        <div className="video-detail-stage" style={{ aspectRatio: assetAspectRatio(asset) }}><AssetThumbnail asset={asset} large /></div>
        <p>{asset.availability === "missing" ? "原始视频文件已缺失" : "该资源没有可播放的本地视频"}</p>
      </section>
    );
  }

  return (
    <section ref={playerRef} className="video-detail-player" aria-label="视频播放器">
      <div className="video-detail-stage" style={{ aspectRatio: assetAspectRatio(asset) }} onDoubleClick={() => void playerRef.current?.requestFullscreen()}>
        <video
          ref={videoRef}
          src={videoPlaybackUrl(asset)}
          poster={asset.thumbnailUrl}
          preload="metadata"
          playsInline
          loop={loop}
          muted={muted}
          onClick={toggle}
          onLoadStart={() => setState((current) => ({ ...current, loading: true }))}
          onLoadedMetadata={(event) => setState((current) => ({
            ...current,
            duration: Number.isFinite(event.currentTarget.duration) ? event.currentTarget.duration : current.duration,
            loading: false,
          }))}
          onTimeUpdate={(event) => setState((current) => ({ ...current, currentTime: event.currentTarget.currentTime }))}
          onPlaying={() => {
            announcePlayback();
            setState((current) => ({ ...current, playing: true, loading: false, error: "" }));
          }}
          onWaiting={() => setState((current) => ({ ...current, loading: true }))}
          onPause={() => setState((current) => ({ ...current, playing: false, loading: false }))}
          onEnded={() => setState((current) => ({ ...current, playing: false, currentTime: current.duration }))}
          onError={(event) => setState((current) => ({ ...current, playing: false, loading: false, error: videoErrorMessage(event.currentTarget) }))}
        />
        {!state.playing && (
          <button className="video-detail-overlay-play" type="button" onClick={toggle} aria-label="播放视频">
            {state.loading ? <LoaderCircle className="video-spinner" size={23} /> : <Play size={23} fill="currentColor" />}
          </button>
        )}
      </div>
      <div className="video-detail-controls">
        <input
          className="video-detail-seek"
          type="range"
          min="0"
          max={Math.max(state.duration, 0)}
          step="0.05"
          value={Math.min(state.currentTime, Math.max(state.duration, 0))}
          onChange={(event) => seek(Number(event.target.value))}
          aria-label="视频进度"
          style={{ "--video-progress": `${state.duration > 0 ? state.currentTime / state.duration * 100 : 0}%` } as CSSProperties}
        />
        <div className="video-detail-control-row">
          <button type="button" onClick={toggle} aria-label={state.playing ? "暂停" : "播放"} title={state.playing ? "暂停" : "播放"}>
            {state.loading ? <LoaderCircle className="video-spinner" size={15} /> : state.playing ? <Pause size={15} fill="currentColor" /> : <Play size={15} fill="currentColor" />}
          </button>
          <button type="button" onClick={() => seek(state.currentTime - 10)} aria-label="后退十秒" title="后退 10 秒"><RotateCcw size={15} /></button>
          <button type="button" onClick={() => seek(state.currentTime + 10)} aria-label="前进十秒" title="前进 10 秒"><RotateCw size={15} /></button>
          <time>{formatVideoTime(state.currentTime)} <span>/ {formatVideoTime(state.duration)}</span></time>
          <span className="video-detail-spacer" />
          <button type="button" onClick={() => {
            const video = videoRef.current;
            if (!video) return;
            if (muted || volume === 0) {
              const restoredVolume = volume === 0 ? 1 : volume;
              video.volume = restoredVolume;
              video.muted = false;
              setVolume(restoredVolume);
              setMuted(false);
            } else {
              video.muted = true;
              setMuted(true);
            }
          }} aria-label={muted || volume === 0 ? "取消静音" : "静音"} title={muted || volume === 0 ? "取消静音" : "静音"}>
            {muted || volume === 0 ? <VolumeX size={15} /> : <Volume2 size={15} />}
          </button>
          <input className="video-volume" type="range" min="0" max="1" step="0.05" value={muted ? 0 : volume} onChange={(event) => changeVolume(Number(event.target.value))} aria-label="音量" />
          <button className={loop ? "active" : ""} type="button" onClick={() => setLoop((current) => !current)} aria-pressed={loop} aria-label="循环播放" title="循环播放"><Repeat1 size={15} /></button>
          <button type="button" onClick={() => void playerRef.current?.requestFullscreen()} aria-label="全屏播放" title="全屏"><Maximize2 size={15} /></button>
        </div>
      </div>
      {state.error && <p className="video-detail-error">{state.error}</p>}
    </section>
  );
}
