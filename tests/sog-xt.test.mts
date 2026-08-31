import assert from "node:assert/strict";
import test from "node:test";
import {
  SH_C0,
  SOG_XT_FORMAT,
  SogXtError,
  activeIndicesOf,
  broadcastRange,
  colorFromDc,
  decodeShPalette,
  decodeSogXt,
  isSogXtMetadata,
  lerp,
  normObs,
  observedRange,
  parseSogXtMeta,
  parseSogXtUrl,
  signedExpm1,
  sogXtPlaneUrls,
  type SogXtMeta,
  type SogXtPixels,
  type SogXtPlanes,
} from "../app/sog-xt.ts";
import { Quat, Vec3, Vec4 } from "playcanvas";
import { createSogXtGSplatData, splatPropertiesOf } from "../app/sog-xt-playcanvas.ts";

/* -------------------------------------------------------------------------- */
/* 合成fixture                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * `gridSide × gridSide` のRGBA面を作る。
 *
 * 実物のKISS-GSサンプルはGarden 256kで4MB近くあり、リポジトリへ置くものでは
 * ない。ここでは既知の値を詰めた2×2の面で、量子化の逆変換だけを確かめる。
 * 実データとの突き合わせはKISS-GS公式サンプルのURLを開いて行う。
 */
function pixels(side: number, texels: number[][]): SogXtPixels {
  const data = new Uint8Array(side * side * 4);
  texels.forEach((texel, index) => {
    data[index * 4 + 0] = texel[0] ?? 0;
    data[index * 4 + 1] = texel[1] ?? 0;
    data[index * 4 + 2] = texel[2] ?? 0;
    data[index * 4 + 3] = texel[3] ?? 255;
  });
  return { width: side, height: side, data };
}

/** すべて同じ値で埋めた面。 */
const flat = (side: number, texel: number[]): SogXtPixels =>
  pixels(side, new Array(side * side).fill(texel));

const GRID = 2;
const ENTRIES = GRID * GRID;

/** 4セル中2セルが有効なマスク（`[1,0,1,0]`）。 */
const MASK_HALF = pixels(GRID, [[255], [0], [255], [0]]);
/** 全セル有効。 */
const MASK_ALL = flat(GRID, [255]);

function baseMeta(overrides: Partial<SogXtMeta> = {}): SogXtMeta {
  return {
    version: 3,
    format: SOG_XT_FORMAT,
    profile: "SOG-XT",
    count: ENTRIES,
    gridSide: GRID,
    mask: { files: ["active_mask.webp"] },
    means: { mins: -1, maxs: 1, files: ["means_bytes_0.webp", "means_bytes_1.webp"] },
    opacities: { mins: -4, maxs: 4, files: ["opacities.webp"] },
    scales: { mins: [-2, -2, -2], maxs: [0, 0, 0], files: ["scales.webp"] },
    quats: { mins: [-1, -1, -1, -1], maxs: [1, 1, 1, 1], files: ["quaternions.webp"], encoding: "direct" },
    sh0: { mins: [-1, -1, -1], maxs: [1, 1, 1], files: ["f_dc.webp"] },
    ...overrides,
  };
}

/**
 * 与えられた面でSOG-XTを一式そろえる。指定しなかったものは中央値で埋める。
 *
 * 観測レンジ（observed-minmax）は画像全体から取るので、テストしたい属性以外
 * のばらつきが結果に混ざらないよう、既定は「全セル同じ値」にしてある。
 */
function planesOf(overrides: Partial<SogXtPlanes> = {}): SogXtPlanes {
  return {
    mask: MASK_ALL,
    meansLow: flat(GRID, [0, 0, 0]),
    meansHigh: flat(GRID, [0, 0, 0]),
    opacities: flat(GRID, [0]),
    scales: flat(GRID, [0, 0, 0]),
    quats: flat(GRID, [0, 0, 0, 0]),
    sh0: flat(GRID, [0, 0, 0]),
    shCentroids: null,
    shLabels: null,
    ...overrides,
  };
}

/* -------------------------------------------------------------------------- */
/* metadata                                                                    */
/* -------------------------------------------------------------------------- */

test("parseSogXtMeta accepts a well-formed container", () => {
  const meta = parseSogXtMeta({
    version: 3,
    format: "sog-xt",
    profile: "SOG-XT",
    count: 128000,
    gridSide: 360,
    mask: { files: ["active_mask.webp"] },
    means: { mins: -3.8, maxs: 3.9, files: ["means_bytes_0.webp", "means_bytes_1.webp"] },
    opacities: { mins: -13.8, maxs: 13.8, files: ["opacities.webp"], normalize: "observed-minmax" },
    scales: { mins: [-13, -14, -13], maxs: [3, 1, 2], files: ["scales.webp"] },
    quats: { mins: [0.2, -0.7, -0.3, -0.8], maxs: [1, 0.8, 0.9, 0.8], files: ["quaternions.webp"], encoding: "direct" },
    sh0: { mins: [-2, -3, -3], maxs: [8, 7, 9], files: ["f_dc.webp"] },
    shN: {
      layout: "uv-codebook",
      coeffs: 15,
      centroidSide: 120,
      tileRows: 3,
      tileCols: 5,
      centroidsMins: new Array(45).fill(-1),
      centroidsMaxs: new Array(45).fill(1),
      files: ["f_rest_centroids.webp", "f_rest_labels.webp"],
    },
  });
  assert.equal(meta.count, 128000);
  assert.equal(meta.gridSide, 360);
  assert.equal(meta.means.files[0], "means_bytes_0.webp");
  assert.equal(meta.shN?.coeffs, 15);
  assert.equal(meta.quats.encoding, "direct");
});

test("parseSogXtMeta rejects a missing required field", () => {
  const meta = baseMeta() as unknown as Record<string, unknown>;
  delete meta.scales;
  assert.throws(
    () => parseSogXtMeta(meta),
    (error: unknown) => error instanceof SogXtError && error.code === "METADATA_INVALID",
  );
});

test("parseSogXtMeta rejects a count larger than the grid", () => {
  assert.throws(
    () => parseSogXtMeta({ ...baseMeta(), count: 5 }),
    (error: unknown) => error instanceof SogXtError && error.code === "METADATA_INVALID",
  );
});

test("parseSogXtMeta rejects an unsupported version", () => {
  assert.throws(
    () => parseSogXtMeta({ ...baseMeta(), version: 99 }),
    (error: unknown) => error instanceof SogXtError && error.code === "UNSUPPORTED_VERSION",
  );
});

test("parseSogXtMeta rejects a PlayCanvas SOG meta.json", () => {
  // PlayCanvas標準のSOGも `meta.json` という名前だが、`format` を持たない。
  // ここで弾けないと、SOG-XTのデコーダへ別形式が流れ込む。
  const playcanvasSog = {
    version: 2,
    count: 1000,
    means: { mins: [0, 0, 0], maxs: [1, 1, 1], files: ["means_l.webp", "means_u.webp"] },
    scales: { mins: [0, 0, 0], maxs: [1, 1, 1], files: ["scales.webp"] },
    quats: { files: ["quats.webp"] },
    sh0: { mins: [0, 0, 0], maxs: [1, 1, 1], files: ["sh0.webp"] },
  };
  assert.equal(isSogXtMetadata(playcanvasSog), false);
  assert.throws(
    () => parseSogXtMeta(playcanvasSog),
    (error: unknown) => error instanceof SogXtError && error.code === "METADATA_INVALID",
  );
});

test("parseSogXtMeta rejects an unsupported SH layout", () => {
  assert.throws(
    () =>
      parseSogXtMeta({
        ...baseMeta(),
        shN: {
          layout: "palette-v9",
          coeffs: 15,
          centroidSide: 8,
          tileRows: 3,
          tileCols: 5,
          centroidsMins: new Array(45).fill(-1),
          centroidsMaxs: new Array(45).fill(1),
          files: ["c.webp", "l.webp"],
        },
      }),
    (error: unknown) => error instanceof SogXtError && error.code === "UNSUPPORTED_SH",
  );
});

test("parseSogXtMeta rejects a quaternion encoding it cannot reconstruct", () => {
  const meta = baseMeta();
  assert.throws(
    () => parseSogXtMeta({ ...meta, quats: { ...meta.quats, encoding: "smallest-three" } }),
    (error: unknown) => error instanceof SogXtError && error.code === "METADATA_INVALID",
  );
});

test("parseSogXtUrl accepts a meta.json URL and a directory URL", () => {
  const fromFile = parseSogXtUrl("https://example.com/a/M/Garden/meta.json");
  assert.equal(fromFile?.metadataUrl, "https://example.com/a/M/Garden/meta.json");
  assert.equal(fromFile?.baseUrl, "https://example.com/a/M/Garden/");

  const fromDir = parseSogXtUrl("https://example.com/a/M/Garden");
  assert.equal(fromDir?.metadataUrl, "https://example.com/a/M/Garden/meta.json");

  const fromSlash = parseSogXtUrl("https://example.com/a/M/Garden/");
  assert.equal(fromSlash?.metadataUrl, "https://example.com/a/M/Garden/meta.json");
});

test("parseSogXtUrl leaves .sog bundles alone", () => {
  // bundled SOGは従来の経路が扱う。ここで拾ってしまうと既存の読み込みが壊れる。
  assert.equal(parseSogXtUrl("https://example.com/space.sog"), null);
  assert.equal(parseSogXtUrl("https://example.com/a/capture.SOG"), null);
  assert.equal(parseSogXtUrl("not a url"), null);
  assert.equal(parseSogXtUrl("ftp://example.com/dir"), null);
});

test("sogXtPlaneUrls resolves file names against the metadata URL", () => {
  const meta = parseSogXtMeta({
    ...baseMeta(),
    shN: {
      layout: "uv-codebook",
      coeffs: 15,
      centroidSide: 4,
      tileRows: 3,
      tileCols: 5,
      centroidsMins: new Array(45).fill(-1),
      centroidsMaxs: new Array(45).fill(1),
      files: ["f_rest_centroids.webp", "f_rest_labels.webp"],
    },
  });
  const urls = sogXtPlaneUrls(meta, "https://example.com/a/M/Garden/meta.json");
  assert.equal(urls.meansLow, "https://example.com/a/M/Garden/means_bytes_0.webp");
  assert.equal(urls.meansHigh, "https://example.com/a/M/Garden/means_bytes_1.webp");
  assert.equal(urls.shCentroids, "https://example.com/a/M/Garden/f_rest_centroids.webp");
  assert.equal(urls.shLabels, "https://example.com/a/M/Garden/f_rest_labels.webp");
});

/* -------------------------------------------------------------------------- */
/* 量子化の素の関数                                                            */
/* -------------------------------------------------------------------------- */

test("normObs maps the observed range onto 0..1", () => {
  assert.ok(Math.abs(normObs(0, 0, 255) - 0) < 1e-6);
  assert.ok(Math.abs(normObs(255, 0, 255) - 1) < 1e-6);
  assert.ok(Math.abs(normObs(128, 0, 255) - 128 / 255) < 1e-6);
  // 観測レンジが実際に狭いストリーム（KISS-GSのquaternionsは0..99だった）。
  assert.ok(Math.abs(normObs(99, 0, 99) - 1) < 1e-6);
  assert.ok(Math.abs(normObs(50, 0, 99) - 50 / 99) < 1e-6);
});

test("normObs stays finite when every texel holds the same value", () => {
  // 1e-8 を足さないとここでNaNになり、全属性が壊れる。
  assert.equal(Number.isFinite(normObs(7, 7, 7)), true);
  assert.equal(normObs(7, 7, 7), 0);
});

test("signedExpm1 inverts the encoder's signed-log", () => {
  const signedLog = (v: number) => Math.sign(v) * Math.log1p(Math.abs(v));
  for (const value of [-44.2, -1.5, 0, 0.25, 51.3]) {
    assert.ok(Math.abs(signedExpm1(signedLog(value)) - value) < 1e-6, `${value}`);
  }
});

test("observedRange scans every pixel of the plane", () => {
  const plane = pixels(2, [
    [10, 20, 30],
    [5, 200, 30],
    [255, 20, 30],
    [10, 20, 1],
  ]);
  assert.deepEqual(observedRange(plane.data, 1), { lo: 5, hi: 255 });
  assert.deepEqual(observedRange(plane.data, 3), { lo: 1, hi: 255 });
});

test("broadcastRange spreads a scalar across the axes", () => {
  assert.deepEqual(broadcastRange(-3.8, 3), [-3.8, -3.8, -3.8]);
  assert.deepEqual(broadcastRange([1, 2, 3], 3), [1, 2, 3]);
});

/* -------------------------------------------------------------------------- */
/* active mask                                                                 */
/* -------------------------------------------------------------------------- */

test("activeIndicesOf keeps only the cells the mask marks", () => {
  assert.deepEqual(Array.from(activeIndicesOf(MASK_HALF, GRID)), [0, 2]);
});

test("decodeSogXt drops the cells the active mask clears", () => {
  const decoded = decodeSogXt(baseMeta({ count: 2 }), planesOf({ mask: MASK_HALF }));
  assert.equal(decoded.count, 2);
  assert.equal(decoded.gridEntries, 4);
  assert.equal(decoded.maskedOut, 2);
  assert.equal(decoded.position.length, 6);
  assert.equal(decoded.opacity.length, 2);
});

test("decodeSogXt reads the masked-in splats, not the first N cells", () => {
  // セル1・3を落として、セル0とセル2の値だけが残ることを確かめる。
  const decoded = decodeSogXt(
    baseMeta({ count: 2, opacities: { mins: 0, maxs: 255, files: ["opacities.webp"] } }),
    planesOf({
      mask: MASK_HALF,
      opacities: pixels(GRID, [[0], [255], [255], [0]]),
    }),
  );
  // 観測レンジは 0..255。セル0が logit 0、セル2が logit 255。
  assert.ok(Math.abs(decoded.opacity[0] - 0.5) < 1e-6);
  assert.ok(decoded.opacity[1] > 0.999999);
});

test("decodeSogXt rejects an active mask that disagrees with meta.count", () => {
  assert.throws(
    () => decodeSogXt(baseMeta({ count: 4 }), planesOf({ mask: MASK_HALF })),
    (error: unknown) => error instanceof SogXtError && error.code === "INCONSISTENT_SPLAT_COUNT",
  );
});

/* -------------------------------------------------------------------------- */
/* position / means                                                            */
/* -------------------------------------------------------------------------- */

test("decodeSogXt combines the two means bytes as low + 256 * high", () => {
  // means は signed-log 空間で [-1, 1]。観測レンジは合成後の16bit値から取る。
  // ここでは 0 と 65535 が現れるので観測レンジは 0..65535 になり、
  // 16bit値 v は signed-log 値 (2 * v / 65535 - 1) に写る。
  const meta = baseMeta({ count: 4, means: { mins: -1, maxs: 1, files: ["m0.webp", "m1.webp"] } });
  const decoded = decodeSogXt(
    meta,
    planesOf({
      // low バイト: セル0が 0、セル1が 255、セル2が 0、セル3が 255
      meansLow: pixels(GRID, [[0, 0, 0], [255, 255, 255], [0, 0, 0], [255, 255, 255]]),
      // high バイト: セル0・1が 0、セル2・3が 255
      meansHigh: pixels(GRID, [[0, 0, 0], [0, 0, 0], [255, 255, 255], [255, 255, 255]]),
    }),
  );
  const n = decoded.count;
  const expected = (u16: number) => signedExpm1(lerp(-1, 1, u16 / 65535));
  // 成分ごとに連続した並びなので、x成分は [0, n) に入る。
  assert.ok(Math.abs(decoded.position[0] - expected(0)) < 1e-5);
  assert.ok(Math.abs(decoded.position[1] - expected(255)) < 1e-5);
  assert.ok(Math.abs(decoded.position[2] - expected(65280)) < 1e-5);
  assert.ok(Math.abs(decoded.position[3] - expected(65535)) < 1e-5);
  // 上位バイトの重みが 256 であること（取り違えると 255 倍ずれる）。
  assert.ok(Math.abs(decoded.position[2] - expected(255 * 256)) < 1e-5);
  assert.equal(decoded.position.length, 3 * n);
});

test("decodeSogXt applies the inverse signed-log, not a plain linear map", () => {
  // 中央値（16bitの真ん中）は signed-log 空間の 0 で、位置も 0 になる。
  const decoded = decodeSogXt(
    baseMeta({ count: 4 }),
    planesOf({
      meansLow: pixels(GRID, [[0, 0, 0], [255, 255, 255], [255, 255, 255], [255, 255, 255]]),
      meansHigh: pixels(GRID, [[0, 0, 0], [127, 127, 127], [255, 255, 255], [255, 255, 255]]),
    }),
  );
  // セル1 = 255 + 127*256 = 32767、観測レンジ 0..65535 の中点＝signed-log 0。
  assert.ok(Math.abs(decoded.position[1]) < 1e-4);
  // 端は exp(1) - 1。線形補間なら 1 になるので、ここで取り違えを検出できる。
  assert.ok(Math.abs(decoded.position[2] - (Math.E - 1)) < 1e-5);
});

/* -------------------------------------------------------------------------- */
/* scale                                                                       */
/* -------------------------------------------------------------------------- */

test("decodeSogXt returns linear scale, not log scale", () => {
  // scales の meta は log 空間で [-2, 0]。観測レンジ 0..255。
  const decoded = decodeSogXt(
    baseMeta({ count: 4 }),
    planesOf({
      scales: pixels(GRID, [[0, 0, 0], [255, 255, 255], [128, 128, 128], [0, 0, 0]]),
    }),
  );
  const n = decoded.count;
  assert.ok(Math.abs(decoded.scale[0] - Math.exp(-2)) < 1e-6);
  assert.ok(Math.abs(decoded.scale[1] - Math.exp(0)) < 1e-6);
  assert.ok(Math.abs(decoded.scale[2] - Math.exp(lerp(-2, 0, 128 / 255))) < 1e-6);
  // log値をそのまま返していないこと（返していれば負の値が出る）。
  for (let i = 0; i < decoded.scale.length; i++) assert.ok(decoded.scale[i] > 0);
  assert.equal(decoded.scale.length, 3 * n);
});

test("decodeSogXt keeps splats from blowing up when the log range is wide", () => {
  // 実データのscaleは log 空間で -14 付近まで振れる。exp を二重に掛けると
  // 巨大なsplatになるので、上限が meta の maxs の exp を超えないこと。
  const meta = baseMeta({
    count: 4,
    scales: { mins: [-14, -14, -14], maxs: [3, 3, 3], files: ["scales.webp"] },
  });
  const decoded = decodeSogXt(
    meta,
    planesOf({ scales: pixels(GRID, [[0, 0, 0], [255, 255, 255], [64, 64, 64], [200, 200, 200]]) }),
  );
  for (let i = 0; i < decoded.scale.length; i++) {
    assert.ok(decoded.scale[i] >= Math.exp(-14) - 1e-9);
    assert.ok(decoded.scale[i] <= Math.exp(3) + 1e-6);
  }
});

/* -------------------------------------------------------------------------- */
/* opacity                                                                     */
/* -------------------------------------------------------------------------- */

test("decodeSogXt returns post-sigmoid opacity", () => {
  const meta = baseMeta({ count: 4, opacities: { mins: -4, maxs: 4, files: ["opacities.webp"] } });
  const decoded = decodeSogXt(
    meta,
    planesOf({ opacities: pixels(GRID, [[0], [255], [128], [64]]) }),
  );
  const sigmoid = (v: number) => 1 / (1 + Math.exp(-v));
  assert.ok(Math.abs(decoded.opacity[0] - sigmoid(-4)) < 1e-6);
  assert.ok(Math.abs(decoded.opacity[1] - sigmoid(4)) < 1e-6);
  assert.ok(Math.abs(decoded.opacity[2] - sigmoid(lerp(-4, 4, 128 / 255))) < 1e-6);
  // すべて 0〜1 に収まり、飽和しきっていない。
  for (let i = 0; i < decoded.opacity.length; i++) {
    assert.ok(decoded.opacity[i] > 0 && decoded.opacity[i] < 1);
  }
});

test("decodeSogXt reads opacity from the red channel only", () => {
  // 緑・青に別の値が入っていても結果が変わらないこと。観測レンジを4chで
  // 取ってしまうと、ここで結果がずれる。
  const meta = baseMeta({ count: 4, opacities: { mins: -4, maxs: 4, files: ["opacities.webp"] } });
  const plain = decodeSogXt(meta, planesOf({ opacities: pixels(GRID, [[0], [255], [128], [64]]) }));
  const noisy = decodeSogXt(
    meta,
    planesOf({
      opacities: pixels(GRID, [
        [0, 9, 250],
        [255, 3, 7],
        [128, 240, 1],
        [64, 17, 33],
      ]),
    }),
  );
  assert.deepEqual(Array.from(noisy.opacity), Array.from(plain.opacity));
});

/* -------------------------------------------------------------------------- */
/* quaternion                                                                  */
/* -------------------------------------------------------------------------- */

test("decodeSogXt turns a stored identity quaternion into an identity xyzw", () => {
  // 格納は wxyz。w だけ最大、xyz は最小レンジの 0 に当たる値を入れる。
  const meta = baseMeta({
    count: 4,
    quats: { mins: [0, 0, 0, 0], maxs: [1, 1, 1, 1], files: ["quaternions.webp"], encoding: "direct" },
  });
  const decoded = decodeSogXt(
    meta,
    planesOf({
      quats: pixels(GRID, [
        [255, 0, 0, 0],
        [255, 0, 0, 0],
        [255, 0, 0, 0],
        [255, 0, 0, 0],
      ]),
    }),
  );
  const n = decoded.count;
  // 出力は xyzw。identity は (0, 0, 0, 1)。
  assert.ok(Math.abs(decoded.rotation[0] - 0) < 1e-6, "x");
  assert.ok(Math.abs(decoded.rotation[n] - 0) < 1e-6, "y");
  assert.ok(Math.abs(decoded.rotation[2 * n] - 0) < 1e-6, "z");
  assert.ok(Math.abs(decoded.rotation[3 * n] - 1) < 1e-6, "w");
});

test("decodeSogXt keeps the stored wxyz order when unpacking a 90° rotation", () => {
  // Y軸まわり90°: xyzw = (0, sin45, 0, cos45)。格納は wxyz なので
  // RGBA = (cos45, 0, sin45, 0)。レンジを [-1, 1]、観測レンジを 0..255 に
  // 取り、cos45 ≈ 0.7071 を最も近いバイトで表す。
  const half = Math.SQRT1_2;
  const byteFor = (value: number) => Math.round(((value + 1) / 2) * 255);
  const meta = baseMeta({
    count: 4,
    quats: { mins: [-1, -1, -1, -1], maxs: [1, 1, 1, 1], files: ["quaternions.webp"], encoding: "direct" },
  });
  const texel = [byteFor(half), byteFor(0), byteFor(half), byteFor(0)];
  const decoded = decodeSogXt(
    meta,
    // 観測レンジを 0..255 に固定するため、両端の値を持つセルも混ぜる。
    planesOf({ quats: pixels(GRID, [texel, [0, 0, 0, 0], [255, 255, 255, 255], texel]) }),
  );
  const n = decoded.count;
  const q = [decoded.rotation[0], decoded.rotation[n], decoded.rotation[2 * n], decoded.rotation[3 * n]];
  assert.ok(Math.abs(q[0]) < 0.01, `x=${q[0]}`);
  assert.ok(Math.abs(q[1] - half) < 0.01, `y=${q[1]}`);
  assert.ok(Math.abs(q[2]) < 0.01, `z=${q[2]}`);
  assert.ok(Math.abs(q[3] - half) < 0.01, `w=${q[3]}`);
});

test("decodeSogXt normalises the quaternion it emits", () => {
  const meta = baseMeta({
    count: 4,
    quats: { mins: [0, 0, 0, 0], maxs: [2, 2, 2, 2], files: ["quaternions.webp"], encoding: "direct" },
  });
  const decoded = decodeSogXt(
    meta,
    planesOf({
      quats: pixels(GRID, [
        [255, 255, 0, 0],
        [255, 0, 255, 0],
        [128, 128, 128, 255],
        [255, 255, 255, 255],
      ]),
    }),
  );
  const n = decoded.count;
  for (let i = 0; i < n; i++) {
    const length = Math.hypot(
      decoded.rotation[i],
      decoded.rotation[n + i],
      decoded.rotation[2 * n + i],
      decoded.rotation[3 * n + i],
    );
    assert.ok(Math.abs(length - 1) < 1e-5, `|q[${i}]| = ${length}`);
  }
});

/* -------------------------------------------------------------------------- */
/* f_dc                                                                        */
/* -------------------------------------------------------------------------- */

test("decodeSogXt returns SH DC coefficients, not colours", () => {
  const meta = baseMeta({ count: 4, sh0: { mins: [-2, -2, -2], maxs: [2, 2, 2], files: ["f_dc.webp"] } });
  const decoded = decodeSogXt(
    meta,
    planesOf({
      sh0: pixels(GRID, [
        [0, 128, 255],
        [255, 255, 255],
        [0, 0, 0],
        [128, 128, 128],
      ]),
    }),
  );
  const n = decoded.count;
  assert.ok(Math.abs(decoded.fDc[0] - -2) < 1e-6, "r");
  assert.ok(Math.abs(decoded.fDc[n] - lerp(-2, 2, 128 / 255)) < 1e-6, "g");
  assert.ok(Math.abs(decoded.fDc[2 * n] - 2) < 1e-6, "b");
  // 色にはしていない（色なら 0〜1 に収まる）。
  assert.ok(decoded.fDc[0] < 0);
});

test("colorFromDc matches the 3DGS DC-to-colour conversion", () => {
  // 中性グレーは DC 0。PlayCanvasの `updateColorData` と同じ式。
  assert.ok(Math.abs(colorFromDc(0) - 0.5) < 1e-9);
  assert.ok(Math.abs(colorFromDc(1) - (0.5 + SH_C0)) < 1e-9);
  // 白飛び側はクランプする。
  assert.equal(colorFromDc(100), 1);
  assert.equal(colorFromDc(-100), 0);
});

/* -------------------------------------------------------------------------- */
/* spherical harmonics                                                         */
/* -------------------------------------------------------------------------- */

/** 2×2のコードブック（centroidSide=2）を持つSHメタ。 */
const SH_META = {
  layout: "uv-codebook",
  coeffs: 15,
  centroidSide: 2,
  tileRows: 3,
  tileCols: 5,
  centroidsMins: new Array(45).fill(-1),
  centroidsMaxs: new Array(45).fill(1),
  files: ["f_rest_centroids.webp", "f_rest_labels.webp"],
};

/**
 * centroids画像を組む。幅 = centroidSide * tileCols、高さ = centroidSide * tileRows。
 * `value(centroid, tileRow, tileCol, channel)` がその位置のバイト値。
 */
function centroidPlane(
  side: number,
  tileRows: number,
  tileCols: number,
  value: (centroid: number, tileRow: number, tileCol: number, channel: number) => number,
): SogXtPixels {
  const width = side * tileCols;
  const height = side * tileRows;
  const data = new Uint8Array(width * height * 4);
  for (let row = 0; row < side; row++) {
    for (let col = 0; col < side; col++) {
      const centroid = row * side + col;
      for (let tileRow = 0; tileRow < tileRows; tileRow++) {
        for (let tileCol = 0; tileCol < tileCols; tileCol++) {
          const px = tileCol * side + col;
          const py = tileRow * side + row;
          const offset = 4 * (py * width + px);
          for (let channel = 0; channel < 3; channel++) {
            data[offset + channel] = value(centroid, tileRow, tileCol, channel);
          }
          data[offset + 3] = 255;
        }
      }
    }
  }
  return { width, height, data };
}

test("decodeShPalette lays coefficients out as channel * coeffs + coeff", () => {
  // すべてのタイルに同じ値を置き、チャンネルだけ変える。展開後は
  // R が [0, 15)、G が [15, 30)、B が [30, 45) の区画に入るはず。
  const centroids = centroidPlane(2, 3, 5, (_centroid, _row, _col, channel) =>
    channel === 0 ? 0 : channel === 1 ? 128 : 255,
  );
  const { palette, perCentroid } = decodeShPalette(SH_META, centroids);
  assert.equal(perCentroid, 45);
  for (let i = 0; i < 15; i++) {
    assert.ok(Math.abs(palette[i] - -1) < 1e-6, `R slot ${i}`);
    assert.ok(Math.abs(palette[15 + i] - lerp(-1, 1, 128 / 255)) < 1e-6, `G slot ${i}`);
    assert.ok(Math.abs(palette[30 + i] - 1) < 1e-6, `B slot ${i}`);
  }
});

test("decodeShPalette maps tile position onto the coefficient index", () => {
  // タイル (row, col) の係数番号は row * tileCols + col。
  const centroids = centroidPlane(2, 3, 5, (_centroid, tileRow, tileCol) =>
    Math.round(((tileRow * 5 + tileCol) / 14) * 255),
  );
  const { palette } = decodeShPalette(SH_META, centroids);
  for (let coeff = 0; coeff < 15; coeff++) {
    const expected = lerp(-1, 1, Math.round((coeff / 14) * 255) / 255);
    assert.ok(Math.abs(palette[coeff] - expected) < 1e-6, `coeff ${coeff}`);
  }
});

test("decodeShPalette rejects a centroid image of the wrong size", () => {
  assert.throws(
    () => decodeShPalette(SH_META, flat(4, [0, 0, 0])),
    (error: unknown) => error instanceof SogXtError && error.code === "INCONSISTENT_SPLAT_COUNT",
  );
});

test("decodeSogXt looks up SH per splat with label = green * side + red", () => {
  // centroid 0 は 0、centroid 3（row 1, col 1）は 255 で埋める。
  const centroids = centroidPlane(2, 3, 5, (centroid) => (centroid === 3 ? 255 : 0));
  const meta = baseMeta({ count: 2, shN: SH_META });
  const decoded = decodeSogXt(
    meta,
    planesOf({
      mask: MASK_HALF,
      shCentroids: centroids,
      // セル0 → (r=0, g=0) → centroid 0、セル2 → (r=1, g=1) → centroid 3。
      shLabels: pixels(GRID, [
        [0, 0, 0],
        [0, 0, 0],
        [1, 1, 0],
        [0, 0, 0],
      ]),
    }),
  );
  assert.equal(decoded.shBands, 3);
  assert.ok(decoded.fRest);
  const n = decoded.count;
  assert.equal(decoded.fRest?.length, n * 45);
  for (let slot = 0; slot < 45; slot++) {
    assert.ok(Math.abs((decoded.fRest as Float32Array)[slot * n + 0] - -1) < 1e-6, `splat 0 slot ${slot}`);
    assert.ok(Math.abs((decoded.fRest as Float32Array)[slot * n + 1] - 1) < 1e-6, `splat 1 slot ${slot}`);
  }
});

test("decodeSogXt reports SH bands 0 when the container has no shN", () => {
  const decoded = decodeSogXt(baseMeta(), planesOf());
  assert.equal(decoded.shBands, 0);
  assert.equal(decoded.fRest, null);
});

/* -------------------------------------------------------------------------- */
/* malformed images                                                            */
/* -------------------------------------------------------------------------- */

test("decodeSogXt rejects a plane whose size disagrees with gridSide", () => {
  assert.throws(
    () => decodeSogXt(baseMeta(), planesOf({ scales: flat(4, [0, 0, 0]) })),
    (error: unknown) => error instanceof SogXtError && error.code === "INCONSISTENT_SPLAT_COUNT",
  );
  assert.throws(
    () => decodeSogXt(baseMeta(), planesOf({ mask: flat(1, [255]) })),
    (error: unknown) => error instanceof SogXtError && error.code === "INCONSISTENT_SPLAT_COUNT",
  );
});

test("decodeSogXt rejects an SH label outside the codebook", () => {
  const centroids = centroidPlane(2, 3, 5, () => 0);
  assert.throws(
    () =>
      decodeSogXt(
        baseMeta({ count: 4, shN: SH_META }),
        planesOf({
          shCentroids: centroids,
          // g = 200 → label 400、コードブックは 4 件しかない。
          shLabels: pixels(GRID, [
            [0, 200, 0],
            [0, 0, 0],
            [0, 0, 0],
            [0, 0, 0],
          ]),
        }),
      ),
    (error: unknown) => error instanceof SogXtError && error.code === "UNSUPPORTED_SH",
  );
});

/* -------------------------------------------------------------------------- */
/* PlayCanvasへ渡す形                                                          */
/* -------------------------------------------------------------------------- */

test("splatPropertiesOf hands PlayCanvas the PLY property names it reads", () => {
  const centroids = centroidPlane(2, 3, 5, (centroid) => (centroid === 3 ? 255 : 0));
  const decoded = decodeSogXt(
    baseMeta({ count: 4, shN: SH_META }),
    planesOf({ shCentroids: centroids, shLabels: flat(GRID, [0, 0, 0]) }),
  );
  const properties = splatPropertiesOf(decoded);
  const names = properties.map((property) => property.name);
  for (const name of ["x", "y", "z", "opacity", "scale_0", "scale_1", "scale_2"]) {
    assert.ok(names.includes(name), name);
  }
  for (let i = 0; i < 4; i++) assert.ok(names.includes(`rot_${i}`), `rot_${i}`);
  for (let i = 0; i < 3; i++) assert.ok(names.includes(`f_dc_${i}`), `f_dc_${i}`);
  // PlayCanvasは `f_rest_0` から連番で数えて帯域を決める（45本で3帯域）。
  for (let i = 0; i < 45; i++) assert.ok(names.includes(`f_rest_${i}`), `f_rest_${i}`);
  for (const property of properties) assert.equal(property.storage.length, decoded.count);
});

test("splatPropertiesOf maps xyzw onto PlayCanvas rot_0 = w", () => {
  const meta = baseMeta({
    count: 4,
    quats: { mins: [0, 0, 0, 0], maxs: [1, 1, 1, 1], files: ["quaternions.webp"], encoding: "direct" },
  });
  const decoded = decodeSogXt(
    meta,
    planesOf({
      quats: pixels(GRID, [
        [255, 0, 0, 0],
        [255, 0, 0, 0],
        [255, 0, 0, 0],
        [255, 0, 0, 0],
      ]),
    }),
  );
  const byName = new Map(splatPropertiesOf(decoded).map((property) => [property.name, property.storage]));
  // 格納された identity は PlayCanvas側でも identity（rot_0 = w = 1）。
  assert.ok(Math.abs((byName.get("rot_0") as Float32Array)[0] - 1) < 1e-6, "rot_0 = w");
  assert.ok(Math.abs((byName.get("rot_1") as Float32Array)[0]) < 1e-6, "rot_1 = x");
  assert.ok(Math.abs((byName.get("rot_2") as Float32Array)[0]) < 1e-6, "rot_2 = y");
  assert.ok(Math.abs((byName.get("rot_3") as Float32Array)[0]) < 1e-6, "rot_3 = z");
});

test("splatPropertiesOf slices the decoded arrays without copying", () => {
  const decoded = decodeSogXt(baseMeta(), planesOf());
  const byName = new Map(splatPropertiesOf(decoded).map((property) => [property.name, property.storage]));
  assert.equal((byName.get("x") as Float32Array).buffer, decoded.position.buffer);
  assert.equal((byName.get("z") as Float32Array).byteOffset, decoded.position.BYTES_PER_ELEMENT * 2 * decoded.count);
});

test("splatPropertiesOf omits f_rest when the container carries no SH", () => {
  const decoded = decodeSogXt(baseMeta(), planesOf());
  const names = splatPropertiesOf(decoded).map((property) => property.name);
  assert.equal(names.some((name) => name.startsWith("f_rest_")), false);
});

/* -------------------------------------------------------------------------- */
/* PlayCanvasのGSplatDataが実際にどう読むか                                    */
/* -------------------------------------------------------------------------- */

test("createSogXtGSplatData marks the data as activated", () => {
  // `activated` を落とすとPlayCanvasは scale を log、opacity を pre-sigmoid と
  // 解釈する。splatが exp() のぶんだけ巨大になり、不透明度が飽和する。
  const decoded = decodeSogXt(baseMeta(), planesOf());
  const data = createSogXtGSplatData(decoded);
  assert.equal(data.activated, true);
  assert.equal(data.numSplats, decoded.count);
});

test("PlayCanvas reads back the scale and opacity we decoded, unchanged", () => {
  const meta = baseMeta({
    count: 4,
    scales: { mins: [-2, -2, -2], maxs: [0, 0, 0], files: ["scales.webp"] },
    opacities: { mins: -4, maxs: 4, files: ["opacities.webp"] },
  });
  const decoded = decodeSogXt(
    meta,
    planesOf({
      scales: pixels(GRID, [[0, 0, 0], [255, 255, 255], [128, 128, 128], [64, 64, 64]]),
      opacities: pixels(GRID, [[0], [255], [128], [64]]),
    }),
  );
  const data = createSogXtGSplatData(decoded);
  const position = new Vec3();
  const rotation = new Quat();
  const scale = new Vec3();
  const colour = new Vec4();
  const iterator = data.createIter(position, rotation, scale, colour);

  iterator.read(0);
  // scale は線形のまま（activated なら exp を重ねない）。
  assert.ok(Math.abs(scale.x - Math.exp(-2)) < 1e-6);
  // opacity も sigmoid を重ねない。
  assert.ok(Math.abs(colour.w - decoded.opacity[0]) < 1e-6);

  iterator.read(1);
  assert.ok(Math.abs(scale.x - 1) < 1e-6);
  assert.ok(Math.abs(colour.w - decoded.opacity[1]) < 1e-6);
});

test("PlayCanvas reads an identity quaternion back as identity", () => {
  const meta = baseMeta({
    count: 4,
    quats: { mins: [0, 0, 0, 0], maxs: [1, 1, 1, 1], files: ["quaternions.webp"], encoding: "direct" },
  });
  const decoded = decodeSogXt(
    meta,
    planesOf({
      quats: pixels(GRID, [
        [255, 0, 0, 0],
        [255, 0, 0, 0],
        [255, 0, 0, 0],
        [255, 0, 0, 0],
      ]),
    }),
  );
  const rotation = new Quat();
  createSogXtGSplatData(decoded).createIter(null, rotation, null, null).read(0);
  assert.ok(Math.abs(rotation.x) < 1e-6, "x");
  assert.ok(Math.abs(rotation.y) < 1e-6, "y");
  assert.ok(Math.abs(rotation.z) < 1e-6, "z");
  assert.ok(Math.abs(rotation.w - 1) < 1e-6, "w");
});

test("PlayCanvas turns our DC coefficients into the expected colour", () => {
  const meta = baseMeta({ count: 4, sh0: { mins: [-1, -1, -1], maxs: [1, 1, 1], files: ["f_dc.webp"] } });
  const decoded = decodeSogXt(
    meta,
    planesOf({
      sh0: pixels(GRID, [
        [0, 128, 255],
        [255, 255, 255],
        [0, 0, 0],
        [128, 128, 128],
      ]),
    }),
  );
  const colour = new Vec4();
  createSogXtGSplatData(decoded).createIter(null, null, null, colour).read(0);
  const n = decoded.count;
  assert.ok(Math.abs(colour.x - (0.5 + SH_C0 * decoded.fDc[0])) < 1e-6, "r");
  assert.ok(Math.abs(colour.y - (0.5 + SH_C0 * decoded.fDc[n])) < 1e-6, "g");
  assert.ok(Math.abs(colour.z - (0.5 + SH_C0 * decoded.fDc[2 * n])) < 1e-6, "b");
});

test("PlayCanvas counts three SH bands from the 45 f_rest properties we add", () => {
  const centroids = centroidPlane(2, 3, 5, () => 128);
  const decoded = decodeSogXt(
    baseMeta({ count: 4, shN: SH_META }),
    planesOf({ shCentroids: centroids, shLabels: flat(GRID, [0, 0, 0]) }),
  );
  assert.equal(createSogXtGSplatData(decoded).shBands, 3);
  assert.equal(createSogXtGSplatData(decodeSogXt(baseMeta(), planesOf())).shBands, 0);
});

test("PlayCanvas builds centres that match the positions we decoded", () => {
  const decoded = decodeSogXt(
    baseMeta({ count: 4 }),
    planesOf({
      meansLow: pixels(GRID, [[0, 0, 0], [255, 255, 255], [10, 20, 30], [7, 7, 7]]),
      meansHigh: pixels(GRID, [[0, 0, 0], [255, 255, 255], [1, 2, 3], [9, 9, 9]]),
    }),
  );
  const centres = createSogXtGSplatData(decoded).getCenters();
  const n = decoded.count;
  assert.equal(centres.length, 3 * n);
  for (let i = 0; i < n; i++) {
    assert.ok(Math.abs(centres[3 * i + 0] - decoded.position[i]) < 1e-6);
    assert.ok(Math.abs(centres[3 * i + 1] - decoded.position[n + i]) < 1e-6);
    assert.ok(Math.abs(centres[3 * i + 2] - decoded.position[2 * n + i]) < 1e-6);
  }
});
