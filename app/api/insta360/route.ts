/**
 * Insta360 Spatial Capture の共有URLをSOGアセットに解決するエンドポイント。
 *
 * 共有ページはブラウザからのクロスオリジン取得を許可していないため、
 * 解決とSOG本体の中継をサーバー側で行う。
 *
 * - `GET /api/insta360?url=<共有URL>` … 解決結果をJSONで返す
 * - `GET /api/insta360?url=<共有URL>&mode=asset` … SOG本体をそのまま中継する
 */
import {
  findFollowUpApiUrls,
  findSpatialAssetUrl,
  isPubliclyRoutableHost,
  parseInsta360ShareUrl,
  toAbsoluteUrl,
} from "../../insta360";

const CORS_HEADERS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, OPTIONS",
  "access-control-allow-headers": "content-type",
  "access-control-expose-headers": "content-length, content-type",
};

const PAGE_HEADERS: Record<string, string> = {
  "user-agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
  accept: "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8",
  "accept-language": "ja,en;q=0.8",
};

/** 二段目の手掛かりとして追跡するJSON/APIの最大数。 */
const MAX_FOLLOW_UPS = 3;

class ResolveError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function jsonResponse(body: unknown, status: number) {
  return Response.json(body, { status, headers: CORS_HEADERS });
}

async function fetchText(url: string) {
  const response = await fetch(url, { headers: PAGE_HEADERS, redirect: "follow" });
  if (!response.ok) {
    throw new ResolveError(502, `共有ページを取得できませんでした (HTTP ${response.status})`);
  }
  return { text: await response.text(), url: response.url || url };
}

/** 共有URLからSOGアセットのURLを解決する。 */
async function resolveAssetUrl(share: { shareId: string; shareUrl: string }) {
  const page = await fetchText(share.shareUrl);
  const direct = findSpatialAssetUrl(page.text, page.url);
  if (direct) return direct;

  for (const apiUrl of findFollowUpApiUrls(page.text, page.url, share.shareId).slice(0, MAX_FOLLOW_UPS)) {
    try {
      const followUp = await fetchText(apiUrl);
      const found = findSpatialAssetUrl(followUp.text, followUp.url);
      if (found) return found;
    } catch {
      // 手掛かりの取得失敗は致命的ではないので次の候補へ進む。
    }
  }

  throw new ResolveError(
    422,
    "共有ページからSOGのURLを見つけられませんでした。共有が期限切れの可能性があります。SOGファイルをお持ちの場合はドラッグ＆ドロップで読み込めます。",
  );
}

export async function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

export async function GET(request: Request) {
  const requestUrl = new URL(request.url);
  const input = requestUrl.searchParams.get("url") ?? "";
  const mode = requestUrl.searchParams.get("mode") ?? "resolve";
  const share = parseInsta360ShareUrl(input);

  if (!share) {
    return jsonResponse({ error: "Insta360の共有URLを指定してください。" }, 400);
  }

  try {
    const assetUrl = await resolveAssetUrl(share);
    const target = toAbsoluteUrl(assetUrl);
    if (!target || !isPubliclyRoutableHost(target.hostname)) {
      throw new ResolveError(422, "解決したSOGのURLを取得できませんでした。");
    }

    if (mode !== "asset") {
      return jsonResponse({ shareId: share.shareId, assetUrl: target.toString() }, 200);
    }

    const upstream = await fetch(target.toString(), { headers: { accept: "*/*" } });
    if (!upstream.ok || !upstream.body) {
      throw new ResolveError(502, `SOGを取得できませんでした (HTTP ${upstream.status})`);
    }

    const headers = new Headers(CORS_HEADERS);
    headers.set("content-type", "application/octet-stream");
    headers.set("cache-control", "public, max-age=300");
    const length = upstream.headers.get("content-length");
    if (length) headers.set("content-length", length);
    return new Response(upstream.body, { status: 200, headers });
  } catch (error) {
    const status = error instanceof ResolveError ? error.status : 502;
    const message = error instanceof Error ? error.message : "共有URLを解決できませんでした。";
    return jsonResponse({ error: message }, status);
  }
}
