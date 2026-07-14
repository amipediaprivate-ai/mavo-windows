import type { Asset } from "../types";

export function AssetThumbnail({ asset, large = false }: { asset: Asset; large?: boolean }) {
  const gradientId = `gradient-${asset.id}`;
  if (asset.thumbnailUrl) {
    return (
      <div className={`asset-thumbnail real-preview ${large ? "large" : ""}`}>
        <img src={asset.thumbnailUrl} alt={`${asset.name} 预览`} loading="lazy" />
      </div>
    );
  }
  return (
    <div className={`asset-thumbnail motif-${asset.motif} ${large ? "large" : ""}`}>
      <svg viewBox="0 0 240 160" role="img" aria-label={`${asset.name} 预览`}>
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="1" y2="1">
            <stop stopColor={asset.palette[0]} />
            <stop offset="0.6" stopColor={asset.palette[1]} />
            <stop offset="1" stopColor={asset.palette[2]} />
          </linearGradient>
        </defs>
        <rect x="12" y="10" width="216" height="140" rx="24" fill={`url(#${gradientId})`} />
        <circle cx="192" cy="38" r="40" fill="rgba(255,255,255,.08)" />
        {asset.motif === "character" && (
          <>
            <circle cx="120" cy="68" r="31" fill="rgba(255,255,255,.27)" />
            <path d="M68 139c12-36 29-52 52-52s41 16 52 52" fill="rgba(255,255,255,.22)" />
            <path d="M97 61l10-19 12 13 14-19 10 27" fill="rgba(255,255,255,.7)" />
            <circle cx="108" cy="69" r="3.5" fill="#fff" />
            <circle cx="133" cy="69" r="3.5" fill="#fff" />
          </>
        )}
        {asset.motif === "landscape" && (
          <>
            <circle cx="177" cy="48" r="18" fill="rgba(255,255,255,.6)" />
            <path d="M20 135l55-62 28 31 27-46 91 77z" fill="rgba(255,255,255,.27)" />
            <path d="M20 138l81-48 35 26 34-22 54 44z" fill="rgba(5,18,38,.2)" />
          </>
        )}
        {asset.motif === "ui" && (
          <>
            <rect x="42" y="38" width="156" height="86" rx="14" fill="rgba(255,255,255,.2)" stroke="rgba(255,255,255,.55)" />
            <rect x="56" y="53" width="52" height="56" rx="9" fill="rgba(255,255,255,.2)" />
            <path d="M122 59h57M122 77h42M122 98h50" stroke="rgba(255,255,255,.75)" strokeWidth="7" strokeLinecap="round" />
          </>
        )}
        {asset.motif === "icon" && (
          <>
            <path d="M120 28l42 27 5 49-47 34-47-34 5-49z" fill="rgba(255,255,255,.23)" stroke="rgba(255,255,255,.65)" strokeWidth="4" />
            <path d="M120 48l20 25-20 42-20-42z" fill="rgba(255,255,255,.62)" />
          </>
        )}
        {asset.motif === "audio" && (
          <>
            <circle cx="120" cy="80" r="50" fill="rgba(255,255,255,.15)" />
            <path d="M66 83h9l6-22 10 43 10-65 11 79 11-63 10 48 9-33 8 13h23" fill="none" stroke="rgba(255,255,255,.85)" strokeWidth="5" strokeLinecap="round" strokeLinejoin="round" />
          </>
        )}
        {asset.motif === "video" && (
          <>
            <circle cx="120" cy="80" r="45" fill="rgba(255,255,255,.2)" stroke="rgba(255,255,255,.5)" strokeWidth="3" />
            <path d="M108 57l37 23-37 23z" fill="rgba(255,255,255,.85)" />
          </>
        )}
      </svg>
      {asset.metadataStatus === "unsupported" && (
        <span className="preview-unavailable">无法预览</span>
      )}
    </div>
  );
}
