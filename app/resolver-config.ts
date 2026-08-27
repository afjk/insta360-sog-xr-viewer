/**
 * 共有URL／シーンURLを解決するエンドポイントの場所を、ビルド時に決める。
 *
 * Insta360の共有ページもSuperSplatの公開ページもCORSを許可していないので、
 * 解決はサーバー側でしかできない。どこにそのサーバーがあるかは配信先によって
 * 違うため、コードに直接書かず `VITE_SOG_RESOLVER_ORIGIN` で渡す。
 *
 * - 未設定 … 同一オリジンの `/api/...` を使う（Cloudflare Worker版）
 * - `"none"` … 解決エンドポイントを持たない配信。共有URLの入力を無効化する
 * - URL … そのオリジンの `/api/...` を使う（専用Workerなど）
 *
 * オリジンは1つで、その下に提供元ごとのパスがぶら下がる。
 *
 *   <resolver origin>
 *     ├─ /api/insta360
 *     └─ /api/supersplat
 *
 * GitHub Pagesのような静的配信には `/api` が無いため、`vite.pages.config.ts`
 * が既定で `"none"` を入れる。専用Workerを用意したら
 * `VITE_SOG_RESOLVER_ORIGIN=<そのWorkerのオリジン>` を渡してビルドする。
 */

/** 解決エンドポイントを持たない配信であることを示す値。 */
export const RESOLVER_DISABLED = "none";

/** 解決エンドポイントを持つ提供元。 */
export type ResolverProvider = "insta360" | "supersplat";

/** 提供元ごとのパス。オリジンに繋いでエンドポイントにする。 */
export const RESOLVER_PATHS: Record<ResolverProvider, string> = {
  insta360: "/api/insta360",
  supersplat: "/api/supersplat",
};

export type ResolverConfig =
  | { available: true; origin: string; endpoints: Record<ResolverProvider, string> }
  | { available: false; reason: string };

const UNAVAILABLE_REASON =
  "この配信にはInsta360共有URL・SuperSplatシーンURLを解決するエンドポイントがありません。SOGファイルを直接ドロップするか、.sog のURLを指定してください。";

// Viteの `define` が差し込む。差し込まれていないビルドでは未定義のままなので、
// `typeof` で触る（未宣言の識別子でも例外にならない）。
declare const __SOG_RESOLVER_ORIGIN__: string | undefined;

/** ビルド時に差し込まれた設定値。テストしやすいよう解釈は分けてある。 */
export function readResolverOriginSetting(): string {
  return typeof __SOG_RESOLVER_ORIGIN__ === "string" ? __SOG_RESOLVER_ORIGIN__.trim() : "";
}

export function resolverConfigFor(setting: string): ResolverConfig {
  const trimmed = setting.trim();
  if (trimmed === RESOLVER_DISABLED) return { available: false, reason: UNAVAILABLE_REASON };
  const origin = trimmed.replace(/\/+$/, "");
  return {
    available: true,
    origin,
    endpoints: {
      insta360: `${origin}${RESOLVER_PATHS.insta360}`,
      supersplat: `${origin}${RESOLVER_PATHS.supersplat}`,
    },
  };
}

export function resolverConfig(): ResolverConfig {
  return resolverConfigFor(readResolverOriginSetting());
}
