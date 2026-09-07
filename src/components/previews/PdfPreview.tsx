import { useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { GlobalWorkerOptions, getDocument, type PDFDocumentProxy, type RenderTask } from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { indexedAssetStreamUrl } from "../../lib/desktopAssets";
import type { Asset } from "../../types";

GlobalWorkerOptions.workerSrc = workerUrl;

export function PdfPreview({ asset }: { asset: Asset }) {
  const url = indexedAssetStreamUrl(asset);
  return <PdfDocumentPreview key={`${url}:${asset.localPath}:${asset.modifiedAt}:${asset.sizeBytes}`} url={url} name={asset.name} />;
}

function PdfDocumentPreview({ url, name }: { url: string; name: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const renderTail = useRef<Promise<unknown>>(Promise.resolve());
  const [pdf, setPdf] = useState<PDFDocumentProxy>();
  const [pageNumber, setPageNumber] = useState(1);
  const [pageCount, setPageCount] = useState(0);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let disposed = false;
    const task = getDocument({ url });
    setLoading(true);
    setError("");
    void task.promise
      .then((document) => {
        if (disposed) return;
        setPageCount(document.numPages);
        setPdf(document);
      })
      .catch((reason) => {
        if (!disposed) {
          setError(reason instanceof Error ? reason.message : "无法加载 PDF");
          setLoading(false);
        }
      });
    return () => {
      disposed = true;
      void task.destroy().catch(() => undefined);
    };
  }, [url]);

  useEffect(() => {
    if (!pdf) return;
    let disposed = false;
    let render: RenderTask | undefined;
    setLoading(true);
    setError("");
    const previousRender = renderTail.current;
    const pending = (async () => {
        await previousRender.catch(() => undefined);
        if (disposed) return;
        const page = await pdf.getPage(pageNumber);
        if (disposed || !canvasRef.current) return;
        const viewport = page.getViewport({ scale: 1.35 });
        const canvas = canvasRef.current;
        const context = canvas.getContext("2d", { alpha: false });
        if (!context) throw new Error("当前设备无法创建 PDF 画布");
        canvas.width = Math.ceil(viewport.width);
        canvas.height = Math.ceil(viewport.height);
        render = page.render({ canvas, canvasContext: context, viewport });
        await render.promise;
      })()
      .catch((reason) => {
        if (!disposed) setError(reason instanceof Error ? reason.message : "无法渲染 PDF");
      })
      .finally(() => {
        if (!disposed) setLoading(false);
      });
    renderTail.current = pending;
    return () => {
      disposed = true;
      render?.cancel();
    };
  }, [pdf, pageNumber]);

  return (
    <div className="pdf-preview">
      <div className="pdf-preview-canvas">
        <canvas ref={canvasRef} aria-label={`${name} 第 ${pageNumber} 页`} />
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
