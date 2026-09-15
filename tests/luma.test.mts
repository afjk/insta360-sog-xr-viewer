import assert from "node:assert/strict";
import test from "node:test";
import {
  LUMA_CAPTURE_API_ORIGIN,
  LUMA_GAUSS_HEADER_BYTES,
  LUMA_TEXTURE_WIDTH,
  LUMA_TILE_SIDE,
  LumaError,
  captureUrlFromUuid,
  dcFromColor,
  decodeLumaGaussians,
  eigenDecomposeSymmetric3,
  halfToFloat,
  isLumaCaptureUuid,
  isLumaGalleryUrl,
  lumaCaptureApiUrl,
  lumaTexelIndex,
  parseLumaCaptureUrl,
  parseLumaGaussHeader,
  parseLumaWebMeta,
  quaternionFromColumns,
  readLumaArtifacts,
  readLumaCaptureMeta,
  selectLumaGaussians,
  splatFromCovariance,
  SH_C0,
} from "../app/luma.ts";
import { Quat, Vec3, Vec4 } from "playcanvas";
import { createSplatData, splatPropertiesOf } from "../app/splat-playcanvas.ts";
import { createLumaResource } from "../app/luma-playcanvas.ts";

const UUID = "83e9aae8-7023-448e-83a6-53ccb377ec86";

/* -------------------------------------------------------------------------- */
/* 合成fixture                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Number を IEEE 754 half のビット列へ。テスト用の逆変換。
 *
 * 丸めの実装差に引っかからないよう、テストでは half で厳密に表せる値
 * （2の冪の和）しか渡さない。
 */
function floatToHalf(value: number): number {
  const f32 = new Float32Array(1);
  const u32 = new Uint32Array(f32.buffer);
  f32[0] = value;
  const bits = u32[0];
  const sign = (bits >>> 16) & 0x8000;
  const exponent = (bits >>> 23) & 0xff;
  const fraction = bits & 0x7fffff;
  if (exponent === 0xff) return sign | 0x7c00 | (fraction ? 0x200 : 0);
  const shifted = exponent - 127 + 15;
  if (shifted >= 31) return sign | 0x7c00;
  if (shifted <= 0) return sign;
  return sign | (shifted << 10) | (fraction >>> 13);
}

/** 1splat分の入力。position と共分散と色。 */
type Fixture = {
  position: [number, number, number];
  /** Σxx, Σyy, Σzz, Σxy, Σxz, Σyz */
  covariance: [number, number, number, number, number, number];
  /** 0〜255。 */
  color: [number, number, number, number];
};

/**
 * `gs_web_gauss1.bin` / `gs_web_gauss2.bin` の組を作る。
 *
 * 実物のキャプチャは数十MBあってリポジトリへ置くものではない。ここでは
 * タイル1行（2048×4テクセル）だけの最小のテクスチャに、既知の値を
 * splat番号どおりのテクセルへ置いて、番地計算とビット並びを確かめる。
 */
function textures(fixtures: readonly Fixture[]): { gauss1: Uint8Array; gauss2: Uint8Array } {
  const height = LUMA_TILE_SIDE;
  const texels = LUMA_TEXTURE_WIDTH * height;
  const gauss1 = new Uint8Array(LUMA_GAUSS_HEADER_BYTES + texels * 8);
  const gauss2 = new Uint8Array(LUMA_GAUSS_HEADER_BYTES + texels * 16);
  const header = (bytes: Uint8Array, channels: number) => {
    const view = new DataView(bytes.buffer, 0, LUMA_GAUSS_HEADER_BYTES);
    view.setUint32(0, 1, true);
    view.setUint32(4, LUMA_TEXTURE_WIDTH, true);
    view.setUint32(8, height, true);
    view.setUint32(12, channels, true);
  };
  header(gauss1, 2);
  header(gauss2, 4);

  const half1 = new Uint16Array(gauss1.buffer, LUMA_GAUSS_HEADER_BYTES, texels * 4);
  const half2 = new Uint16Array(gauss2.buffer, LUMA_GAUSS_HEADER_BYTES, texels * 8);
  fixtures.forEach((fixture, index) => {
    const texel = lumaTexelIndex(index, LUMA_TEXTURE_WIDTH);
    const [xx, yy, zz, xy, xz, yz] = fixture.covariance;
    half1[texel * 4 + 0] = floatToHalf(fixture.position[0]);
    half1[texel * 4 + 1] = floatToHalf(fixture.position[1]);
    half1[texel * 4 + 2] = floatToHalf(fixture.position[2]);
    half1[texel * 4 + 3] = floatToHalf(xx);
    half2[texel * 8 + 0] = floatToHalf(yy);
    half2[texel * 8 + 1] = floatToHalf(zz);
    half2[texel * 8 + 2] = floatToHalf(xy);
    half2[texel * 8 + 3] = floatToHalf(xz);
    half2[texel * 8 + 4] = floatToHalf(yz);
    // 上位16bitはSHテクスチャの索引。色ではないので触らない。
    half2[texel * 8 + 5] = 0;
    // uint32[3] にRGBAをバイトで詰める。
    const at = LUMA_GAUSS_HEADER_BYTES + texel * 16 + 12;
    gauss2[at + 0] = fixture.color[0];
    gauss2[at + 1] = fixture.color[1];
    gauss2[at + 2] = fixture.color[2];
    gauss2[at + 3] = fixture.color[3];
  });
  return { gauss1, gauss2 };
}

/** クォータニオン xyzw から回転行列（列ベクトル3本）へ。 */
function columnsFromQuaternion(
  x: number,
  y: number,
  z: number,
  w: number,
): [number[], number[], number[]] {
  return [
    [1 - 2 * (y * y + z * z), 2 * (x * y + z * w), 2 * (x * z - y * w)],
    [2 * (x * y - z * w), 1 - 2 * (x * x + z * z), 2 * (y * z + x * w)],
    [2 * (x * z + y * w), 2 * (y * z - x * w), 1 - 2 * (x * x + y * y)],
  ];
}

/** R diag(scale²) Rᵀ を組む。3DGSの共分散の定義そのまま。 */
function covarianceOf(
  scale: readonly [number, number, number],
  quaternion: readonly [number, number, number, number],
): [number, number, number, number, number, number] {
  const [c0, c1, c2] = columnsFromQuaternion(...(quaternion as [number, number, number, number]));
  const columns = [c0, c1, c2];
  const at = (row: number, column: number) =>
    columns.reduce((sum, axis, index) => sum + axis[row] * scale[index] * scale[index] * columns[index][column], 0);
  return [at(0, 0), at(1, 1), at(2, 2), at(0, 1), at(0, 2), at(1, 2)];
}

/* -------------------------------------------------------------------------- */
/* URL                                                                        */
/* -------------------------------------------------------------------------- */

test("parseLumaCaptureUrl accepts the capture page, the embed page and the uuid query", () => {
  for (const input of [
    `https://lumalabs.ai/capture/${UUID}`,
    `https://lumalabs.ai/capture/${UUID}/`,
    `https://www.lumalabs.ai/capture/${UUID}`,
    `lumalabs.ai/capture/${UUID}`,
    `https://lumalabs.ai/embed/${UUID}?mode=sparkles&background=%23ffffff`,
    `https://lumalabs.ai/?uuid=${UUID}`,
    `https://lumalabs.ai/capture/${UUID.toUpperCase()}`,
  ]) {
    assert.deepEqual(
      parseLumaCaptureUrl(input),
      { uuid: UUID, captureUrl: `https://lumalabs.ai/capture/${UUID}` },
      input,
    );
  }
});

test("parseLumaCaptureUrl rejects other hosts, other paths and broken ids", () => {
  for (const input of [
    "",
    "https://lumalabs.ai/featured",
    "https://lumalabs.ai/capture/not-a-uuid",
    `https://lumalabs.ai/capture/${UUID}/extra`,
    `https://lumalabs.ai.example.com/capture/${UUID}`,
    `https://evil.lumalabs.ai/capture/${UUID}`,
    `https://superspl.at/capture/${UUID}`,
    `ftp://lumalabs.ai/capture/${UUID}`,
    `https://lumalabs.ai/capture/${UUID.slice(0, -1)}`,
  ]) {
    assert.equal(parseLumaCaptureUrl(input), null, input);
  }
});

test("isLumaGalleryUrl separates the listing pages from a capture", () => {
  assert.equal(isLumaGalleryUrl("https://lumalabs.ai/featured"), true);
  assert.equal(isLumaGalleryUrl("https://lumalabs.ai/featured/"), true);
  assert.equal(isLumaGalleryUrl("https://lumalabs.ai/"), true);
  assert.equal(isLumaGalleryUrl("https://lumalabs.ai/gallery"), true);
  assert.equal(isLumaGalleryUrl(`https://lumalabs.ai/capture/${UUID}`), false);
  assert.equal(isLumaGalleryUrl(`https://lumalabs.ai/featured?uuid=${UUID}`), false);
  assert.equal(isLumaGalleryUrl("https://superspl.at/featured"), false);
});

test("uuid helpers round-trip and validate", () => {
  assert.equal(isLumaCaptureUuid(UUID), true);
  assert.equal(isLumaCaptureUuid(` ${UUID} `), true);
  assert.equal(isLumaCaptureUuid("83e9aae8-7023-448e-83a6"), false);
  assert.equal(captureUrlFromUuid(UUID), `https://lumalabs.ai/capture/${UUID}`);
  assert.equal(captureUrlFromUuid("nope"), null);
  assert.equal(
    lumaCaptureApiUrl(UUID),
    `${LUMA_CAPTURE_API_ORIGIN}/api/v3/captures/${UUID}/public`,
  );
  assert.equal(lumaCaptureApiUrl("nope"), null);
});

/* -------------------------------------------------------------------------- */
/* 公開APIの応答                                                               */
/* -------------------------------------------------------------------------- */

test("readLumaArtifacts reads both response shapes and drops unusable urls", () => {
  const artifacts = [
    { type: "gs_web_gauss1", url: "https://cdn.example.com/a/gauss1.bin" },
    { type: "gs_web_gauss2", url: "https://cdn.example.com/a/gauss2.bin" },
    { type: "gs_web_webmeta", url: "https://cdn.example.com/a/webmeta.json" },
    // 弾かれるもの: http、ループバック、URLでない、typeが無い
    { type: "insecure", url: "http://cdn.example.com/a/x.bin" },
    { type: "loopback", url: "https://127.0.0.1/a/x.bin" },
    { type: "broken", url: "not a url at all" },
    { type: "", url: "https://cdn.example.com/a/y.bin" },
  ];
  const expected = {
    gs_web_gauss1: "https://cdn.example.com/a/gauss1.bin",
    gs_web_gauss2: "https://cdn.example.com/a/gauss2.bin",
    gs_web_webmeta: "https://cdn.example.com/a/webmeta.json",
  };
  assert.deepEqual(readLumaArtifacts({ response: { artifacts } }), expected);
  assert.deepEqual(readLumaArtifacts({ latestRun: { artifacts } }), expected);
  assert.deepEqual(readLumaArtifacts({ artifacts }), expected);
  assert.deepEqual(readLumaArtifacts({ response: {} }), {});
  assert.deepEqual(readLumaArtifacts(null), {});
  assert.deepEqual(readLumaArtifacts("nope"), {});
});

test("readLumaCaptureMeta takes the title when the response carries one", () => {
  assert.deepEqual(readLumaCaptureMeta({ response: { title: " Kind Humanoid " } }), {
    title: "Kind Humanoid",
  });
  assert.deepEqual(readLumaCaptureMeta({ name: "MIT WPU Globe" }), { title: "MIT WPU Globe" });
  assert.deepEqual(readLumaCaptureMeta({ response: {} }), { title: null });
  assert.deepEqual(readLumaCaptureMeta(null), { title: null });
});

test("selectLumaGaussians prefers the web artifacts and names the compressed-only case", () => {
  const web = {
    gs_web_webmeta: "https://cdn.example.com/a/webmeta.json",
    gs_web_gauss1: "https://cdn.example.com/a/gauss1.bin",
    gs_web_gauss2: "https://cdn.example.com/a/gauss2.bin",
  };
  const compressed = {
    gs_compressed: "https://cdn.example.com/a/core.bin",
    gs_compressed_meta: "https://cdn.example.com/a/compressed.json",
  };
  assert.deepEqual(selectLumaGaussians(web), {
    format: "web-v1",
    metaUrl: web.gs_web_webmeta,
    gauss1Url: web.gs_web_gauss1,
    gauss2Url: web.gs_web_gauss2,
    shUrl: null,
  });
  // 両方あってもweb v1を選ぶ（読めるのはこちらだけ）。
  assert.equal(selectLumaGaussians({ ...web, ...compressed })?.format, "web-v1");
  assert.deepEqual(selectLumaGaussians(compressed), {
    format: "compressed",
    metaUrl: compressed.gs_compressed_meta,
    coreUrl: compressed.gs_compressed,
  });
  // 片方だけでは組にならない。
  assert.equal(selectLumaGaussians({ gs_web_gauss1: web.gs_web_gauss1 }), null);
  assert.equal(selectLumaGaussians({ gs_compressed: compressed.gs_compressed }), null);
  assert.equal(selectLumaGaussians({}), null);
});

test("parseLumaWebMeta reads v1 and rejects anything else", () => {
  assert.deepEqual(
    parseLumaWebMeta({
      version: 1,
      num_splats: 1234,
      total_bytes: 5678,
      scene_center: [1, 2, 3],
      have_sh: true,
    }),
    { version: 1, numSplats: 1234, totalBytes: 5678, sceneCenter: [1, 2, 3], haveSh: true },
  );
  // 足りない項目は既定値へ落とす。splat数だけは必須。
  assert.deepEqual(parseLumaWebMeta({ version: 1, num_splats: 7 }), {
    version: 1,
    numSplats: 7,
    totalBytes: 0,
    sceneCenter: [0, 0, 0],
    haveSh: false,
  });
  for (const payload of [
    null,
    {},
    { version: 2, num_splats: 7 },
    { version: 1 },
    { version: 1, num_splats: 0 },
  ]) {
    assert.throws(
      () => parseLumaWebMeta(payload),
      (error: unknown) => error instanceof LumaError && error.code === "LUMA_META_INVALID",
      JSON.stringify(payload),
    );
  }
});

/* -------------------------------------------------------------------------- */
/* テクスチャの読み出し                                                        */
/* -------------------------------------------------------------------------- */

test("parseLumaGaussHeader accepts the documented header and rejects the rest", () => {
  const { gauss1, gauss2 } = textures([]);
  assert.deepEqual(parseLumaGaussHeader(gauss1, 2), {
    version: 1,
    width: LUMA_TEXTURE_WIDTH,
    height: LUMA_TILE_SIDE,
    channels: 2,
  });
  assert.deepEqual(parseLumaGaussHeader(gauss2, 4), {
    version: 1,
    width: LUMA_TEXTURE_WIDTH,
    height: LUMA_TILE_SIDE,
    channels: 4,
  });
  // チャンネル数を取り違えた組み合わせは通らない。
  assert.throws(() => parseLumaGaussHeader(gauss1, 4), LumaError);
  assert.throws(() => parseLumaGaussHeader(gauss2, 2), LumaError);
  // 短すぎるもの、versionと幅が違うもの。
  assert.throws(() => parseLumaGaussHeader(new Uint8Array(8), 2), LumaError);
  const wrong = new Uint8Array(gauss1);
  new DataView(wrong.buffer).setUint32(0, 2, true);
  assert.throws(() => parseLumaGaussHeader(wrong, 2), LumaError);
  const narrow = new Uint8Array(gauss1);
  new DataView(narrow.buffer).setUint32(4, 1024, true);
  assert.throws(() => parseLumaGaussHeader(narrow, 2), LumaError);
});

test("lumaTexelIndex matches the shader's tile addressing", () => {
  // シェーダの ivec2(4*((D>>4)&0x1ff) + (D&3), 4*(D>>13) + ((D>>2)&3)) をそのまま。
  const reference = (index: number) => {
    const x = 4 * ((index >> 4) & 0x1ff) + (index & 3);
    const y = 4 * (index >> 13) + ((index >> 2) & 3);
    return y * LUMA_TEXTURE_WIDTH + x;
  };
  for (const index of [0, 1, 2, 3, 4, 15, 16, 17, 8191, 8192, 8193, 123456, 1_000_000]) {
    assert.equal(lumaTexelIndex(index, LUMA_TEXTURE_WIDTH), reference(index), `index=${index}`);
  }
  // 最初のタイルは 4×4 の16splat。番号の下位4bitがタイル内の位置。
  assert.equal(lumaTexelIndex(0, LUMA_TEXTURE_WIDTH), 0);
  assert.equal(lumaTexelIndex(3, LUMA_TEXTURE_WIDTH), 3);
  assert.equal(lumaTexelIndex(4, LUMA_TEXTURE_WIDTH), LUMA_TEXTURE_WIDTH);
  assert.equal(lumaTexelIndex(16, LUMA_TEXTURE_WIDTH), 4);
  // タイル1行（512タイル × 16splat = 8192）を越えると次のタイル行へ。
  assert.equal(lumaTexelIndex(8192, LUMA_TEXTURE_WIDTH), 4 * LUMA_TEXTURE_WIDTH);
});

test("halfToFloat matches unpackHalf2x16 for the values we care about", () => {
  assert.equal(halfToFloat(0x0000), 0);
  assert.equal(halfToFloat(0x3c00), 1);
  assert.equal(halfToFloat(0xbc00), -1);
  assert.equal(halfToFloat(0x3800), 0.5);
  assert.equal(halfToFloat(0x4000), 2);
  assert.equal(halfToFloat(0x7c00), Infinity);
  assert.ok(Number.isNaN(halfToFloat(0x7e00)));
  // 非正規化数。最小の正の非正規化数は 2^-24。
  assert.ok(Math.abs(halfToFloat(0x0001) - Math.pow(2, -24)) < 1e-30);
  for (const value of [0.25, -3, 1.5, 0.0625, 1024]) {
    assert.equal(halfToFloat(floatToHalf(value)), value, `value=${value}`);
  }
});

/* -------------------------------------------------------------------------- */
/* 共分散 → スケールと姿勢                                                     */
/* -------------------------------------------------------------------------- */

test("eigenDecomposeSymmetric3 diagonalises a diagonal matrix without moving the axes", () => {
  const { values, vectors } = eigenDecomposeSymmetric3(4, 9, 16, 0, 0, 0);
  assert.deepEqual(
    values.map((value) => Math.round(value)),
    [4, 9, 16],
  );
  assert.deepEqual(vectors, [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ]);
});

test("splatFromCovariance recovers the ellipsoid it was built from", () => {
  const cases: {
    scale: [number, number, number];
    quaternion: [number, number, number, number];
  }[] = [
    { scale: [0.3, 0.1, 0.05], quaternion: [0, 0, 0, 1] },
    { scale: [0.2, 0.2, 0.02], quaternion: [0.5, 0.5, 0.5, 0.5] },
    { scale: [1, 0.5, 0.25], quaternion: [0.183, -0.365, 0.548, 0.730] },
    // 等方（固有値が縮退）。姿勢は一意に決まらないが楕円体は一致する。
    { scale: [0.1, 0.1, 0.1], quaternion: [0, 0.707106781, 0, 0.707106781] },
  ];
  for (const { scale, quaternion } of cases) {
    const length = Math.hypot(...quaternion);
    const unit = quaternion.map((value) => value / length) as [number, number, number, number];
    const sigma = covarianceOf(scale, unit);
    const splat = splatFromCovariance(...sigma);

    // 姿勢とスケールを組み直したら、元の共分散へ戻る。
    const rebuilt = covarianceOf(splat.scale, splat.rotation);
    sigma.forEach((value, index) => {
      assert.ok(
        Math.abs(value - rebuilt[index]) < 1e-9,
        `Σ[${index}] ${value} vs ${rebuilt[index]}`,
      );
    });
    // スケールは順番こそ違うが同じ3つの値。
    const sorted = (values: readonly number[]) => [...values].sort((a, b) => a - b);
    sorted(splat.scale).forEach((value, index) => {
      assert.ok(Math.abs(value - sorted(scale)[index]) < 1e-6, `scale ${value}`);
    });
    // クォータニオンは正規化されている。
    assert.ok(Math.abs(Math.hypot(...splat.rotation) - 1) < 1e-9);
  }
});

test("splatFromCovariance keeps a right-handed basis", () => {
  // 固有ベクトルの並びが鏡映になりうる共分散。回転として使えなければならない。
  const splat = splatFromCovariance(0.04, 0.01, 0.0025, 0.005, -0.003, 0.002);
  const [c0, c1, c2] = columnsFromQuaternion(...splat.rotation);
  const det =
    c0[0] * (c1[1] * c2[2] - c1[2] * c2[1]) -
    c1[0] * (c0[1] * c2[2] - c0[2] * c2[1]) +
    c2[0] * (c0[1] * c1[2] - c0[2] * c1[1]);
  assert.ok(Math.abs(det - 1) < 1e-6, `det=${det}`);
});

test("quaternionFromColumns handles a 180° rotation (trace <= 0)", () => {
  // Z軸まわり180°。trace = -1 なので、分岐の別の枝を通る。
  const quaternion = quaternionFromColumns([-1, 0, 0], [0, -1, 0], [0, 0, 1]);
  assert.ok(Math.abs(Math.abs(quaternion[2]) - 1) < 1e-9, JSON.stringify(quaternion));
  assert.ok(Math.abs(quaternion[3]) < 1e-9);
});

test("dcFromColor is the inverse of PlayCanvas' DC evaluation", () => {
  for (const color of [0, 0.25, 0.5, 1]) {
    assert.ok(Math.abs(0.5 + SH_C0 * dcFromColor(color) - color) < 1e-12, `color=${color}`);
  }
});

/* -------------------------------------------------------------------------- */
/* デコード                                                                    */
/* -------------------------------------------------------------------------- */

test("decodeLumaGaussians unpacks position, covariance and colour per splat", () => {
  const first: Fixture = {
    position: [1.5, -2, 0.25],
    covariance: covarianceOf([0.25, 0.125, 0.0625], [0, 0, 0, 1]),
    color: [255, 128, 0, 64],
  };
  const second: Fixture = {
    position: [-4, 8, 16],
    covariance: covarianceOf([0.5, 0.5, 0.5], [0, 0, 0, 1]),
    color: [0, 0, 0, 255],
  };
  const { gauss1, gauss2 } = textures([first, second]);
  const decoded = decodeLumaGaussians(gauss1, gauss2, 2);

  assert.equal(decoded.count, 2);
  assert.equal(decoded.shBands, 0);
  assert.equal(decoded.fRest, null);
  assert.equal(decoded.degenerate, 0);
  assert.equal(decoded.textureHeight, LUMA_TILE_SIDE);

  // planarな並び: [x0, x1, y0, y1, z0, z1]。
  assert.deepEqual(Array.from(decoded.position), [1.5, -4, -2, 8, 0.25, 16]);

  // 軸に沿った共分散なので、スケールはそのまま（順番は固有値分解が決める）。
  const scaleOf = (index: number) =>
    [decoded.scale[index], decoded.scale[2 + index], decoded.scale[4 + index]].sort(
      (a, b) => a - b,
    );
  scaleOf(0).forEach((value, index) => {
    assert.ok(Math.abs(value - [0.0625, 0.125, 0.25][index]) < 1e-4, `scale0 ${value}`);
  });
  scaleOf(1).forEach((value) => assert.ok(Math.abs(value - 0.5) < 1e-4, `scale1 ${value}`));

  // 色はDC係数へ、不透明度はそのまま0〜1。
  assert.ok(Math.abs(0.5 + SH_C0 * decoded.fDc[0] - 1) < 1e-6);
  assert.ok(Math.abs(0.5 + SH_C0 * decoded.fDc[2] - 128 / 255) < 1e-6);
  assert.ok(Math.abs(0.5 + SH_C0 * decoded.fDc[4] - 0) < 1e-6);
  assert.ok(Math.abs(decoded.opacity[0] - 64 / 255) < 1e-6);
  assert.equal(decoded.opacity[1], 1);
});

test("decodeLumaGaussians keeps a splat with a broken covariance instead of shifting the rest", () => {
  const good: Fixture = {
    position: [1, 1, 1],
    covariance: covarianceOf([0.25, 0.25, 0.25], [0, 0, 0, 1]),
    color: [10, 20, 30, 40],
  };
  const broken: Fixture = {
    position: [2, 2, 2],
    covariance: [Number.NaN, 0, 0, 0, 0, 0],
    color: [50, 60, 70, 80],
  };
  const { gauss1, gauss2 } = textures([good, broken, good]);
  const decoded = decodeLumaGaussians(gauss1, gauss2, 3);

  assert.equal(decoded.count, 3);
  assert.equal(decoded.degenerate, 1);
  // 壊れていたsplatは大きさ0・単位クォータニオンで残る。番号はずれない。
  assert.equal(decoded.scale[1], 0);
  assert.equal(decoded.scale[3 + 1], 0);
  assert.equal(decoded.rotation[3 * 3 + 1], 1);
  assert.equal(decoded.position[1], 2);
  assert.ok(Math.abs(decoded.opacity[1] - 80 / 255) < 1e-6);
  assert.ok(decoded.scale[2] > 0);
});

test("decodeLumaGaussians clamps the count to what actually arrived", () => {
  const fixture: Fixture = {
    position: [0, 0, 0],
    covariance: covarianceOf([0.1, 0.1, 0.1], [0, 0, 0, 1]),
    color: [1, 2, 3, 4],
  };
  const { gauss1, gauss2 } = textures([fixture]);
  // ヘッダが宣言しているより多いsplat数を渡しても、テクスチャの容量で止まる。
  const decoded = decodeLumaGaussians(gauss1, gauss2, 999_999_999);
  assert.equal(decoded.count, LUMA_TEXTURE_WIDTH * LUMA_TILE_SIDE);

  // 途中で切れたテクスチャは、タイル1行に足りなければ読まない。
  assert.throws(
    () => decodeLumaGaussians(gauss1.subarray(0, LUMA_GAUSS_HEADER_BYTES + 64), gauss2, 8),
    (error: unknown) => error instanceof LumaError && error.code === "LUMA_GAUSS_INVALID",
  );
  // 高さが食い違う2枚も弾く。
  const { gauss2: tall } = textures([fixture]);
  new DataView(tall.buffer).setUint32(8, LUMA_TILE_SIDE * 2, true);
  assert.throws(
    () => decodeLumaGaussians(gauss1, tall, 8),
    (error: unknown) => error instanceof LumaError && error.code === "LUMA_GAUSS_INVALID",
  );
});

test("decoded Luma splats map onto PlayCanvas properties in wxyz order", () => {
  const fixture: Fixture = {
    position: [1, 2, 3],
    covariance: covarianceOf([0.25, 0.125, 0.0625], [0, 0, 0.707106781, 0.707106781]),
    color: [200, 100, 50, 255],
  };
  const { gauss1, gauss2 } = textures([fixture]);
  const decoded = decodeLumaGaussians(gauss1, gauss2, 1);
  const properties = splatPropertiesOf(decoded);
  const named = new Map(properties.map((property) => [property.name, property]));

  // SHは持たないので `f_rest_*` は出さない。
  assert.equal(properties.some((property) => property.name.startsWith("f_rest_")), false);
  for (const name of ["x", "y", "z", "scale_0", "rot_0", "rot_3", "f_dc_0", "opacity"]) {
    assert.ok(named.has(name), name);
  }
  // `rot_0` は w、`rot_1..3` が x/y/z。
  assert.equal(named.get("rot_0")?.storage[0], decoded.rotation[3]);
  assert.equal(named.get("rot_1")?.storage[0], decoded.rotation[0]);
  assert.equal(named.get("rot_2")?.storage[0], decoded.rotation[1]);
  assert.equal(named.get("rot_3")?.storage[0], decoded.rotation[2]);
  assert.equal(named.get("x")?.storage[0], 1);
});

test("PlayCanvas reads back the splat we decoded from Luma's textures", () => {
  // Lumaのバイト列 → デコード → GSplatData → PlayCanvas自身のiteratorという
  // 一周ぶんの確認。実データを開く前に確かめられるのはここまでで、色・大きさ・
  // 姿勢・不透明度のどれもが往復で変わらないことを縛る。
  const scale: [number, number, number] = [0.25, 0.125, 0.0625];
  // Y軸まわり90°。identityではないので、並べ替えの取り違えが見える。
  const quaternion: [number, number, number, number] = [0, 0.7071067811865476, 0, 0.7071067811865476];
  const fixture: Fixture = {
    position: [1.5, -2, 0.25],
    covariance: covarianceOf(scale, quaternion),
    color: [255, 128, 0, 64],
  };
  const { gauss1, gauss2 } = textures([fixture]);
  const decoded = decodeLumaGaussians(gauss1, gauss2, 1);
  const data = createSplatData(decoded, "test");

  assert.equal(data.activated, true);
  assert.equal(data.numSplats, 1);

  const position = new Vec3();
  const rotation = new Quat();
  const readScale = new Vec3();
  const colour = new Vec4();
  data.createIter(position, rotation, readScale, colour).read(0);

  // 位置はそのまま。
  assert.ok(Math.abs(position.x - 1.5) < 1e-6, `x=${position.x}`);
  assert.ok(Math.abs(position.y + 2) < 1e-6, `y=${position.y}`);
  assert.ok(Math.abs(position.z - 0.25) < 1e-6, `z=${position.z}`);

  // スケールは線形のまま（activatedなのでexpを重ねない）。軸の順番は
  // 固有値分解が決めるので、集合として一致することを見る。
  const sorted = (values: readonly number[]) => [...values].sort((a, b) => a - b);
  sorted([readScale.x, readScale.y, readScale.z]).forEach((value, index) => {
    assert.ok(Math.abs(value - sorted(scale)[index]) < 1e-4, `scale ${value}`);
  });

  // 姿勢は、読み戻した回転とスケールから共分散を組み直して突き合わせる。
  const rebuilt = covarianceOf(
    [readScale.x, readScale.y, readScale.z],
    [rotation.x, rotation.y, rotation.z, rotation.w],
  );
  covarianceOf(scale, quaternion).forEach((value, index) => {
    assert.ok(Math.abs(value - rebuilt[index]) < 1e-5, `Σ[${index}] ${value} vs ${rebuilt[index]}`);
  });

  // 色はPlayCanvasがDC係数から評価し直すので、詰めたRGBA8へ戻る。
  assert.ok(Math.abs(colour.x - 1) < 1e-3, `r=${colour.x}`);
  assert.ok(Math.abs(colour.y - 128 / 255) < 1e-3, `g=${colour.y}`);
  assert.ok(Math.abs(colour.z - 0) < 1e-3, `b=${colour.z}`);
  // 不透明度もsigmoidを重ねない。
  assert.ok(Math.abs(colour.w - 64 / 255) < 1e-6, `a=${colour.w}`);
});

test("createLumaResource reports a Luma error when PlayCanvas cannot take the data", () => {
  // GPUデバイスが無いNodeでは `GSplatResource` は作れない。失敗が
  // `LumaError` として出ること——画面に日本語の文言が出る形——を縛る。
  const fixture: Fixture = {
    position: [0, 0, 0],
    covariance: covarianceOf([0.1, 0.1, 0.1], [0, 0, 0, 1]),
    color: [1, 2, 3, 4],
  };
  const { gauss1, gauss2 } = textures([fixture]);
  const decoded = decodeLumaGaussians(gauss1, gauss2, 1);
  assert.throws(
    () => createLumaResource(null as never, decoded),
    (error: unknown) =>
      error instanceof LumaError && error.code === "LUMA_RESOURCE_CREATION_FAILED",
  );
});
