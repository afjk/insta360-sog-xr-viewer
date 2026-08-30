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
 *   シーンURL
 *     → scene page (/scene/{id}) 取得
 *     → Downloadable判定         … NG/判定不能なら403でここで終了
 *     → ライセンス確認           … 取れなければ422でここで終了
 *     → viewer page (/s?id={id}) 取得   ← ここまで来て初めてアクセスする
 *     → asset discovery
 *
 * SuperSplatは1枚のHTMLで完結していない。許可とライセンスはscene pageに、
 * 実際に読むアセットのURLはviewer pageにある。**viewer pageへのアクセスは
 * Downloadableを確認したあとにしか行わない。** 許可されていない作品について、
 * 配信側へ足跡を残さないため。
 *
 * 逆順——シーンIDからCDNを叩いてデータが見つかったから読む——は禁止。作者が
 * ダウンロードを許可していない作品のデータがCDN上に存在することはあり得るが、
 * それは取得してよい理由にならない。判定できないときも読み込まない（fail-closed）。
 */
import {
  SUPERSPLAT_ERROR_MESSAGES,
  findSuperSplatContentUrls,
  findSuperSplatViewerUrl,
  parseSuperSplatUrl,
  readSuperSplatAttribution,
  readSuperSplatDownloadPermission,
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

/**
 * superspl.at のページを取ってくる。取れない場合は投げる。
 *
 * リダイレクトは追い、**最終URL**も返す。相対URLで書かれたcontentUrlは
 * リダイレクト後のURLを基準に解決しないとずれるため。
 *
 * 取りに行く先は呼び出し側が組み立てた superspl.at のURLだけ。ページから
 * 拾った任意のURLをここへ通すことはない。
 */
async function fetchSuperSplatPage(
  url: string,
  missingCode: SuperSplatErrorCode,
): Promise<{ html: string; finalUrl: string }> {
  let response: Response;
  try {
    response = await fetch(url, { headers: PAGE_HEADERS, redirect: "follow" });
  } catch {
    throw new SuperSplatError("SUPERSPLAT_UNAVAILABLE");
  }
  if (response.status === 404 || response.status === 410) throw new SuperSplatError(missingCode);
  if (!response.ok) throw new SuperSplatError("SUPERSPLAT_UNAVAILABLE");

  const html = await response.text().catch(() => "");
  if (!html) throw new SuperSplatError("SUPERSPLAT_UNAVAILABLE");
  return {
    html: html.length > MAX_PAGE_BYTES ? html.slice(0, MAX_PAGE_BYTES) : html,
    finalUrl: response.url || url,
  };
}

/**
 * 403の切り分け用の診断ログ。
 *
 * ページ構造が変わるとDownloadableを読めなくなり、利用者からは「許可されて
 * いる作品なのに403」に見える。何を根拠に落としたかだけを残す。HTML断片や
 * 解決したURLは出さない。
 */
function logPermission(sceneId: string, reason: string): void {
  console.warn("[supersplat] permission unresolved", { sceneId, reason });
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
  // 1. scene page。公開状態・帰属・許可はすべてここから読む。
  const scene = await fetchSuperSplatPage(share.sceneUrl, "SUPERSPLAT_SCENE_NOT_FOUND");
  const permission = readSuperSplatDownloadPermission(scene.html);

  // 2. Downloadable。`false` も「読み取れなかった (null)」も同じく読み込まない。
  if (permission.downloadable !== true) {
    logPermission(share.sceneId, permission.reason);
    throw new SuperSplatError("SUPERSPLAT_NOT_DOWNLOADABLE");
  }

  // 3. ライセンス。取れなければ推測せず明示的に断る。
  if (!permission.license) {
    logPermission(share.sceneId, "license-not-found");
    throw new SuperSplatError("SUPERSPLAT_LICENSE_NOT_FOUND");
  }

  // 4. ここまで通って初めてviewer pageを取りに行く。
  const viewerUrl = findSuperSplatViewerUrl(scene.html, share.sceneId);
  if (!viewerUrl) throw new SuperSplatError("SUPERSPLAT_ASSET_NOT_FOUND");
  const viewer = await fetchSuperSplatPage(viewerUrl, "SUPERSPLAT_SCENE_NOT_FOUND");

  // 5. アセットのURLはviewer pageが持っている。相対URLはリダイレクト後の
  //    最終URLを基準に解決する。
  const asset = selectSuperSplatAsset(findSuperSplatContentUrls(viewer.html, viewer.finalUrl));
  if (!asset) throw new SuperSplatError("SUPERSPLAT_ASSET_NOT_FOUND");

  const meta = readSuperSplatSceneMeta(scene.html);
  const attribution = readSuperSplatAttribution(
    scene.html,
    share.sceneUrl,
    meta.title,
    permission.license,
  );
  return {
    provider: "supersplat",
    sceneId: share.sceneId,
    pageUrl: share.sceneUrl,
    title: meta.title,
    author: meta.author,
    downloadable: true,
    license: permission.license,
    attribution,
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
