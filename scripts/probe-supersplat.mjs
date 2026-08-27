/**
 * 実際のSuperSplat公開シーンに対してresolverの解析を通すsmoke test。
 *
 * 外部サービスに依存するので通常の `npm test` には含めない。SuperSplat側の
 * ページ構造が変わったときに、どの段階で読めなくなったかを切り分けるための道具。
 *
 *   npm run probe:supersplat                 # 既定のシーン (Lion) を見る
 *   node scripts/probe-supersplat.mjs 56155c3f
 *   node scripts/probe-supersplat.mjs 56155c3f --dump ./tmp
 *
 * `--dump <dir>` を付けると、scene page と viewer page の**生HTML**をそのまま
 * 保存する。ブラウザのDOMではなくserver-side fetchで実際に返ってくる中身が
 * 手に入るので、parserを実構造へ合わせるときはこれを基準にすること。
 */
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  findSuperSplatContentUrls,
  findSuperSplatViewerUrl,
  parseSuperSplatUrl,
  readSuperSplatDownloadPermission,
  readSuperSplatSceneMeta,
  selectSuperSplatAsset,
} from "../app/supersplat.ts";

// テスト対象の実シーン。作者がDownloadableを有効にしている公開シーン。
const DEFAULT_SCENE_ID = "56155c3f";

const PAGE_HEADERS = {
  "user-agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
  accept: "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8",
  "accept-language": "ja,en;q=0.8",
};

const args = process.argv.slice(2);
const dumpIndex = args.indexOf("--dump");
const dumpDir = dumpIndex >= 0 ? args[dumpIndex + 1] : null;
const sceneId = args.find((arg) => !arg.startsWith("--") && arg !== dumpDir) ?? DEFAULT_SCENE_ID;

const share = parseSuperSplatUrl(`https://superspl.at/scene/${sceneId}`);
if (!share) {
  console.error(`invalid scene id: ${sceneId}`);
  process.exit(2);
}

/** ページを取り、必要なら生HTMLを保存する。 */
const fetchPage = async (url, name) => {
  const response = await fetch(url, { headers: PAGE_HEADERS, redirect: "follow" });
  const html = await response.text();
  console.log(`  ${name}: HTTP ${response.status}  final=${response.url}  ${html.length} bytes`);
  if (dumpDir) {
    const path = resolve(dumpDir, `${name}-${sceneId}.html`);
    await mkdir(resolve(dumpDir), { recursive: true });
    await writeFile(path, html);
    console.log(`  ${name}: dumped -> ${path}`);
  }
  if (!response.ok) throw new Error(`${name} returned HTTP ${response.status}`);
  return { html, finalUrl: response.url || url };
};

const fail = (message) => {
  console.error(`\nFAILED: ${message}`);
  if (!dumpDir) {
    console.error("Re-run with --dump <dir> to capture the raw HTML for both pages.");
  }
  process.exit(1);
};

console.log(`probing ${share.sceneUrl}\n`);

// 1. scene page —— 許可・ライセンス・帰属
console.log("scene page");
const scene = await fetchPage(share.sceneUrl, "scene");
const permission = readSuperSplatDownloadPermission(scene.html);
const meta = readSuperSplatSceneMeta(scene.html);
console.log(`  permission reason: ${permission.reason}`);

if (permission.downloadable !== true) {
  console.log("");
  console.log(`sceneId:      ${share.sceneId}`);
  console.log(`downloadable: ${permission.downloadable}`);
  fail(
    `resolver would answer 403 SUPERSPLAT_NOT_DOWNLOADABLE (reason: ${permission.reason}). ` +
      "If the page really does offer a download, the parser needs updating.",
  );
}
if (!permission.license) {
  fail("resolver would answer 422 SUPERSPLAT_LICENSE_NOT_FOUND");
}

// 2. viewer page —— アセット。許可を確認したあとにしか取りに行かない。
console.log("\nviewer page");
const viewerUrl = findSuperSplatViewerUrl(scene.html, share.sceneId);
const viewer = await fetchPage(viewerUrl, "viewer");
const contentUrls = findSuperSplatContentUrls(viewer.html, viewer.finalUrl);
console.log(`  contentUrl candidates: ${contentUrls.length}`);
for (const url of contentUrls) console.log(`    - ${url}`);

const asset = selectSuperSplatAsset(contentUrls);
if (!asset) fail("resolver would answer 422 SUPERSPLAT_ASSET_NOT_FOUND");

console.log("");
console.log(`sceneId:      ${share.sceneId}`);
console.log(`title:        ${meta.title || "(none)"}`);
console.log(`author:       ${meta.author || "(none)"}`);
console.log(`downloadable: true`);
console.log(`license:      ${permission.license.label} (${permission.license.code})`);
console.log(`format:       ${asset.format}`);
console.log(`revision:     ${asset.revision ?? "(none)"}`);
console.log(`assetUrl:     ${asset.url}`);
