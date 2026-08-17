import { useEffect, useMemo, useState } from "react";
import { indexedAssetStreamUrl } from "../../lib/desktopAssets";
import type { Asset } from "../../types";

const sample = "天地玄黄 Caevir 设计资产 0123456789";

export function FontPreview({ asset }: { asset: Asset }) {
  const family = useMemo(() => `caevir-preview-${asset.id.replace(/[^a-z0-9-]/gi, "-")}`, [asset.id]);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let disposed = false;
    const face = new FontFace(family, `url("${indexedAssetStreamUrl(asset)}")`);
    setReady(false);
    setError("");
    void face.load()
      .then((loaded) => {
        if (disposed) return;
        document.fonts.add(loaded);
        setReady(true);
      })
      .catch((reason) => {
        if (!disposed) setError(reason instanceof Error ? reason.message : "无法加载字体");
      });
    return () => {
      disposed = true;
      document.fonts.delete(face);
    };
  }, [asset, family]);

  if (error) return <div className="preview-adapter-message">{error}</div>;
  if (!ready) return <div className="preview-adapter-message">正在加载字体…</div>;
  return (
    <div className="font-preview" style={{ fontFamily: `'${family}', sans-serif` }}>
      <p className="font-preview-display">{sample}</p>
      <p className="font-preview-letters">Aa Bb Cc 中文字体预览</p>
      <p className="font-preview-numbers">0123456789 !?@# ¥$%</p>
    </div>
  );
}
