import assert from "node:assert/strict";
import test from "node:test";
import { readRangedFile } from "../src/lib/rangedFile.ts";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";

test("reads a file larger than 32 MiB completely through bounded range responses", async () => {
  const previous = globalThis.fetch;
  const total = 33 * 1024 * 1024 + 7;
  let requests = 0;
  globalThis.fetch = async (_url, options) => {
    const [, startText, endText] = /bytes=(\d+)-(\d+)/.exec(options.headers.Range);
    const start = Number(startText), end = Math.min(Number(endText), total - 1);
    const bytes = new Uint8Array(end - start + 1).fill(requests++);
    assert.ok(bytes.length <= 8 * 1024 * 1024);
    return new Response(bytes, { status: 206, headers: { "Content-Range": `bytes ${start}-${end}/${total}` } });
  };
  try {
    const result = new Uint8Array(await readRangedFile("http://audit.local/model"));
    assert.equal(result.length, total);
    assert.equal(requests, 5);
    for (let i = 0; i < total; i++) assert.equal(result[i], Math.floor(i / (8 * 1024 * 1024)));
  } finally { globalThis.fetch = previous; }
});

test("rejects truncated ranges and observes cancellation", async () => {
  const previous = globalThis.fetch;
  globalThis.fetch = async () => new Response(new Uint8Array(2), { status: 206, headers: { "Content-Range": "bytes 0-3/4" } });
  try {
    await assert.rejects(readRangedFile("http://audit.local/model"), /不完整/);
    const controller = new AbortController(); controller.abort();
    await assert.rejects(readRangedFile("http://audit.local/model", controller.signal), { name: "AbortError" });
  } finally { globalThis.fetch = previous; }
});

test("a 33 MiB GLB loads through the installed Three.js parser", async () => {
  const previous = globalThis.fetch;
  const bytes = new Uint8Array(33 * 1024 * 1024);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, 0x46546c67, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, bytes.length, true);
  view.setUint32(12, bytes.length - 20, true);
  view.setUint32(16, 0x4e4f534a, true);
  bytes.fill(32, 20);
  bytes.set(new TextEncoder().encode(JSON.stringify({ asset: { version: "2.0" }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ name: "large-model-fixture" }] })), 20);
  globalThis.fetch = async (_url, options) => {
    const [, a, b] = /bytes=(\d+)-(\d+)/.exec(options.headers.Range);
    const start = Number(a), end = Math.min(Number(b), bytes.length - 1);
    return new Response(bytes.slice(start, end + 1), { status: 206, headers: { "Content-Range": `bytes ${start}-${end}/${bytes.length}` } });
  };
  try {
    const buffer = await readRangedFile("http://audit.local/model");
    const model = await new GLTFLoader().parseAsync(buffer, "");
    assert.equal(model.scene.children[0].name, "large-model-fixture");
  } finally { globalThis.fetch = previous; }
});
