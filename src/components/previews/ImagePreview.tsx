import { useEffect, useState } from "react";
import { loadOriginalAsset } from "../../lib/desktopAssets";
import type { Asset } from "../../types";

export function ImagePreview({ asset }: { asset: Asset }) {
  const [url, setUrl] = useState<string>();
  const [error, setError] = useState("");

  useEffect(() => {
    let disposed = false;
    let objectUrl: string | undefined;
    setUrl(undefined);
    setError("");
    void loadOriginalAsset(asset)
      .then((nextUrl) => {
        objectUrl = nextUrl;
        if (disposed) URL.revokeObjectURL(nextUrl);
        else setUrl(nextUrl);
      })
      .catch((reason) => {
        if (!disposed) setError(reason instanceof Error ? reason.message : "无法读取原图");
      });
    return () => {
      disposed = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [asset]);

  if (error) return <div className="preview-adapter-message">{error}</div>;
  if (!url) return <div className="preview-adapter-message">正在读取原图…</div>;
  return <img src={url} alt={`${asset.name} 原图`} onError={() => setError("无法生成安全预览，请使用系统查看器打开原文件")} />;
}
