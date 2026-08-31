/**
 * KISS-GS の SOG-XT コンテナを数値へ戻すための純粋関数群。
 *
 * SOG-XT は Fraunhofer HHI の KISS-GS（ECCV 2026）が配っている 3D Gaussian
 * Splatting の圧縮表現で、`meta.json` ＋ ロスレスWebP群という構成になっている。
 * PlayCanvas標準のSOG（`meta.json` ＋ WebP）とは**別物**で、量子化の枠の取り方
 * （observed-minmax）も、meansの持ち方（signed-log ＋ 16bit 2枚組）も、SHの
 * 持ち方（uv-codebook）も違う。名前と拡張子が似ているだけなので、既存の
 * unbundled SOG 経路へ渡してはいけない。
 *
 * ここに書いてある変換はすべて、KISS-GS公式ページが配っているビューア
 * （`fraunhoferhhi/kiss-gs` の `gh-pages` ブランチ、
 * `viewer/scenes/index.js`）のデコーダから起こしている。対応関係は
 * 各関数のコメントに元の識別子で残してある（例: `Pt` = normObs）。
 *
 * DOMにもPlayCanvasにも依存しないので、そのままNodeでテストできる。
 */

/** このデコーダが読める `meta.json` の `format`。 */
export const SOG_XT_FORMAT = "sog-xt";
/** 読める `version`。KISS-GS公式サンプル（2026-08時点）はすべて 3。 */
export const SOG_XT_SUPPORTED_VERSIONS = [3] as const;
/** コンテナのメタデータのファイル名。ディレクトリURLにはこれを足す。 */
export const SOG_XT_METADATA_FILENAME = "meta.json";
/** 3DGSのSH第0次係数を色へ直す定数。PlayCanvasの `SH_C0` と同じ値。 */
export const SH_C0 = 0.28209479177387814;
/** observed-minmax の除算保護。KISS-GS側の `EPSILON` と同じ値にそろえる。 */
const OBSERVED_EPSILON = 1e-8;

/** UI・呼び出し側がエラーの種類で分岐するための識別子。 */
export type SogXtErrorCode =
  | "METADATA_DOWNLOAD_FAILED"
  | "METADATA_INVALID"
  | "UNSUPPORTED_VERSION"
  | "IMAGE_DOWNLOAD_FAILED"
  | "IMAGE_DECODE_FAILED"
  | "INCONSISTENT_SPLAT_COUNT"
  | "UNSUPPORTED_SH"
  | "RESOURCE_CREATION_FAILED";

/** ユーザーに出す日本語。元のエラーはdebug consoleへ別途残す。 */
export const SOG_XT_ERROR_MESSAGES: Record<SogXtErrorCode, string> = {
  METADATA_DOWNLOAD_FAILED: "KISS-GS SOG-XTのmeta.jsonを取得できませんでした。",
  METADATA_INVALID: "KISS-GS SOG-XTのmeta.jsonを解釈できませんでした。",
  UNSUPPORTED_VERSION: "このKISS-GS SOG-XTのバージョンには未対応です。",
  IMAGE_DOWNLOAD_FAILED: "KISS-GS SOG-XTの画像を取得できませんでした。",
  IMAGE_DECODE_FAILED: "KISS-GS SOG-XTの画像をデコードできませんでした。",
  INCONSISTENT_SPLAT_COUNT: "KISS-GS SOG-XTの画像サイズがmeta.jsonと一致しません。",
  UNSUPPORTED_SH: "このKISS-GS SOG-XTのSH表現には未対応です。",
  RESOURCE_CREATION_FAILED: "KISS-GS SOG-XTをPlayCanvasへ渡せませんでした。",
};

/** 種類を持つデコードエラー。`message` は開発者向け、`code` が表示の切り替え。 */
export class SogXtError extends Error {
  readonly code: SogXtErrorCode;
  constructor(code: SogXtErrorCode, detail?: string) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = "SogXtError";
    this.code = code;
  }
  /** ユーザーへ出す日本語。 */
  get userMessage(): string {
    return SOG_XT_ERROR_MESSAGES[this.code];
  }
}

/** 呼び出し側の `catch` から表示用の文言を取り出す。 */
export function sogXtErrorMessage(error: unknown): string {
  if (error instanceof SogXtError) return error.userMessage;
  if (error instanceof Error && error.message) return error.message;
  return "KISS-GS SOG-XTを読み込めませんでした。";
}

/** `sog-image.ts` / `sog-optimizer.ts` と同じ、RGBA8のピクセル面。 */
export type SogXtPixels = { width: number; height: number; data: Uint8Array };

/** スカラーでも配列でも来る min/max。`means` はスカラー1つで3軸を共有する。 */
export type SogXtRange = number | number[];

export type SogXtMeta = {
  version: number;
  format: string;
  profile?: string;
  /** 有効なsplat数。`active_mask` で1になっているセルの数と一致する。 */
  count: number;
  /** 各ストリーム画像の一辺。画像は `gridSide × gridSide` でなければならない。 */
  gridSide: number;
  mask: { files: string[] };
  /** signed-log空間での範囲。files は [下位バイト, 上位バイト]。 */
  means: { mins: SogXtRange; maxs: SogXtRange; files: string[] };
  /** pre-sigmoid（logit）空間での範囲。 */
  opacities: { mins: SogXtRange; maxs: SogXtRange; files: string[] };
  /** log空間での範囲。 */
  scales: { mins: SogXtRange; maxs: SogXtRange; files: string[] };
  /** 格納順は wxyz。`encoding` は現状 `direct` のみ。 */
  quats: { mins: SogXtRange; maxs: SogXtRange; files: string[]; encoding?: string };
  /** SHのDC係数（色そのものではない）の範囲。 */
  sh0: { mins: SogXtRange; maxs: SogXtRange; files: string[] };
  /** 高次SH。無い（SH0のみの）コンテナもある。 */
  shN?: {
    layout: string;
    coeffs: number;
    centroidSide: number;
    tileRows: number;
    tileCols: number;
    centroidsMins: number[];
    centroidsMaxs: number[];
    /** [centroids, labels] の順。 */
    files: string[];
  };
};

/** WebPを取りに行くときの、ストリーム名 → 絶対URL。 */
export type SogXtPlaneUrls = {
  mask: string;
  meansLow: string;
  meansHigh: string;
  opacities: string;
  scales: string;
  quats: string;
  sh0: string;
  shCentroids: string | null;
  shLabels: string | null;
};

/** `decodeSogXt` へ渡すピクセル面。SHが無いコンテナでは末尾2つが `null`。 */
export type SogXtPlanes = {
  mask: SogXtPixels;
  meansLow: SogXtPixels;
  meansHigh: SogXtPixels;
  opacities: SogXtPixels;
  scales: SogXtPixels;
  quats: SogXtPixels;
  sh0: SogXtPixels;
  shCentroids: SogXtPixels | null;
  shLabels: SogXtPixels | null;
};

/**
 * デコード結果。**activated形式**でそろえてある。
 *
 * - `scale` は線形（`exp(log scale)` 済み）
 * - `opacity` はsigmoid適用済み（0〜1）
 * - `rotation` は xyzw、正規化済み
 * - `fDc` は色ではなくSHのDC係数そのもの（色は `0.5 + SH_C0 * fDc`）
 * - `fRest` は PLY の `f_rest_*` と同じ並び（`channel * coeffs + coeff`）
 *
 * PlayCanvasの `GSplatData` は `activated = true` を立てればこの意味で読むので、
 * log/pre-sigmoidへ戻す往復を挟まずに済む。
 *
 * **並びは成分ごと（planar）**。`position` なら `[x0..xN-1, y0..yN-1, z0..zN-1]`
 * のように、成分ごとに連続した区画が並ぶ。`x0,y0,z0,x1,…` のインターリーブでは
 * ない。PlayCanvasの `GSplatData` は属性ごとに1本のTypedArrayを要求するので、
 * この並びなら `subarray()` をそのまま渡せて、45本のSH配列を含めて1バイトも
 * 詰め替えずに済む。Workerからの受け渡しも属性ごとに1つのTransferableで足りる。
 */
export type DecodedSogXt = {
  count: number;
  /** 3 × count。`[x…, y…, z…]`。コンテナのローカル座標（シーン配置は掛けない）。 */
  position: Float32Array;
  /** 3 × count。`[x…, y…, z…]`。線形スケール。 */
  scale: Float32Array;
  /** 4 × count。`[x…, y…, z…, w…]`。正規化済み。 */
  rotation: Float32Array;
  /** count。sigmoid適用済み。 */
  opacity: Float32Array;
  /** 3 × count。`[r…, g…, b…]`。SHのDC係数。 */
  fDc: Float32Array;
  /** (coeffs * 3) × count。`f_rest_0` の全splat、`f_rest_1` の全splat…の順。無ければ `null`。 */
  fRest: Float32Array | null;
  /** PlayCanvasへ渡すSHの帯域。`fRest` が無ければ 0。 */
  shBands: 0 | 1 | 2 | 3;
  /** デバッグ用。画像の総セル数と、active maskで落ちた数。 */
  gridEntries: number;
  maskedOut: number;
  /** 量子化の枠。観測値なので、値がおかしいときの当たりを付けるのに使う。 */
  observed: {
    means: { lo: number; hi: number };
    opacity: { lo: number; hi: number };
    scale: { lo: number; hi: number };
    quat: { lo: number; hi: number };
    sh0: { lo: number; hi: number };
    shCentroids: { lo: number; hi: number } | null;
  };
};

/* -------------------------------------------------------------------------- */
/* 量子化まわりの素の関数                                                      */
/* -------------------------------------------------------------------------- */

/**
 * 観測レンジ [lo, hi] を [0, 1] へ。KISS-GSビューアの `Pt` / WGSLの `normObs`。
 *
 * `hi - lo` に 1e-8 を足すのは向こうと同じ。単一値しか無いストリームで
 * 0除算にならないようにするためで、ここを省くと結果がNaNになる。
 */
export function normObs(value: number, lo: number, hi: number): number {
  return (value - lo) / (hi - lo + OBSERVED_EPSILON);
}

/** KISS-GSビューアの `Tt`。 */
export function lerp(a: number, b: number, t: number): number {
  return a * (1 - t) + b * t;
}

/** signed-log の逆変換。KISS-GSビューアの `At` / WGSLの `signedExpm1`。 */
export function signedExpm1(value: number): number {
  return Math.sign(value) * (Math.exp(Math.abs(value)) - 1);
}

/**
 * RGBA8の面から、先頭 `channels` チャンネルの観測min/maxを取る。
 *
 * KISS-GSビューアの `Rt`。走査するのは**画像の全画素**で、active maskで
 * 落ちるセルも含む。エンコーダが枠を決めたときと同じ母集団にするため、
 * ここでmaskを見てはいけない。
 */
export function observedRange(
  data: Uint8Array,
  channels: number,
): { lo: number; hi: number } {
  let lo = Number.POSITIVE_INFINITY;
  let hi = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < data.length; i += 4) {
    for (let c = 0; c < channels; c++) {
      const value = data[i + c];
      if (value < lo) lo = value;
      if (value > hi) hi = value;
    }
  }
  return { lo, hi };
}

/** スカラーで来る min/max を軸数ぶんに広げる。KISS-GSビューアの `ce`。 */
export function broadcastRange(value: SogXtRange, length: number): number[] {
  if (typeof value === "number") return new Array<number>(length).fill(value);
  if (value.length === length) return [...value];
  return new Array<number>(length).fill(value[0]);
}

/* -------------------------------------------------------------------------- */
/* メタデータ                                                                  */
/* -------------------------------------------------------------------------- */

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isPositiveInt = (value: unknown): value is number =>
  typeof value === "number" && Number.isInteger(value) && value > 0;

const readRange = (raw: unknown, field: string): SogXtRange => {
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  if (Array.isArray(raw) && raw.length > 0 && raw.every((v) => typeof v === "number" && Number.isFinite(v))) {
    return raw as number[];
  }
  throw new SogXtError("METADATA_INVALID", `${field} が数値でも数値配列でもありません`);
};

const readFiles = (raw: unknown, field: string, expected: number): string[] => {
  if (!Array.isArray(raw) || raw.length < expected || !raw.every((v) => typeof v === "string" && v.length > 0)) {
    throw new SogXtError("METADATA_INVALID", `${field}.files に ${expected} 個のファイル名が必要です`);
  }
  return raw.slice(0, expected) as string[];
};

const readStream = (
  meta: Record<string, unknown>,
  field: string,
  fileCount: number,
): { mins: SogXtRange; maxs: SogXtRange; files: string[] } & Record<string, unknown> => {
  const stream = meta[field];
  if (!isRecord(stream)) throw new SogXtError("METADATA_INVALID", `${field} がありません`);
  return {
    ...stream,
    mins: readRange(stream.mins, `${field}.mins`),
    maxs: readRange(stream.maxs, `${field}.maxs`),
    files: readFiles(stream.files, field, fileCount),
  };
};

/**
 * `meta.json` をSOG-XTとして読む。形が違えば投げる。
 *
 * `format` が `sog-xt` でないものはここで弾く。PlayCanvas標準のSOGも
 * `meta.json` という名前なので、その取り違えを防ぐのがこの関数の主目的。
 */
export function parseSogXtMeta(input: unknown): SogXtMeta {
  if (!isRecord(input)) throw new SogXtError("METADATA_INVALID", "オブジェクトではありません");

  if (input.format !== SOG_XT_FORMAT) {
    throw new SogXtError("METADATA_INVALID", `format が ${SOG_XT_FORMAT} ではありません`);
  }
  if (typeof input.version !== "number") {
    throw new SogXtError("METADATA_INVALID", "version がありません");
  }
  if (!(SOG_XT_SUPPORTED_VERSIONS as readonly number[]).includes(input.version)) {
    throw new SogXtError("UNSUPPORTED_VERSION", `version ${input.version}`);
  }
  if (!isPositiveInt(input.count)) throw new SogXtError("METADATA_INVALID", "count が正の整数ではありません");
  if (!isPositiveInt(input.gridSide)) {
    throw new SogXtError("METADATA_INVALID", "gridSide が正の整数ではありません");
  }
  if (input.count > input.gridSide * input.gridSide) {
    throw new SogXtError("METADATA_INVALID", "count が gridSide² を超えています");
  }

  const mask = input.mask;
  if (!isRecord(mask)) throw new SogXtError("METADATA_INVALID", "mask がありません");

  const meta: SogXtMeta = {
    version: input.version,
    format: input.format,
    profile: typeof input.profile === "string" ? input.profile : undefined,
    count: input.count,
    gridSide: input.gridSide,
    mask: { files: readFiles(mask.files, "mask", 1) },
    means: readStream(input, "means", 2),
    opacities: readStream(input, "opacities", 1),
    scales: readStream(input, "scales", 1),
    quats: readStream(input, "quats", 1),
    sh0: readStream(input, "sh0", 1),
  };

  const quatEncoding = (input.quats as Record<string, unknown>).encoding;
  if (typeof quatEncoding === "string" && quatEncoding !== "direct") {
    // `direct` は「4成分をそのまま量子化してある」形。省略した成分を復元する
    // 形式（smallest-three等）が来たら、成分の並べ直しだけでは済まない。
    throw new SogXtError("METADATA_INVALID", `quats.encoding ${quatEncoding} は未対応です`);
  }
  meta.quats.encoding = typeof quatEncoding === "string" ? quatEncoding : undefined;

  const shN = input.shN;
  if (isRecord(shN)) {
    if (shN.layout !== "uv-codebook") {
      throw new SogXtError("UNSUPPORTED_SH", `shN.layout ${String(shN.layout)}`);
    }
    if (!isPositiveInt(shN.centroidSide) || !isPositiveInt(shN.tileRows) || !isPositiveInt(shN.tileCols)) {
      throw new SogXtError("METADATA_INVALID", "shN の tile 情報が不正です");
    }
    const perCentroid = shN.tileRows * shN.tileCols * 3;
    if (isPositiveInt(shN.coeffs) && shN.coeffs !== shN.tileRows * shN.tileCols) {
      throw new SogXtError("UNSUPPORTED_SH", "shN.coeffs が tileRows × tileCols と一致しません");
    }
    const mins = shN.centroidsMins;
    const maxs = shN.centroidsMaxs;
    if (!Array.isArray(mins) || !Array.isArray(maxs) || mins.length !== perCentroid || maxs.length !== perCentroid) {
      throw new SogXtError("UNSUPPORTED_SH", "shN.centroidsMins/Maxs の長さが合いません");
    }
    meta.shN = {
      layout: shN.layout,
      coeffs: shN.tileRows * shN.tileCols,
      centroidSide: shN.centroidSide,
      tileRows: shN.tileRows,
      tileCols: shN.tileCols,
      centroidsMins: mins as number[],
      centroidsMaxs: maxs as number[],
      files: readFiles(shN.files, "shN", 2),
    };
  }

  return meta;
}

/** JSONを見てSOG-XTかどうかだけ判定する。PlayCanvas標準SOGとの取り違え防止。 */
export function isSogXtMetadata(input: unknown): boolean {
  return isRecord(input) && input.format === SOG_XT_FORMAT;
}

/**
 * 入力URLから、SOG-XTの `meta.json` のURLと基準URLを決める。
 *
 * 受け付けるのは2通り。
 *  1. `.../meta.json` そのもの
 *  2. SOG-XTディレクトリ（`.../M/MipNeRF360-Garden` か、末尾スラッシュ付き）
 *
 * 2は「最後のセグメントに拡張子が無い」ことで見分ける。ここで返るのは
 * 「SOG-XTかもしれないURL」でしかなく、SOG-XTかどうかは取得した
 * `meta.json` の `format` で決める。URL文字列から提供元を推測しない。
 */
export function parseSogXtUrl(input: string): { metadataUrl: string; baseUrl: string } | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;

  const segments = url.pathname.split("/");
  const last = segments[segments.length - 1];

  if (last.toLowerCase() === SOG_XT_METADATA_FILENAME) {
    return { metadataUrl: url.toString(), baseUrl: new URL(".", url).toString() };
  }
  // ディレクトリらしきURL。末尾スラッシュか、拡張子を持たない最後のセグメント。
  if (last === "" || !/\.[a-z0-9]+$/i.test(last)) {
    const base = new URL(last === "" ? "./" : `${last}/`, url);
    return {
      metadataUrl: new URL(SOG_XT_METADATA_FILENAME, base).toString(),
      baseUrl: base.toString(),
    };
  }
  return null;
}

/** `meta.json` の相対ファイル名を、取得に使える絶対URLへ直す。 */
export function sogXtPlaneUrls(meta: SogXtMeta, metadataUrl: string): SogXtPlaneUrls {
  const resolve = (name: string) => new URL(name, metadataUrl).toString();
  return {
    mask: resolve(meta.mask.files[0]),
    meansLow: resolve(meta.means.files[0]),
    meansHigh: resolve(meta.means.files[1]),
    opacities: resolve(meta.opacities.files[0]),
    scales: resolve(meta.scales.files[0]),
    quats: resolve(meta.quats.files[0]),
    sh0: resolve(meta.sh0.files[0]),
    shCentroids: meta.shN ? resolve(meta.shN.files[0]) : null,
    shLabels: meta.shN ? resolve(meta.shN.files[1]) : null,
  };
}

/* -------------------------------------------------------------------------- */
/* デコード                                                                    */
/* -------------------------------------------------------------------------- */

const expectGrid = (pixels: SogXtPixels, side: number, name: string) => {
  if (pixels.width !== side || pixels.height !== side) {
    throw new SogXtError(
      "INCONSISTENT_SPLAT_COUNT",
      `${name} が ${pixels.width}×${pixels.height} で、gridSide ${side} と一致しません`,
    );
  }
  if (pixels.data.length < side * side * 4) {
    throw new SogXtError("INCONSISTENT_SPLAT_COUNT", `${name} の画素数が足りません`);
  }
};

/** active maskが1のセルの番号を集める。KISS-GSビューアと同じく赤チャンネルだけ見る。 */
export function activeIndicesOf(mask: SogXtPixels, gridSide: number): Uint32Array {
  const entries = gridSide * gridSide;
  const indices: number[] = [];
  for (let i = 0; i < entries; i++) {
    if (mask.data[4 * i] > 0) indices.push(i);
  }
  return Uint32Array.from(indices);
}

/**
 * SHのコードブックを展開する。KISS-GSビューアの `Ft`。
 *
 * centroids画像は `centroidSide × centroidSide` 個のコードワードを、
 * `tileRows × tileCols` のタイルへばらして敷き詰めてある。1コードワードは
 * `tileRows*tileCols*3` 個の係数を持ち、その並びは `channel * coeffs + coeff`
 * ——つまりPLYの `f_rest_*` と同じ順になる。
 */
export function decodeShPalette(
  meta: NonNullable<SogXtMeta["shN"]>,
  centroids: SogXtPixels,
): { palette: Float32Array; perCentroid: number; observed: { lo: number; hi: number } } {
  const side = meta.centroidSide;
  const { tileRows, tileCols } = meta;
  const perCentroid = tileRows * tileCols * 3;
  const tileArea = tileRows * tileCols;

  if (centroids.width !== side * tileCols || centroids.height !== side * tileRows) {
    throw new SogXtError(
      "INCONSISTENT_SPLAT_COUNT",
      `f_rest_centroids が ${centroids.width}×${centroids.height} で、` +
        `${side * tileCols}×${side * tileRows} と一致しません`,
    );
  }

  const observed = observedRange(centroids.data, 3);
  const mins = broadcastRange(meta.centroidsMins, perCentroid);
  const maxs = broadcastRange(meta.centroidsMaxs, perCentroid);
  const palette = new Float32Array(side * side * perCentroid);
  const rowWidth = side * tileCols;

  for (let row = 0; row < side; row++) {
    for (let col = 0; col < side; col++) {
      const base = (row * side + col) * perCentroid;
      for (let tileRow = 0; tileRow < tileRows; tileRow++) {
        for (let tileCol = 0; tileCol < tileCols; tileCol++) {
          const pixel = 4 * ((tileRow * side + row) * rowWidth + (tileCol * side + col));
          const coeff = tileRow * tileCols + tileCol;
          for (let channel = 0; channel < 3; channel++) {
            const slot = channel * tileArea + coeff;
            const normalized = normObs(centroids.data[pixel + channel], observed.lo, observed.hi);
            palette[base + slot] = lerp(mins[slot], maxs[slot], normalized);
          }
        }
      }
    }
  }
  return { palette, perCentroid, observed };
}

/** PlayCanvasが受け付けるSH帯域。1帯域=3係数、2=8、3=15。 */
const shBandsForCoeffs = (coeffs: number): 0 | 1 | 2 | 3 => {
  if (coeffs >= 15) return 3;
  if (coeffs >= 8) return 2;
  if (coeffs >= 3) return 1;
  return 0;
};

/**
 * SOG-XTのピクセル面を、レンダラが使える属性配列へ戻す。
 *
 * 手順はKISS-GS公式ビューアと同じ順番で、
 *  1. active maskで生きているセルを拾う
 *  2. 各ストリームの**画像全体**から観測min/max（observed-minmax）を取る
 *  3. 生バイト → 観測レンジで[0,1] → metaのmin/maxへ線形補間
 *  4. ストリームごとの逆変換（means: signed-exp、scales: exp、opacity: sigmoid）
 * を掛ける。
 */
export function decodeSogXt(meta: SogXtMeta, planes: SogXtPlanes): DecodedSogXt {
  const side = meta.gridSide;
  const entries = side * side;

  expectGrid(planes.mask, side, "active_mask");
  expectGrid(planes.meansLow, side, meta.means.files[0]);
  expectGrid(planes.meansHigh, side, meta.means.files[1]);
  expectGrid(planes.opacities, side, meta.opacities.files[0]);
  expectGrid(planes.scales, side, meta.scales.files[0]);
  expectGrid(planes.quats, side, meta.quats.files[0]);
  expectGrid(planes.sh0, side, meta.sh0.files[0]);
  if (meta.shN && planes.shLabels) expectGrid(planes.shLabels, side, meta.shN.files[1]);

  const activeIndices = activeIndicesOf(planes.mask, side);
  const count = activeIndices.length;
  if (count !== meta.count) {
    throw new SogXtError(
      "INCONSISTENT_SPLAT_COUNT",
      `active maskが ${count} 個で、meta.count ${meta.count} と一致しません`,
    );
  }

  // means は 2枚の8bit画像で16bit値を作る。下位が `means_bytes_0`、
  // 上位が `means_bytes_1`（ffsplatの `split_bytes` はビット位置の昇順で
  // 連番を振る）。観測レンジも合成後の16bit値に対して取る。
  const meansCombined = new Uint16Array(3 * entries);
  let meansLo = Number.POSITIVE_INFINITY;
  let meansHi = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < entries; i++) {
    for (let k = 0; k < 3; k++) {
      const value = planes.meansLow.data[4 * i + k] + 256 * planes.meansHigh.data[4 * i + k];
      meansCombined[3 * i + k] = value;
      if (value < meansLo) meansLo = value;
      if (value > meansHi) meansHi = value;
    }
  }

  const opacityObserved = observedRange(planes.opacities.data, 1);
  const scaleObserved = observedRange(planes.scales.data, 3);
  const quatObserved = observedRange(planes.quats.data, 4);
  const sh0Observed = observedRange(planes.sh0.data, 3);

  const meansMins = broadcastRange(meta.means.mins, 3);
  const meansMaxs = broadcastRange(meta.means.maxs, 3);
  const scaleMins = broadcastRange(meta.scales.mins, 3);
  const scaleMaxs = broadcastRange(meta.scales.maxs, 3);
  const quatMins = broadcastRange(meta.quats.mins, 4);
  const quatMaxs = broadcastRange(meta.quats.maxs, 4);
  const sh0Mins = broadcastRange(meta.sh0.mins, 3);
  const sh0Maxs = broadcastRange(meta.sh0.maxs, 3);
  const opacityMins = broadcastRange(meta.opacities.mins, 1);
  const opacityMaxs = broadcastRange(meta.opacities.maxs, 1);

  const position = new Float32Array(3 * count);
  const scale = new Float32Array(3 * count);
  const rotation = new Float32Array(4 * count);
  const opacity = new Float32Array(count);
  const fDc = new Float32Array(3 * count);

  for (let i = 0; i < count; i++) {
    const src = activeIndices[i];
    const rgba = 4 * src;
    const xyz = 3 * src;

    for (let k = 0; k < 3; k++) {
      const plane = k * count + i;
      position[plane] = signedExpm1(
        lerp(meansMins[k], meansMaxs[k], normObs(meansCombined[xyz + k], meansLo, meansHi)),
      );
      scale[plane] = Math.exp(
        lerp(
          scaleMins[k],
          scaleMaxs[k],
          normObs(planes.scales.data[rgba + k], scaleObserved.lo, scaleObserved.hi),
        ),
      );
      fDc[plane] = lerp(
        sh0Mins[k],
        sh0Maxs[k],
        normObs(planes.sh0.data[rgba + k], sh0Observed.lo, sh0Observed.hi),
      );
    }

    // 格納順は wxyz。xyzw へ並べ替えてから正規化する（KISS-GS側も
    // シーン回転と合成する直前に正規化している）。
    const qw = lerp(quatMins[0], quatMaxs[0], normObs(planes.quats.data[rgba + 0], quatObserved.lo, quatObserved.hi));
    const qx = lerp(quatMins[1], quatMaxs[1], normObs(planes.quats.data[rgba + 1], quatObserved.lo, quatObserved.hi));
    const qy = lerp(quatMins[2], quatMaxs[2], normObs(planes.quats.data[rgba + 2], quatObserved.lo, quatObserved.hi));
    const qz = lerp(quatMins[3], quatMaxs[3], normObs(planes.quats.data[rgba + 3], quatObserved.lo, quatObserved.hi));
    const length = Math.hypot(qx, qy, qz, qw) || 1;
    rotation[i] = qx / length;
    rotation[count + i] = qy / length;
    rotation[2 * count + i] = qz / length;
    rotation[3 * count + i] = qw / length;

    const logit = lerp(
      opacityMins[0],
      opacityMaxs[0],
      normObs(planes.opacities.data[rgba], opacityObserved.lo, opacityObserved.hi),
    );
    opacity[i] = 1 / (1 + Math.exp(-logit));
  }

  let fRest: Float32Array | null = null;
  let shBands: 0 | 1 | 2 | 3 = 0;
  let shCentroidsObserved: { lo: number; hi: number } | null = null;

  if (meta.shN && planes.shCentroids && planes.shLabels) {
    const { palette, perCentroid, observed } = decodeShPalette(meta.shN, planes.shCentroids);
    shCentroidsObserved = observed;
    const centroidSide = meta.shN.centroidSide;
    const centroidCount = centroidSide * centroidSide;
    fRest = new Float32Array(count * perCentroid);
    for (let i = 0; i < count; i++) {
      const rgba = 4 * activeIndices[i];
      // ラベルはコードブックの2次元座標を2チャンネルに割ってある（R=列、G=行）。
      const label = planes.shLabels.data[rgba + 1] * centroidSide + planes.shLabels.data[rgba + 0];
      if (label >= centroidCount) {
        throw new SogXtError("UNSUPPORTED_SH", `f_rest_labels の値 ${label} がコードブックの外です`);
      }
      const base = label * perCentroid;
      for (let slot = 0; slot < perCentroid; slot++) fRest[slot * count + i] = palette[base + slot];
    }
    shBands = shBandsForCoeffs(meta.shN.coeffs);
  }

  return {
    count,
    position,
    scale,
    rotation,
    opacity,
    fDc,
    fRest,
    shBands,
    gridEntries: entries,
    maskedOut: entries - count,
    observed: {
      means: { lo: meansLo, hi: meansHi },
      opacity: opacityObserved,
      scale: scaleObserved,
      quat: quatObserved,
      sh0: sh0Observed,
      shCentroids: shCentroidsObserved,
    },
  };
}

/** SHのDC係数から表示色（0〜1）へ。デバッグ表示とテスト用。 */
export function colorFromDc(dc: number): number {
  return Math.min(1, Math.max(0, 0.5 + SH_C0 * dc));
}
