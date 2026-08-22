/**
 * Insta360共有URLをSOGに解決し、本体を中継するリクエストハンドラ。
 *
 * 共有ページはブラウザからのクロスオリジン取得を許可していないため、
 * この処理はサーバー側で動かす必要がある。アプリ本体のCloudflare Worker
 * (`app/api/insta360/route.ts`) と、GitHub Pages用の専用Worker
 * (`resolver-worker/index.ts`) の両方から同じ実装を使う。
 *
 * - `GET ?url=<共有URL>` … 解決結果をJSONで返す
 * - `GET ?url=<共有URL>&mode=asset` … SOG本体をそのまま中継する
 */
import {
  isPubliclyRoutableHost,
  parseInsta360ShareUrl,
  resolveSpatialAssetFromHtml,
  toAbsoluteUrl,
  type Insta360Share,
} from "./insta360";

export const CORS_HEADERS: Record<string, string> = {
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

/**
 * 共有ページからSOGのURLを取り出す。
 *
 * 署名付きURLには有効期限（`x-oss-expires`）があるため、解決結果は保存せず
 * 毎回ここで取り直す。キャッシュするのは変換済みのSOGだけ。
 */
async function resolveAssetUrl(share: Insta360Share): Promise<string> {
  const response = await fetch(share.shareUrl, { headers: PAGE_HEADERS, redirect: "follow" });
  if (!response.ok) {
    throw new ResolveError(502, `共有ページを取得できませんでした (HTTP ${response.status})`);
  }
  const html = await response.text();
  const assetUrl = resolveSpatialAssetFromHtml(html, response.url || share.shareUrl);
  if (!assetUrl) {
    throw new ResolveError(
      422,
      "共有ページからSOGのURLを見つけられませんでした。共有が期限切れの可能性があります。SOGファイルをお持ちの場合はドラッグ＆ドロップで読み込めます。",
    );
  }
  return assetUrl;
}

export function handleInsta360Options(): Response {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

export async function handleInsta360Request(request: Request): Promise<Response> {
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
