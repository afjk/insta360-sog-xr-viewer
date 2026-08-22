/**
 * GitHub Pages（静的配信）から使うための、共有URL解決専用のCloudflare Worker。
 *
 * アプリ本体のWorkerとは別にこれを置くことで、GitHub Pages版でも
 * Insta360共有URLを解決できる。解決ロジックは `app/insta360-resolver.ts` と共有。
 *
 * デプロイ:
 *   npm run resolver:deploy
 * デプロイ後、リポジトリ変数 `SOG_RESOLVER_ORIGIN` にWorkerのオリジンを設定すると
 * GitHub Pagesのビルドがそれを拾う。
 */
import {
  CORS_HEADERS,
  handleInsta360Options,
  handleInsta360Request,
} from "../app/insta360-resolver";

const worker = {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") return handleInsta360Options();
    if (request.method !== "GET") {
      return new Response("Method not allowed", { status: 405, headers: CORS_HEADERS });
    }
    if (url.pathname === "/api/insta360") return handleInsta360Request(request);
    if (url.pathname === "/") {
      return new Response("insta360-sog-xr-viewer share URL resolver\n", {
        status: 200,
        headers: { ...CORS_HEADERS, "content-type": "text/plain; charset=utf-8" },
      });
    }
    return new Response("Not found", { status: 404, headers: CORS_HEADERS });
  },
};

export default worker;
