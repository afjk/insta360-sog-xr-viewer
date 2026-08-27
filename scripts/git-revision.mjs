/**
 * いま動いている（デプロイしようとしている）コミットを一行で表す。
 *
 * `git fetch` しただけで `pull` を忘れると、古いコードのまま probe を走らせたり
 * Worker をデプロイしたりしてしまう。出力からは気づけず、実際に2回それで
 * 往復したので、結果と一緒に必ず出す。
 *
 * 判定できない場合（gitが無い / リポジトリ外 / upstream未設定）は黙って諦める。
 * ここは補助情報であって、これが理由で処理を止めることはしない。
 */
import { execFileSync } from "node:child_process";

const git = (...args) => {
  try {
    return execFileSync("git", args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
};

/** `0e47039 (2 behind upstream — run git pull)` のような一行。 */
export function revisionSummary() {
  const sha = git("rev-parse", "--short", "HEAD");
  if (!sha) return "unknown";
  // upstreamが無いこともあるので、SHAとは別に聞く。最後にfetchした時点との比較。
  const behind = git("rev-list", "--count", "HEAD..@{u}");
  const notes = [
    git("status", "--porcelain") ? "uncommitted changes" : "",
    behind && behind !== "0" ? `${behind} behind upstream — run git pull` : "",
  ]
    .filter(Boolean)
    .join(", ");
  return notes ? `${sha} (${notes})` : sha;
}
