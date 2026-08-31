/**
 * 入力URLを扱うときの共通の関門。
 *
 * Insta360共有ページからも、SuperSplatの公開シーンページからも、resolverは
 * 「ページに書いてあったURL」をサーバー側で再取得する。踏み台にされないよう、
 * どちらの経路も同じ判定をここで通す。
 *
 * DOMにもWorkerランタイムにも依存しない。ブラウザ側（`SogViewer`）、
 * Cloudflare Worker、Nodeのテストのいずれからも読める。
 */

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

/** ホスト名が許可リストのいずれか（完全一致かそのサブドメイン）か。 */
export function hasHostSuffix(hostname: string, suffixes: readonly string[]): boolean {
  const host = hostname.toLowerCase();
  return suffixes.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
}

/**
 * コンテナ形式（`meta.json` ＋ 画像群）のメタデータURL。
 *
 * PlayCanvasのunbundled SOGも、KISS-GSのSOG-XTも、ディレクトリの中に
 * `meta.json` を置いて、その隣の画像を相対パスで参照する。Viewerはどちらの
 * 形式でも「`meta.json` そのもののURL」と「それが置いてあるディレクトリの
 * URL」の両方を受け付けるので、その2つを1つのURLへ寄せる規則をここに置く。
 *
 * 読み込みの入口（どのファイルを取りに行くか）と、パーマリンクの
 * 正規化（同じ空間かどうか）が同じ規則を見る必要があるため、共通化してある。
 *
 * ディレクトリかどうかは「最後のセグメントに拡張子が無い」で決める。
 * `.sog` のようにファイルを名指ししているURLは対象外で `null` を返す。
 */
export const CONTAINER_METADATA_FILENAME = "meta.json";

export function containerMetadataUrl(url: URL): { metadata: URL; base: URL } | null {
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  const last = url.pathname.split("/").pop() ?? "";
  if (last.toLowerCase() === CONTAINER_METADATA_FILENAME) {
    return { metadata: new URL(url.href), base: new URL(".", url) };
  }
  if (last === "" || !/\.[a-z0-9]+$/i.test(last)) {
    const base = new URL(last === "" ? "./" : `${last}/`, url);
    return { metadata: new URL(CONTAINER_METADATA_FILENAME, base), base };
  }
  return null;
}
