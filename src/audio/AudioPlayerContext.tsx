import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { Asset } from "../types";
import { audioPlaybackUrl, canPlayAudio } from "../lib/desktopAssets";

export type AudioPlaybackMode = "once" | "loop";
export type AudioPlaybackStatus = "idle" | "loading" | "playing" | "paused" | "error";

interface AudioPlayerValue {
  activeAsset?: Asset;
  status: AudioPlaybackStatus;
  currentTime: number;
  duration: number;
  mode: AudioPlaybackMode;
  error: string;
  isActive: (asset: Asset) => boolean;
  toggle: (asset: Asset) => void;
  seekAndPlay: (asset: Asset, time: number) => void;
  skip: (seconds: number) => void;
  setMode: (mode: AudioPlaybackMode) => void;
}

interface PendingPlayback {
  assetId: string;
  time?: number;
  autoplay: boolean;
}

const AudioPlayerContext = createContext<AudioPlayerValue | undefined>(undefined);

function savedPlaybackMode(): AudioPlaybackMode {
  try {
    return window.localStorage.getItem("mavo-audio-playback-mode") === "loop" ? "loop" : "once";
  } catch {
    return "once";
  }
}

function mediaErrorMessage(audio: HTMLAudioElement) {
  switch (audio.error?.code) {
    case MediaError.MEDIA_ERR_ABORTED:
      return "音频读取已中止";
    case MediaError.MEDIA_ERR_NETWORK:
      return "无法读取本地音频";
    case MediaError.MEDIA_ERR_DECODE:
      return "该音频编码暂不支持播放";
    case MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED:
      return "该音频格式暂不支持播放";
    default:
      return "音频播放失败";
  }
}

export function AudioPlayerProvider({ children }: { children: ReactNode }) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const activeAssetRef = useRef<Asset | undefined>(undefined);
  const pendingPlaybackRef = useRef<PendingPlayback | undefined>(undefined);
  const tickerRef = useRef<number | undefined>(undefined);
  const lastTickRef = useRef(0);
  const [activeAsset, setActiveAsset] = useState<Asset>();
  const [status, setStatus] = useState<AudioPlaybackStatus>("idle");
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [mode, setPlaybackMode] = useState<AudioPlaybackMode>(savedPlaybackMode);
  const [error, setError] = useState("");

  const stopTicker = useCallback(() => {
    if (tickerRef.current !== undefined) {
      window.cancelAnimationFrame(tickerRef.current);
      tickerRef.current = undefined;
    }
  }, []);

  const startTicker = useCallback(() => {
    stopTicker();
    const tick = (timestamp: number) => {
      const audio = audioRef.current;
      if (!audio || audio.paused) {
        tickerRef.current = undefined;
        return;
      }
      if (timestamp - lastTickRef.current >= 50) {
        lastTickRef.current = timestamp;
        setCurrentTime(audio.currentTime);
      }
      tickerRef.current = window.requestAnimationFrame(tick);
    };
    tickerRef.current = window.requestAnimationFrame(tick);
  }, [stopTicker]);

  useEffect(() => () => stopTicker(), [stopTicker]);

  const playElement = useCallback((audio: HTMLAudioElement) => {
    setError("");
    setStatus("loading");
    void audio.play().catch(() => {
      setStatus("error");
      setError(mediaErrorMessage(audio));
    });
  }, []);

  const prepareAsset = useCallback((asset: Asset, time: number | undefined, autoplay: boolean) => {
    const audio = audioRef.current;
    if (!audio) return;
    if (!canPlayAudio(asset)) {
      setActiveAsset(asset);
      activeAssetRef.current = asset;
      setStatus("error");
      setCurrentTime(0);
      setDuration((asset.durationMs ?? 0) / 1000);
      setError(asset.availability === "missing" ? "原始音频文件已缺失" : "该资源没有可播放的本地音频");
      return;
    }

    const sameAsset = activeAssetRef.current?.id === asset.id;
    if (!sameAsset) {
      audio.pause();
      activeAssetRef.current = asset;
      setActiveAsset(asset);
      setCurrentTime(0);
      setDuration((asset.durationMs ?? 0) / 1000);
      setError("");
      setStatus("loading");
      pendingPlaybackRef.current = { assetId: asset.id, time, autoplay };
      audio.src = audioPlaybackUrl(asset);
      audio.load();
      return;
    }

    if (time !== undefined && Number.isFinite(time)) {
      const maximum = Number.isFinite(audio.duration) ? audio.duration : (asset.durationMs ?? 0) / 1000;
      audio.currentTime = Math.min(Math.max(time, 0), Math.max(maximum, 0));
      setCurrentTime(audio.currentTime);
    }
    if (autoplay) playElement(audio);
  }, [playElement]);

  const toggle = useCallback((asset: Asset) => {
    const audio = audioRef.current;
    if (!audio) return;
    if (activeAssetRef.current?.id === asset.id && !audio.paused) {
      audio.pause();
      return;
    }
    const restartAt = activeAssetRef.current?.id === asset.id && Number.isFinite(audio.duration) && audio.currentTime >= audio.duration
      ? 0
      : undefined;
    prepareAsset(asset, restartAt, true);
  }, [prepareAsset]);

  const seekAndPlay = useCallback((asset: Asset, time: number) => {
    prepareAsset(asset, time, true);
  }, [prepareAsset]);

  const skip = useCallback((seconds: number) => {
    const audio = audioRef.current;
    if (!audio || !activeAssetRef.current) return;
    const maximum = Number.isFinite(audio.duration) ? audio.duration : duration;
    audio.currentTime = Math.min(Math.max(audio.currentTime + seconds, 0), Math.max(maximum, 0));
    setCurrentTime(audio.currentTime);
  }, [duration]);

  const setMode = useCallback((nextMode: AudioPlaybackMode) => {
    setPlaybackMode(nextMode);
    if (audioRef.current) audioRef.current.loop = nextMode === "loop";
    try {
      window.localStorage.setItem("mavo-audio-playback-mode", nextMode);
    } catch {
      // Playback still works if persistent storage is unavailable.
    }
  }, []);

  const value = useMemo<AudioPlayerValue>(() => ({
    activeAsset,
    status,
    currentTime,
    duration,
    mode,
    error,
    isActive: (asset) => activeAsset?.id === asset.id,
    toggle,
    seekAndPlay,
    skip,
    setMode,
  }), [activeAsset, status, currentTime, duration, mode, error, toggle, seekAndPlay, skip, setMode]);

  return (
    <AudioPlayerContext.Provider value={value}>
      {children}
      <audio
        ref={audioRef}
        className="global-audio-element"
        preload="metadata"
        loop={mode === "loop"}
        onLoadedMetadata={(event) => {
          const audio = event.currentTarget;
          setDuration(Number.isFinite(audio.duration) ? audio.duration : (activeAssetRef.current?.durationMs ?? 0) / 1000);
          const pending = pendingPlaybackRef.current;
          if (!pending || pending.assetId !== activeAssetRef.current?.id) return;
          pendingPlaybackRef.current = undefined;
          if (pending.time !== undefined) {
            audio.currentTime = Math.min(Math.max(pending.time, 0), Number.isFinite(audio.duration) ? audio.duration : pending.time);
            setCurrentTime(audio.currentTime);
          }
          if (pending.autoplay) playElement(audio);
        }}
        onPlaying={() => {
          setStatus("playing");
          startTicker();
        }}
        onWaiting={() => setStatus("loading")}
        onCanPlay={(event) => {
          if (!event.currentTarget.paused) setStatus("playing");
        }}
        onPause={(event) => {
          stopTicker();
          setCurrentTime(event.currentTarget.currentTime);
          if (!event.currentTarget.ended) setStatus("paused");
        }}
        onEnded={(event) => {
          stopTicker();
          setCurrentTime(event.currentTarget.duration);
          setStatus("paused");
        }}
        onError={(event) => {
          stopTicker();
          setStatus("error");
          setError(mediaErrorMessage(event.currentTarget));
        }}
      />
    </AudioPlayerContext.Provider>
  );
}

export function useAudioPlayer() {
  const context = useContext(AudioPlayerContext);
  if (!context) throw new Error("useAudioPlayer must be used inside AudioPlayerProvider");
  return context;
}
