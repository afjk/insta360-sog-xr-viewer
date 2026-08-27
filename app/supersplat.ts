/**
 * SuperSplat（https://superspl.at）の公開シーンURLを読むための純粋関数群。
 *
 * SuperSplat固有の知識——URLの形、公開ページの埋め込みデータの置き場所、
 * 配信CDNのホスト、ライセンス表記——は全てこのモジュールに閉じ込める。
 * `SogViewer` にも `supersplat-resolver.ts` にもHTML構造を漏らさない。
 *
 * DOMにもWorkerランタイムにも依存しないので、ブラウザ側・Cloudflare Worker・
 * Nodeのテストのどこからでも読める。
 *
 * ## ページの役割分担
 *
 * SuperSplatは1枚のHTMLで完結していない。用途の違う2つのページを使い分ける。
 *
 *   scene page   https://superspl.at/scene/{sceneId}
 *     公開状態・title・author・Downloadable・licenseの確認に使う。
 *
 *   viewer page  https://superspl.at/s?id={sceneId}
 *     Viewerが実際に読むアセット（contentUrl / contentFilename）の取得に使う。
 *
 * resolverはこの順で読む。viewer pageへはDownloadableを確認したあとにしか
 * 行かない（`supersplat-resolver.ts` を参照）。
 *
 * ## 参照した実装
 *
 * SuperSplatの公開ページを描いているViewer本体はオープンソースで、埋め込み
 * データの受け渡し方が読める。ここでの解析はその契約に合わせてある。
 *
 * - `playcanvas/supersplat-viewer` … `src/module/render-html.ts` が
 *   `<script type="application/json" id="sse-bootstrap">` に `contentUrl` /
 *   `contentFilename` などを流し込む。ページ側の唯一の差し込み口。
 * - `playcanvas/supersplat` … `src/publish.ts` の `publishFormat` が
 *   `"sog"`（通常）と `"ssog"`（Streamed SOG）に分かれる。
 *
 * ## 実ページで確認した構造（2026-08時点）
 *
 * scene page (`/scene/{sceneId}`) のSSR HTML:
 *
 *   <head>
 *     <link rel="license" href="https://creativecommons.org/licenses/by/4.0/">
 *   <body>
 *     <div class="flex flex-wrap items-center gap-2">
 *       <button><svg class="lucide lucide-download ..."/>Download</button>
 *       <span title="Attribution">CC BY 4.0</span>
 *     </div>
 *
 * ライセンスはDownloadボタンの中ではなく `<head>` にある。両者は離れているので、
 * 「ボタンの中にライセンスがあるはず」という読み方はしない。
 *
 * 同じページには紛らわしいものが同居している。いずれも許可の根拠にしない:
 *
 *   - 「27 downloads」という統計表示（Downloadボタンと同じlucideアイコンを使う）
 *   - 作者が説明文に書いた `# CC-BY - ...` のような自由記述
 *   - `download-a1b2c3d4.js` のようなビルド成果物のファイル名
 *
 * React Routerのloader data（devalue形式）にも `downloads` / `enabled` /
 * `license` / `by` が入っている。将来はそちらのほうが安定した判定元になりうるが、
 * devalueのパーサーを持ち込むだけの利点が今は無いので採っていない。
 *
 * ## まだ確認できていないもの
 *
 * viewer page (`/s?id={sceneId}`) の実HTTP応答は未確認。`contentUrl` の置き場所は
 * SuperSplat公式Viewer (`playcanvas/supersplat-viewer`) の実装から読み取れる
 * 契約に合わせてあるが、実物との突き合わせはできていない。
 * `scripts/probe-supersplat.mjs --dump` で採取できる。
 */
// 拡張子を明示しているのは、このモジュールをテストからNodeで直接importするため。
// バンドラは付いていても解決できる。
import { hasHostSuffix, isPubliclyRoutableHost, toAbsoluteUrl } from "./url-safety.ts";

/** 公開シーンURLとして受け付けるホスト。厳密にこの1つだけ。 */
export const SUPERSPLAT_HOST = "superspl.at";

/**
 * アセット（SOG本体・WebP）の取得を許可するホスト。
 *
 * ページに書いてあったURLをそのまま信じないための関門。実際の配信は
 * CloudFront (`*.cloudfront.net`) から行われている（`pnooyen/download-splat`
 * が解決している `contentUrl` も同じ形）。配信先が変わったらここへ足す。
 */
export const SUPERSPLAT_ASSET_HOST_SUFFIXES = [
  SUPERSPLAT_HOST,
  "cloudfront.net",
  "playcanvas.com",
];

/**
 * シーンIDとして許可する文字。
 *
 * 実データは `56155c3f` のような短い16進だが、桁数を決め打ちにはしない。
 * パス組み立てとパーマリンク (`?ss=`) の両方でそのまま使うので、`/` `\` `.`
 * `:` `%` を混ぜられない文字種に限る。これでパストラバーサルもスキーム
 * 差し替えも成立しない。
 */
const SCENE_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

/** SuperSplatの公開シーンを指す識別子と、正規化した公開ページURL。 */
export type SuperSplatShare = {
  sceneId: string;
  sceneUrl: string;
};

/** 公開ページから読み取ったライセンス。 */
export type SuperSplatLicense = {
  /** SPDX風の識別子。例: `CC-BY-4.0`。 */
  code: string;
  /** 画面に出す表記。例: `CC BY 4.0`。 */
  label: string;
};

/**
 * PlayCanvasのgsplatローダーから見たアセットの種類。
 *
 * - `sog`          … 単一ファイルのbundled SOG（meta.jsonとWebPをZIPに詰めたもの）
 * - `sog-meta`     … unbundled SOG。`meta.json` が同じディレクトリのWebPを相対参照する
 * - `streamed-sog` … Streamed SOG（`lod-meta.json`）。このPRでは表示しない
 */
export type SuperSplatAssetFormat = "sog" | "sog-meta" | "streamed-sog";

export type SuperSplatAsset = {
  format: SuperSplatAssetFormat;
  url: string;
  /** 配信リビジョン（`v3` など）。URLから読み取れなければ `null`。 */
  revision: string | null;
};

/** scene pageから読み取った表示用のメタデータ。取得可否の判断には使わない。 */
export type SuperSplatSceneMeta = {
  title: string;
  author: string;
};

/**
 * scene pageから読み取った「取得してよいか」の判断。
 *
 * licenseは独立した項目ではなく、**ダウンロード操作に付随して示されている**もの。
 * 「CC BYの表記がページのどこかにある」だけでは許可の根拠にしない。
 */
export type SuperSplatDownloadPermission = {
  /**
   * 作者がダウンロードを許可しているか。
   *
   * `null` は「ページから判定できなかった」。`false` と同じく読み込まない
   * （fail-closed）が、原因の切り分けのために区別して持つ。
   */
  downloadable: boolean | null;
  license: SuperSplatLicense | null;
  /**
   * 何を根拠にそう判断したか。403の切り分け用にログへ出すためのもので、
   * APIレスポンスには載せない（ページ構造を外へ晒さない）。
   */
  reason: SuperSplatPermissionReason;
};

/** `SuperSplatDownloadPermission.reason` に入る値。 */
export type SuperSplatPermissionReason =
  /** 埋め込みJSONの真偽値が `true` だった。 */
  | "downloadable-flag"
  /** 埋め込みJSONの真偽値が `false` だった。作者が許可していない。 */
  | "downloadable-flag-false"
  /** ダウンロード操作があり、ページが機械可読なライセンスを持っていた。 */
  | "download-control-with-page-license"
  /** ダウンロード操作の周辺にライセンスが併記されていた。 */
  | "download-control-with-license"
  /** ダウンロード操作は見つかったが、ライセンスが伴っていなかった。 */
  | "download-control-without-license"
  /** ダウンロード操作を機械的に見つけられなかった。 */
  | "download-control-not-found";

/** resolverが返す内部エラーコード。ユーザー向け文言とは分けて扱う。 */
export type SuperSplatErrorCode =
  | "INVALID_SUPERSPLAT_URL"
  | "SUPERSPLAT_SCENE_NOT_FOUND"
  | "SUPERSPLAT_NOT_DOWNLOADABLE"
  | "SUPERSPLAT_LICENSE_NOT_FOUND"
  | "SUPERSPLAT_ASSET_NOT_FOUND"
  | "SUPERSPLAT_STREAMED_SOG_UNSUPPORTED"
  | "SUPERSPLAT_UNAVAILABLE";

/**
 * 内部エラーコードに対応するユーザー向けの文言。
 *
 * コードはresolverとViewerの間の契約、文言は画面表示。分けておくと、
 * resolverを更新せずにViewer側の言い回しだけ直せる。
 */
export const SUPERSPLAT_ERROR_MESSAGES: Record<SuperSplatErrorCode, string> = {
  INVALID_SUPERSPLAT_URL:
    "SuperSplatの公開シーンURL（https://superspl.at/scene/…）を指定してください。",
  SUPERSPLAT_SCENE_NOT_FOUND:
    "このSuperSplatシーンが見つかりませんでした。URLが正しいか、公開されているかをご確認ください。",
  SUPERSPLAT_NOT_DOWNLOADABLE:
    "このSuperSplatシーンはダウンロードが許可されていないため読み込めません。",
  SUPERSPLAT_LICENSE_NOT_FOUND:
    "このSuperSplatシーンのライセンスを確認できなかったため読み込みませんでした。",
  SUPERSPLAT_ASSET_NOT_FOUND:
    "このSuperSplatシーンから読み込めるSOGを見つけられませんでした。",
  SUPERSPLAT_STREAMED_SOG_UNSUPPORTED:
    "このSuperSplatシーンはストリーミング形式です。現在このViewerでは未対応です。",
  SUPERSPLAT_UNAVAILABLE:
    "SuperSplatの公開ページを取得できませんでした。時間をおいて試してください。",
};

/**
 * resolverが成功時に返すペイロード。resolverとViewerの間の契約。
 *
 * 両方から読めるようにここへ置く。Viewerはこの形だけを知っていればよく、
 * 公開ページの構造を知る必要はない。
 */
export type SuperSplatResolution = {
  provider: "supersplat";
  sceneId: string;
  pageUrl: string;
  title: string;
  author: string;
  /** ここに来ている時点で必ず `true`。判定を通ったことを応答にも残す。 */
  downloadable: true;
  license: SuperSplatLicense;
  asset: SuperSplatAsset;
};

/** resolverが失敗時に返すペイロード。 */
export type SuperSplatErrorPayload = {
  error: string;
  code: SuperSplatErrorCode;
};

/** SuperSplatのシーンIDとして扱える文字列か。 */
export function isSuperSplatSceneId(value: string): boolean {
  return SCENE_ID_PATTERN.test(value.trim());
}

/** シーンIDから正規の公開ページURLを組み立てる。形が違えば `null`。 */
export function sceneUrlFromSceneId(value: string): string | null {
  const sceneId = value.trim();
  if (!isSuperSplatSceneId(sceneId)) return null;
  return `https://${SUPERSPLAT_HOST}/scene/${sceneId}`;
}

/**
 * SuperSplatの公開シーンURLを解析してシーンIDを取り出す。
 *
 * 受け付ける形は2つ。どちらも canonical な `/scene/{sceneId}` へ正規化する。
 *
 *   https://superspl.at/scene/{sceneId}
 *   https://superspl.at/s?id={sceneId}
 *
 * ホストは `superspl.at` 完全一致のみ。`superspl.at.example.com` のような
 * 紛らわしいドメインも、サブドメインも通さない。
 */
export function parseSuperSplatUrl(input: string): SuperSplatShare | null {
  const url = toAbsoluteUrl(input);
  if (!url || url.hostname.toLowerCase() !== SUPERSPLAT_HOST) return null;

  // `new URL` が `..` を畳んでくれるので、ここに残るのは正規化済みのパス。
  // それでも `%2F` はデコードされずに残るため、IDの文字種でもう一度弾く。
  const fromPath = url.pathname.match(/^\/scene\/([^/]+)\/?$/)?.[1] ?? "";
  const fromQuery = url.pathname.replace(/\/$/, "") === "/s" ? url.searchParams.get("id") ?? "" : "";
  const sceneId = (fromPath || fromQuery).trim();
  if (!isSuperSplatSceneId(sceneId)) return null;

  return { sceneId, sceneUrl: `https://${SUPERSPLAT_HOST}/scene/${sceneId}` };
}

/** SuperSplatのCDNとして取得を許可するホストか。 */
export function isSuperSplatAssetUrl(input: string): boolean {
  const url = toAbsoluteUrl(input);
  if (!url) return false;
  return (
    isPubliclyRoutableHost(url.hostname) &&
    hasHostSuffix(url.hostname, SUPERSPLAT_ASSET_HOST_SUFFIXES)
  );
}

// ---------------------------------------------------------------------------
// 公開ページの解析
//
// ここから下はSuperSplatのページ構造に依存する。壊れたときに直す場所を
// 1か所にまとめるため、HTMLを見るコードは全てこのモジュールに置く。
// ---------------------------------------------------------------------------

const SCRIPT_BLOCK = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;

const attributeOf = (attributes: string, name: string): string => {
  const match = attributes.match(new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, "i"));
  return (match?.[2] ?? match?.[3] ?? match?.[4] ?? "").trim();
};

const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

/**
 * `{` から対応する `}` までを切り出す。文字列リテラルとエスケープは飛ばす。
 *
 * `window.__X__ = { … };` のような素のscriptから、JSONとして読める部分だけを
 * 取り出すために使う。正規表現では入れ子の括弧を数えられない。
 */
const balancedObject = (text: string, start: number): string | null => {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(start, index + 1);
    }
  }
  return null;
};

/**
 * 公開ページに埋まっている構造化データを全て取り出す。
 *
 * 拾うのは次の3種類で、いずれも「ページが機械可読な形で置いているもの」。
 * HTMLの見た目（`includes("Download")` のような文字列一致）では判定しない。
 *
 * 1. `<script type="application/json">` … Viewer本体の `sse-bootstrap` がこの形。
 * 2. `<script type="application/ld+json">` … schema.orgの構造化データ。
 * 3. 素の `<script>` 内の `… = { … };` … アプリの初期stateを載せる一般的な形。
 */
export function embeddedJsonBlocks(html: string): unknown[] {
  const blocks: unknown[] = [];
  for (const match of html.matchAll(SCRIPT_BLOCK)) {
    const type = attributeOf(match[1], "type").toLowerCase();
    const body = match[2];
    if (type === "application/json" || type === "application/ld+json") {
      const parsed = parseJson(body);
      if (parsed !== null) blocks.push(parsed);
      continue;
    }
    if (type && type !== "module" && type !== "text/javascript" && type !== "application/javascript") {
      continue;
    }
    // 素のscriptからは代入の右辺だけを見る。1ブロックに複数あってもよい。
    for (const assignment of body.matchAll(/[=:]\s*(?=\{)/g)) {
      const object = balancedObject(body, assignment.index + assignment[0].length);
      if (!object || object.length > 2_000_000) continue;
      const parsed = parseJson(object);
      if (parsed !== null) blocks.push(parsed);
    }
  }
  return blocks;
}

/** 埋め込みJSONを深さ優先で辿り、キー名に一致した値を集める。 */
const collectByKey = (roots: readonly unknown[], keys: readonly string[]): unknown[] => {
  const wanted = new Set(keys.map((key) => key.toLowerCase()));
  const found: unknown[] = [];
  const seen = new Set<unknown>();
  const walk = (node: unknown, depth: number) => {
    if (depth > 12 || !node || typeof node !== "object" || seen.has(node)) return;
    seen.add(node);
    if (Array.isArray(node)) {
      for (const item of node) walk(item, depth + 1);
      return;
    }
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (wanted.has(key.toLowerCase())) found.push(value);
      walk(value, depth + 1);
    }
  };
  for (const root of roots) walk(root, 0);
  return found;
};

// 「作者がダウンロードを許可した」ことを表す真偽値のキー。
const DOWNLOADABLE_KEYS = ["downloadable", "isdownloadable", "allowdownload", "allowdownloads"];
const LICENSE_KEYS = ["license", "licence", "licenseCode", "licenseId", "usageInfo"];
const AUTHOR_KEYS = ["author", "username", "owner", "creator", "authorName"];

/** Creative Commonsの正規URLから識別子と表記を組み立てる。 */
const licenseFromUrl = (href: string): SuperSplatLicense | null => {
  const url = toAbsoluteUrl(href);
  if (!url || !/(^|\.)creativecommons\.org$/i.test(url.hostname)) return null;
  const path = url.pathname.toLowerCase();
  const zero = path.match(/\/publicdomain\/zero\/([\d.]+)/);
  if (zero) return { code: `CC0-${zero[1]}`, label: `CC0 ${zero[1]}` };
  if (path.startsWith("/publicdomain/mark")) return { code: "PDM-1.0", label: "Public Domain Mark 1.0" };
  const cc = path.match(/\/licenses\/([a-z-]+)\/([\d.]+)/);
  if (!cc) return null;
  const terms = cc[1].toUpperCase();
  return { code: `CC-${terms}-${cc[2]}`, label: `CC ${terms} ${cc[2]}` };
};

/**
 * `CC-BY-4.0` / `CC BY 4.0` / `cc-by-nc-sa-4.0` のような文字列を正規化する。
 *
 * SPDXの識別子をcodeに、空白区切りをlabelに使う。どちらの書き方で来ても
 * 同じ組になるようにしておくと、UIとテストが1つの形だけを見ればよくなる。
 */
const licenseFromCode = (value: string): SuperSplatLicense | null => {
  const text = value.trim();
  if (!text) return null;
  const cc0 = text.match(/^cc[\s-]?0(?:[\s-]+([\d.]+))?$/i);
  if (cc0) {
    const version = cc0[1] ?? "1.0";
    return { code: `CC0-${version}`, label: `CC0 ${version}` };
  }
  const cc = text.match(/^cc[\s-]+((?:by|nc|nd|sa)(?:[\s-]+(?:by|nc|nd|sa))*)[\s-]+([\d.]+)$/i);
  if (cc) {
    const terms = cc[1].replace(/[\s-]+/g, "-").toUpperCase();
    return { code: `CC-${terms}-${cc[2]}`, label: `CC ${terms.replace(/-/g, "-")} ${cc[2]}` };
  }
  // CC以外（`MIT` など）はそのまま通す。表記を作れる程度に短いものだけ。
  if (/^[A-Za-z0-9][A-Za-z0-9.\-+ ]{0,48}$/.test(text)) return { code: text, label: text };
  return null;
};

const licenseFromValue = (value: unknown): SuperSplatLicense | null => {
  if (typeof value === "string") {
    return licenseFromUrl(value) ?? licenseFromCode(value);
  }
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const code = record.code ?? record.id ?? record.spdx ?? record.identifier;
  const label = record.label ?? record.name ?? record.title;
  const url = record.url ?? record.href ?? record["@id"];
  if (typeof url === "string") {
    const fromUrl = licenseFromUrl(url);
    if (fromUrl) {
      return {
        code: typeof code === "string" && code ? code : fromUrl.code,
        label: typeof label === "string" && label ? label : fromUrl.label,
      };
    }
  }
  if (typeof code === "string" && code) {
    const normalized = licenseFromCode(code);
    if (normalized) {
      return { code: normalized.code, label: typeof label === "string" && label ? label : normalized.label };
    }
  }
  if (typeof label === "string") return licenseFromCode(label);
  return null;
};

/**
 * `<link rel="license">` / `<a rel="license">` を読む。
 *
 * 「機械可読なライセンスリンクを公開ページに埋め込んでいる」というのが
 * SuperSplat側の説明で、その標準的な表現がこの `rel="license"`。
 */
const licenseFromRelLink = (html: string): SuperSplatLicense | null => {
  for (const match of html.matchAll(/<(?:link|a)\b([^>]*)>/gi)) {
    const attributes = match[1];
    const rel = attributeOf(attributes, "rel").toLowerCase();
    if (!rel.split(/\s+/).includes("license")) continue;
    const license = licenseFromUrl(attributeOf(attributes, "href"));
    if (license) return license;
  }
  return null;
};

/** 表示に回す文字列の実体参照をほどく。属性値に `&amp;` などが入るため。 */
const decodeEntities = (text: string): string =>
  text
    .replace(/&#(\d+);/g, (_, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code: string) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&quot;/gi, '"')
    .replace(/&apos;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&nbsp;/gi, " ")
    // `&amp;` は最後。先に戻すと `&amp;lt;` が `<` に化ける。
    .replace(/&amp;/gi, "&");

const metaContent = (html: string, names: readonly string[]): string => {
  for (const match of html.matchAll(/<meta\b([^>]*)>/gi)) {
    const attributes = match[1];
    const key = (attributeOf(attributes, "property") || attributeOf(attributes, "name")).toLowerCase();
    if (!names.includes(key)) continue;
    const content = decodeEntities(attributeOf(attributes, "content"));
    if (content) return content;
  }
  return "";
};

/** `<title>` の中身。 */
const documentTitle = (html: string): string =>
  decodeEntities(html.match(/<title\b[^>]*>([\s\S]*?)<\/title\s*>/i)?.[1] ?? "").trim();

/**
 * 表題の末尾に付くサイト名を落とす。
 *
 * 実ページは `<title>Lion - SuperSplat</title>` / `og:title` も同じ形。区切りは
 * ハイフンで、`|` とは限らない。何を落とすかは `og:site_name` が教えてくれるので、
 * 区切り文字だけを決め打ちして残りはその値で照合する。
 *
 * 落とした結果が空になる場合（作品名がサイト名と同じ）は元の値を返す。
 */
const stripSiteName = (text: string, siteName: string): string => {
  const value = text.trim();
  const site = siteName.trim();
  if (!value || !site) return value;
  const escaped = site.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const stripped = value.replace(new RegExp(`\\s*[-|｜—–]\\s*${escaped}\\s*$`, "i"), "").trim();
  return stripped || value;
};

const firstString = (values: readonly unknown[]): string => {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
};

/**
 * scene pageから表示用のtitle / authorを読む。
 *
 * 取得してよいかの判断には関与しない。判断は
 * `readSuperSplatDownloadPermission` が行う。
 */
export function readSuperSplatSceneMeta(html: string): SuperSplatSceneMeta {
  const blocks = embeddedJsonBlocks(html);
  // サイト名は `og:site_name` が持っている。表題から落とす接尾辞をこれで決める。
  const siteName = metaContent(html, ["og:site_name"]);

  // 埋め込みJSONの `title` / `name` は**見ない**。実ページではそこにサイト名
  // （"SuperSplat"）が入っていて、シーン名より先に当たってしまう。作品名を
  // 名指ししているのはOGPのほうなので、そちらを先に読む。
  const title =
    stripSiteName(metaContent(html, ["og:title", "twitter:title"]), siteName) ||
    // プレビュー画像のalt。実ページではサイト名の付かない作品名そのもの。
    metaContent(html, ["og:image:alt"]) ||
    stripSiteName(documentTitle(html), siteName);

  const author =
    firstString(collectByKey(blocks, AUTHOR_KEYS)) ||
    metaContent(html, ["author", "og:article:author", "twitter:creator"]);

  return { title, author };
}

// ダウンロード操作を表しうる要素。入れ子にならないタグだけを対象にするので、
// 非貪欲マッチで要素1つ分の断片を切り出せる。
// ダウンロード操作を表しうる要素。入れ子にならないタグだけを対象にするので、
// 非貪欲マッチで要素1つ分の断片を切り出せる。
const DOWNLOAD_ELEMENT = /<(a|button|form)\b([^>]*)>([\s\S]*?)<\/\1\s*>/gi;

// URLがダウンロードを指していると分かる形。パスと拡張子だけを見る。
// `download-a1b2c3.js` のようなビルド成果物のファイル名には当たらない
// （`download` の直後が区切りであることを要求している）。
const DOWNLOAD_HREF = /(^|\/)downloads?(\/|$|\?)|\.(sog|ply|splat|zip)($|\?)/i;

/**
 * 「ダウンロード操作」を表す語。
 *
 * 単数形の `Download` だけに当たり、複数形の `downloads` には**当たらない**。
 * 実ページにはlucideのdownloadアイコンを使った「27 downloads」という統計表示が
 * あり、これを操作と取り違えないため。`download` の直後が英字なら不一致になる。
 */
const DOWNLOAD_WORD = /(^|[^a-z])download([^a-z]|$)/i;

const textOf = (fragment: string): string =>
  fragment
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();

/**
 * 要素が「ダウンロード操作」だと機械的に読み取れるか。
 *
 * 手がかりは2種類。
 *
 * 1. 属性側の表明 … `<a download>`、ダウンロードを指す `href` / `action`、
 *    `data-*` / `aria-label` / `title` に現れる `download`。
 * 2. 表示テキストの `Download` … 実ページのボタンは
 *    `<button><svg class="lucide lucide-download"/>Download</button>` で、
 *    属性側に手がかりが無いためこちらで拾う。
 *
 * `class` は見ない。アイコン名（`lucide-download`）は装飾であって操作の表明では
 * なく、統計表示にも同じアイコンが使われているため。
 */
const isDownloadControl = (attributes: string, inner: string): boolean => {
  // `<a download>` はHTML標準の「これは保存操作である」という表明。
  if (/\bdownload\b(?=[\s=>]|$)/i.test(attributes)) return true;
  for (const name of ["href", "action", "formaction"]) {
    if (DOWNLOAD_HREF.test(attributeOf(attributes, name))) return true;
  }
  for (const match of attributes.matchAll(/\b(data-[\w-]+|aria-label|title|id|name)\s*=\s*("([^"]*)"|'([^']*)')/gi)) {
    const value = match[3] ?? match[4] ?? "";
    if (DOWNLOAD_WORD.test(value)) return true;
  }
  return DOWNLOAD_WORD.test(textOf(inner));
};

/**
 * ページから明示的なダウンロード操作を探す。見つかればその要素のHTML断片。
 *
 * 対象は `a` / `button` / `form` だけ。見出しや統計表示（`<span>27 downloads</span>`）
 * のような、押せない要素は最初から候補に入らない。
 */
export function findDownloadControl(html: string): string | null {
  for (const match of html.matchAll(DOWNLOAD_ELEMENT)) {
    const [fragment, , attributes, inner] = match;
    if (isDownloadControl(attributes, inner)) return fragment;
  }
  return null;
}

/**
 * 断片の中からライセンスを読む。`rel="license"` → CC URL → 表示テキストの順。
 *
 * ページ全体の `rel="license"` が取れないときの補助。実ページでは
 * Downloadボタンの隣に `<span title="Attribution">CC BY 4.0</span>` が並ぶ。
 */
const licenseWithin = (fragment: string): SuperSplatLicense | null => {
  const fromRel = licenseFromRelLink(fragment);
  if (fromRel) return fromRel;
  for (const match of fragment.matchAll(/https?:\/\/(?:www\.)?creativecommons\.org\/[^\s"'<>]+/gi)) {
    const license = licenseFromUrl(match[0]);
    if (license) return license;
  }
  // 表示されている表記から起こす。`CC BY 4.0` のような並びだけを拾う。
  const label = textOf(fragment).match(
    /\bCC0(?:[\s-]+[\d.]+)?\b|\bCC[\s-]+(?:BY|NC|ND|SA)(?:[\s-]+(?:BY|NC|ND|SA))*[\s-]+[\d.]+\b/i,
  );
  return label ? licenseFromCode(label[0]) : null;
};

/**
 * Downloadボタンの周辺に併記されたライセンスを読む。
 *
 * 実ページのDownload UIはこの形で、ライセンスはボタンの**兄弟**にある。
 *
 *   <div class="flex flex-wrap items-center gap-2">
 *     <button><svg class="lucide lucide-download"/>Download</button>
 *     <span title="Attribution">CC BY 4.0</span>
 *   </div>
 *
 * ボタンの断片だけを見ても届かないので、ボタンの直後に続く範囲も併せて見る。
 * ページ全体を見に行くわけではないので、離れた場所の説明文は拾わない。
 */
const licenseBesideControl = (html: string, control: string): SuperSplatLicense | null => {
  const inside = licenseWithin(control);
  if (inside) return inside;
  const at = html.indexOf(control);
  if (at < 0) return null;
  // ボタンの直後の兄弟数個ぶん。囲みの `</div>` を越える前に見つかることを狙う。
  const after = html.slice(at + control.length, at + control.length + 400);
  return licenseWithin(after.split(/<\/div\s*>/i)[0] ?? "");
};

/**
 * scene pageから「取得してよいか」を読む。asset discoveryより必ず先に呼ぶ。
 *
 * 判定は2段構え。
 *
 * 1. 埋め込みJSONの真偽値（`downloadable` など）。あればこれが最優先で、
 *    ページの見た目に左右されない一番強い根拠。
 * 2. **明示的なDownload操作**と**機械可読なライセンス**の組み合わせ。実ページは
 *    この形で、ライセンスは `<head>` に置かれている。
 *
 *      <head>
 *        <link rel="license" href="https://creativecommons.org/licenses/by/4.0/">
 *      <body>
 *        <button><svg class="lucide lucide-download"/>Download</button>
 *        <span title="Attribution">CC BY 4.0</span>
 *
 *    ライセンスの第一の取得元は `<link rel="license">`。SuperSplat自身が設定した
 *    値で、一番信頼できる。ボタン隣の `<span title="Attribution">` はそれが
 *    取れないときの補助として使う。
 *
 * 両方が揃ったときだけ許可とみなす。片方だけでは許可しない。
 *
 * - `<link rel="license">` だけ … 配布を許可しているとは限らない
 * - Downloadボタンだけ … どの条件で配っているのか分からない
 * - `html.includes("Download")` … 論外。統計表示の「27 downloads」や、
 *   作者が説明文に書いた `# CC-BY - ...` も許可の根拠にはしない
 *
 * どちらでも判定できなければ `downloadable: null` を返す。呼び出し側は
 * `false` と同じく読み込まない。
 */
export function readSuperSplatDownloadPermission(html: string): SuperSplatDownloadPermission {
  const blocks = embeddedJsonBlocks(html);

  // ページが設定したライセンス。`rel="license"` が最優先。
  // 作品説明文に書かれた `# CC-BY - ...` のような自由記述はここに入らない。
  const pageLicense =
    licenseFromRelLink(html) ??
    collectByKey(blocks, LICENSE_KEYS).map(licenseFromValue).find((value) => value !== null) ??
    licenseFromCode(metaContent(html, ["license", "og:license", "dcterms.license"])) ??
    null;

  const flags = collectByKey(blocks, DOWNLOADABLE_KEYS).filter(
    (value): value is boolean => typeof value === "boolean",
  );
  if (flags.length > 0) {
    return flags.some((flag) => flag)
      ? { downloadable: true, license: pageLicense, reason: "downloadable-flag" }
      : { downloadable: false, license: pageLicense, reason: "downloadable-flag-false" };
  }

  const control = findDownloadControl(html);
  if (!control) {
    return { downloadable: null, license: pageLicense, reason: "download-control-not-found" };
  }

  // Download操作があり、ページが機械可読なライセンスを持っている。
  if (pageLicense) {
    return { downloadable: true, license: pageLicense, reason: "download-control-with-page-license" };
  }

  // `rel="license"` が無いページ向けの保険。ボタンに併記された表記から起こす。
  const beside = licenseBesideControl(html, control);
  if (beside) {
    return { downloadable: true, license: beside, reason: "download-control-with-license" };
  }

  return { downloadable: null, license: null, reason: "download-control-without-license" };
}

/**
 * scene pageに対応するviewer pageのURLを決める。
 *
 * 原則は `https://superspl.at/s?id={sceneId}`。scene page自身がviewerを指して
 * いる（iframeの`src`やリンク）ならそちらを優先するが、**ホストが
 * `superspl.at`、パスが `/s`、`id` が今見ているsceneIdと一致するもの**しか
 * 採らない。ページに書いてあった任意のURLを取りに行かないための関門。
 */
export function findSuperSplatViewerUrl(html: string, sceneId: string): string | null {
  if (!isSuperSplatSceneId(sceneId)) return null;
  const fallback = `https://${SUPERSPLAT_HOST}/s?id=${sceneId}`;

  const accepts = (value: string): string | null => {
    let url: URL;
    try {
      url = new URL(value, `https://${SUPERSPLAT_HOST}/scene/${sceneId}`);
    } catch {
      return null;
    }
    if (url.protocol !== "https:") return null;
    if (url.hostname.toLowerCase() !== SUPERSPLAT_HOST) return null;
    if (url.pathname.replace(/\/$/, "") !== "/s") return null;
    if (url.searchParams.get("id") !== sceneId) return null;
    return url.toString();
  };

  for (const match of html.matchAll(/<(?:iframe|a|link)\b([^>]*)>/gi)) {
    const attributes = match[1];
    for (const name of ["src", "href"]) {
      const candidate = accepts(attributeOf(attributes, name));
      if (candidate) return candidate;
    }
  }
  return fallback;
}

/**
 * 公開ページに書かれているアセットのURLを集める。
 *
 * Viewer本体（`renderViewerHtml`）が差し込む `contentUrl` が正規の取得元。
 * 素のscriptに `const contentUrl = '…'` として置かれていた時期もあるので、
 * そちらも読む。**CDNのURLを組み立てて当て推量で叩くことはしない。**
 * リビジョンもページが持っているURLから読むだけで、探索はしない。
 */
export function findSuperSplatContentUrls(html: string, pageUrl: string): string[] {
  const candidates: string[] = [];
  const push = (value: unknown) => {
    if (typeof value !== "string" || !value) return;
    // `data:` uri でシーンを配る形もあるが、Viewerが直接読める形ではないので取らない。
    if (/^data:/i.test(value)) return;
    try {
      candidates.push(new URL(value, pageUrl).toString());
    } catch {
      /* 相対URLとしても絶対URLとしても読めないものは捨てる */
    }
  };

  for (const value of collectByKey(embeddedJsonBlocks(html), ["contentUrl", "contenturl"])) push(value);
  for (const match of html.matchAll(/\bcontentUrl\s*[=:]\s*['"]([^'"]+)['"]/g)) push(match[1]);

  return [...new Set(candidates)];
}

const REVISION_PATTERN = /^v\d+$/i;

/** URLのパスに含まれる配信リビジョン（`v3` など）を読む。無ければ `null`。 */
export function revisionOf(url: string): string | null {
  const absolute = toAbsoluteUrl(url);
  if (!absolute) return null;
  const segments = absolute.pathname.split("/").filter(Boolean);
  // 末尾側が新しい構造でも拾えるよう後ろから探す。
  for (let index = segments.length - 1; index >= 0; index -= 1) {
    if (REVISION_PATTERN.test(segments[index])) return segments[index].toLowerCase();
  }
  return null;
}

const formatOf = (url: string): SuperSplatAssetFormat | null => {
  const absolute = toAbsoluteUrl(url);
  if (!absolute) return null;
  const basename = absolute.pathname.toLowerCase().split("/").pop() ?? "";
  if (basename === "lod-meta.json") return "streamed-sog";
  if (basename === "meta.json") return "sog-meta";
  if (basename.endsWith(".sog")) return "sog";
  return null;
};

// PlayCanvasのgsplatローダーが素直に読める順。bundled SOGが一番扱いやすく、
// `lod-meta.json` は今回のViewerでは表示できない（PR2で対応する）。
const FORMAT_PRIORITY: SuperSplatAssetFormat[] = ["sog", "sog-meta", "streamed-sog"];

/**
 * 集めた候補から、実際に読み込むアセットを1つ選ぶ。
 *
 * 公開ホストとして許可していないURLはここで落とす。ページに書いてあるという
 * だけで任意のホストを取りに行かないための最後の関門。
 */
export function selectSuperSplatAsset(urls: readonly string[]): SuperSplatAsset | null {
  const allowed = urls.filter(isSuperSplatAssetUrl);
  for (const format of FORMAT_PRIORITY) {
    const url = allowed.find((candidate) => formatOf(candidate) === format);
    if (url) return { format, url, revision: revisionOf(url) };
  }
  return null;
}
