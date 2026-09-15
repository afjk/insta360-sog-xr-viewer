/// <reference lib="webworker" />
/**
 * Lumaの公開キャプチャの取得とデコードをUIスレッドの外で走らせるWorker。
 *
 * UIスレッドが受け取るのは進捗と完成した属性配列だけで、公開APIの解析も
 * テクスチャの展開も共分散の固有値分解もこちらで完結する。属性配列は
 * Transferableとして渡すので、main threadへのコピーは起きない。
 *
 * ここはネットワークとメッセージの段取りだけを持つ。バイト並びとURLの規則は
 * すべて `luma.ts` にある。
 */
import {
  LumaError,
  decodeLumaGaussians,
  lumaCaptureApiUrl,
  parseLumaWebMeta,
  readLumaArtifacts,
  readLumaCaptureMeta,
  selectLumaGaussians,
  type DecodedLuma,
  type LumaErrorCode,
} from "./luma.ts";

export type LumaRequest = { uuid: string };

/** 読み込みの内訳。`?debug=1` とベンチマーク表示で使う。 */
export type LumaTimings = {
  /** 公開APIとテクスチャの取得にかかった合計。 */
  downloadMs: number;
  /** テクスチャをsplatの属性へ戻すのにかかった時間。 */
  decodeMs: number;
  /** Worker内の総時間。 */
  totalMs: number;
};

/** UIへ返す、キャプチャの要約。APIの応答そのものは渡さない。 */
export type LumaSummary = {
  /** 読んだgaussianの形式。現在は `web-v1` のみ。 */
  format: "web-v1";
  /** 公開ページから取れた題名。無ければ `null`。 */
  title: string | null;
  /** `gs_web_webmeta.json` が宣言しているsplat数。 */
  declaredCount: number;
  /** テクスチャの高さ（px）。宣言数と合わないときの当たりを付けるのに使う。 */
  textureHeight: number;
  /** 共分散が壊れていて大きさ0にしたsplatの数。 */
  degenerate: number;
  /** SHのテクスチャを持っているか。持っていても現状は読まない。 */
  haveSh: boolean;
};

export type LumaProgress = { type: "progress"; stage: string; ratio: number };
export type LumaResult = {
  type: "done";
  decoded: DecodedLuma;
  summary: LumaSummary;
  downloadedBytes: number;
  timings: LumaTimings;
};
export type LumaFailure = { type: "error"; code: LumaErrorCode; message: string; detail: string };
export type LumaMessage = LumaProgress | LumaResult | LumaFailure;

const worker = self as unknown as DedicatedWorkerGlobalScope;

const report = (stage: string, ratio: number) => {
  worker.postMessage({ type: "progress", stage, ratio } satisfies LumaProgress);
};

/** 公開APIのJSONを取る。404は「見つからない」、それ以外の失敗は「届かない」。 */
async function fetchCapturePayload(uuid: string): Promise<unknown> {
  const url = lumaCaptureApiUrl(uuid);
  if (!url) throw new LumaError("INVALID_LUMA_URL", uuid);

  let response: Response;
  try {
    response = await fetch(url, { headers: { accept: "application/json" } });
  } catch (error) {
    throw new LumaError("LUMA_UNAVAILABLE", String(error));
  }
  if (response.status === 404 || response.status === 410) {
    throw new LumaError("LUMA_CAPTURE_NOT_FOUND", `HTTP ${response.status}`);
  }
  if (!response.ok) throw new LumaError("LUMA_UNAVAILABLE", `HTTP ${response.status}`);
  try {
    return await response.json();
  } catch (error) {
    throw new LumaError("LUMA_UNAVAILABLE", String(error));
  }
}

/** JSONのartifactを取る。 */
async function fetchJson(url: string): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(url, { headers: { accept: "application/json" } });
  } catch (error) {
    throw new LumaError("LUMA_META_INVALID", `${url} (${String(error)})`);
  }
  if (!response.ok) throw new LumaError("LUMA_META_INVALID", `${url} (HTTP ${response.status})`);
  try {
    return await response.json();
  } catch (error) {
    throw new LumaError("LUMA_META_INVALID", `${url} (${String(error)})`);
  }
}

/**
 * テクスチャを取る。読みながら進捗を出す。
 *
 * gaussianのテクスチャは数十MBになりうるので、総バイト数が分かる限りは実際の
 * 受信量で進捗を出す。`onBytes` の第2引数は総バイト数で、**分からなければ 0**。
 * 配信側が `access-control-expose-headers` に `content-length` を載せていないと
 * cross-originでは読めないため、0を「不明」として呼び出し側へ渡す
 * （受信量を総量の代わりに使うと、常に100%扱いになってしまう）。
 */
async function fetchTexture(
  url: string,
  onBytes: (received: number, total: number) => void,
): Promise<Uint8Array> {
  let response: Response;
  try {
    response = await fetch(url);
  } catch (error) {
    throw new LumaError("LUMA_GAUSS_DOWNLOAD_FAILED", `${url} (${String(error)})`);
  }
  if (!response.ok) {
    throw new LumaError("LUMA_GAUSS_DOWNLOAD_FAILED", `${url} (HTTP ${response.status})`);
  }
  const declared = Number(response.headers.get("content-length") ?? "");
  const total = Number.isFinite(declared) && declared > 0 ? declared : 0;
  if (!response.body) {
    const bytes = new Uint8Array(await response.arrayBuffer());
    onBytes(bytes.byteLength, total);
    return bytes;
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    chunks.push(value);
    received += value.byteLength;
    onBytes(received, total);
  }
  const bytes = new Uint8Array(received);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.byteLength;
  }
  return bytes;
}

async function load(request: LumaRequest): Promise<LumaResult> {
  const startedAt = performance.now();
  performance.mark?.("luma:worker:start");

  report("キャプチャ情報を取得中", 0.02);
  const downloadStart = performance.now();
  const payload = await fetchCapturePayload(request.uuid);
  const artifacts = readLumaArtifacts(payload);
  const gaussians = selectLumaGaussians(artifacts);
  if (!gaussians) {
    throw new LumaError("LUMA_ARTIFACTS_NOT_FOUND", `types=${Object.keys(artifacts).join(",")}`);
  }
  // Luma独自の圧縮ストリームは公式ライブラリ同梱のWASMデコーダにしか復元手段が
  // 無い。推測でこじ開けず、未対応であることを明示して止める。
  if (gaussians.format === "compressed") {
    throw new LumaError("LUMA_COMPRESSED_UNSUPPORTED", "gs_compressed only");
  }

  report("メタデータを取得中", 0.08);
  const meta = parseLumaWebMeta(await fetchJson(gaussians.metaUrl));

  // 2枚まとめて進捗を出す。総バイト数が分かっているものだけを分母にする。
  // どちらも分からなければ割合を出さず、段階の表示だけに留める。
  const received = [0, 0];
  const totals = [0, 0];
  const onBytes = (slot: number) => (bytes: number, total: number) => {
    received[slot] = bytes;
    totals[slot] = total;
    const known = totals[0] + totals[1];
    if (known <= 0) return;
    const done = (totals[0] > 0 ? received[0] : 0) + (totals[1] > 0 ? received[1] : 0);
    report("Gaussianを取得中", 0.1 + 0.75 * Math.min(done / known, 1));
  };
  report("Gaussianを取得中", 0.1);
  const [gauss1, gauss2] = await Promise.all([
    fetchTexture(gaussians.gauss1Url, onBytes(0)),
    fetchTexture(gaussians.gauss2Url, onBytes(1)),
  ]);
  const downloadMs = performance.now() - downloadStart;
  const downloadedBytes = gauss1.byteLength + gauss2.byteLength;

  report("Gaussianを復元中", 0.88);
  const decodeStart = performance.now();
  const decoded = decodeLumaGaussians(gauss1, gauss2, meta.numSplats);
  const decodeMs = performance.now() - decodeStart;
  report("Gaussianを復元中", 0.99);

  performance.mark?.("luma:worker:end");
  performance.measure?.("luma:worker", "luma:worker:start", "luma:worker:end");

  return {
    type: "done",
    decoded,
    summary: {
      format: "web-v1",
      title: readLumaCaptureMeta(payload).title,
      declaredCount: meta.numSplats,
      textureHeight: decoded.textureHeight,
      degenerate: decoded.degenerate,
      haveSh: meta.haveSh,
    },
    downloadedBytes,
    timings: {
      downloadMs: Math.round(downloadMs),
      decodeMs: Math.round(decodeMs),
      totalMs: Math.round(performance.now() - startedAt),
    },
  };
}

/** 結果に含まれるTypedArrayの裏バッファ。コピーせずにmain threadへ渡す。 */
const transferablesOf = (decoded: DecodedLuma): Transferable[] =>
  [
    decoded.position.buffer,
    decoded.scale.buffer,
    decoded.rotation.buffer,
    decoded.opacity.buffer,
    decoded.fDc.buffer,
  ] as Transferable[];

worker.onmessage = async (event: MessageEvent<LumaRequest>) => {
  try {
    const result = await load(event.data);
    worker.postMessage(result, transferablesOf(result.decoded));
  } catch (error) {
    const failure: LumaFailure =
      error instanceof LumaError
        ? { type: "error", code: error.code, message: error.userMessage, detail: error.message }
        : {
            type: "error",
            code: "LUMA_UNAVAILABLE",
            message: "Lumaキャプチャを読み込めませんでした。",
            detail: String(error),
          };
    worker.postMessage(failure);
  }
};
