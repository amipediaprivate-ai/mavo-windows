import { LoaderCircle, Pause, Play } from "lucide-react";
import { useAnimatedImagePlayer } from "../animation/AnimatedImageContext";
import { canPlayAnimatedImage } from "../lib/desktopAssets";
import type { Asset } from "../types";
import { AssetThumbnail } from "./AssetThumbnail";

interface AnimatedImagePlayerProps {
  asset: Asset;
  variant: "card" | "detail";
}

export function AnimatedImagePlayer({ asset, variant }: AnimatedImagePlayerProps) {
  const player = useAnimatedImagePlayer();
  const active = player.isActive(asset);
  const playing = active && player.status === "playing" && Boolean(player.playbackUrl);
  const loading = active && player.status === "loading";
  const failed = active && player.status === "error";
  const playable = canPlayAnimatedImage(asset);
  const unavailableMessage = asset.availability === "missing"
    ? "原始动图文件已缺失"
    : asset.format.toUpperCase() !== "GIF"
      ? "该动图格式暂不支持播放"
      : "该资源没有可播放的本地动图";

  return (
    <div
      className={`animated-image-player ${variant} ${playing ? "playing" : ""}`}
      onDoubleClick={(event) => event.stopPropagation()}
    >
      {playing ? (
        <img className="animated-image-frame" src={player.playbackUrl} alt={`${asset.name} 播放中`} />
      ) : (
        <AssetThumbnail asset={asset} large={variant === "detail"} />
      )}
      <button
        className="animated-image-toggle"
        type="button"
        disabled={!playable}
        onClick={(event) => {
          event.stopPropagation();
          player.toggle(asset);
        }}
        aria-label={playing || loading ? "停止播放动图" : "播放动图"}
        aria-pressed={playing}
        title={playable ? (playing || loading ? "停止播放" : "播放动图") : unavailableMessage}
      >
        {loading ? (
          <LoaderCircle className="animated-image-spinner" size={variant === "detail" ? 17 : 13} />
        ) : playing ? (
          <Pause size={variant === "detail" ? 17 : 13} fill="currentColor" />
        ) : (
          <Play size={variant === "detail" ? 17 : 13} fill="currentColor" />
        )}
        {variant === "detail" && <span>{loading ? "正在载入" : playing ? "停止播放" : "播放动图"}</span>}
      </button>
      {variant === "detail" && <span className="animated-image-badge">{asset.format} 动图</span>}
      {failed && <span className="animated-image-error" title={player.error}>播放失败</span>}
    </div>
  );
}
