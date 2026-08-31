/// <reference lib="webworker" />
/**
 * KISS-GS SOG-XTの取得とデコードをUIスレッドの外で走らせるWorker。
 *
 * UIスレッドが受け取るのは進捗と完成した属性配列だけで、`meta.json` の解析も
 * WebPのデコードも逆量子化もこちらで完結する。属性配列はTransferableとして
 * 渡すので、main threadへのコピーは起きない。
 *
 * WebPの読み出しには既存の `sog-image.ts` の `ImageReader` を使う。Canvas 2Dの
 * `getImageData` はアルファ乗算済みの値を返すため、量子化された数値そのものを
 * 詰めてあるSOG-XTの画像には使えない。WebGL2のテクスチャへ非乗算・色空間変換
 * なしで上げて `readPixels` する、この読み出し口をSOG-XTでも共有する。
 */
import { createImageReader, type ImageReader } from "./sog-image.ts";
import {
  SogXtError,
  decodeSogXt,
  parseSogXtMeta,
  sogXtPlaneUrls,
  type DecodedSogXt,
  type SogXtErrorCode,
  type SogXtMeta,
  type SogXtPixels,
  type SogXtPlanes,
} from "./sog-xt.ts";

export type SogXtRequest = { metadataUrl: string };

/** 読み込みの内訳。`?debug=1` とベンチマーク表示で使う。 */
export type SogXtTimings = {
  /** `meta.json` とWebPの取得にかかった合計。 */
  downloadMs: number;
  /** WebPを画素へ戻すのにかかった時間。 */
  imageDecodeMs: number;
  /** 逆量子化とマスク適用にかかった時間。 */
  decodeMs: number;
  /** Worker内の総時間。 */
  totalMs: number;
};

/** UIへ返す、コンテナの要約。`meta.json` そのものは渡さない。 */
export type SogXtSummary = {
  version: number;
  profile: string | null;
  /** `meta.json` が宣言しているsplat数。 */
  declaredCount: number;
  gridSide: number;
  gridEntries: number;
  /** active maskで落ちた数。 */
  maskedOut: number;
  shBands: 0 | 1 | 2 | 3;
  shCoeffs: number;
  files: number;
};

export type SogXtProgress = { type: "progress"; stage: string; ratio: number };
export type SogXtResult = {
  type: "done";
  decoded: DecodedSogXt;
  summary: SogXtSummary;
  downloadedBytes: number;
  timings: SogXtTimings;
};
export type SogXtFailure = { type: "error"; code: SogXtErrorCode; message: string; detail: string };
export type SogXtMessage = SogXtProgress | SogXtResult | SogXtFailure;

const worker = self as unknown as DedicatedWorkerGlobalScope;

const report = (stage: string, ratio: number) => {
  worker.postMessage({ type: "progress", stage, ratio } satisfies SogXtProgress);
};

/** 取得に失敗したら、どの段階かが分かるコードを付けて投げ直す。 */
async function fetchBytes(url: string, code: SogXtErrorCode): Promise<Uint8Array> {
  let response: Response;
  try {
    response = await fetch(url);
  } catch (error) {
    throw new SogXtError(code, `${url} (${String(error)})`);
  }
  if (!response.ok) throw new SogXtError(code, `${url} (HTTP ${response.status})`);
  return new Uint8Array(await response.arrayBuffer());
}

async function fetchMeta(url: string): Promise<SogXtMeta> {
  const bytes = await fetchBytes(url, "METADATA_DOWNLOAD_FAILED");
  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder().decode(bytes));
  } catch (error) {
    throw new SogXtError("METADATA_INVALID", String(error));
  }
  return parseSogXtMeta(json);
}

async function load(request: SogXtRequest): Promise<SogXtResult> {
  const startedAt = performance.now();
  performance.mark?.("sog-xt:worker:start");

  report("meta.jsonを取得中", 0.02);
  const downloadStart = performance.now();
  const meta = await fetchMeta(request.metadataUrl);
  const urls = sogXtPlaneUrls(meta, request.metadataUrl);

  // ストリーム名と取得先。SHの2枚はコンテナに無いこともある。
  const planeUrls: [keyof SogXtPlanes, string][] = (
    Object.entries(urls) as [keyof SogXtPlanes, string | null][]
  ).filter((entry): entry is [keyof SogXtPlanes, string] => entry[1] !== null);

  report("WebPを取得中", 0.08);
  let fetched = 0;
  let downloadedBytes = 0;
  const payloads = new Map<keyof SogXtPlanes, Uint8Array>();
  await Promise.all(
    planeUrls.map(async ([name, url]) => {
      const bytes = await fetchBytes(url, "IMAGE_DOWNLOAD_FAILED");
      payloads.set(name, bytes);
      downloadedBytes += bytes.byteLength;
      fetched += 1;
      report("WebPを取得中", 0.08 + (0.42 * fetched) / planeUrls.length);
    }),
  );
  const downloadMs = performance.now() - downloadStart;

  let reader: ImageReader | null = null;
  let imageDecodeMs = 0;
  try {
    reader = createImageReader();
    const imageStart = performance.now();
    const pixels: Partial<Record<keyof SogXtPlanes, SogXtPixels>> = {};
    let decodedImages = 0;
    for (const [name, url] of planeUrls) {
      const bytes = payloads.get(name);
      if (!bytes) throw new SogXtError("IMAGE_DOWNLOAD_FAILED", url);
      try {
        // MIMEの判定は拡張子で行うので、クエリを落としたファイル名を渡す。
        pixels[name] = await reader.read(bytes, new URL(url).pathname.split("/").pop() ?? url);
      } catch (error) {
        throw new SogXtError("IMAGE_DECODE_FAILED", `${url} (${String(error)})`);
      }
      payloads.delete(name);
      decodedImages += 1;
      report("WebPを展開中", 0.5 + (0.35 * decodedImages) / planeUrls.length);
    }
    imageDecodeMs = performance.now() - imageStart;

    report("Gaussianを復元中", 0.88);
    const decodeStart = performance.now();
    const decoded = decodeSogXt(meta, {
      mask: pixels.mask as SogXtPixels,
      meansLow: pixels.meansLow as SogXtPixels,
      meansHigh: pixels.meansHigh as SogXtPixels,
      opacities: pixels.opacities as SogXtPixels,
      scales: pixels.scales as SogXtPixels,
      quats: pixels.quats as SogXtPixels,
      sh0: pixels.sh0 as SogXtPixels,
      shCentroids: pixels.shCentroids ?? null,
      shLabels: pixels.shLabels ?? null,
    });
    const decodeMs = performance.now() - decodeStart;
    report("Gaussianを復元中", 0.99);

    performance.mark?.("sog-xt:worker:end");
    performance.measure?.("sog-xt:worker", "sog-xt:worker:start", "sog-xt:worker:end");

    return {
      type: "done",
      decoded,
      summary: {
        version: meta.version,
        profile: meta.profile ?? null,
        declaredCount: meta.count,
        gridSide: meta.gridSide,
        gridEntries: decoded.gridEntries,
        maskedOut: decoded.maskedOut,
        shBands: decoded.shBands,
        shCoeffs: meta.shN?.coeffs ?? 0,
        files: planeUrls.length + 1,
      },
      downloadedBytes,
      timings: {
        downloadMs: Math.round(downloadMs),
        imageDecodeMs: Math.round(imageDecodeMs),
        decodeMs: Math.round(decodeMs),
        totalMs: Math.round(performance.now() - startedAt),
      },
    };
  } finally {
    reader?.dispose();
  }
}

/** 結果に含まれるTypedArrayの裏バッファ。コピーせずにmain threadへ渡す。 */
const transferablesOf = (decoded: DecodedSogXt): Transferable[] => {
  const buffers = [
    decoded.position.buffer,
    decoded.scale.buffer,
    decoded.rotation.buffer,
    decoded.opacity.buffer,
    decoded.fDc.buffer,
  ];
  if (decoded.fRest) buffers.push(decoded.fRest.buffer);
  return buffers as Transferable[];
};

worker.onmessage = async (event: MessageEvent<SogXtRequest>) => {
  try {
    const result = await load(event.data);
    worker.postMessage(result, transferablesOf(result.decoded));
  } catch (error) {
    const failure: SogXtFailure =
      error instanceof SogXtError
        ? { type: "error", code: error.code, message: error.userMessage, detail: error.message }
        : {
            type: "error",
            code: "METADATA_INVALID",
            message: "KISS-GS SOG-XTを読み込めませんでした。",
            detail: String(error),
          };
    worker.postMessage(failure);
  }
};
