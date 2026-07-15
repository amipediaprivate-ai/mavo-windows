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
import { canPlayAnimatedImage, loadOriginalAsset } from "../lib/desktopAssets";
import type { Asset } from "../types";

export type AnimatedImageStatus = "idle" | "loading" | "playing" | "stopped" | "error";

interface AnimatedImageValue {
  activeAsset?: Asset;
  playbackUrl?: string;
  status: AnimatedImageStatus;
  error: string;
  isActive: (asset: Asset) => boolean;
  toggle: (asset: Asset) => void;
}

const AnimatedImageContext = createContext<AnimatedImageValue | undefined>(undefined);

export function AnimatedImageProvider({ children }: { children: ReactNode }) {
  const playbackUrlRef = useRef<string | undefined>(undefined);
  const requestRef = useRef(0);
  const [activeAsset, setActiveAsset] = useState<Asset>();
  const [playbackUrl, setPlaybackUrl] = useState<string>();
  const [status, setStatus] = useState<AnimatedImageStatus>("idle");
  const [error, setError] = useState("");

  const replacePlaybackUrl = useCallback((nextUrl?: string) => {
    if (playbackUrlRef.current && playbackUrlRef.current !== nextUrl) {
      URL.revokeObjectURL(playbackUrlRef.current);
    }
    playbackUrlRef.current = nextUrl;
    setPlaybackUrl(nextUrl);
  }, []);

  useEffect(() => () => {
    requestRef.current += 1;
    if (playbackUrlRef.current) URL.revokeObjectURL(playbackUrlRef.current);
  }, []);

  const toggle = useCallback((asset: Asset) => {
    if (!canPlayAnimatedImage(asset)) return;

    if (activeAsset?.id === asset.id) {
      if (status === "playing" || status === "loading") {
        requestRef.current += 1;
        setStatus("stopped");
        return;
      }
      if (playbackUrlRef.current) {
        setError("");
        setStatus("playing");
        return;
      }
    }

    const requestId = ++requestRef.current;
    replacePlaybackUrl();
    setActiveAsset(asset);
    setError("");
    setStatus("loading");
    void loadOriginalAsset(asset)
      .then((url) => {
        if (requestId !== requestRef.current) {
          URL.revokeObjectURL(url);
          return;
        }
        replacePlaybackUrl(url);
        setStatus("playing");
      })
      .catch((loadError) => {
        if (requestId !== requestRef.current) return;
        setError(loadError instanceof Error ? loadError.message : "无法读取动图");
        setStatus("error");
      });
  }, [activeAsset?.id, replacePlaybackUrl, status]);

  const value = useMemo<AnimatedImageValue>(() => ({
    activeAsset,
    playbackUrl,
    status,
    error,
    isActive: (asset) => activeAsset?.id === asset.id,
    toggle,
  }), [activeAsset, error, playbackUrl, status, toggle]);

  return <AnimatedImageContext.Provider value={value}>{children}</AnimatedImageContext.Provider>;
}

export function useAnimatedImagePlayer() {
  const context = useContext(AnimatedImageContext);
  if (!context) throw new Error("useAnimatedImagePlayer must be used inside AnimatedImageProvider");
  return context;
}
