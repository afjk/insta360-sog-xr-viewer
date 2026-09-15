/**
 * Luma AI（https://lumalabs.ai）の公開キャプチャを読むための純粋関数群。
 *
 * Luma固有の知識——URLの形、公開APIの場所、artifactの種類、gaussianの
 * ビット詰め——は全てこのモジュールに閉じ込める。`SogViewer` にも
 * `luma.worker.ts` にもバイト並びを漏らさない。
 *
 * DOMにもWorkerランタイムにも依存しないので、ブラウザ側・Nodeのテストの
 * どこからでも読める。
 *
 * ## resolverを通さない
 *
 * Insta360共有ページとSuperSplatの公開ページはCORSを許可していないので、
 * 解決をサーバー側（`app/insta360-resolver.ts` / `app/supersplat-resolver.ts`）
 * でやっている。Lumaは違う。**公開キャプチャのAPIとartifactは、Luma自身が
 * 第三者のページから直接fetchさせる前提で配っている。**
 *
 * Lumaは `@lumaai/luma-web`（MIT, Luma AI）という公式のWebGLライブラリを
 * 出していて、その使い方が
 *
 *   new LumaSplatsThree({ source: 'https://lumalabs.ai/capture/<uuid>' })
 *
 * ——つまり任意のオリジンのページから、キャプチャのURLだけを渡してブラウザで
 * 取得する——というもの。公式のexample（`lumalabs/luma-web-examples` の
 * `src/DemoVR.ts` など）もそのまま第三者サイトから公開キャプチャを開いている。
 * 同じ取得をこちらのブラウザから行うだけなので、解決エンドポイントは要らない。
 * GitHub Pages版（`VITE_SOG_RESOLVER_ORIGIN=none`）でもLumaは開ける。
 *
 * ## 形式の出どころ
 *
 * ここに書いてあるAPIのパス・artifactの種類・バイト並びは、すべて公式
 * ライブラリ `@lumaai/luma-web` 0.2.2 の配布物（MIT）から読んだもの。
 *
 * - `dist/library/luma-web.module.js` … `LumaSplatsLoader` が
 *   `getArtifacts()` で叩くエンドポイントと、`downloadGauss1/2` の
 *   ヘッダ検証、`extractCpuPoints` のテクセル番地計算。
 * - 同ファイルの splat vertex shader … s0/s1テクスチャの中身の意味
 *   （位置・3D共分散・色）。このモジュールの `decodeLumaGaussians` は
 *   そのシェーダの読み出しと同じ並びを前提にしている。
 *
 * **実物のAPI応答とは突き合わせていない。** 実装時の環境から
 * `lumalabs.ai` / `webapp.engineeringlumalabs.com` へ到達できなかったため、
 * JSONのフィールド名（`response` / `latestRun` / `artifacts`）は公式ライブラリが
 * 読んでいるものをそのまま使い、それ以外（タイトルなど表示用の項目）は
 * 「あれば使う」形にしてある。応答の形が違っていたら直すのはこのモジュールだけ。
 *
 * ## 2種類のgaussian artifact
 *
 * Lumaのキャプチャは、描画に使うgaussianを2通りの形で持っている。
 *
 *   web v1     `gs_web_webmeta.json` ＋ `gs_web_gauss1.bin` ＋ `gs_web_gauss2.bin`
 *              ヘッダ付きの素のテクスチャ。ここではこちらを読む。
 *
 *   compressed `gs_compressed_meta.json` ＋ `gs_compressed`（core.bin）
 *              ブロックごとに難読化された圧縮ストリーム。復元は公式ライブラリが
 *              同梱するWASMデコーダにしかない。**このViewerでは読まない。**
 *
 * compressedしか無いキャプチャは、SuperSplatのStreamed SOGと同じ扱いにする
 * ——推測でこじ開けず、未対応であることを明示して読み込まない。
 */
// 拡張子を明示しているのは、このモジュールをテストからNodeで直接importするため。
import { isPubliclyRoutableHost, toAbsoluteUrl } from "./url-safety.ts";

/** キャプチャの公開ページを置いているホスト。完全一致のみ。 */
export const LUMA_PAGE_HOSTS = ["lumalabs.ai", "www.lumalabs.ai"] as const;

/**
 * 公開キャプチャのメタデータを返すAPIのオリジン。
 *
 * `lumalabs.ai` ではなく `webapp.engineeringlumalabs.com`。公式ライブラリが
 * 叩いているのがこちらで、ページのホストとは別。
 */
export const LUMA_CAPTURE_API_ORIGIN = "https://webapp.engineeringlumalabs.com";

/** 3DGSのSH第0次係数を色へ直す定数。`sog-xt.ts` の `SH_C0` と同じ値。 */
export const SH_C0 = 0.28209479177387814;

/** gaussianテクスチャの幅。公式ライブラリの `L = 2048` に対応する。 */
export const LUMA_TEXTURE_WIDTH = 2048;

/** テクセルを詰めるタイルの一辺。公式ライブラリの `p = 4`。 */
export const LUMA_TILE_SIDE = 4;

/** `gs_web_gauss1/2.bin` の先頭にあるヘッダの大きさ（uint32 × 4）。 */
export const LUMA_GAUSS_HEADER_BYTES = 16;

/** このデコーダが読める `gs_web_gauss*.bin` のバージョン。 */
export const LUMA_GAUSS_VERSION = 1;

const CAPTURE_UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** ギャラリー（一覧）ページのパス。単一の空間を指していないので読み込めない。 */
const GALLERY_PATHS = ["/featured", "/gallery", "/discover", "/interactive-scenes"];

/** 解析したキャプチャの参照。 */
export type LumaCapture = {
  /** キャプチャのUUID。パーマリンクにもこれを載せる。 */
  uuid: string;
  /** 正規化した公開ページのURL。クレジットのリンク先に使う。 */
  captureUrl: string;
};

/** APIから読み取った、表示に使うメタデータ。取得可否の判断には使わない。 */
export type LumaCaptureMeta = {
  /** キャプチャの題名。応答に無ければ `null`。 */
  title: string | null;
};

/**
 * 公開APIが返すartifactの一覧。`{ type: url }` の形へ寄せたもの。
 *
 * 公式ライブラリの `convertArtifactArray` と同じ形。同じ `type` が複数あれば
 * 最後のものが残る（ライブラリの挙動に合わせる）。
 */
export type LumaArtifacts = Record<string, string>;

/** artifactのうち、gaussianを載せているものの組み合わせ。 */
export type LumaGaussians =
  | {
      format: "web-v1";
      /** splat数などを載せたJSON。 */
      metaUrl: string;
      /** 位置と共分散の一部（RG32UI相当）。 */
      gauss1Url: string;
      /** 共分散の残りと色（RGBA32UI相当）。 */
      gauss2Url: string;
      /** SHのテクスチャ。あっても現状は読まない。 */
      shUrl: string | null;
    }
  | {
      format: "compressed";
      metaUrl: string;
      coreUrl: string;
    };

/** `gs_web_gauss*.bin` のヘッダ。 */
export type LumaGaussHeader = {
  version: number;
  width: number;
  height: number;
  channels: number;
};

/** `gs_web_webmeta.json` から読み取るもの。 */
export type LumaWebMeta = {
  /** `1` 以外はこのデコーダの対象外。 */
  version: number;
  /** キャプチャが宣言しているsplat数。 */
  numSplats: number;
  /** 配信バイト数。進捗表示の目安。分からなければ `0`。 */
  totalBytes: number;
  /** シーンの中心。読めなければ原点。 */
  sceneCenter: [number, number, number];
  /** SHのテクスチャを持っているか。持っていても現状は読まない。 */
  haveSh: boolean;
};

/**
 * デコード結果。`sog-xt.ts` の `DecodedSogXt` と同じ **activated形式**。
 *
 * - `scale` は線形（`exp` 済み）
 * - `opacity` はsigmoid適用済み（0〜1）
 * - `rotation` は xyzw、正規化済み
 * - `fDc` は色ではなくSHのDC係数（色は `0.5 + SH_C0 * fDc`）
 *
 * 並びは成分ごと（planar）。`splat-playcanvas.ts` がこの形をそのまま
 * `GSplatData` へ渡す。
 */
export type DecodedLuma = {
  count: number;
  /** 3 × count。`[x…, y…, z…]`。キャプチャのローカル座標。 */
  position: Float32Array;
  /** 3 × count。`[x…, y…, z…]`。線形スケール。共分散の固有値の平方根。 */
  scale: Float32Array;
  /** 4 × count。`[x…, y…, z…, w…]`。正規化済み。 */
  rotation: Float32Array;
  /** count。0〜1。 */
  opacity: Float32Array;
  /** 3 × count。`[r…, g…, b…]`。SHのDC係数。 */
  fDc: Float32Array;
  /** Lumaは色をRGBA8で持っていて高次のSHは別テクスチャなので、常に `null`。 */
  fRest: null;
  shBands: 0;
  /** デバッグ用。共分散が退化していて姿勢を決められなかったsplatの数。 */
  degenerate: number;
  /** デバッグ用。読んだテクスチャの高さ（px）。 */
  textureHeight: number;
};

/** UI・呼び出し側がエラーの種類で分岐するための識別子。 */
export type LumaErrorCode =
  | "INVALID_LUMA_URL"
  | "LUMA_GALLERY_URL"
  | "LUMA_CAPTURE_NOT_FOUND"
  | "LUMA_UNAVAILABLE"
  | "LUMA_ARTIFACTS_NOT_FOUND"
  | "LUMA_COMPRESSED_UNSUPPORTED"
  | "LUMA_META_INVALID"
  | "LUMA_GAUSS_DOWNLOAD_FAILED"
  | "LUMA_GAUSS_INVALID"
  | "LUMA_RESOURCE_CREATION_FAILED";

/**
 * エラーコードに対応するユーザー向けの文言。
 *
 * コードはデコーダとViewerの間の契約、文言は画面表示。分けておくと、
 * デコーダを触らずに言い回しだけ直せる。
 */
export const LUMA_ERROR_MESSAGES: Record<LumaErrorCode, string> = {
  INVALID_LUMA_URL:
    "Lumaのキャプチャページ（https://lumalabs.ai/capture/…）のURLを指定してください。",
  LUMA_GALLERY_URL:
    "これはLumaの一覧ページです。開きたいキャプチャのページを開いて、そのURL（https://lumalabs.ai/capture/…）を貼り付けてください。",
  LUMA_CAPTURE_NOT_FOUND:
    "このLumaキャプチャが見つかりませんでした。URLが正しいか、公開されているかをご確認ください。",
  LUMA_UNAVAILABLE:
    "Lumaのキャプチャ情報を取得できませんでした。時間をおいて試してください。",
  LUMA_ARTIFACTS_NOT_FOUND:
    "このLumaキャプチャから読み込めるGaussian Splatを見つけられませんでした。",
  LUMA_COMPRESSED_UNSUPPORTED:
    "このLumaキャプチャはLuma独自の圧縮形式でのみ配信されています。現在このViewerでは未対応です。",
  LUMA_META_INVALID: "LumaキャプチャのメタデータJSONを解釈できませんでした。",
  LUMA_GAUSS_DOWNLOAD_FAILED: "LumaキャプチャのGaussianデータを取得できませんでした。",
  LUMA_GAUSS_INVALID: "LumaキャプチャのGaussianデータを解釈できませんでした。",
  LUMA_RESOURCE_CREATION_FAILED: "LumaキャプチャをPlayCanvasへ渡せませんでした。",
};

/** 種類を持つエラー。`message` は開発者向け、`code` が表示の切り替え。 */
export class LumaError extends Error {
  readonly code: LumaErrorCode;
  constructor(code: LumaErrorCode, detail?: string) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = "LumaError";
    this.code = code;
  }
  /** ユーザーへ出す日本語。 */
  get userMessage(): string {
    return LUMA_ERROR_MESSAGES[this.code];
  }
}

/** 呼び出し側の `catch` から表示用の文言を取り出す。 */
export function lumaErrorMessage(error: unknown): string {
  if (error instanceof LumaError) return error.userMessage;
  if (error instanceof Error && error.message) return error.message;
  return "Lumaキャプチャを読み込めませんでした。";
}

/* -------------------------------------------------------------------------- */
/* URL                                                                        */
/* -------------------------------------------------------------------------- */

/**
 * LumaのキャプチャIDとして扱える文字列か。
 *
 * 公式ライブラリは最後のパスセグメントから `/^([\w-]+)/` を取るだけで形を
 * 見ていないが、こちらはUUIDだけを通す。実在するキャプチャURLはすべて
 * UUIDで、緩めるとページのパス（`/featured` など）まで拾ってしまう。
 */
export function isLumaCaptureUuid(value: string): boolean {
  return CAPTURE_UUID_PATTERN.test(value.trim());
}

/** UUIDから正規の公開ページURLを組み立てる。形が違えば `null`。 */
export function captureUrlFromUuid(value: string): string | null {
  const uuid = value.trim().toLowerCase();
  if (!isLumaCaptureUuid(uuid)) return null;
  return `https://${LUMA_PAGE_HOSTS[0]}/capture/${uuid}`;
}

/**
 * Lumaのキャプチャ URLを解析してUUIDを取り出す。
 *
 * 受け付ける形は3つ。どれも canonical な `/capture/{uuid}` へ正規化する。
 *
 *   https://lumalabs.ai/capture/{uuid}     公開ページ
 *   https://lumalabs.ai/embed/{uuid}       埋め込み用ページ（共有メニューから出る形）
 *   https://lumalabs.ai/…?uuid={uuid}      公式ライブラリのviewerが使うquery
 *
 * ホストは `lumalabs.ai` / `www.lumalabs.ai` の完全一致のみ。
 * `lumalabs.ai.example.com` のような紛らわしいドメインは通さない。
 * `?mode=sparkles` のような表示用のqueryは落とす。
 */
export function parseLumaCaptureUrl(input: string): LumaCapture | null {
  const url = toAbsoluteUrl(input);
  if (!url) return null;
  const host = url.hostname.toLowerCase();
  if (!LUMA_PAGE_HOSTS.some((allowed) => allowed === host)) return null;

  // `new URL` が `..` を畳んでくれるので、ここに残るのは正規化済みのパス。
  // それでも `%2F` はデコードされずに残るため、IDの文字種でもう一度弾く。
  const fromPath = url.pathname.match(/^\/(?:capture|embed)\/([^/]+)\/?$/)?.[1] ?? "";
  const fromQuery = url.searchParams.get("uuid") ?? "";
  const uuid = (fromPath || fromQuery).trim().toLowerCase();
  const captureUrl = captureUrlFromUuid(uuid);
  return captureUrl ? { uuid, captureUrl } : null;
}

/**
 * 一覧ページのURLか。
 *
 * `https://lumalabs.ai/featured` のような一覧は空間ひとつを指していないので
 * 読み込めない。ただ弾くだけだと「なぜ開けないのか」が分からないので、
 * 専用の文言（`LUMA_GALLERY_URL`）を出すために見分ける。
 */
export function isLumaGalleryUrl(input: string): boolean {
  const url = toAbsoluteUrl(input);
  if (!url) return false;
  const host = url.hostname.toLowerCase();
  if (!LUMA_PAGE_HOSTS.some((allowed) => allowed === host)) return false;
  if (parseLumaCaptureUrl(input)) return false;
  const path = url.pathname.replace(/\/+$/, "").toLowerCase() || "/";
  return path === "/" || GALLERY_PATHS.some((gallery) => path === gallery);
}

/** 公開キャプチャのメタデータを返すAPIのURL。形が違えば `null`。 */
export function lumaCaptureApiUrl(value: string): string | null {
  const uuid = value.trim().toLowerCase();
  if (!isLumaCaptureUuid(uuid)) return null;
  return `${LUMA_CAPTURE_API_ORIGIN}/api/v3/captures/${uuid}/public`;
}

/* -------------------------------------------------------------------------- */
/* 公開APIの応答                                                               */
/* -------------------------------------------------------------------------- */

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

/**
 * artifactのURLとして受け付けてよいか。
 *
 * 取りに行くのはブラウザで、資格情報も付けない。それでも応答に入っていた
 * 文字列をそのままfetchするので、httpsで公開ルーティング可能なホストだけに
 * 絞る。配信CDNのホスト名は実物で確認できていないので固定していない——
 * 確認できたらSuperSplat（`isSuperSplatAssetUrl`）と同じくホスト名で
 * 絞り込むほうがよい。
 */
export function isLumaArtifactUrl(input: string): boolean {
  const url = toAbsoluteUrl(input);
  if (!url) return false;
  return url.protocol === "https:" && isPubliclyRoutableHost(url.hostname);
}

/**
 * 公開APIの応答からartifactの一覧を取り出す。
 *
 * 応答は `{ response: { artifacts: [...] } }` か
 * `{ latestRun: { artifacts: [...] } }`。公式ライブラリが
 * `(response ?? latestRun).artifacts` と読んでいるので、同じ順で見る。
 *
 * 各要素は `{ type, url }`。URLの形が通らないものは黙って落とす（部分的に
 * 壊れた応答でも、読めるartifactだけで開けるようにする）。
 */
export function readLumaArtifacts(payload: unknown): LumaArtifacts {
  const root = asRecord(payload);
  if (!root) return {};
  const run = asRecord(root.response) ?? asRecord(root.latestRun) ?? root;
  const list = run.artifacts;
  if (!Array.isArray(list)) return {};

  const artifacts: LumaArtifacts = {};
  for (const item of list) {
    const entry = asRecord(item);
    const type = typeof entry?.type === "string" ? entry.type.trim() : "";
    const url = typeof entry?.url === "string" ? entry.url.trim() : "";
    if (!type || !isLumaArtifactUrl(url)) continue;
    artifacts[type] = url;
  }
  return artifacts;
}

/**
 * 表示用のメタデータを読む。
 *
 * 実物の応答と突き合わせていないので、題名のキー名は候補を順に見るだけに
 * してある。取れなくても読み込みは続ける（クレジットにはキャプチャページの
 * リンクを必ず出すので、題名は無くても出典は辿れる）。
 */
export function readLumaCaptureMeta(payload: unknown): LumaCaptureMeta {
  const root = asRecord(payload);
  const run = asRecord(root?.response) ?? asRecord(root?.latestRun) ?? root;
  for (const source of [run, root]) {
    for (const key of ["title", "name", "captureName", "displayName"]) {
      const value = source?.[key];
      if (typeof value === "string" && value.trim()) return { title: value.trim() };
    }
  }
  return { title: null };
}

/**
 * gaussianを載せているartifactを選ぶ。
 *
 * web v1の3点（`gs_web_webmeta` / `gs_web_gauss1` / `gs_web_gauss2`）が
 * 揃っていればそれを使う。無ければcompressedの有無だけを見て返す——
 * 呼び出し側が「未対応」と「そもそも無い」を区別して出せるようにする。
 *
 * 公式ライブラリは `gs_compressed_meta` があればそちらを優先するが、ここでは
 * 逆にweb v1を優先する。読めるのはweb v1だけなので、両方あるキャプチャは
 * web v1として開く。
 */
export function selectLumaGaussians(artifacts: LumaArtifacts): LumaGaussians | null {
  const metaUrl = artifacts.gs_web_webmeta;
  const gauss1Url = artifacts.gs_web_gauss1;
  const gauss2Url = artifacts.gs_web_gauss2;
  if (metaUrl && gauss1Url && gauss2Url) {
    return {
      format: "web-v1",
      metaUrl,
      gauss1Url,
      gauss2Url,
      shUrl: artifacts.gs_web_sh ?? null,
    };
  }
  const coreUrl = artifacts.gs_compressed;
  const compressedMetaUrl = artifacts.gs_compressed_meta;
  if (coreUrl && compressedMetaUrl) {
    return { format: "compressed", metaUrl: compressedMetaUrl, coreUrl };
  }
  return null;
}

/**
 * `gs_web_webmeta.json` を読む。
 *
 * 公式ライブラリの `downloadMeta` が `version == 1` のときに読む項目と同じ。
 * `version` が1以外なら、それはcompressed側のメタデータなので弾く。
 */
export function parseLumaWebMeta(payload: unknown): LumaWebMeta {
  const root = asRecord(payload);
  if (!root) throw new LumaError("LUMA_META_INVALID", "オブジェクトではありません");

  const version = typeof root.version === "number" ? root.version : 0;
  if (version !== 1) {
    throw new LumaError("LUMA_META_INVALID", `version=${String(root.version)}`);
  }
  const numSplats = typeof root.num_splats === "number" ? Math.floor(root.num_splats) : 0;
  if (!Number.isFinite(numSplats) || numSplats < 1) {
    throw new LumaError("LUMA_META_INVALID", `num_splats=${String(root.num_splats)}`);
  }
  const center = Array.isArray(root.scene_center) ? root.scene_center : [];
  const axis = (index: number) =>
    typeof center[index] === "number" && Number.isFinite(center[index])
      ? (center[index] as number)
      : 0;
  return {
    version,
    numSplats,
    totalBytes: typeof root.total_bytes === "number" ? root.total_bytes : 0,
    sceneCenter: [axis(0), axis(1), axis(2)],
    haveSh: root.have_sh === true,
  };
}

/* -------------------------------------------------------------------------- */
/* gaussianテクスチャの読み出し                                                */
/* -------------------------------------------------------------------------- */

/**
 * `gs_web_gauss*.bin` のヘッダを読む。
 *
 * 先頭16バイトは uint32 × 4 で `[version, width, height, channels]`。
 * 公式ライブラリの `downloadGauss1` / `downloadGauss2` は
 * `version != 1 || width != 2048 || channels != 期待値` を即エラーにしている。
 * 同じ条件で弾く——ここを緩めると、別物を読んで無音で壊れた空間が出る。
 */
export function parseLumaGaussHeader(bytes: Uint8Array, expectedChannels: number): LumaGaussHeader {
  if (bytes.byteLength < LUMA_GAUSS_HEADER_BYTES) {
    throw new LumaError("LUMA_GAUSS_INVALID", `header too short (${bytes.byteLength}B)`);
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, LUMA_GAUSS_HEADER_BYTES);
  const header: LumaGaussHeader = {
    version: view.getUint32(0, true),
    width: view.getUint32(4, true),
    height: view.getUint32(8, true),
    channels: view.getUint32(12, true),
  };
  if (header.version !== LUMA_GAUSS_VERSION) {
    throw new LumaError("LUMA_GAUSS_INVALID", `version=${header.version}`);
  }
  if (header.width !== LUMA_TEXTURE_WIDTH) {
    throw new LumaError("LUMA_GAUSS_INVALID", `width=${header.width}`);
  }
  if (header.channels !== expectedChannels) {
    throw new LumaError(
      "LUMA_GAUSS_INVALID",
      `channels=${header.channels} (expected ${expectedChannels})`,
    );
  }
  if (header.height < 1) {
    throw new LumaError("LUMA_GAUSS_INVALID", `height=${header.height}`);
  }
  return header;
}

/**
 * splat番号からテクセルの番地（`y * width + x`）へ。
 *
 * Lumaはsplatを4×4のタイルに詰めている。シェーダの
 *
 *   ivec2(4 * ((D >> 4) & 0x1ff) + (D & 3), 4 * (D >> 13) + ((D >> 2) & 3))
 *
 * と、CPU側の `extractCpuPoints` の計算がこれ。番号の下2bitがタイル内のx、
 * 次の2bitがタイル内のy、続く9bitがタイル列（512列 × 4px = 2048px）、
 * 残りがタイル行になる。
 */
export function lumaTexelIndex(splatIndex: number, width: number): number {
  const x = LUMA_TILE_SIDE * ((splatIndex >> 4) & 0x1ff) + (splatIndex & 3);
  const y = LUMA_TILE_SIDE * (splatIndex >> 13) + ((splatIndex >> 2) & 3);
  return y * width + x;
}

/**
 * IEEE 754 half（16bit）をNumberへ。
 *
 * `unpackHalf2x16` のCPU側。公式ライブラリが同じ変換を持っている
 * （`luma-web.module.js` 末尾の関数）ので、値の意味はそれと一致する。
 */
export function halfToFloat(bits: number): number {
  const exponent = (bits & 0x7c00) >> 10;
  const fraction = bits & 0x03ff;
  const sign = bits >> 15 ? -1 : 1;
  if (exponent === 0) return sign * 6.103515625e-5 * (fraction / 1024);
  if (exponent === 31) return fraction ? NaN : sign * Infinity;
  return sign * Math.pow(2, exponent - 15) * (1 + fraction / 1024);
}

/** 色（0〜1）からSHのDC係数へ。`colorFromDc` の逆。 */
export function dcFromColor(color: number): number {
  return (color - 0.5) / SH_C0;
}

/**
 * 対称3×3行列の固有値分解。Jacobi回転を収束するまで回す。
 *
 * Lumaが持っているのは3D共分散 Σ そのもの（スケールと姿勢に分けた形では
 * ない）。3DGSの Σ = R diag(s²) Rᵀ なので、固有値の平方根がスケール、
 * 固有ベクトルが姿勢になる。
 *
 * 返す `vectors` は**列ベクトル**を3本並べた配列（`vectors[i]` が
 * `values[i]` に対応する固有ベクトル）。
 */
export function eigenDecomposeSymmetric3(
  xx: number,
  yy: number,
  zz: number,
  xy: number,
  xz: number,
  yz: number,
): { values: [number, number, number]; vectors: [number[], number[], number[]] } {
  // 作業用の対称行列と、掛け合わせていく回転。
  const a = [
    [xx, xy, xz],
    [xy, yy, yz],
    [xz, yz, zz],
  ];
  const v = [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1],
  ];
  // 非対角の大きさが数値誤差の水準まで落ちたら止める。実データでは数回で収まる。
  const scale = Math.abs(xx) + Math.abs(yy) + Math.abs(zz) + 1e-30;
  for (let sweep = 0; sweep < 24; sweep += 1) {
    const off = Math.abs(a[0][1]) + Math.abs(a[0][2]) + Math.abs(a[1][2]);
    if (off <= 1e-12 * scale) break;
    for (const [p, q] of [
      [0, 1],
      [0, 2],
      [1, 2],
    ] as const) {
      const apq = a[p][q];
      if (Math.abs(apq) <= 1e-18 * scale) continue;
      // 2×2の部分行列を対角化する回転角。`theta` が大きいときの
      // 桁落ちを避けるため、`t` は分母を足す形で求める。
      const theta = (a[q][q] - a[p][p]) / (2 * apq);
      const t =
        (theta >= 0 ? 1 : -1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
      const c = 1 / Math.sqrt(t * t + 1);
      const s = t * c;
      const app = a[p][p];
      const aqq = a[q][q];
      a[p][p] = app - t * apq;
      a[q][q] = aqq + t * apq;
      a[p][q] = 0;
      a[q][p] = 0;
      const r = p === 0 && q === 1 ? 2 : p === 0 && q === 2 ? 1 : 0;
      const apr = a[p][r];
      const aqr = a[q][r];
      a[p][r] = c * apr - s * aqr;
      a[r][p] = a[p][r];
      a[q][r] = s * apr + c * aqr;
      a[r][q] = a[q][r];
      for (let row = 0; row < 3; row += 1) {
        const vp = v[row][p];
        const vq = v[row][q];
        v[row][p] = c * vp - s * vq;
        v[row][q] = s * vp + c * vq;
      }
    }
  }
  return {
    values: [a[0][0], a[1][1], a[2][2]],
    vectors: [
      [v[0][0], v[1][0], v[2][0]],
      [v[0][1], v[1][1], v[2][1]],
      [v[0][2], v[1][2], v[2][2]],
    ],
  };
}

/**
 * 回転行列（列ベクトル3本）からクォータニオン xyzw へ。
 *
 * 最大成分から求める分岐つきの標準的な手順。`w` が0近傍でも桁落ちしない。
 */
export function quaternionFromColumns(
  c0: readonly number[],
  c1: readonly number[],
  c2: readonly number[],
): [number, number, number, number] {
  const m00 = c0[0];
  const m10 = c0[1];
  const m20 = c0[2];
  const m01 = c1[0];
  const m11 = c1[1];
  const m21 = c1[2];
  const m02 = c2[0];
  const m12 = c2[1];
  const m22 = c2[2];
  const trace = m00 + m11 + m22;
  let x: number;
  let y: number;
  let z: number;
  let w: number;
  if (trace > 0) {
    const s = Math.sqrt(trace + 1) * 2;
    w = 0.25 * s;
    x = (m21 - m12) / s;
    y = (m02 - m20) / s;
    z = (m10 - m01) / s;
  } else if (m00 > m11 && m00 > m22) {
    const s = Math.sqrt(1 + m00 - m11 - m22) * 2;
    w = (m21 - m12) / s;
    x = 0.25 * s;
    y = (m01 + m10) / s;
    z = (m02 + m20) / s;
  } else if (m11 > m22) {
    const s = Math.sqrt(1 + m11 - m00 - m22) * 2;
    w = (m02 - m20) / s;
    x = (m01 + m10) / s;
    y = 0.25 * s;
    z = (m12 + m21) / s;
  } else {
    const s = Math.sqrt(1 + m22 - m00 - m11) * 2;
    w = (m10 - m01) / s;
    x = (m02 + m20) / s;
    y = (m12 + m21) / s;
    z = 0.25 * s;
  }
  const length = Math.hypot(x, y, z, w) || 1;
  return [x / length, y / length, z / length, w / length];
}

/**
 * 共分散から線形スケールと姿勢クォータニオンへ。
 *
 * 固有ベクトルの向きは固有値分解が決めるものなので、3本を並べた行列は
 * 鏡映（det = -1）になることがある。そのままではクォータニオンにできないので
 * 1本だけ符号を反転させて右手系へ直す。ガウシアンは原点対称なので、
 * 軸の向きを反転しても表す楕円体は変わらない。
 */
export function splatFromCovariance(
  xx: number,
  yy: number,
  zz: number,
  xy: number,
  xz: number,
  yz: number,
): { scale: [number, number, number]; rotation: [number, number, number, number] } {
  const { values, vectors } = eigenDecomposeSymmetric3(xx, yy, zz, xy, xz, yz);
  const [c0, c1, c2] = vectors;
  // det < 0 なら鏡映。3本目を反転して右手系に揃える。
  const det =
    c0[0] * (c1[1] * c2[2] - c1[2] * c2[1]) -
    c1[0] * (c0[1] * c2[2] - c0[2] * c2[1]) +
    c2[0] * (c0[1] * c1[2] - c0[2] * c1[1]);
  if (det < 0) {
    c2[0] = -c2[0];
    c2[1] = -c2[1];
    c2[2] = -c2[2];
  }
  // 数値誤差で僅かに負へ振れた固有値は0へ丸める（負のスケールは作らない）。
  const scale: [number, number, number] = [
    Math.sqrt(Math.max(values[0], 0)),
    Math.sqrt(Math.max(values[1], 0)),
    Math.sqrt(Math.max(values[2], 0)),
  ];
  return { scale, rotation: quaternionFromColumns(c0, c1, c2) };
}

/**
 * 2つのテクスチャをsplatの属性へ展開する。
 *
 * バイト並びは公式ライブラリのvertex shaderが読んでいるもの。
 *
 *   gauss1 テクセル（uint32 × 2 = half × 4）
 *     [0] position.x  [1] position.y  [2] position.z  [3] Σxx
 *
 *   gauss2 テクセル（uint32 × 4）
 *     uint32[0] → half[0] Σyy, half[1] Σzz
 *     uint32[1] → half[2] Σxy, half[3] Σxz
 *     uint32[2] → half[4] Σyz, 上位16bitはSHテクスチャの索引（色ではない）
 *     uint32[3] → byte で R, G, B, A
 *
 * 共分散はシェーダで `mat3(n.x,o.x,o.y, o.x,n.y,o.z, o.y,o.z,n.z)` と組まれる
 * ——つまり n = (Σxx, Σyy, Σzz)、o = (Σxy, Σxz, Σyz) の対称行列。掛かる
 * `zs_aa_ts.z` は `tweakScale²`（既定1）なので、そのままΣとして読める。
 *
 * 色は評価済みのRGBで、SHのDC係数ではない。PlayCanvasへはDC係数として
 * 渡すので `dcFromColor` で戻す。不透明度はそのまま0〜1（activated形式）。
 */
export function decodeLumaGaussians(
  gauss1: Uint8Array,
  gauss2: Uint8Array,
  declaredCount: number,
): DecodedLuma {
  const header1 = parseLumaGaussHeader(gauss1, 2);
  const header2 = parseLumaGaussHeader(gauss2, 4);
  if (header1.height !== header2.height) {
    throw new LumaError(
      "LUMA_GAUSS_INVALID",
      `height mismatch (${header1.height} vs ${header2.height})`,
    );
  }
  const width = header1.width;
  const texels = width * header1.height;
  // 実際に届いたバイト数からもテクセル数を数える。ヘッダを信用して読み進めると
  // 途切れた応答で範囲外を読む。
  const available1 = Math.floor((gauss1.byteLength - LUMA_GAUSS_HEADER_BYTES) / 8);
  const available2 = Math.floor((gauss2.byteLength - LUMA_GAUSS_HEADER_BYTES) / 16);
  // タイル1行（4px）単位へ切り下げる。splat番号はタイルの中を行き来するので、
  // 行の途中で切ったテクセル数をそのまま上限にすると、番号が届いていない
  // テクセルを指しうる。公式ライブラリの `partialSizes` と同じ丸め方。
  const block = width * LUMA_TILE_SIDE;
  const capacity = Math.floor(Math.min(texels, available1, available2) / block) * block;
  const count = Math.min(declaredCount, capacity);
  if (count < 1) {
    throw new LumaError(
      "LUMA_GAUSS_INVALID",
      `no splats (declared=${declaredCount}, capacity=${capacity})`,
    );
  }

  const half1 = alignedUint16(gauss1, LUMA_GAUSS_HEADER_BYTES);
  const half2 = alignedUint16(gauss2, LUMA_GAUSS_HEADER_BYTES);
  const byte2 = gauss2.subarray(LUMA_GAUSS_HEADER_BYTES);

  const position = new Float32Array(3 * count);
  const scale = new Float32Array(3 * count);
  const rotation = new Float32Array(4 * count);
  const opacity = new Float32Array(count);
  const fDc = new Float32Array(3 * count);
  let degenerate = 0;

  for (let index = 0; index < count; index += 1) {
    const texel = lumaTexelIndex(index, width);
    const at1 = texel * 4; // half × 4
    const at2 = texel * 8; // half × 8
    const atByte = texel * 16 + 12; // uint32[3] の先頭バイト

    position[index] = halfToFloat(half1[at1]);
    position[count + index] = halfToFloat(half1[at1 + 1]);
    position[2 * count + index] = halfToFloat(half1[at1 + 2]);

    const sigmaXX = halfToFloat(half1[at1 + 3]);
    const sigmaYY = halfToFloat(half2[at2]);
    const sigmaZZ = halfToFloat(half2[at2 + 1]);
    const sigmaXY = halfToFloat(half2[at2 + 2]);
    const sigmaXZ = halfToFloat(half2[at2 + 3]);
    const sigmaYZ = halfToFloat(half2[at2 + 4]);

    if (
      Number.isFinite(sigmaXX) &&
      Number.isFinite(sigmaYY) &&
      Number.isFinite(sigmaZZ) &&
      Number.isFinite(sigmaXY) &&
      Number.isFinite(sigmaXZ) &&
      Number.isFinite(sigmaYZ)
    ) {
      const splat = splatFromCovariance(
        sigmaXX,
        sigmaYY,
        sigmaZZ,
        sigmaXY,
        sigmaXZ,
        sigmaYZ,
      );
      scale[index] = splat.scale[0];
      scale[count + index] = splat.scale[1];
      scale[2 * count + index] = splat.scale[2];
      rotation[index] = splat.rotation[0];
      rotation[count + index] = splat.rotation[1];
      rotation[2 * count + index] = splat.rotation[2];
      rotation[3 * count + index] = splat.rotation[3];
    } else {
      // 壊れた共分散は点を消すのではなく、大きさ0のsplatとして残す。
      // splat番号がずれると色や位置との対応が崩れる。
      rotation[3 * count + index] = 1;
      degenerate += 1;
    }

    fDc[index] = dcFromColor(byte2[atByte] / 255);
    fDc[count + index] = dcFromColor(byte2[atByte + 1] / 255);
    fDc[2 * count + index] = dcFromColor(byte2[atByte + 2] / 255);
    opacity[index] = byte2[atByte + 3] / 255;
  }

  return {
    count,
    position,
    scale,
    rotation,
    opacity,
    fDc,
    fRest: null,
    shBands: 0,
    degenerate,
    textureHeight: header1.height,
  };
}

/**
 * ヘッダの後ろをUint16として読むためのview。
 *
 * `fetch` → `arrayBuffer` なら `byteOffset` は0なので、ほとんどの場合は
 * viewを張るだけ（コピーなし）。2バイト境界に乗っていないときだけ写す。
 */
function alignedUint16(bytes: Uint8Array, headerBytes: number): Uint16Array {
  const start = bytes.byteOffset + headerBytes;
  const length = Math.floor((bytes.byteLength - headerBytes) / 2);
  if (start % 2 === 0) return new Uint16Array(bytes.buffer, start, length);
  const copy = new Uint8Array(bytes.subarray(headerBytes, headerBytes + length * 2));
  return new Uint16Array(copy.buffer, 0, length);
}
