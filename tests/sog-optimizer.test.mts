import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_OPTIMIZE_SETTINGS,
  OPTIMIZER_VERSION,
  buildOptimizedMeta,
  buildZipArchive,
  cacheKey,
  chooseSplatIndices,
  encodePng,
  gatherPixels,
  imageSizeFor,
  parseZipArchive,
  readOpacity,
  readSogBundle,
  type ImagePixels,
  type SogMeta,
} from "../app/sog-optimizer.ts";

/** テスト用の最小PNGデコーダ。Canvasを通さずに1バイトずつ突き合わせる。 */
async function decodePng(png: Uint8Array): Promise<ImagePixels> {
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  assert.deepEqual(Array.from(png.subarray(0, 8)), [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  let offset = 8;
  let width = 0;
  let height = 0;
  const idat: Uint8Array[] = [];
  while (offset < png.length) {
    const length = view.getUint32(offset);
    const type = new TextDecoder().decode(png.subarray(offset + 4, offset + 8));
    const body = png.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      width = new DataView(body.buffer, body.byteOffset, body.byteLength).getUint32(0);
      height = new DataView(body.buffer, body.byteOffset, body.byteLength).getUint32(4);
      assert.equal(body[8], 8, "bit depth");
      assert.equal(body[9], 6, "RGBA color type");
      assert.equal(body[12], 0, "no interlace");
    } else if (type === "IDAT") {
      idat.push(body);
    }
    offset += 12 + length;
  }

  const deflated = new Blob(idat as BlobPart[]).stream().pipeThrough(new DecompressionStream("deflate"));
  const raw = new Uint8Array(await new Response(deflated).arrayBuffer());

  const stride = width * 4;
  const data = new Uint8Array(stride * height);
  const paeth = (a: number, b: number, c: number) => {
    const p = a + b - c;
    const pa = Math.abs(p - a);
    const pb = Math.abs(p - b);
    const pc = Math.abs(p - c);
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
  };
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    for (let x = 0; x < stride; x++) {
      const value = raw[y * (stride + 1) + 1 + x];
      const left = x >= 4 ? data[y * stride + x - 4] : 0;
      const up = y > 0 ? data[(y - 1) * stride + x] : 0;
      const upLeft = y > 0 && x >= 4 ? data[(y - 1) * stride + x - 4] : 0;
      const restored =
        filter === 1 ? value + left
          : filter === 2 ? value + up
            : filter === 3 ? value + ((left + up) >> 1)
              : filter === 4 ? value + paeth(left, up, upLeft)
                : value;
      data[y * stride + x] = restored & 0xff;
    }
  }
  return { width, height, data };
}

function noisyPixels(width: number, height: number): ImagePixels {
  const data = new Uint8Array(width * height * 4);
  let seed = 12345;
  for (let i = 0; i < data.length; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    data[i] = seed & 0xff;
  }
  // Canvasのアルファ乗算で必ず壊れる組み合わせを混ぜておく。
  data.set([200, 150, 90, 0], 0);
  data.set([255, 1, 128, 1], 4);
  data.set([17, 240, 3, 252], 8);
  return { width, height, data };
}

test("PNG round-trips every byte, including RGB under zero alpha", async () => {
  const source = noisyPixels(37, 11);
  const decoded = await decodePng(await encodePng(source));
  assert.equal(decoded.width, 37);
  assert.equal(decoded.height, 11);
  assert.deepEqual(decoded.data, source.data);
});

test("PNG filtering shrinks smooth data well below the raw size", async () => {
  const width = 64;
  const height = 64;
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    data[i * 4] = i % 256;
    data[i * 4 + 1] = (i >> 2) % 256;
    data[i * 4 + 2] = 128;
    data[i * 4 + 3] = 255;
  }
  const png = await encodePng({ width, height, data });
  assert.ok(png.length < data.length / 4, `expected compression, got ${png.length} of ${data.length}`);
  assert.deepEqual((await decodePng(png)).data, data);
});

test("zip archives round-trip through the PlayCanvas-compatible reader", async () => {
  const first = new Uint8Array([1, 2, 3, 4, 5]);
  const second = new TextEncoder().encode('{"version":2}');
  const zip = buildZipArchive([
    { filename: "means_l.png", data: first },
    { filename: "meta.json", data: second },
  ]);

  const entries = parseZipArchive(zip.buffer as ArrayBuffer);
  assert.deepEqual(entries.map((entry) => entry.filename), ["means_l.png", "meta.json"]);
  assert.ok(entries.every((entry) => entry.compression === "none"));

  const files = await readSogBundle(zip.buffer as ArrayBuffer);
  assert.deepEqual(files.get("means_l.png"), first);
  assert.deepEqual(files.get("meta.json"), second);
});

test("keeps the most opaque splat of each bucket and drops invisible ones", () => {
  const opacity = new Uint8Array([250, 0, 10, 0, 30, 200, 0, 40]);
  const kept = chooseSplatIndices(opacity, opacity.length, 2);
  // 不透明度0のsplatは候補から外れ、残り [0,2,4,5,7] を2バケットに割る。
  assert.deepEqual(Array.from(kept), [0, 5]);
  assert.ok(kept[0] < kept[1], "indices stay in source order");
});

test("returns every visible splat when the target is larger than the source", () => {
  const opacity = new Uint8Array([9, 0, 9]);
  assert.deepEqual(Array.from(chooseSplatIndices(opacity, 3, 500_000)), [0, 2]);
});

test("falls back to all splats when nothing clears the opacity floor", () => {
  const opacity = new Uint8Array([0, 0, 0, 0]);
  assert.deepEqual(Array.from(chooseSplatIndices(opacity, 4, 2)), [0, 2]);
});

test("gathers stream pixels in the chosen order", () => {
  const source: ImagePixels = {
    width: 2,
    height: 2,
    data: Uint8Array.from([
      0, 0, 0, 0, 11, 12, 13, 14, 21, 22, 23, 24, 31, 32, 33, 34,
    ]),
  };
  const gathered = gatherPixels(source, Uint32Array.from([3, 1]), { width: 2, height: 1 });
  assert.deepEqual(Array.from(gathered.data), [31, 32, 33, 34, 11, 12, 13, 14]);
});

test("reads opacity straight out of the sh0 alpha channel", () => {
  const sh0: ImagePixels = { width: 2, height: 1, data: Uint8Array.from([1, 2, 3, 200, 4, 5, 6, 7]) };
  assert.deepEqual(Array.from(readOpacity(sh0, 2)), [200, 7]);
});

test("sizes stream images the way splat-transform does", () => {
  assert.deepEqual(imageSizeFor(1_000_000), { width: 1000, height: 1000 });
  assert.deepEqual(imageSizeFor(500_000), { width: 708, height: 707 });
  assert.deepEqual(imageSizeFor(1), { width: 1, height: 1 });
});

const sourceMeta: SogMeta = {
  version: 2,
  count: 1_000_000,
  asset: { generator: "splat-transform v3.1.3" },
  means: { mins: [-1, -2, -3], maxs: [1, 2, 3], files: ["means_l.webp", "means_u.webp"] },
  scales: { codebook: [0.5], files: ["scales.webp"] },
  quats: { files: ["quats.webp"] },
  sh0: { codebook: [0.25], files: ["sh0.webp"] },
  shN: { count: 65536, bands: 3, codebook: [0.1], files: ["shN_centroids.webp", "shN_labels.webp"] },
};

test("rewrites meta while preserving codebooks and quantization ranges", () => {
  const meta = buildOptimizedMeta(sourceMeta, 500_000, false);
  assert.equal(meta.count, 500_000);
  assert.equal(meta.version, 2);
  assert.match(String(meta.asset?.generator), /vr-optimizer v1/);
  assert.deepEqual(meta.means.files, ["means_l.png", "means_u.png"]);
  assert.deepEqual(meta.means.mins, [-1, -2, -3]);
  assert.deepEqual(meta.scales.codebook, [0.5]);
  assert.deepEqual(meta.sh0.codebook, [0.25]);
  assert.equal(meta.shN, undefined, "spherical harmonics are dropped");
  assert.deepEqual(sourceMeta.means.files, ["means_l.webp", "means_u.webp"], "source meta untouched");
});

test("keeps spherical harmonics when asked to", () => {
  const meta = buildOptimizedMeta(sourceMeta, 250_000, true);
  assert.deepEqual(meta.shN?.files, ["shN_centroids.png", "shN_labels.png"]);
  assert.deepEqual(meta.shN?.codebook, [0.1]);
});

test("cache keys separate sources, targets, settings and optimizer versions", () => {
  const key = cacheKey("sha-a", DEFAULT_OPTIMIZE_SETTINGS);
  assert.equal(key, `sha-a:500000:nosh:v${OPTIMIZER_VERSION}`);
  assert.notEqual(key, cacheKey("sha-b", DEFAULT_OPTIMIZE_SETTINGS));
  assert.notEqual(key, cacheKey("sha-a", { ...DEFAULT_OPTIMIZE_SETTINGS, targetSplats: 250_000 }));
  assert.notEqual(key, cacheKey("sha-a", { ...DEFAULT_OPTIMIZE_SETTINGS, dropSphericalHarmonics: false }));
});
