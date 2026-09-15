/**
 * デコード済みSOG-XTをPlayCanvasのGSplatリソースへ載せる層。
 *
 * 変換そのもの——属性名の対応、`rot_*` の wxyz 並べ替え、`activated` の
 * 扱い——は提供元に依らないので `splat-playcanvas.ts` にある。こちらは
 * KISS-GS固有のもの、つまり失敗を `SogXtError` のコードへ翻訳することと、
 * 生成物に残すコメントだけを持つ。
 *
 * `DecodedSogXt` はKISS-GSのデコード結果がそのままactivated形式
 * （`scale` は線形、`opacity` はsigmoid済み）なので、log/pre-sigmoidへ
 * 戻す往復は挟まない。
 */
import { GSplatData, GSplatResource } from "playcanvas";
import { SogXtError, type DecodedSogXt } from "./sog-xt.ts";
import {
  SplatBridgeError,
  createSplatData,
  createSplatResource,
  splatPropertiesOf as splatProperties,
  type SplatProperty,
} from "./splat-playcanvas.ts";

/** 生成した `GSplatData` に残すコメント。出どころの記録用。 */
const SOG_XT_COMMENT = "generated from KISS-GS SOG-XT";

export type { SplatProperty };

/** デコード結果からPLY互換の属性一覧を組む。実装は `splat-playcanvas.ts`。 */
export function splatPropertiesOf(decoded: DecodedSogXt): SplatProperty[] {
  return splatProperties(decoded);
}

/** SOG-XT用の失敗コードへ翻訳する。 */
function asSogXtError(error: unknown): unknown {
  if (!(error instanceof SplatBridgeError)) return error;
  const code = error.failure === "empty" ? "INCONSISTENT_SPLAT_COUNT" : "RESOURCE_CREATION_FAILED";
  const failure = new SogXtError(code, error.message);
  failure.cause = error.cause ?? error;
  return failure;
}

/** `GSplatData` を組む。`activated` の意味は `splat-playcanvas.ts` を参照。 */
export function createSogXtGSplatData(decoded: DecodedSogXt): GSplatData {
  try {
    return createSplatData(decoded, SOG_XT_COMMENT);
  } catch (error) {
    throw asSogXtError(error);
  }
}

/** デコード結果からGPUリソースを作る。`GSplatComponent.resource` へそのまま渡せる。 */
export function createSogXtResource(
  device: ConstructorParameters<typeof GSplatResource>[0],
  decoded: DecodedSogXt,
): GSplatResource {
  try {
    return createSplatResource(device, decoded, SOG_XT_COMMENT);
  } catch (error) {
    throw asSogXtError(error);
  }
}
