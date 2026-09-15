/**
 * 自前でデコードしたsplatをPlayCanvasのGSplatリソースへ載せる、提供元に依らない層。
 *
 * 中間PLYは作らない。`playcanvas` 2.21は `GSplatData` と `GSplatResource` を
 * どちらもpublic exportとして出していて、`GSplatComponent` には
 * 「procedural/container splat」用の `resource` セッターがある。つまり
 *
 *   TypedArray → GSplatData → GSplatResource → GSplatComponent
 *
 * を、privateな内部パスへ触らずに組める。巨大なPLYのBlobを作ってパーサへ
 * 通し直す必要はない。
 *
 * KISS-GS SOG-XT（`sog-xt-playcanvas.ts`）とLumaキャプチャ
 * （`luma-playcanvas.ts`）が同じ変換を通る。属性名の対応・`rot_*` の並び・
 * `activated` の意味といった間違えやすい部分を2か所に書かないため、
 * 変換そのものはここにしか置かない。提供元ごとのモジュールは、自分の
 * エラー型へ翻訳するだけの薄い層にしてある。
 */
import { GSplatData, GSplatResource } from "playcanvas";

/**
 * デコード結果に要求する形。**activated形式**でそろえてあること。
 *
 * - `scale` は線形（`exp(log scale)` 済み）
 * - `opacity` はsigmoid適用済み（0〜1）
 * - `rotation` は xyzw、正規化済み
 * - `fDc` は色ではなくSHのDC係数そのもの（色は `0.5 + SH_C0 * fDc`）
 * - `fRest` は PLY の `f_rest_*` と同じ並び（`channel * coeffs + coeff`）
 *
 * 並びは成分ごと（planar）。`position` なら `[x0..xN-1, y0..yN-1, z0..zN-1]`。
 * `sog-xt.ts` の `DecodedSogXt` と `luma.ts` の `DecodedLuma` がこれを満たす。
 */
export type DecodedSplats = {
  count: number;
  position: Float32Array;
  scale: Float32Array;
  rotation: Float32Array;
  opacity: Float32Array;
  fDc: Float32Array;
  fRest: Float32Array | null;
  shBands: 0 | 1 | 2 | 3;
};

/** PlayCanvasの `PlyProperty` と同じ形。型だけこちらで持つ。 */
export type SplatProperty = {
  type: string;
  name: string;
  storage: Float32Array;
  byteSize: number;
};

/** 変換に失敗した理由。提供元ごとのエラーコードへ翻訳するために種類を持つ。 */
export type SplatBridgeFailure = "empty" | "resource";

export class SplatBridgeError extends Error {
  readonly failure: SplatBridgeFailure;
  constructor(failure: SplatBridgeFailure, detail?: string) {
    super(detail ? `${failure}: ${detail}` : failure);
    this.name = "SplatBridgeError";
    this.failure = failure;
  }
}

const prop = (name: string, storage: Float32Array): SplatProperty => ({
  type: "float",
  name,
  storage,
  byteSize: 4,
});

/**
 * デコード結果からPLY互換の属性一覧を組む。
 *
 * `DecodedSplats` は成分ごとに連続した並び（planar）なので、どの属性も
 * `subarray()` で切り出すだけで済む——値のコピーは一度も起きない。
 *
 * 名前と意味の対応:
 *  - `x` / `y` / `z`              ← `position`
 *  - `scale_0..2`                 ← `scale`（線形。`activated` 前提）
 *  - `rot_0..3`                   ← `rotation`。PlayCanvasは **wxyz** 順で読む
 *                                    （`rot_0` が w）ので、xyzwから並べ替える
 *  - `f_dc_0..2`                  ← `fDc`（SHのDC係数。色ではない）
 *  - `opacity`                    ← `opacity`（sigmoid済み。`activated` 前提）
 *  - `f_rest_0..`                 ← `fRest`。並びはPLYと同じ `channel*coeffs+coeff`
 */
export function splatPropertiesOf(decoded: DecodedSplats): SplatProperty[] {
  const n = decoded.count;
  const slice = (source: Float32Array, index: number) => source.subarray(index * n, (index + 1) * n);

  const properties: SplatProperty[] = [
    prop("x", slice(decoded.position, 0)),
    prop("y", slice(decoded.position, 1)),
    prop("z", slice(decoded.position, 2)),
    prop("scale_0", slice(decoded.scale, 0)),
    prop("scale_1", slice(decoded.scale, 1)),
    prop("scale_2", slice(decoded.scale, 2)),
    // xyzw で持っているものを wxyz として渡す。
    prop("rot_0", slice(decoded.rotation, 3)),
    prop("rot_1", slice(decoded.rotation, 0)),
    prop("rot_2", slice(decoded.rotation, 1)),
    prop("rot_3", slice(decoded.rotation, 2)),
    prop("f_dc_0", slice(decoded.fDc, 0)),
    prop("f_dc_1", slice(decoded.fDc, 1)),
    prop("f_dc_2", slice(decoded.fDc, 2)),
    prop("opacity", decoded.opacity.subarray(0, n)),
  ];

  if (decoded.fRest && decoded.shBands > 0) {
    // PlayCanvasは `f_rest_0` から連番で数えて帯域を決める（9→1帯域、24→2、
    // 45→3）。途中が欠けると帯域を取り違えるので、必ず先頭から詰めて渡す。
    const slots = decoded.fRest.length / n;
    for (let i = 0; i < slots; i++) properties.push(prop(`f_rest_${i}`, slice(decoded.fRest, i)));
  }
  return properties;
}

/**
 * `GSplatData` を組む。
 *
 * `activated = true` を立てるのが要点。これを忘れると PlayCanvas は
 * `scale_*` を log空間、`opacity` をpre-sigmoidとして読むので、splatが
 * `exp(linear)` で巨大になり、不透明度が飽和する。
 *
 * `comment` はPLYのコメント行に当たるもので、どのデコーダが作った
 * データかを残すためだけに使う。
 */
export function createSplatData(decoded: DecodedSplats, comment: string): GSplatData {
  if (decoded.count < 1) throw new SplatBridgeError("empty", "splatが0個です");
  const data = new GSplatData(
    [{ name: "vertex", count: decoded.count, properties: splatPropertiesOf(decoded) }],
    [comment],
  );
  data.activated = true;
  return data;
}

/**
 * デコード結果からGPUリソースを作る。`GSplatComponent.resource` へそのまま渡せる。
 *
 * 失敗はすべて `SplatBridgeError("resource")` にまとめる。元のエラーは `cause`
 * として残すので、debug consoleからは原因まで辿れる。
 */
export function createSplatResource(
  device: ConstructorParameters<typeof GSplatResource>[0],
  decoded: DecodedSplats,
  comment: string,
): GSplatResource {
  const data = createSplatData(decoded, comment);
  try {
    return new GSplatResource(device, data);
  } catch (error) {
    const failure = new SplatBridgeError("resource", String(error));
    failure.cause = error;
    throw failure;
  }
}
