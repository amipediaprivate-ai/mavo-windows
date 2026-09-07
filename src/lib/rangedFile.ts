// Assemble large model files without making any individual protocol response
// unbounded. Three.js parsers consume the resulting complete buffer.
export async function readRangedFile(url: string, signal?: AbortSignal): Promise<ArrayBuffer> {
  const chunkSize = 8 * 1024 * 1024;
  const maxBytes = 512 * 1024 * 1024;
  let result: Uint8Array<ArrayBuffer> | undefined;
  let offset = 0;
  while (true) {
    signal?.throwIfAborted();
    const response = await fetch(url, { signal, headers: { Range: `bytes=${offset}-${offset + chunkSize - 1}` } });
    if (response.status === 200 && offset === 0) {
      const size = Number(response.headers.get("Content-Length"));
      if (size > maxBytes) throw new Error("模型超过 512 MiB，请使用系统查看器打开");
      return response.arrayBuffer();
    }
    if (response.status !== 206) throw new Error(`模型读取失败（${response.status}）`);
    const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers.get("Content-Range") ?? "");
    if (!range) throw new Error("模型分段响应缺少有效的文件范围");
    const [, startText, endText, totalText] = range;
    const start = Number(startText), end = Number(endText), total = Number(totalText);
    if (!Number.isSafeInteger(total) || total > maxBytes) throw new Error("模型超过 512 MiB，请使用系统查看器打开");
    if (start !== offset || end < start || end >= total || (result && total !== result.length)) throw new Error("模型文件范围不一致，请重试");
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (bytes.length !== end - start + 1) throw new Error("模型文件读取不完整，请重试");
    result ??= new Uint8Array(total);
    result.set(bytes, offset);
    offset = end + 1;
    if (offset === total) return result.buffer;
  }
}
