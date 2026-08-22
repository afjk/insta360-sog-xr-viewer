/// <reference lib="webworker" />
/**
 * SOGの軽量化をUIスレッドの外で走らせるWorker。
 *
 * 変換はすべてブラウザ内で完結し、SOGを外部へ送ることはない。
 */
import { createImageReader, type ImageReader } from "./sog-image";
import {
  buildOptimizedMeta,
  buildZipArchive,
  chooseSplatIndices,
  encodePng,
  gatherPixels,
  imageSizeFor,
  readOpacity,
  readSogBundle,
  type ImagePixels,
  type OptimizeSettings,
  type SogMeta,
  type ZipEntry,
} from "./sog-optimizer";

export type OptimizeRequest = { buffer: ArrayBuffer; settings: OptimizeSettings };

export type OptimizeTimings = {
  decodeMs: number;
  decimateMs: number;
  encodeMs: number;
  totalMs: number;
};

export type OptimizeProgress = { type: "progress"; stage: string; ratio: number };
export type OptimizeResult = {
  type: "done";
  buffer: ArrayBuffer;
  splats: number;
  sourceSplats: number;
  bytes: number;
  timings: OptimizeTimings;
};
export type OptimizeFailure = { type: "error"; message: string };
export type OptimizeMessage = OptimizeProgress | OptimizeResult | OptimizeFailure;

const worker = self as unknown as DedicatedWorkerGlobalScope;

const report = (stage: string, ratio: number) => {
  worker.postMessage({ type: "progress", stage, ratio } satisfies OptimizeProgress);
};

/** ストリーム名 → meta.json 上の位置。centroidsはsplatごとではないので別扱い。 */
function perSplatFiles(meta: SogMeta, keepSh: boolean): string[] {
  const files = [
    meta.means.files[0],
    meta.means.files[1],
    meta.quats.files[0],
    meta.scales.files[0],
    meta.sh0.files[0],
  ];
  if (keepSh && meta.shN?.files[1]) files.push(meta.shN.files[1]);
  return files;
}

async function optimize(request: OptimizeRequest): Promise<OptimizeResult> {
  const startedAt = performance.now();
  report("SOGを解析中", 0.02);

  const files = await readSogBundle(request.buffer);
  const metaFile = files.get("meta.json");
  if (!metaFile) throw new Error("SOGにmeta.jsonが含まれていません。");
  const meta = JSON.parse(new TextDecoder().decode(metaFile)) as SogMeta;
  const sourceSplats = meta.count;
  if (!sourceSplats || sourceSplats < 1) throw new Error("SOGのsplat数を読み取れませんでした。");

  const keepSh = !request.settings.dropSphericalHarmonics && Boolean(meta.shN);
  const streamNames = perSplatFiles(meta, keepSh);

  let reader: ImageReader | null = null;
  let decodeMs = 0;
  let decimateMs = 0;
  let encodeMs = 0;

  try {
    reader = createImageReader();

    const decodeStart = performance.now();
    const streams = new Map<string, ImagePixels>();
    for (let i = 0; i < streamNames.length; i++) {
      const name = streamNames[i];
      const bytes = files.get(name);
      if (!bytes) throw new Error(`SOGに ${name} が含まれていません。`);
      streams.set(name, await reader.read(bytes, name));
      report("SOGを解析中", 0.05 + (0.3 * (i + 1)) / streamNames.length);
    }
    decodeMs = performance.now() - decodeStart;

    const decimateStart = performance.now();
    report("Gaussianを削減中", 0.38);
    const sh0 = streams.get(meta.sh0.files[0]);
    if (!sh0) throw new Error("SOGのsh0ストリームを読み取れませんでした。");
    const indices = chooseSplatIndices(
      readOpacity(sh0, sourceSplats),
      sourceSplats,
      request.settings.targetSplats,
    );
    const size = imageSizeFor(indices.length);
    const gathered = streamNames.map((name) => ({
      name,
      pixels: gatherPixels(streams.get(name) as ImagePixels, indices, size),
    }));
    streams.clear();
    decimateMs = performance.now() - decimateStart;

    const encodeStart = performance.now();
    const entries: ZipEntry[] = [];
    for (let i = 0; i < gathered.length; i++) {
      const stream = gathered[i];
      const filename = `${stream.name.replace(/\.[^.]+$/, "")}.png`;
      entries.push({ filename, data: await encodePng(stream.pixels) });
      report("SOGを圧縮中", 0.45 + (0.5 * (i + 1)) / (gathered.length + (keepSh ? 1 : 0)));
    }
    if (keepSh && meta.shN) {
      const centroidsName = meta.shN.files[0];
      const centroids = files.get(centroidsName);
      if (!centroids) throw new Error(`SOGに ${centroidsName} が含まれていません。`);
      entries.push({
        filename: `${centroidsName.replace(/\.[^.]+$/, "")}.png`,
        data: await encodePng(await reader.read(centroids, centroidsName)),
      });
    }
    encodeMs = performance.now() - encodeStart;

    const optimizedMeta = buildOptimizedMeta(meta, indices.length, keepSh);
    entries.push({
      filename: "meta.json",
      data: new TextEncoder().encode(JSON.stringify(optimizedMeta)),
    });

    report("SOGを圧縮中", 0.97);
    const archive = buildZipArchive(entries);
    const buffer = archive.buffer.slice(
      archive.byteOffset,
      archive.byteOffset + archive.byteLength,
    ) as ArrayBuffer;

    return {
      type: "done",
      buffer,
      splats: indices.length,
      sourceSplats,
      bytes: buffer.byteLength,
      timings: {
        decodeMs: Math.round(decodeMs),
        decimateMs: Math.round(decimateMs),
        encodeMs: Math.round(encodeMs),
        totalMs: Math.round(performance.now() - startedAt),
      },
    };
  } finally {
    reader?.dispose();
  }
}

worker.onmessage = async (event: MessageEvent<OptimizeRequest>) => {
  try {
    const result = await optimize(event.data);
    worker.postMessage(result, [result.buffer]);
  } catch (error) {
    worker.postMessage({
      type: "error",
      message: error instanceof Error ? error.message : "VR向けSOGを生成できませんでした。",
    } satisfies OptimizeFailure);
  }
};
