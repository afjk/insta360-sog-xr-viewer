/**
 * Insta360共有URLをSOGのURLへ解決するリクエストハンドラ。
 *
 * 共有ページも、その裏のタスク詳細APIも、ブラウザからのクロスオリジン取得を
 * 許可していないため、この処理はサーバー側で動かす必要がある。アプリ本体の
 * Cloudflare Worker (`app/api/insta360/route.ts`) と、GitHub Pages用の専用Worker
 * (`resolver-worker/index.ts`) の両方から同じ実装を使う。
 *
 * 返すのはURLだけで、SOG本体は中継しない。解決後の署名付きURLは
 * `access-control-allow-origin: *` を返すので、ブラウザが直接取りに行ける。
 * 15MB前後のSOGをWorkerに通す必要はない。
 *
 * - `GET ?url=<共有URL>` … 解決したSOGのURLと、あればカメラ情報のURLをJSONで返す
 */
import {
  isPubliclyRoutableHost,
  parseInsta360ShareUrl,
  resolveAssetsFromHtml,
  resolveAssetsFromTaskDetail,
  taskDetailApiUrls,
  toAbsoluteUrl,
  type Insta360Assets,
  type Insta360Share,
} from "./insta360";

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

const API_HEADERS: Record<string, string> = {
  "user-agent": PAGE_HEADERS["user-agent"],
  accept: "application/json",
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

const NOT_FOUND_MESSAGE =
  "共有ページからSOGのURLを見つけられませんでした。共有が期限切れの可能性があります。SOGファイルをお持ちの場合はドラッグ＆ドロップで読み込めます。";

/**
 * 共有ページ自身が使うタスク詳細APIからSOGのURLを取り出す。
 *
 * ページのHTMLを読むより構造が安定しているのでこちらを先に試す。ただしこのAPIは
 * `access-control-allow-origin` をInsta360のオリジンにしか返さないため、
 * ブラウザから直接は呼べない。だからこの処理はサーバー側にある。
 */
async function resolveViaApi(share: Insta360Share): Promise<Insta360Assets | null> {
  for (const endpoint of taskDetailApiUrls(share.shareId)) {
    let response: Response;
    try {
      response = await fetch(endpoint, { headers: API_HEADERS });
    } catch {
      continue;
    }
    if (!response.ok) continue;
    const body = await response.json().catch(() => null);
    const assets = resolveAssetsFromTaskDetail(body);
    if (assets) return assets;
  }
  return null;
}

/** 共有ページのHTMLに埋まっている `__NEXT_DATA__` からアセットのURLを取り出す。 */
async function resolveViaSharePage(share: Insta360Share): Promise<Insta360Assets> {
  const response = await fetch(share.shareUrl, { headers: PAGE_HEADERS, redirect: "follow" });
  if (!response.ok) {
    throw new ResolveError(502, `共有ページを取得できませんでした (HTTP ${response.status})`);
  }
  const html = await response.text();
  const assets = resolveAssetsFromHtml(html, response.url || share.shareUrl);
  if (!assets) throw new ResolveError(422, NOT_FOUND_MESSAGE);
  return assets;
}

/**
 * 共有IDからSOGのURLを取り出す。
 *
 * まずタスク詳細APIを試し、駄目なら共有ページのHTMLへ落ちる。どちらも同じ
 * `outputs` を返すので、片方の形が変わってももう片方で解決できる。
 *
 * 署名付きURLには有効期限（`x-oss-expires`）があるため、解決結果は保存せず
 * 毎回ここで取り直す。キャッシュするのは変換済みのSOGだけ。
 */
async function resolveAssets(share: Insta360Share): Promise<Insta360Assets> {
  const fromApi = await resolveViaApi(share);
  if (fromApi) return fromApi;
  return resolveViaSharePage(share);
}

/**
 * 公開ホスト宛のURLだけを通す。共有ページから拾ったURLをブラウザへ渡すので、
 * ここを通らないものは返さない。
 */
const publicUrlOrNull = (url: string | null): string | null => {
  const target = url ? toAbsoluteUrl(url) : null;
  return target && isPubliclyRoutableHost(target.hostname) ? target.toString() : null;
};

export function handleInsta360Options(): Response {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}

export async function handleInsta360Request(request: Request): Promise<Response> {
  const requestUrl = new URL(request.url);
  const input = requestUrl.searchParams.get("url") ?? "";
  const share = parseInsta360ShareUrl(input);

  if (!share) {
    return jsonResponse({ error: "Insta360の共有URLを指定してください。" }, 400);
  }

  try {
    const assets = await resolveAssets(share);
    const assetUrl = publicUrlOrNull(assets.assetUrl);
    if (!assetUrl) {
      throw new ResolveError(422, "解決したSOGのURLを取得できませんでした。");
    }
    // カメラ情報は初期視点にしか使わないので、取れなくてもSOGの表示は妨げない。
    const camerasUrl = publicUrlOrNull(assets.camerasUrl);
    return jsonResponse({ shareId: share.shareId, assetUrl, camerasUrl }, 200);
  } catch (error) {
    const status = error instanceof ResolveError ? error.status : 502;
    const message = error instanceof Error ? error.message : "共有URLを解決できませんでした。";
    return jsonResponse({ error: message }, status);
  }
}
