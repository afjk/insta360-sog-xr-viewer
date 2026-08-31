/**
 * Viewer専用パーマリンク (`?id=` / `?ss=` / `?url=`、任意で `&view=`) の読み書き。
 *
 * 一度開いた空間を別の端末へ渡せるようにするための仕組み。resolverが返す
 * アセットのURLは、Insta360なら有効期限つきの署名付きURL、SuperSplatなら
 * リビジョン込みのCDN URLで、どちらも恒久的な識別子ではない。アドレスバーに
 * 残すのは提供元ごとの永続IDだけにして、開くたびにresolverで取り直す。
 *
 *   ?id=GS3DG…   Insta360 Spatial Captureの共有ID
 *   ?ss=56155c3f SuperSplatのシーンID
 *   ?url=https…  Viewerが直接取りに行けるアセットのURL
 *
 * `?url=` はresolverを通さない空間——`.sog` の直接URL、PlayCanvasの
 * unbundled SOG（`meta.json`）、KISS-GSのSOG-XT——のためのもの。これらは
 * 提供元側にIDが無く、URLそのものが恒久的な識別子になる。SOG-XTだけの
 * 専用形式は作らない：どの形式かは開いてみれば分かるので、リンクに載せる
 * 必要がない。
 *
 * `view=` はその空間のどこから見ているかを足したもの。空間の中身ではなく
 * カメラの姿勢しか含まないので、こちらにも期限つきの情報は入らない。提供元に
 * よらず同じ形式なので、`?url=…&view=…` も `?id=…&view=…` と同じように使える。
 *
 * URLの組み立ては文字列連結ではなく `URL` / `URLSearchParams` で行う。
 * `URLSearchParams` が `?url=` の値のパーセントエンコードを両方向で面倒を
 * 見るので、こちらで `encodeURIComponent` を掛けてはいけない（二重encodeに
 * なる）。GitHub Pagesの `/insta360-sog-xr-viewer/` のようなサブパス配信でも、
 * originとpathnameをそのまま引き継ぐため壊れない。
 */
// 拡張子を明示しているのは、このモジュールをテストからNodeで直接importするため。
// バンドラは付いていても解決できる。
import { isInsta360ShareId } from "./insta360.ts";
import { isSuperSplatSceneId } from "./supersplat.ts";
import { containerMetadataUrl } from "./url-safety.ts";
import { formatViewPose, parseViewPose, type ViewPose } from "./view-pose.ts";

/** パーマリンクがInsta360の共有IDを載せるquery parameter名。 */
export const SHARE_ID_PARAM = "id";

/** パーマリンクがSuperSplatのシーンIDを載せるquery parameter名。 */
export const SCENE_ID_PARAM = "ss";

/** パーマリンクがアセットのURLを載せるquery parameter名。 */
export const SOURCE_URL_PARAM = "url";

/** パーマリンクが視点を載せるquery parameter名。 */
export const VIEW_PARAM = "view";

/** 空間を指すparameterを、読むときの優先順で並べたもの。 */
const SPACE_PARAMS = [SHARE_ID_PARAM, SCENE_ID_PARAM, SOURCE_URL_PARAM] as const;

/**
 * パーマリンクが指している空間。
 *
 * 「どの提供元の、どのID か」を1つの値として持つ。ラベル文字列やURLの形から
 * 後で提供元を推測しない——推測が要る形にしないための型。
 *
 * `url` はresolverを介さずViewerが直接取りに行く空間で、載っているのは
 * 正規化済みのアセットURL（`canonicalSpaceUrl`）。中身が `.sog` か
 * unbundled SOGかSOG-XTかは、開いたときに判定するのでここには持たない。
 */
export type SpaceRef =
  | { provider: "insta360"; id: string }
  | { provider: "supersplat"; id: string }
  | { provider: "url"; url: string };

const parseHref = (href: string): URL | null => {
  try {
    return new URL(href);
  } catch {
    return null;
  }
};

/**
 * アセットURLを、同じ空間なら同じ文字列になる形へ寄せる。
 *
 * やること:
 *  - `http:` / `https:` 以外は弾く。`blob:` / `data:` / `file:` は共有できない
 *    （受け取った側の端末では開けないうえ、ローカルのファイルを指しうる）
 *  - fragment（`#…`）は落とす。取得先には関係しない
 *  - コンテナのディレクトリURLは `meta.json` へ寄せる。KISS-GSの
 *    `.../MipNeRF360-Garden` と `.../MipNeRF360-Garden/meta.json` は同じ空間
 *
 * queryは**残す**。署名付きURLのように、queryが無いと取得できないアセットが
 * あるため、一般URLのqueryを一律で捨てることはしない。
 */
export function canonicalSpaceUrl(input: string): string | null {
  const url = parseHref(input.trim());
  if (!url) return null;
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  url.hash = "";
  return (containerMetadataUrl(url)?.metadata ?? url).toString();
}

/**
 * 現在のURLから、開くべき空間を読む。
 *
 * 形が合わないものはここで落とす。呼び出し側はこれを通ったIDやURLだけを
 * 取得先に組み立てるので、不正な値がネットワークへ出ることはない。
 *
 * 空間のparameterが複数あるURLは異常だが、既存のリンクを壊さないほうを採る。
 * 優先順は先に配ってあった順で **`id` → `ss` → `url`**。先に見つかった
 * parameterだけを見て、残りは無視する。
 */
export function readSpaceRef(href: string): SpaceRef | null {
  const url = parseHref(href);
  if (!url) return null;
  for (const param of SPACE_PARAMS) {
    const value = url.searchParams.get(param)?.trim() ?? "";
    if (!value) continue;
    if (param === SHARE_ID_PARAM) {
      return isInsta360ShareId(value) ? { provider: "insta360", id: value } : null;
    }
    if (param === SCENE_ID_PARAM) {
      return isSuperSplatSceneId(value) ? { provider: "supersplat", id: value } : null;
    }
    const canonical = canonicalSpaceUrl(value);
    return canonical ? { provider: "url", url: canonical } : null;
  }
  return null;
}

/**
 * 2つの空間参照が同じものを指しているか。
 *
 * URL参照は文字列を突き合わせる前に正規化する。KISS-GSのディレクトリURLと
 * `meta.json` のURLは、同じ空間として揃う。
 */
export function isSameSpace(a: SpaceRef | null, b: SpaceRef | null): boolean {
  if (a === null || b === null || a.provider !== b.provider) return false;
  if (a.provider === "url" || b.provider === "url") {
    if (a.provider !== "url" || b.provider !== "url") return false;
    const left = canonicalSpaceUrl(a.url);
    return left !== null && left === canonicalSpaceUrl(b.url);
  }
  return a.id === b.id;
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
 * 空間参照を、パーマリンクへ載せるparameter名と値へ直す。
 *
 * 提供元ごとの検証もここでやる。形が合わなければ `null` を返し、リンクを
 * 作らない。ここを通った値だけがネットワークへ出る。
 */
const spaceParamOf = (space: SpaceRef): { name: string; value: string } | null => {
  if (space.provider === "insta360") {
    const id = space.id.trim();
    return isInsta360ShareId(id) ? { name: SHARE_ID_PARAM, value: id } : null;
  }
  if (space.provider === "supersplat") {
    const id = space.id.trim();
    return isSuperSplatSceneId(id) ? { name: SCENE_ID_PARAM, value: id } : null;
  }
  // 正規化した形を載せる。受け取った側の `readSpaceRef` と同じ文字列になる。
  const url = canonicalSpaceUrl(space.url);
  return url ? { name: SOURCE_URL_PARAM, value: url } : null;
};

/**
 * 空間を載せたパーマリンクを作る。
 *
 * `pose` を渡すと「この視点のリンク」（`?…&view=…`）に、渡さなければ
 * 「この空間のリンク」になる。後者では残っている `view` を落とす。
 * 空間のリンクに前の視点が紛れ込むと、受け取った側が別の場所から始まってしまう。
 *
 * 提供元が違うパラメータ（`id` / `ss` / `url` のうち残り2つ）は必ず落とす。
 * 複数が載ったリンクをこちらから配らないため。それ以外のquery parameterは
 * 将来使う可能性があるので触らない。hashは共有先に持って行く意味がないので落とす。
 *
 * `url=` の値は `URLSearchParams.set` へ生のまま渡す。パーセントエンコードは
 * `URLSearchParams` が行うので、ここで `encodeURIComponent` を掛けると
 * 二重encodeになる。
 */
export function permalinkFor(
  href: string,
  space: SpaceRef,
  pose?: ViewPose | null,
): string | null {
  const url = parseHref(href);
  const own = spaceParamOf(space);
  if (!url || !own) return null;
  url.searchParams.set(own.name, own.value);
  for (const param of SPACE_PARAMS) {
    if (param !== own.name) url.searchParams.delete(param);
  }
  const view = pose ? formatViewPose(pose) : null;
  if (view) url.searchParams.set(VIEW_PARAM, view);
  else url.searchParams.delete(VIEW_PARAM);
  url.hash = "";
  return url.toString();
}

/**
 * リンクを配れない空間へ切り替えたときに、古い `id` / `ss` / `url` を落とす。
 *
 * 視点は空間に紐づくので `view` も一緒に落とす。
 */
export function hrefWithoutSpace(href: string): string | null {
  const url = parseHref(href);
  if (!url) return null;
  for (const param of SPACE_PARAMS) url.searchParams.delete(param);
  url.searchParams.delete(VIEW_PARAM);
  return url.toString();
}
