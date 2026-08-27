/**
 * Viewer専用パーマリンク (`?id=` / `?ss=`、任意で `&view=`) の読み書き。
 *
 * 一度開いた空間を別の端末へ渡せるようにするための仕組み。resolverが返す
 * アセットのURLは、Insta360なら有効期限つきの署名付きURL、SuperSplatなら
 * リビジョン込みのCDN URLで、どちらも恒久的な識別子ではない。アドレスバーに
 * 残すのは提供元ごとの永続IDだけにして、開くたびにresolverで取り直す。
 *
 *   ?id=GS3DG…   Insta360 Spatial Captureの共有ID
 *   ?ss=56155c3f SuperSplatのシーンID
 *
 * `view=` はその空間のどこから見ているかを足したもの。空間の中身ではなく
 * カメラの姿勢しか含まないので、こちらにも期限つきの情報は入らない。提供元に
 * よらず同じ形式なので、`?ss=…&view=…` も `?id=…&view=…` と同じように使える。
 *
 * URLの組み立ては文字列連結ではなく `URL` / `URLSearchParams` で行う。
 * GitHub Pagesの `/insta360-sog-xr-viewer/` のようなサブパス配信でも、
 * originとpathnameをそのまま引き継ぐため壊れない。
 */
// 拡張子を明示しているのは、このモジュールをテストからNodeで直接importするため。
// バンドラは付いていても解決できる。
import { isInsta360ShareId } from "./insta360.ts";
import { isSuperSplatSceneId } from "./supersplat.ts";
import { formatViewPose, parseViewPose, type ViewPose } from "./view-pose.ts";

/** パーマリンクがInsta360の共有IDを載せるquery parameter名。 */
export const SHARE_ID_PARAM = "id";

/** パーマリンクがSuperSplatのシーンIDを載せるquery parameter名。 */
export const SCENE_ID_PARAM = "ss";

/** パーマリンクが視点を載せるquery parameter名。 */
export const VIEW_PARAM = "view";

/**
 * パーマリンクが指している空間。
 *
 * 「どの提供元の、どのID か」を1つの値として持つ。ラベル文字列やURLの形から
 * 後で提供元を推測しない——推測が要る形にしないための型。
 */
export type SpaceRef =
  | { provider: "insta360"; id: string }
  | { provider: "supersplat"; id: string };

const parseHref = (href: string): URL | null => {
  try {
    return new URL(href);
  } catch {
    return null;
  }
};

/** 提供元ごとのID検証。ここを通ったIDだけがネットワークへ出る。 */
const isValidId = (space: SpaceRef): boolean =>
  space.provider === "insta360" ? isInsta360ShareId(space.id) : isSuperSplatSceneId(space.id);

/**
 * 現在のURLから、開くべき空間を読む。
 *
 * 形が合わないものはここで落とす。呼び出し側はこれを通ったIDだけを
 * シーンURLに組み立てるので、不正な値がネットワークへ出ることはない。
 *
 * `id` と `ss` が両方あるURLは異常だが、既存のリンクを壊さないほうを採る。
 * `?id=` は先に配ってあるので**`id` を優先**し、`ss` は無視する。
 */
export function readSpaceRef(href: string): SpaceRef | null {
  const url = parseHref(href);
  if (!url) return null;
  const shareId = url.searchParams.get(SHARE_ID_PARAM)?.trim() ?? "";
  if (shareId) {
    return isInsta360ShareId(shareId) ? { provider: "insta360", id: shareId } : null;
  }
  const sceneId = url.searchParams.get(SCENE_ID_PARAM)?.trim() ?? "";
  if (sceneId) {
    return isSuperSplatSceneId(sceneId) ? { provider: "supersplat", id: sceneId } : null;
  }
  return null;
}

/** 2つの空間参照が同じものを指しているか。 */
export function isSameSpace(a: SpaceRef | null, b: SpaceRef | null): boolean {
  return a !== null && b !== null && a.provider === b.provider && a.id === b.id;
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
 * 空間を載せたパーマリンクを作る。
 *
 * `pose` を渡すと「この視点のリンク」（`?…&view=…`）に、渡さなければ
 * 「この空間のリンク」になる。後者では残っている `view` を落とす。
 * 空間のリンクに前の視点が紛れ込むと、受け取った側が別の場所から始まってしまう。
 *
 * 提供元が違うパラメータ（`id` ⇄ `ss`）は必ず落とす。両方が載ったリンクを
 * こちらから配らないため。それ以外のquery parameterは将来使う可能性が
 * あるので触らない。hashは共有先に持って行く意味がないので落とす。
 */
export function permalinkFor(
  href: string,
  space: SpaceRef,
  pose?: ViewPose | null,
): string | null {
  const url = parseHref(href);
  if (!url || !isValidId(space)) return null;
  const [own, other] =
    space.provider === "insta360"
      ? [SHARE_ID_PARAM, SCENE_ID_PARAM]
      : [SCENE_ID_PARAM, SHARE_ID_PARAM];
  url.searchParams.set(own, space.id.trim());
  url.searchParams.delete(other);
  const view = pose ? formatViewPose(pose) : null;
  if (view) url.searchParams.set(VIEW_PARAM, view);
  else url.searchParams.delete(VIEW_PARAM);
  url.hash = "";
  return url.toString();
}

/**
 * resolver由来でない空間へ切り替えたときに、古い `id` / `ss` を落とす。
 *
 * 視点は空間に紐づくので `view` も一緒に落とす。
 */
export function hrefWithoutSpace(href: string): string | null {
  const url = parseHref(href);
  if (!url) return null;
  url.searchParams.delete(SHARE_ID_PARAM);
  url.searchParams.delete(SCENE_ID_PARAM);
  url.searchParams.delete(VIEW_PARAM);
  return url.toString();
}
