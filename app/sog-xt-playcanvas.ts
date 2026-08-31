/**
 * デコード済みSOG-XTをPlayCanvasのGSplatリソースへ載せる層。
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
 * `GSplatData` は `activated` フラグを持っていて、立てると
 *   - `scale_*` を線形（`exp` 済み）
 *   - `opacity` をsigmoid済み
 * として読む。KISS-GSのデコード結果はまさにその形なので、ここで
 * log/pre-sigmoidへ戻す往復は挟まない。
 */
import { GSplatData, GSplatResource } from "playcanvas";
import { SogXtError, type DecodedSogXt } from "./sog-xt.ts";

/** PlayCanvasの `PlyProperty` と同じ形。型だけこちらで持つ。 */
type SplatProperty = { type: string; name: string; storage: Float32Array; byteSize: number };

const prop = (name: string, storage: Float32Array): SplatProperty => ({
  type: "float",
  name,
  storage,
  byteSize: 4,
});

/**
 * デコード結果からPLY互換の属性一覧を組む。
 *
 * `DecodedSogXt` は成分ごとに連続した並び（planar）なので、どの属性も
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
export function splatPropertiesOf(decoded: DecodedSogXt): SplatProperty[] {
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
 */
export function createSogXtGSplatData(decoded: DecodedSogXt): GSplatData {
  if (decoded.count < 1) {
    throw new SogXtError("INCONSISTENT_SPLAT_COUNT", "splatが0個です");
  }
  const data = new GSplatData(
    [{ name: "vertex", count: decoded.count, properties: splatPropertiesOf(decoded) }],
    ["generated from KISS-GS SOG-XT"],
  );
  data.activated = true;
  return data;
}

/**
 * デコード結果からGPUリソースを作る。`GSplatComponent.resource` へそのまま渡せる。
 *
 * 失敗はすべて `RESOURCE_CREATION_FAILED` にまとめる。元のエラーは `cause`
 * として残すので、debug consoleからは原因まで辿れる。
 */
export function createSogXtResource(
  device: ConstructorParameters<typeof GSplatResource>[0],
  decoded: DecodedSogXt,
): GSplatResource {
  const data = createSogXtGSplatData(decoded);
  try {
    return new GSplatResource(device, data);
  } catch (error) {
    const failure = new SogXtError("RESOURCE_CREATION_FAILED", String(error));
    failure.cause = error;
    throw failure;
  }
}
