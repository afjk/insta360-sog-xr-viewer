/**
 * VR向けに軽量化したSOGを生成するための純粋関数群。
 *
 * SOGバンドルはZIPの中にWebP/PNGのストリームとmeta.jsonが入った形式で、
 * 各ストリームはsplat番号をそのままピクセル番号として並べたRGBA画像になっている。
 * そのためsplatを間引く処理は「残すインデックスを選び、各ストリームの
 * ピクセルを詰め直す」だけで済み、量子化やコードブックはそのまま使い回せる。
 *
 * 再エンコードにPNGを使うのは、Canvasのエンコーダがアルファ乗算済みで
 * 値を保持できないため。SOGはアルファに不透明度や量子化モードを詰めており、
 * 1ビットも壊せない。DOMにもWebGLにも依存しないので、そのままテストできる。
 */

/** 出力形式を変えたらこの値を上げる。キャッシュキーに含める。 */
export const OPTIMIZER_VERSION = 1;
export const DEFAULT_TARGET_SPLATS = 500_000;
/** UIから選べる目標splat数。将来の追加もここだけで済む。 */
export const TARGET_SPLAT_PRESETS = [250_000, 500_000, 750_000, 1_000_000];
/** これ未満の不透明度はほぼ見えないので、間引きの候補から外す。 */
export const MIN_VISIBLE_OPACITY = 2;

export type OptimizeSettings = {
  targetSplats: number;
  /** 視点依存の色（SH）を落とす。splat-transformのVR向け出力と同じ構成になる。 */
  dropSphericalHarmonics: boolean;
};

export const DEFAULT_OPTIMIZE_SETTINGS: OptimizeSettings = {
  targetSplats: DEFAULT_TARGET_SPLATS,
  dropSphericalHarmonics: true,
};

export type SogStream = { files: string[] } & Record<string, unknown>;

export type SogMeta = {
  version: number;
  count: number;
  asset?: Record<string, unknown>;
  means: SogStream;
  scales: SogStream;
  quats: SogStream;
  sh0: SogStream;
  shN?: SogStream;
};

export type ZipEntry = { filename: string; data: Uint8Array };
export type RawZipEntry = ZipEntry & { compression: "none" | "deflate" | "unknown" };

export type ImagePixels = { width: number; height: number; data: Uint8Array };

/** splat番号をピクセル番号として持つストリーム。centroidsは含まない。 */
export const PER_SPLAT_STREAMS = ["means_l", "means_u", "quats", "scales", "sh0", "sh_labels"] as const;

const ZIP_EOCD_MAGIC = 0x06054b50;
const ZIP_CDR_MAGIC = 0x02014b50;
const ZIP_LFH_MAGIC = 0x04034b50;
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(data: Uint8Array, seed = 0): number {
  let c = (seed ^ 0xffffffff) >>> 0;
  for (let i = 0; i < data.length; i++) c = (crcTable[(c ^ data[i]) & 0xff] ^ (c >>> 8)) >>> 0;
  return (c ^ 0xffffffff) >>> 0;
}

/** PlayCanvasのSOGローダーと同じ読み方でZIPの中身を列挙する。 */
export function parseZipArchive(buffer: ArrayBuffer): RawZipEntry[] {
  const view = new DataView(buffer);
  const u16 = (offset: number) => view.getUint16(offset, true);
  const u32 = (offset: number) => view.getUint32(offset, true);

  let eocd = -1;
  for (let offset = view.byteLength - 22; offset >= 0 && eocd < 0; offset--) {
    if (u32(offset) === ZIP_EOCD_MAGIC) eocd = offset;
  }
  if (eocd < 0) throw new Error("SOGを読み込めませんでした: ZIPの終端が見つかりません。");
  if (u32(eocd + 12) === 0xffffffff || u32(eocd + 16) === 0xffffffff) {
    throw new Error("SOGを読み込めませんでした: Zip64には対応していません。");
  }

  const entries: RawZipEntry[] = [];
  let offset = u32(eocd + 16);
  const count = u16(eocd + 8);
  for (let i = 0; i < count; i++) {
    if (u32(offset) !== ZIP_CDR_MAGIC) throw new Error("SOGを読み込めませんでした: 中央ディレクトリが壊れています。");
    const method = u16(offset + 10);
    const compressedSize = u32(offset + 20);
    const filenameLength = u16(offset + 28);
    const extraLength = u16(offset + 30);
    const commentLength = u16(offset + 32);
    const localOffset = u32(offset + 42);
    const filename = new TextDecoder().decode(new Uint8Array(buffer, offset + 46, filenameLength));
    if (u32(localOffset) !== ZIP_LFH_MAGIC) throw new Error("SOGを読み込めませんでした: ローカルヘッダが壊れています。");
    const dataOffset = localOffset + 30 + u16(localOffset + 26) + u16(localOffset + 28);
    entries.push({
      filename,
      compression: method === 0 ? "none" : method === 8 ? "deflate" : "unknown",
      data: new Uint8Array(buffer, dataOffset, compressedSize),
    });
    offset += 46 + filenameLength + extraLength + commentLength;
  }
  return entries;
}

async function collectStream(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = stream.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.byteLength;
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.byteLength;
  }
  return out;
}

async function compress(data: Uint8Array, format: "deflate" | "deflate-raw"): Promise<Uint8Array> {
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new CompressionStream(format));
  return collectStream(stream as ReadableStream<Uint8Array>);
}

export async function inflateRaw(data: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  return collectStream(stream as ReadableStream<Uint8Array>);
}

/** SOGバンドルを展開してファイル名→バイト列にする。 */
export async function readSogBundle(buffer: ArrayBuffer): Promise<Map<string, Uint8Array>> {
  const files = new Map<string, Uint8Array>();
  for (const entry of parseZipArchive(buffer)) {
    if (entry.compression === "unknown") {
      throw new Error(`SOGを読み込めませんでした: ${entry.filename} の圧縮方式に対応していません。`);
    }
    files.set(entry.filename, entry.compression === "deflate" ? await inflateRaw(entry.data) : entry.data);
  }
  return files;
}

/** 無圧縮（STORED）のZIPを組み立てる。中身は既に圧縮済みの画像なので再圧縮しない。 */
export function buildZipArchive(entries: ZipEntry[]): Uint8Array {
  const encoder = new TextEncoder();
  const parts = entries.map((entry) => ({
    name: encoder.encode(entry.filename),
    data: entry.data,
    crc: crc32(entry.data),
  }));

  const localSize = parts.reduce((sum, part) => sum + 30 + part.name.length + part.data.length, 0);
  const centralSize = parts.reduce((sum, part) => sum + 46 + part.name.length, 0);
  const out = new Uint8Array(localSize + centralSize + 22);
  const view = new DataView(out.buffer);
  const offsets: number[] = [];
  let at = 0;

  for (const part of parts) {
    offsets.push(at);
    view.setUint32(at, ZIP_LFH_MAGIC, true);
    view.setUint16(at + 4, 20, true); // version needed
    view.setUint16(at + 8, 0, true); // stored
    view.setUint32(at + 14, part.crc, true);
    view.setUint32(at + 18, part.data.length, true);
    view.setUint32(at + 22, part.data.length, true);
    view.setUint16(at + 26, part.name.length, true);
    out.set(part.name, at + 30);
    out.set(part.data, at + 30 + part.name.length);
    at += 30 + part.name.length + part.data.length;
  }

  const centralStart = at;
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    view.setUint32(at, ZIP_CDR_MAGIC, true);
    view.setUint16(at + 4, 20, true);
    view.setUint16(at + 6, 20, true);
    view.setUint16(at + 10, 0, true); // stored
    view.setUint32(at + 16, part.crc, true);
    view.setUint32(at + 20, part.data.length, true);
    view.setUint32(at + 24, part.data.length, true);
    view.setUint16(at + 28, part.name.length, true);
    view.setUint32(at + 42, offsets[i], true);
    out.set(part.name, at + 46);
    at += 46 + part.name.length;
  }

  view.setUint32(at, ZIP_EOCD_MAGIC, true);
  view.setUint16(at + 8, parts.length, true);
  view.setUint16(at + 10, parts.length, true);
  view.setUint32(at + 12, at - centralStart, true);
  view.setUint32(at + 16, centralStart, true);
  return out;
}

const paeth = (a: number, b: number, c: number) => {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
};

/**
 * 各行でフィルタを選び、PNGのスキャンラインを組み立てる。
 * 1回目のパスで5種類のフィルタのスコアだけを比べ、勝った1種類だけを書き出す。
 */
export function filterScanlines(width: number, height: number, rgba: Uint8Array): Uint8Array {
  const stride = width * 4;
  const out = new Uint8Array((stride + 1) * height);
  const scores = new Float64Array(5);

  const filtered = (filter: number, raw: number, left: number, up: number, upLeft: number) => {
    switch (filter) {
      case 1: return (raw - left) & 0xff;
      case 2: return (raw - up) & 0xff;
      case 3: return (raw - ((left + up) >> 1)) & 0xff;
      case 4: return (raw - paeth(left, up, upLeft)) & 0xff;
      default: return raw;
    }
  };

  for (let y = 0; y < height; y++) {
    const row = y * stride;
    const prior = row - stride;
    scores.fill(0);

    for (let x = 0; x < stride; x++) {
      const raw = rgba[row + x];
      const left = x >= 4 ? rgba[row + x - 4] : 0;
      const up = y > 0 ? rgba[prior + x] : 0;
      const upLeft = y > 0 && x >= 4 ? rgba[prior + x - 4] : 0;
      for (let filter = 0; filter < 5; filter++) {
        const value = filtered(filter, raw, left, up, upLeft);
        scores[filter] += value > 127 ? 256 - value : value;
      }
    }

    let bestFilter = 0;
    for (let filter = 1; filter < 5; filter++) {
      if (scores[filter] < scores[bestFilter]) bestFilter = filter;
    }

    const target = y * (stride + 1);
    out[target] = bestFilter;
    for (let x = 0; x < stride; x++) {
      const left = x >= 4 ? rgba[row + x - 4] : 0;
      const up = y > 0 ? rgba[prior + x] : 0;
      const upLeft = y > 0 && x >= 4 ? rgba[prior + x - 4] : 0;
      out[target + 1 + x] = filtered(bestFilter, rgba[row + x], left, up, upLeft);
    }
  }
  return out;
}

function pngChunk(type: string, body: Uint8Array): Uint8Array {
  const chunk = new Uint8Array(12 + body.length);
  const view = new DataView(chunk.buffer);
  view.setUint32(0, body.length);
  for (let i = 0; i < 4; i++) chunk[4 + i] = type.charCodeAt(i);
  chunk.set(body, 8);
  view.setUint32(8 + body.length, crc32(chunk.subarray(4, 8 + body.length)));
  return chunk;
}

/** 8bit RGBAのロスレスPNGを書き出す。Canvasを介さないので値が壊れない。 */
export async function encodePng(pixels: ImagePixels): Promise<Uint8Array> {
  const { width, height, data } = pixels;
  if (data.length < width * height * 4) throw new Error("PNGの画素数が足りません。");

  const header = new Uint8Array(13);
  const headerView = new DataView(header.buffer);
  headerView.setUint32(0, width);
  headerView.setUint32(4, height);
  header[8] = 8; // bit depth
  header[9] = 6; // RGBA
  const idat = await compress(filterScanlines(width, height, data), "deflate");

  const chunks = [
    new Uint8Array(PNG_SIGNATURE),
    pngChunk("IHDR", header),
    pngChunk("IDAT", idat),
    pngChunk("IEND", new Uint8Array(0)),
  ];
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}

/** splat-transformと同じく、splat数を正方形に近い画像へ収める。 */
export function imageSizeFor(count: number): { width: number; height: number } {
  const width = Math.max(1, Math.ceil(Math.sqrt(count)));
  return { width, height: Math.max(1, Math.ceil(count / width)) };
}

/**
 * 残すsplatのインデックスを選ぶ。
 *
 * 元データの並び順を保ったまま等間隔のバケットに切り、各バケットで最も
 * 不透明なsplatを残す。決定的なのでキャッシュとも噛み合う。
 *
 * 前提: SOGのストリームがsplat-transformの並び順（空間的に近いsplatが
 * 連続する）を保っていること。Insta360 Spatial Capture由来のSOGはこれを
 * 満たす。並び順が空間的でないSOGを与えた場合、選ばれるsplat数は変わらない
 * が、バケットが空間的にまとまらないため間引きの分布が偏りうる。あらゆる
 * SOGへ広げるなら、meansをデコードしてMorton順に並べ直してからバケットを
 * 切る方式へ移す必要がある。
 */
export function chooseSplatIndices(
  opacity: Uint8Array,
  count: number,
  targetSplats: number,
): Uint32Array {
  const visible = new Uint32Array(count);
  let visibleCount = 0;
  for (let i = 0; i < count; i++) {
    if (opacity[i] >= MIN_VISIBLE_OPACITY) visible[visibleCount++] = i;
  }
  // すべて透明なSOGでも表示は維持したいので、その場合は全splatを候補にする。
  if (visibleCount === 0) {
    for (let i = 0; i < count; i++) visible[i] = i;
    visibleCount = count;
  }

  const pool = visible.subarray(0, visibleCount);
  if (visibleCount <= targetSplats) return pool.slice();

  const kept = new Uint32Array(targetSplats);
  for (let bucket = 0; bucket < targetSplats; bucket++) {
    const start = Math.floor((bucket * visibleCount) / targetSplats);
    const end = Math.max(start + 1, Math.floor(((bucket + 1) * visibleCount) / targetSplats));
    let best = pool[start];
    let bestOpacity = opacity[best];
    for (let i = start + 1; i < end; i++) {
      const index = pool[i];
      if (opacity[index] > bestOpacity) {
        best = index;
        bestOpacity = opacity[index];
      }
    }
    kept[bucket] = best;
  }
  return kept;
}

/** 選んだインデックスの順にピクセルを詰め直す。 */
export function gatherPixels(
  source: ImagePixels,
  indices: Uint32Array,
  size: { width: number; height: number },
): ImagePixels {
  const data = new Uint8Array(size.width * size.height * 4);
  for (let i = 0; i < indices.length; i++) {
    const from = indices[i] * 4;
    const to = i * 4;
    data[to] = source.data[from];
    data[to + 1] = source.data[from + 1];
    data[to + 2] = source.data[from + 2];
    data[to + 3] = source.data[from + 3];
  }
  return { width: size.width, height: size.height, data };
}

/** sh0のアルファがそのまま不透明度なので、そこだけ抜き出す。 */
export function readOpacity(sh0: ImagePixels, count: number): Uint8Array {
  const opacity = new Uint8Array(count);
  for (let i = 0; i < count; i++) opacity[i] = sh0.data[i * 4 + 3];
  return opacity;
}

/**
 * 出力用のmeta.jsonを作る。コードブックや量子化範囲は元のまま使うので、
 * ファイル名とsplat数だけを差し替える。
 */
export function buildOptimizedMeta(
  meta: SogMeta,
  keptCount: number,
  keepSphericalHarmonics: boolean,
): SogMeta {
  const withFiles = (stream: SogStream, files: string[]): SogStream => ({ ...stream, files });
  const optimized: SogMeta = {
    ...meta,
    asset: {
      ...(meta.asset ?? {}),
      generator: `insta360-sog-xr-viewer vr-optimizer v${OPTIMIZER_VERSION}`,
    },
    count: keptCount,
    means: withFiles(meta.means, ["means_l.png", "means_u.png"]),
    scales: withFiles(meta.scales, ["scales.png"]),
    quats: withFiles(meta.quats, ["quats.png"]),
    sh0: withFiles(meta.sh0, ["sh0.png"]),
  };
  if (keepSphericalHarmonics && meta.shN) {
    optimized.shN = withFiles(meta.shN, ["shN_centroids.png", "shN_labels.png"]);
  } else {
    delete optimized.shN;
  }
  return optimized;
}

/** 同じSOG・同じ設定なら同じキーになるキャッシュキー。 */
export function cacheKey(sourceHash: string, settings: OptimizeSettings): string {
  return [
    sourceHash,
    settings.targetSplats,
    settings.dropSphericalHarmonics ? "nosh" : "sh",
    `v${OPTIMIZER_VERSION}`,
  ].join(":");
}

export async function sha256Hex(buffer: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
