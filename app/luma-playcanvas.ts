/**
 * デコード済みLumaキャプチャをPlayCanvasのGSplatリソースへ載せる層。
 *
 * 変換そのものは `splat-playcanvas.ts`（提供元に依らない）。こちらはLuma固有の
 * もの、つまり失敗を `LumaError` のコードへ翻訳することと、生成物に残す
 * コメントだけを持つ。
 *
 * `luma.ts` の `decodeLumaGaussians` はactivated形式（`scale` は共分散の
 * 固有値の平方根＝線形、`opacity` は0〜1）を返すので、log/pre-sigmoidへ
 * 戻す往復は挟まない。
 */
import { GSplatResource } from "playcanvas";
import { LumaError, type DecodedLuma } from "./luma.ts";
import { SplatBridgeError, createSplatResource } from "./splat-playcanvas.ts";

/** 生成した `GSplatData` に残すコメント。出どころの記録用。 */
const LUMA_COMMENT = "generated from Luma capture";

/** デコード結果からGPUリソースを作る。`GSplatComponent.resource` へそのまま渡せる。 */
export function createLumaResource(
  device: ConstructorParameters<typeof GSplatResource>[0],
  decoded: DecodedLuma,
): GSplatResource {
  try {
    return createSplatResource(device, decoded, LUMA_COMMENT);
  } catch (error) {
    if (!(error instanceof SplatBridgeError)) throw error;
    const code = error.failure === "empty" ? "LUMA_GAUSS_INVALID" : "LUMA_RESOURCE_CREATION_FAILED";
    const failure = new LumaError(code, error.message);
    failure.cause = error.cause ?? error;
    throw failure;
  }
}
