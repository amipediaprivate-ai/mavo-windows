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
import { announceMediaPlayback, MEDIA_PLAYBACK_STARTED_EVENT, playbackOwner } from "../lib/mediaPlayback";

export type AudioPlaybackMode = "once" | "loop";
export type AudioPlaybackStatus = "idle" | "loading" | "playing" | "paused" | "error";
export type AudioSequenceStatus = "idle" | "playing" | "paused";

export interface AudioSequenceController {
  getNext: (currentAsset: Asset) => Promise<Asset | undefined>;
  onAssetChange: (asset: Asset) => void;
  onFinished?: () => void;
  onError?: (message: string) => void;
}

interface AudioPlayerValue {
  activeAsset?: Asset;
  status: AudioPlaybackStatus;
  currentTime: number;
  duration: number;
  volume: number;
  error: string;
  isActive: (asset: Asset) => boolean;
  modeFor: (asset: Asset) => AudioPlaybackMode;
  toggle: (asset: Asset) => void;
  seekAndPlay: (asset: Asset, time: number) => void;
  skip: (seconds: number) => void;
  setMode: (asset: Asset, mode: AudioPlaybackMode) => void;
  setVolume: (volume: number) => void;
  toggleMute: () => void;
}

interface AudioSequenceValue {
  activeAsset?: Asset;
  sequenceStatus: AudioSequenceStatus;
  startSequence: (asset: Asset, controller: AudioSequenceController) => void;
  pauseSequence: () => void;
  resumeSequence: () => void;
  stopSequence: () => void;
}

interface PendingPlayback {
  assetId: string;
  time?: number;
  autoplay: boolean;
}

const AudioPlayerContext = createContext<AudioPlayerValue | undefined>(undefined);
const AudioSequenceContext = createContext<AudioSequenceValue | undefined>(undefined);
const PLAYBACK_MODES_KEY = "caevir-audio-playback-modes";

function playbackModeKey(asset: Asset) {
  return asset.assetUid ?? asset.id;
}

function savedPlaybackModes(): Record<string, AudioPlaybackMode> {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(PLAYBACK_MODES_KEY) ?? "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, AudioPlaybackMode] => entry[1] === "loop"));
  } catch {
    return {};
  }
}

function savedVolume() {
  try {
    const saved = window.localStorage.getItem("caevir-audio-volume");
    if (saved === null) return 1;
    const value = Number(saved);
    return Number.isFinite(value) && value >= 0 && value <= 1 ? value : 1;
  } catch {
    return 1;
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
  const sequenceControllerRef = useRef<AudioSequenceController | undefined>(undefined);
  const sequenceGenerationRef = useRef(0);
  const sequenceAdvancingRef = useRef(false);
  const sequenceStatusRef = useRef<AudioSequenceStatus>("idle");
  const [activeAsset, setActiveAsset] = useState<Asset>();
  const [status, setStatus] = useState<AudioPlaybackStatus>("idle");
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [sequenceStatus, setSequenceStatusState] = useState<AudioSequenceStatus>("idle");
  const [playbackModes, setPlaybackModes] = useState<Record<string, AudioPlaybackMode>>(savedPlaybackModes);
  const playbackModesRef = useRef(playbackModes);
  const [volume, setVolumeState] = useState(savedVolume);
  const lastAudibleVolumeRef = useRef(volume > 0 ? volume : 1);
  const [error, setError] = useState("");
  playbackModesRef.current = playbackModes;

  const setSequenceStatus = useCallback((nextStatus: AudioSequenceStatus) => {
    sequenceStatusRef.current = nextStatus;
    setSequenceStatusState(nextStatus);
  }, []);

  const modeFor = useCallback((asset: Asset): AudioPlaybackMode => playbackModes[playbackModeKey(asset)] ?? "once", [playbackModes]);

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
      if (timestamp - lastTickRef.current >= 100) {
        lastTickRef.current = timestamp;
        setCurrentTime(audio.currentTime);
      }
      tickerRef.current = window.requestAnimationFrame(tick);
    };
    tickerRef.current = window.requestAnimationFrame(tick);
  }, [stopTicker]);

  useEffect(() => () => stopTicker(), [stopTicker]);

  useEffect(() => {
    if (audioRef.current) audioRef.current.volume = volume;
  }, [volume]);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio || !activeAsset) return;
    audio.loop = sequenceStatus === "idle" && modeFor(activeAsset) === "loop";
  }, [activeAsset, modeFor, sequenceStatus]);

  useEffect(() => {
    const pauseForOtherMedia = (event: Event) => {
      if (playbackOwner(event) !== "global-audio") audioRef.current?.pause();
    };
    window.addEventListener(MEDIA_PLAYBACK_STARTED_EVENT, pauseForOtherMedia);
    return () => window.removeEventListener(MEDIA_PLAYBACK_STARTED_EVENT, pauseForOtherMedia);
  }, []);

  const clearSequence = useCallback(() => {
    sequenceGenerationRef.current += 1;
    sequenceAdvancingRef.current = false;
    sequenceControllerRef.current = undefined;
    setSequenceStatus("idle");
    const audio = audioRef.current;
    const asset = activeAssetRef.current;
    if (audio && asset) audio.loop = playbackModesRef.current[playbackModeKey(asset)] === "loop";
  }, [setSequenceStatus]);

  const playElement = useCallback((audio: HTMLAudioElement) => {
    setError("");
    setStatus("loading");
    void audio.play().catch(() => {
      setStatus("error");
      setError(mediaErrorMessage(audio));
    });
  }, []);

  const prepareAsset = useCallback((asset: Asset, time: number | undefined, autoplay: boolean, preserveSequence = false) => {
    const audio = audioRef.current;
    if (!audio) return;
    if (!preserveSequence && sequenceStatusRef.current !== "idle") clearSequence();
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
    audio.loop = sequenceStatusRef.current === "idle" && playbackModesRef.current[playbackModeKey(asset)] === "loop";
    if (!sameAsset) {
      pendingPlaybackRef.current = { assetId: asset.id, time, autoplay };
      audio.pause();
      activeAssetRef.current = asset;
      setActiveAsset(asset);
      setCurrentTime(0);
      setDuration((asset.durationMs ?? 0) / 1000);
      setError("");
      setStatus("loading");
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
  }, [clearSequence, playElement]);

  const advanceSequence = useCallback(async () => {
    const controller = sequenceControllerRef.current;
    const currentAsset = activeAssetRef.current;
    if (!controller || !currentAsset || sequenceStatusRef.current === "idle") return;
    const generation = sequenceGenerationRef.current;
    sequenceAdvancingRef.current = true;
    try {
      const nextAsset = await controller.getNext(currentAsset);
      if (generation !== sequenceGenerationRef.current || controller !== sequenceControllerRef.current) return;
      sequenceAdvancingRef.current = false;
      if (!nextAsset) {
        clearSequence();
        setStatus("paused");
        controller.onFinished?.();
        return;
      }
      controller.onAssetChange(nextAsset);
      prepareAsset(nextAsset, 0, sequenceStatusRef.current === "playing", true);
    } catch (reason) {
      if (generation !== sequenceGenerationRef.current) return;
      sequenceAdvancingRef.current = false;
      const message = reason instanceof Error ? reason.message : "无法继续顺序播放";
      clearSequence();
      setStatus("error");
      setError(message);
      controller.onError?.(message);
    }
  }, [clearSequence, prepareAsset]);

  const toggle = useCallback((asset: Asset) => {
    const audio = audioRef.current;
    if (!audio) return;
    const sameAsset = activeAssetRef.current?.id === asset.id;
    if (sameAsset && !audio.paused) {
      audio.pause();
      return;
    }
    if (!sameAsset && sequenceStatusRef.current !== "idle") clearSequence();
    if (sameAsset && sequenceStatusRef.current === "paused") setSequenceStatus("playing");
    const restartAt = sameAsset && Number.isFinite(audio.duration) && audio.currentTime >= audio.duration ? 0 : undefined;
    prepareAsset(asset, restartAt, true, sameAsset && sequenceStatusRef.current !== "idle");
  }, [clearSequence, prepareAsset, setSequenceStatus]);

  const seekAndPlay = useCallback((asset: Asset, time: number) => {
    const sameSequenceAsset = sequenceStatusRef.current !== "idle" && activeAssetRef.current?.id === asset.id;
    if (sameSequenceAsset) setSequenceStatus("playing");
    prepareAsset(asset, time, true, sameSequenceAsset);
  }, [prepareAsset, setSequenceStatus]);

  const skip = useCallback((seconds: number) => {
    const audio = audioRef.current;
    if (!audio || !activeAssetRef.current) return;
    const maximum = Number.isFinite(audio.duration) ? audio.duration : duration;
    audio.currentTime = Math.min(Math.max(audio.currentTime + seconds, 0), Math.max(maximum, 0));
    setCurrentTime(audio.currentTime);
  }, [duration]);

  const setMode = useCallback((asset: Asset, nextMode: AudioPlaybackMode) => {
    setPlaybackModes((current) => {
      const next = { ...current };
      const key = playbackModeKey(asset);
      if (nextMode === "loop") next[key] = "loop"; else delete next[key];
      try {
        window.localStorage.setItem(PLAYBACK_MODES_KEY, JSON.stringify(next));
      } catch {
        // Playback still works if persistent storage is unavailable.
      }
      return next;
    });
    if (activeAssetRef.current?.id === asset.id && sequenceStatusRef.current === "idle" && audioRef.current) {
      audioRef.current.loop = nextMode === "loop";
    }
  }, []);

  const startSequence = useCallback((asset: Asset, controller: AudioSequenceController) => {
    sequenceGenerationRef.current += 1;
    sequenceAdvancingRef.current = false;
    sequenceControllerRef.current = controller;
    setSequenceStatus("playing");
    controller.onAssetChange(asset);
    prepareAsset(asset, 0, true, true);
  }, [prepareAsset, setSequenceStatus]);

  const pauseSequence = useCallback(() => {
    if (sequenceStatusRef.current === "idle") return;
    if (pendingPlaybackRef.current) pendingPlaybackRef.current.autoplay = false;
    audioRef.current?.pause();
    setSequenceStatus("paused");
    setStatus("paused");
  }, [setSequenceStatus]);

  const resumeSequence = useCallback(() => {
    if (sequenceStatusRef.current !== "paused") return;
    setSequenceStatus("playing");
    const audio = audioRef.current;
    if (!audio) return;
    if (sequenceAdvancingRef.current) {
      setStatus("loading");
      return;
    }
    if (pendingPlaybackRef.current) {
      pendingPlaybackRef.current.autoplay = true;
      setStatus("loading");
    } else {
      playElement(audio);
    }
  }, [playElement, setSequenceStatus]);

  const stopSequence = useCallback(() => {
    if (sequenceStatusRef.current === "idle") return;
    clearSequence();
    pendingPlaybackRef.current = undefined;
    const audio = audioRef.current;
    if (audio) {
      audio.pause();
      audio.currentTime = 0;
    }
    stopTicker();
    setCurrentTime(0);
    setStatus("idle");
  }, [clearSequence, stopTicker]);

  const setVolume = useCallback((nextVolume: number) => {
    const normalized = Math.min(Math.max(Number.isFinite(nextVolume) ? nextVolume : 1, 0), 1);
    if (normalized > 0) lastAudibleVolumeRef.current = normalized;
    if (audioRef.current) audioRef.current.volume = normalized;
    setVolumeState(normalized);
    try {
      window.localStorage.setItem("caevir-audio-volume", String(normalized));
    } catch {
      // Playback still works if persistent storage is unavailable.
    }
  }, []);

  const toggleMute = useCallback(() => {
    setVolume(volume > 0 ? 0 : lastAudibleVolumeRef.current);
  }, [setVolume, volume]);

  const value = useMemo<AudioPlayerValue>(() => ({
    activeAsset,
    status,
    currentTime,
    duration,
    volume,
    error,
    isActive: (asset) => activeAsset?.id === asset.id,
    modeFor,
    toggle,
    seekAndPlay,
    skip,
    setMode,
    setVolume,
    toggleMute,
  }), [activeAsset, status, currentTime, duration, volume, error, modeFor, toggle, seekAndPlay, skip, setMode, setVolume, toggleMute]);

  const sequenceValue = useMemo<AudioSequenceValue>(() => ({
    activeAsset,
    sequenceStatus,
    startSequence,
    pauseSequence,
    resumeSequence,
    stopSequence,
  }), [activeAsset, sequenceStatus, startSequence, pauseSequence, resumeSequence, stopSequence]);

  return (
    <AudioSequenceContext.Provider value={sequenceValue}>
      <AudioPlayerContext.Provider value={value}>
        {children}
        <audio
          ref={audioRef}
          className="global-audio-element"
          preload="metadata"
          onLoadedMetadata={(event) => {
            const audio = event.currentTarget;
            audio.loop = sequenceStatusRef.current === "idle" && !!activeAssetRef.current
              && playbackModesRef.current[playbackModeKey(activeAssetRef.current)] === "loop";
            setDuration(Number.isFinite(audio.duration) ? audio.duration : (activeAssetRef.current?.durationMs ?? 0) / 1000);
            const pending = pendingPlaybackRef.current;
            if (!pending || pending.assetId !== activeAssetRef.current?.id) return;
            pendingPlaybackRef.current = undefined;
            if (pending.time !== undefined) {
              audio.currentTime = Math.min(Math.max(pending.time, 0), Number.isFinite(audio.duration) ? audio.duration : pending.time);
              setCurrentTime(audio.currentTime);
            }
            if (pending.autoplay) playElement(audio); else setStatus("paused");
          }}
          onPlaying={() => {
            announceMediaPlayback("global-audio");
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
            if (!event.currentTarget.ended && !pendingPlaybackRef.current) {
              setStatus("paused");
              if (sequenceStatusRef.current === "playing") setSequenceStatus("paused");
            }
          }}
          onEnded={(event) => {
            stopTicker();
            setCurrentTime(event.currentTarget.duration);
            if (sequenceStatusRef.current !== "idle") void advanceSequence(); else setStatus("paused");
          }}
          onError={(event) => {
            stopTicker();
            pendingPlaybackRef.current = undefined;
            const message = mediaErrorMessage(event.currentTarget);
            setStatus("error");
            setError(message);
            if (sequenceStatusRef.current !== "idle") void advanceSequence();
          }}
        />
      </AudioPlayerContext.Provider>
    </AudioSequenceContext.Provider>
  );
}

export function useAudioPlayer() {
  const context = useContext(AudioPlayerContext);
  if (!context) throw new Error("useAudioPlayer must be used inside AudioPlayerProvider");
  return context;
}

export function useAudioSequence() {
  const context = useContext(AudioSequenceContext);
  if (!context) throw new Error("useAudioSequence must be used inside AudioPlayerProvider");
  return context;
}
