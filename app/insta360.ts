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
  const unescaped = unescapeJsonText(text);
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
 * JSONの中に埋まったテキストをURL抽出用にほどく。
 *
 * 共有ページの署名付きURLは `?a=1&b=2` のように区切りがエスケープされて
 * いるため、`\/` だけを戻していた頃はURLが途中で切れていた。ここでは走査用の
 * 使い捨てコピーを作るだけなので、`\uXXXX` をまとめて戻して構わない。
 */
export function unescapeJsonText(text: string): string {
  return text
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/\\\//g, "/");
}

/** 共有ページ（Next.js）が埋め込む初期データ。 */
export function extractNextData(html: string): unknown {
  const match = html.match(
    /<script[^>]+id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i,
  );
  if (!match) return null;
  try {
    return JSON.parse(match[1]);
  } catch {
    return null;
  }
}

/** `taskDetail.outputs` の1件。キー名のゆれを吸収した形。 */
export type Insta360Output = {
  name: string;
  type: string;
  fileFormat: string;
  url: string;
};

const pickString = (record: Record<string, unknown>, keys: string[]): string => {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value) return value;
  }
  return "";
};

const pathOf = (url: string): string => {
  const absolute = toAbsoluteUrl(url);
  return absolute ? absolute.pathname.toLowerCase() : url.toLowerCase();
};

const toOutput = (entry: unknown): Insta360Output | null => {
  if (!entry || typeof entry !== "object") return null;
  const record = entry as Record<string, unknown>;
  const url = pickString(record, ["url", "fileUrl", "file_url", "downloadUrl", "download_url"]);
  if (!toAbsoluteUrl(url)) return null;
  const name = pickString(record, ["name", "fileName", "file_name"]) ||
    pathOf(url).split("/").pop() || "";
  const fileFormat =
    pickString(record, ["fileFormat", "file_format", "format"]) ||
    (name.includes(".") ? name.split(".").pop() ?? "" : "");
  return {
    name,
    type: pickString(record, ["type", "fileType", "file_type"]),
    fileFormat: fileFormat.toLowerCase(),
    url,
  };
};

/**
 * 共有ページの初期データから生成済みアセットの一覧を取り出す。
 *
 * 素直な場所は `props.pageProps.taskDetail.outputs` だが、Next.jsのページ構造は
 * 変わりうるので、見つからなければURLを持つオブジェクトの配列を全体から探す。
 */
export function findTaskOutputs(data: unknown): Insta360Output[] {
  const documented = (data as {
    props?: { pageProps?: { taskDetail?: { outputs?: unknown } } };
  } | null)?.props?.pageProps?.taskDetail?.outputs;
  const fromDocumentedPath = Array.isArray(documented)
    ? documented.map(toOutput).filter((output): output is Insta360Output => output !== null)
    : [];
  if (fromDocumentedPath.length > 0) return fromDocumentedPath;

  const seen = new Set<unknown>();
  const search = (node: unknown, depth: number): Insta360Output[] => {
    if (depth > 8 || !node || typeof node !== "object" || seen.has(node)) return [];
    seen.add(node);
    if (Array.isArray(node)) {
      const outputs = node
        .map(toOutput)
        .filter((output): output is Insta360Output => output !== null);
      if (outputs.length > 0) return outputs;
      for (const item of node) {
        const found = search(item, depth + 1);
        if (found.length > 0) return found;
      }
      return [];
    }
    for (const value of Object.values(node as Record<string, unknown>)) {
      const found = search(value, depth + 1);
      if (found.length > 0) return found;
    }
    return [];
  };
  return search(data, 0);
}

/** PlayCanvasがそのまま読めるアセットを選ぶ。SOGバンドルを優先する。 */
export function selectSpatialOutput(outputs: Insta360Output[]): Insta360Output | null {
  return (
    outputs.find((output) => output.fileFormat === "sog") ??
    outputs.find((output) => pathOf(output.url).endsWith(".sog")) ??
    outputs.find((output) => pathOf(output.url).endsWith("/meta.json")) ??
    null
  );
}

/**
 * 撮影時のカメラ情報（`2_cameras.json`）を選ぶ。
 *
 * SOGと同じ `outputs` に並んでいる。実データでは `type` が `"model"`（SOGやPLYと
 * 同じ）だったので、型では見分けられない。判定はファイル名で行う。
 * `meta.json`（SOGディレクトリ形式の索引）は別物なので取らない。
 */
export function selectCamerasOutput(outputs: Insta360Output[]): Insta360Output | null {
  return outputs.find((output) => /(^|[/_])cameras\.json$/.test(pathOf(output.url))) ?? null;
}

/** 共有ページ／タスク詳細から取り出した、Viewerが使うアセット一式。 */
export type Insta360Assets = {
  /** PlayCanvasへ渡すSOG（署名付き）。 */
  assetUrl: string;
  /** 撮影時のカメラ情報。公式Viewerの初期視点はここから来る。無ければ`null`。 */
  camerasUrl: string | null;
};

/**
 * 共有ページのHTMLからアセットのURLを取り出す。
 *
 * `__NEXT_DATA__` に署名付きURLが最初から入っているので、まずそれを読む。
 * 構造が変わった場合に備えて、従来のURL走査も残してある（そちらはSOGだけ）。
 */
export function resolveAssetsFromHtml(html: string, baseUrl: string): Insta360Assets | null {
  const outputs = findTaskOutputs(extractNextData(html));
  const selected = selectSpatialOutput(outputs);
  if (selected) {
    return { assetUrl: selected.url, camerasUrl: selectCamerasOutput(outputs)?.url ?? null };
  }
  const scanned = findSpatialAssetUrl(html, baseUrl);
  return scanned ? { assetUrl: scanned, camerasUrl: null } : null;
}

/** 共有ページ自身が叩くタスク詳細APIのオリジン。共有ページの `metaData` に出てくる値。 */
export const INSTA360_SERVICE_ORIGINS = {
  cn: "https://service-c.insta360.com",
  global: "https://service-g.insta360.com",
} as const;

const TASK_DETAIL_PATH = "/app-service/app/service/gs3d/task/detail";

/**
 * 共有IDからタスク詳細APIのURLを組み立てる。
 *
 * 共有ページのスクリプトは共有IDの5文字目でリージョンを決めている
 * （`C` は中国、`G` はグローバル）。判別できない場合は両方に問い合わせて、
 * 先に成功した方を使う。
 */
export function taskDetailApiUrls(shareId: string): string[] {
  const region = shareId.charAt(4).toUpperCase();
  const origins =
    region === "C"
      ? [INSTA360_SERVICE_ORIGINS.cn]
      : region === "G"
        ? [INSTA360_SERVICE_ORIGINS.global]
        : [INSTA360_SERVICE_ORIGINS.global, INSTA360_SERVICE_ORIGINS.cn];
  return origins.map(
    (origin) => `${origin}${TASK_DETAIL_PATH}?taskOrderNo=${encodeURIComponent(shareId)}`,
  );
}

/**
 * タスク詳細APIのレスポンス（`{ code, data: { outputs } }`）からアセットのURLを取り出す。
 *
 * 中身は共有ページに埋まっている `taskDetail` と同じ形なので、出力の選別は共通の
 * 処理を使う。
 */
export function resolveAssetsFromTaskDetail(body: unknown): Insta360Assets | null {
  const payload = body as { code?: number; data?: unknown } | null;
  if (!payload || typeof payload !== "object") return null;
  if (typeof payload.code === "number" && payload.code !== 0) return null;
  const outputs = findTaskOutputs(payload.data ?? payload);
  const selected = selectSpatialOutput(outputs);
  if (!selected) return null;
  return { assetUrl: selected.url, camerasUrl: selectCamerasOutput(outputs)?.url ?? null };
}

/**
 * 共有IDの形。実データは `GS3D` + リージョン1文字 + 32桁の16進で、
 * 共有ページのスクリプトも5文字目でリージョンを判定している。
 *
 * Viewerのパーマリンク (`?id=`) は外から任意の文字列が入ってくるので、
 * ネットワークへ出す前にこの形で弾く。共有URLを貼られた場合の
 * `parseInsta360ShareUrl` より厳しいが、あちらは入力がInsta360のURLである
 * ことが既に分かっている。
 */
const SHARE_ID_PATTERN = /^GS3D[A-Za-z][0-9a-f]{32}$/i;

/** Insta360 Spatial Captureの共有IDとして扱える文字列か。 */
export function isInsta360ShareId(value: string): boolean {
  return SHARE_ID_PATTERN.test(value.trim());
}

/** 共有IDから共有ページのURLを組み立てる。IDの形が違えばnull。 */
export function shareUrlFromShareId(value: string): string | null {
  const shareId = value.trim();
  if (!isInsta360ShareId(shareId)) return null;
  return `https://app.insta360.com/3dspace/detail/${shareId}`;
}
