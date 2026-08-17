import { useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { GlobalWorkerOptions, getDocument } from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { indexedAssetStreamUrl } from "../../lib/desktopAssets";
import type { Asset } from "../../types";

GlobalWorkerOptions.workerSrc = workerUrl;

export function PdfPreview({ asset }: { asset: Asset }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [pageNumber, setPageNumber] = useState(1);
  const [pageCount, setPageCount] = useState(0);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let disposed = false;
    const task = getDocument({ url: indexedAssetStreamUrl(asset) });
    setLoading(true);
    setError("");
    void task.promise
      .then(async (document) => {
        if (disposed) return;
        setPageCount(document.numPages);
        const page = await document.getPage(pageNumber);
        if (disposed || !canvasRef.current) return;
        const viewport = page.getViewport({ scale: 1.35 });
        const canvas = canvasRef.current;
        const context = canvas.getContext("2d", { alpha: false });
        if (!context) throw new Error("当前设备无法创建 PDF 画布");
        canvas.width = Math.ceil(viewport.width);
        canvas.height = Math.ceil(viewport.height);
        await page.render({ canvas, canvasContext: context, viewport }).promise;
      })
      .catch((reason) => {
        if (!disposed) setError(reason instanceof Error ? reason.message : "无法渲染 PDF");
      })
      .finally(() => {
        if (!disposed) setLoading(false);
      });
    return () => {
      disposed = true;
      void task.destroy();
    };
  }, [asset, pageNumber]);

  return (
    <div className="pdf-preview">
      <div className="pdf-preview-canvas">
        <canvas ref={canvasRef} aria-label={`${asset.name} 第 ${pageNumber} 页`} />
        {loading && <span className="preview-adapter-message">正在渲染 PDF…</span>}
        {error && <span className="preview-adapter-message">{error}</span>}
      </div>
      {pageCount > 1 && (
        <div className="pdf-preview-controls">
          <button onClick={() => setPageNumber((page) => Math.max(1, page - 1))} disabled={pageNumber <= 1} aria-label="上一页"><ChevronLeft size={16} /></button>
          <span>{pageNumber} / {pageCount}</span>
          <button onClick={() => setPageNumber((page) => Math.min(pageCount, page + 1))} disabled={pageNumber >= pageCount} aria-label="下一页"><ChevronRight size={16} /></button>
        </div>
      )}
    </div>
  );
}
