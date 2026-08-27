/**
 * SuperSplatの公開シーンURLを、読み込んでよいSOGのURLへ解決するリクエストハンドラ。
 *
 * `app/insta360-resolver.ts` と同じ考え方で、解決だけをサーバー側で行い、SOG本体は
 * 中継しない。アプリ本体のWorker (`app/api/supersplat/route.ts`) と、GitHub Pages用の
 * 専用Worker (`resolver-worker/index.ts`) の両方から同じ実装を使う。
 *
 * - `GET ?url=<SuperSplatのシーンURL>` … 公開メタデータと、あればアセットのURLをJSONで返す
 *
 * ## 処理順（この順序が仕様）
 *
 *   シーンURL → 公開ページ取得 → 公開メタデータ解析 → Downloadable判定
 *     → （YESのときだけ）ライセンス確認 → asset discovery
 *
 * 逆順——シーンIDからCDNを叩いてデータが見つかったから読む——は禁止。作者が
 * ダウンロードを許可していない作品のデータがCDN上に存在することはあり得るが、
 * それは取得してよい理由にならない。判定できないときも読み込まない（fail-closed）。
 */
import {
  SUPERSPLAT_ERROR_MESSAGES,
  findSuperSplatContentUrls,
  parseSuperSplatUrl,
  readSuperSplatSceneMeta,
  selectSuperSplatAsset,
  type SuperSplatErrorCode,
  type SuperSplatResolution,
  type SuperSplatShare,
} from "./supersplat";

export const CORS_HEADERS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, OPTIONS",
  "access-control-allow-headers": "content-type",
};

const PAGE_HEADERS: Record<string, string> = {
  "user-agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
  accept: "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8",
  "accept-language": "ja,en;q=0.8",
};

/** 公開ページのHTMLとして読む上限。ページとしては十分で、巨大な応答で詰まらせない。 */
const MAX_PAGE_BYTES = 4 * 1024 * 1024;

/**
 * 内部エラーコードとHTTP statusの対応。
 *
 * 「読み込ませない」判断（Downloadable OFF）は403に統一する。ページは取れたが
 * 必要な情報が揃わなかったものは422、SuperSplat側に届かなかったものは502。
 */
const ERROR_STATUS: Record<SuperSplatErrorCode, number> = {
  INVALID_SUPERSPLAT_URL: 400,
  SUPERSPLAT_SCENE_NOT_FOUND: 404,
  SUPERSPLAT_NOT_DOWNLOADABLE: 403,
  SUPERSPLAT_LICENSE_NOT_FOUND: 422,
  SUPERSPLAT_ASSET_NOT_FOUND: 422,
  SUPERSPLAT_STREAMED_SOG_UNSUPPORTED: 422,
  SUPERSPLAT_UNAVAILABLE: 502,
};

class SuperSplatError extends Error {
  code: SuperSplatErrorCode;

  constructor(code: SuperSplatErrorCode) {
    super(SUPERSPLAT_ERROR_MESSAGES[code]);
    this.code = code;
  }
}

function jsonResponse(body: unknown, status: number) {
  return Response.json(body, { status, headers: CORS_HEADERS });
}

/** 公開ページのHTMLを取ってくる。ページが無い／取れない場合は投げる。 */
async function fetchScenePage(share: SuperSplatShare): Promise<string> {
  let response: Response;
  try {
    response = await fetch(share.sceneUrl, { headers: PAGE_HEADERS, redirect: "follow" });
  } catch {
    throw new SuperSplatError("SUPERSPLAT_UNAVAILABLE");
  }
  if (response.status === 404 || response.status === 410) {
    throw new SuperSplatError("SUPERSPLAT_SCENE_NOT_FOUND");
  }
  if (!response.ok) throw new SuperSplatError("SUPERSPLAT_UNAVAILABLE");

  const html = await response.text().catch(() => "");
  if (!html) throw new SuperSplatError("SUPERSPLAT_UNAVAILABLE");
  return html.length > MAX_PAGE_BYTES ? html.slice(0, MAX_PAGE_BYTES) : html;
}

/**
 * 公開シーンを解決する。処理順はモジュール冒頭のとおり。
 *
 * asset discoveryはDownloadableとライセンスの確認を通ったあとにしか走らない。
 * ここでのdiscoveryはページに書かれているURLを読むだけで、CDNへは触らない。
 */
export async function resolveSuperSplatScene(
  share: SuperSplatShare,
): Promise<SuperSplatResolution> {
  const html = await fetchScenePage(share);
  const meta = readSuperSplatSceneMeta(html);

  // 1. Downloadable。`false` も「読み取れなかった (null)」も同じく読み込まない。
  if (meta.downloadable !== true) throw new SuperSplatError("SUPERSPLAT_NOT_DOWNLOADABLE");

  // 2. ライセンス。取れなければ推測せず明示的に断る。
  if (!meta.license) throw new SuperSplatError("SUPERSPLAT_LICENSE_NOT_FOUND");

  // 3. ここまで通って初めてアセットを探す。
  const asset = selectSuperSplatAsset(findSuperSplatContentUrls(html, share.sceneUrl));
  if (!asset) throw new SuperSplatError("SUPERSPLAT_ASSET_NOT_FOUND");

  return {
    provider: "supersplat",
    sceneId: share.sceneId,
    pageUrl: share.sceneUrl,
    title: meta.title,
    author: meta.author,
    downloadable: true,
    license: meta.license,
    // `streamed-sog` もそのまま返す。表示できるかどうかはViewerが決める。
    // 将来Streamed SOGへ対応するとき、resolverはこのままでよい。
    asset,
  };
}

export function handleSuperSplatOptions(): Response {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

export async function handleSuperSplatRequest(request: Request): Promise<Response> {
  const requestUrl = new URL(request.url);
  const share = parseSuperSplatUrl(requestUrl.searchParams.get("url") ?? "");

  if (!share) {
    const code: SuperSplatErrorCode = "INVALID_SUPERSPLAT_URL";
    return jsonResponse({ error: SUPERSPLAT_ERROR_MESSAGES[code], code }, ERROR_STATUS[code]);
  }

  try {
    return jsonResponse(await resolveSuperSplatScene(share), 200);
  } catch (error) {
    const code: SuperSplatErrorCode =
      error instanceof SuperSplatError ? error.code : "SUPERSPLAT_UNAVAILABLE";
    return jsonResponse({ error: SUPERSPLAT_ERROR_MESSAGES[code], code }, ERROR_STATUS[code]);
  }
}
