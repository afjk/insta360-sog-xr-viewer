/**
 * Viewer専用パーマリンク (`?id=<共有ID>`) の読み書き。
 *
 * 一度開いた空間を別の端末へ渡せるようにするための仕組み。共有ページから
 * 解決した署名付きSOGのURLは有効期限つきで、`x-oss-signature` を含むため
 * アドレスバーには残さない。恒久的な識別子である共有IDだけを載せる。
 *
 * URLの組み立ては文字列連結ではなく `URL` / `URLSearchParams` で行う。
 * GitHub Pagesの `/insta360-sog-xr-viewer/` のようなサブパス配信でも、
 * originとpathnameをそのまま引き継ぐため壊れない。
 */
// 拡張子を明示しているのは、このモジュールをテストからNodeで直接importするため。
// バンドラは付いていても解決できる。
import { isInsta360ShareId } from "./insta360.ts";

/** パーマリンクが共有IDを載せるquery parameter名。 */
export const SHARE_ID_PARAM = "id";

const parseHref = (href: string): URL | null => {
  try {
    return new URL(href);
  } catch {
    return null;
  }
};

/**
 * 現在のURLから共有IDを読む。
 *
 * 形が合わないものはここで落とす。呼び出し側はこれを通ったIDだけを
 * 共有URLに組み立てるので、不正な値がネットワークへ出ることはない。
 */
export function readShareId(href: string): string | null {
  const url = parseHref(href);
  const value = url?.searchParams.get(SHARE_ID_PARAM)?.trim() ?? "";
  return value && isInsta360ShareId(value) ? value : null;
}

/**
 * 共有IDを載せたパーマリンクを作る。
 *
 * `id` 以外のquery parameterは将来使う可能性があるので触らない。hashは
 * 共有先に持って行く意味がないので落とす。
 */
export function permalinkFor(href: string, shareId: string): string | null {
  const url = parseHref(href);
  if (!url || !isInsta360ShareId(shareId)) return null;
  url.searchParams.set(SHARE_ID_PARAM, shareId.trim());
  url.hash = "";
  return url.toString();
}

/** Insta360由来でない空間へ切り替えたときに、古い `id` を落とす。 */
export function hrefWithoutShareId(href: string): string | null {
  const url = parseHref(href);
  if (!url) return null;
  url.searchParams.delete(SHARE_ID_PARAM);
  return url.toString();
}
