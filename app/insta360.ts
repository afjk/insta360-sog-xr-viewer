/**
 * Insta360 Spatial Capture の共有URLからSOGアセットURLを解決するための純粋関数群。
 *
 * ブラウザ側（`SogViewer`）とサーバー側（`app/api/insta360/route.ts`）の
 * 両方から使うため、DOMにもWorkerランタイムにも依存しない実装にしている。
 */

/** 共有URLとして受け付けるホストのサフィックス。 */
export const INSTA360_HOST_SUFFIXES = ["insta360.com", "insta360.cn", "arashivision.com"];

/** 共有ページのHTMLから拾うアセットURLの候補パターン。 */
const ASSET_PATTERN = /(?:https?:\/\/|\/)[^\s"'`<>\\)]+?\.(?:sog|json)(?:\?[^\s"'`<>\\)]*)?/gi;

/** 解決の手掛かりとして追跡してよいJSON/APIのURLパターン。 */
const API_PATTERN = /https?:\/\/[^\s"'`<>\\)]+/gi;

export type Insta360Share = {
  shareId: string;
  shareUrl: string;
};

/** 入力文字列を絶対URLとして解釈する。スキームが無い場合はhttpsを補う。 */
export function toAbsoluteUrl(input: string): URL | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  try {
    const url = new URL(withScheme);
    return url.protocol === "http:" || url.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

/** Insta360が運用しているホストかどうか。 */
export function isInsta360Host(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return INSTA360_HOST_SUFFIXES.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
}

/**
 * ループバックやプライベートIP宛のURLを弾く。共有ページから拾ったURLを
 * サーバーが再取得するため、SSRFの踏み台にならないようにする。
 */
export function isPubliclyRoutableHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (!host || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) return false;
  if (host === "::1" || host.startsWith("fc") || host.startsWith("fd")) return false;
  const ipv4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!ipv4) return true;
  const [a, b] = ipv4.slice(1).map(Number);
  if (a === 10 || a === 127 || a === 0) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  if (a === 169 && b === 254) return false;
  return true;
}

/** Insta360の共有ページURLを解析して共有IDを取り出す。 */
export function parseInsta360ShareUrl(input: string): Insta360Share | null {
  const url = toAbsoluteUrl(input);
  if (!url || !isInsta360Host(url.hostname)) return null;
  const fromPath = url.pathname.match(/\/3dspace\/(?:detail|share|space)\/([A-Za-z0-9_-]+)/);
  const shareId =
    fromPath?.[1] ??
    url.searchParams.get("id") ??
    url.searchParams.get("share_id") ??
    url.searchParams.get("shareId") ??
    "";
  if (!shareId) return null;
  return { shareId, shareUrl: url.toString() };
}

/** PlayCanvasがそのまま読み込めるSOGアセットのURLか。 */
export function isSpatialAssetUrl(input: string): boolean {
  const url = toAbsoluteUrl(input);
  if (!url) return false;
  const path = url.pathname.toLowerCase();
  return path.endsWith(".sog") || path.endsWith("/meta.json");
}

/**
 * HTMLやJSONのテキストからSOGアセットURLを探す。
 * `.sog` バンドルを優先し、無ければSOGディレクトリ形式の `meta.json` を返す。
 */
export function findSpatialAssetUrl(text: string, baseUrl: string): string | null {
  const unescaped = text.replace(/\\u002[fF]/g, "/").replace(/\\\//g, "/");
  const bundles: string[] = [];
  const manifests: string[] = [];

  for (const match of unescaped.matchAll(ASSET_PATTERN)) {
    let resolved: URL;
    try {
      resolved = new URL(match[0], baseUrl);
    } catch {
      continue;
    }
    const path = resolved.pathname.toLowerCase();
    if (path.endsWith(".sog")) bundles.push(resolved.toString());
    else if (path.endsWith("/meta.json")) manifests.push(resolved.toString());
  }

  return bundles[0] ?? manifests[0] ?? null;
}

/**
 * 共有ページ内で共有IDを含むAPI/JSONのURLを集める。
 * 共有ページ自体がSPAでSOGのURLを持たない場合の二段目の手掛かりに使う。
 */
export function findFollowUpApiUrls(text: string, baseUrl: string, shareId: string): string[] {
  const base = toAbsoluteUrl(baseUrl);
  if (!base || !shareId) return [];
  const unescaped = text.replace(/\\u002[fF]/g, "/").replace(/\\\//g, "/");
  const found: string[] = [];

  for (const match of unescaped.matchAll(API_PATTERN)) {
    let resolved: URL;
    try {
      resolved = new URL(match[0]);
    } catch {
      continue;
    }
    if (!isInsta360Host(resolved.hostname)) continue;
    if (!resolved.href.includes(shareId)) continue;
    if (!/\/api\//i.test(resolved.pathname) && !resolved.pathname.toLowerCase().endsWith(".json")) continue;
    if (!found.includes(resolved.href)) found.push(resolved.href);
  }

  return found;
}
