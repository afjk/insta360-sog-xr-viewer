/**
 * Viewer専用パーマリンク (`?id=<共有ID>` / `?id=…&view=<視点>`) の読み書き。
 *
 * 一度開いた空間を別の端末へ渡せるようにするための仕組み。共有ページから
 * 解決した署名付きSOGのURLは有効期限つきで、`x-oss-signature` を含むため
 * アドレスバーには残さない。恒久的な識別子である共有IDだけを載せる。
 *
 * `view=` はその空間のどこから見ているかを足したもの。空間の中身ではなく
 * カメラの姿勢しか含まないので、こちらにも期限つきの情報は入らない。
 *
 * URLの組み立ては文字列連結ではなく `URL` / `URLSearchParams` で行う。
 * GitHub Pagesの `/insta360-sog-xr-viewer/` のようなサブパス配信でも、
 * originとpathnameをそのまま引き継ぐため壊れない。
 */
// 拡張子を明示しているのは、このモジュールをテストからNodeで直接importするため。
// バンドラは付いていても解決できる。
import { isInsta360ShareId } from "./insta360.ts";
import { formatViewPose, parseViewPose, type ViewPose } from "./view-pose.ts";

/** パーマリンクが共有IDを載せるquery parameter名。 */
export const SHARE_ID_PARAM = "id";

/** パーマリンクが視点を載せるquery parameter名。 */
export const VIEW_PARAM = "view";

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
 * 現在のURLから視点を読む。
 *
 * 壊れた値や桁あふれは `parseViewPose` が弾く。読めなければ`null`を返すだけで、
 * 空間そのものは通常どおり開く。
 */
export function readViewPose(href: string): ViewPose | null {
  const value = parseHref(href)?.searchParams.get(VIEW_PARAM)?.trim() ?? "";
  return value ? parseViewPose(value) : null;
}

/**
 * 共有IDを載せたパーマリンクを作る。
 *
 * `pose` を渡すと「この視点のリンク」（`?id=…&view=…`）に、渡さなければ
 * 「この空間のリンク」（`?id=…`）になる。後者では残っている `view` を落とす。
 * 空間のリンクに前の視点が紛れ込むと、受け取った側が別の場所から始まってしまう。
 *
 * `id` / `view` 以外のquery parameterは将来使う可能性があるので触らない。hashは
 * 共有先に持って行く意味がないので落とす。
 */
export function permalinkFor(
  href: string,
  shareId: string,
  pose?: ViewPose | null,
): string | null {
  const url = parseHref(href);
  if (!url || !isInsta360ShareId(shareId)) return null;
  url.searchParams.set(SHARE_ID_PARAM, shareId.trim());
  const view = pose ? formatViewPose(pose) : null;
  if (view) url.searchParams.set(VIEW_PARAM, view);
  else url.searchParams.delete(VIEW_PARAM);
  url.hash = "";
  return url.toString();
}

/**
 * Insta360由来でない空間へ切り替えたときに、古い `id` を落とす。
 *
 * 視点は空間に紐づくので `view` も一緒に落とす。
 */
export function hrefWithoutShareId(href: string): string | null {
  const url = parseHref(href);
  if (!url) return null;
  url.searchParams.delete(SHARE_ID_PARAM);
  url.searchParams.delete(VIEW_PARAM);
  return url.toString();
}
