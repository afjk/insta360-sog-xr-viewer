/**
 * デプロイ直前に、どのコミットを配ろうとしているかを出す。
 *
 * `package.json` の `preresolver:deploy` から自動で走る。止めはしない——
 * 意図して古い版へ戻したい場合もあるので、判断は人に委ねる。
 */
import { revisionSummary } from "./git-revision.mjs";

console.log(`deploying revision: ${revisionSummary()}`);
