import assert from "node:assert/strict";
import test from "node:test";
import {
  SUPERSPLAT_ERROR_MESSAGES,
  embeddedJsonBlocks,
  findSuperSplatContentUrls,
  isSuperSplatAssetUrl,
  isSuperSplatSceneId,
  parseSuperSplatUrl,
  readSuperSplatSceneMeta,
  revisionOf,
  sceneUrlFromSceneId,
  selectSuperSplatAsset,
} from "../app/supersplat.ts";

// テスト対象の実シーン。https://superspl.at/scene/56155c3f
const SCENE_ID = "56155c3f";
const SCENE_URL = `https://superspl.at/scene/${SCENE_ID}`;
const CDN = "https://d1abcxyz0000.cloudfront.net/splats/56155c3f/v3";

/**
 * 公開ページの形を模したfixture。
 *
 * 実ページのHTMLそのものではなく、SuperSplat側が機械可読な形で置いている
 * ものだけを写している。SuperSplat公式Viewer (`playcanvas/supersplat-viewer`)
 * が差し込む `sse-bootstrap` と、`rel="license"` の機械可読ライセンスリンク。
 * このテストは実ページへは一切アクセスしない。
 */
function scenePage(options: {
  downloadable?: boolean | null;
  licenseHref?: string | null;
  licenseCode?: string | null;
  contentUrl?: string | null;
  title?: string;
  author?: string;
} = {}) {
  const {
    downloadable = true,
    licenseHref = "https://creativecommons.org/licenses/by/4.0/",
    licenseCode = null,
    contentUrl = `${CDN}/meta.json`,
    title = "Lion",
    author = "splat-artist",
  } = options;

  const scene: Record<string, unknown> = { id: SCENE_ID, title, author };
  if (downloadable !== null) scene.downloadable = downloadable;
  if (licenseCode !== null) scene.license = licenseCode;

  const bootstrap = contentUrl === null ? {} : { contentUrl, contentFilename: "meta.json" };

  return `<!doctype html><html><head>
    <title>${title} | SuperSplat</title>
    <meta property="og:title" content="${title}" />
    ${licenseHref ? `<link rel="license" href="${licenseHref}" />` : ""}
    <script type="application/json" id="sse-bootstrap">${JSON.stringify(bootstrap)}</script>
    <script>window.__SCENE__ = ${JSON.stringify(scene)};</script>
  </head><body><div id="app"></div></body></html>`;
}

// --- URL parser ------------------------------------------------------------

test("parses both public SuperSplat scene URL forms", () => {
  assert.deepEqual(parseSuperSplatUrl(SCENE_URL), { sceneId: SCENE_ID, sceneUrl: SCENE_URL });
  assert.deepEqual(parseSuperSplatUrl(`https://superspl.at/s?id=${SCENE_ID}`), {
    sceneId: SCENE_ID,
    sceneUrl: SCENE_URL,
  });
});

test("normalises every accepted form to the canonical scene URL", () => {
  for (const input of [
    SCENE_URL,
    `${SCENE_URL}/`,
    `${SCENE_URL}?utm_source=x`,
    `superspl.at/scene/${SCENE_ID}`,
    `https://superspl.at/s?id=${SCENE_ID}&foo=bar`,
    `  ${SCENE_URL}  `,
  ]) {
    assert.equal(parseSuperSplatUrl(input)?.sceneUrl, SCENE_URL, input);
  }
});

test("accepts only the superspl.at host", () => {
  for (const bad of [
    `https://example.com/scene/${SCENE_ID}`,
    `https://superspl.at.evil.example/scene/${SCENE_ID}`,
    // サブドメインも通さない。厳密に superspl.at のみ。
    `https://www.superspl.at/scene/${SCENE_ID}`,
    `https://cdn.superspl.at/scene/${SCENE_ID}`,
  ]) {
    assert.equal(parseSuperSplatUrl(bad), null, bad);
  }
});

test("rejects malformed input and non-http schemes", () => {
  for (const bad of [
    "",
    "   ",
    "javascript:alert(1)",
    "not a url at all",
    "https://superspl.at/",
    "https://superspl.at/scene/",
    "https://superspl.at/editor",
    "https://superspl.at/s",
    "https://superspl.at/s?id=",
  ]) {
    assert.equal(parseSuperSplatUrl(bad), null, JSON.stringify(bad));
  }
});

test("keeps path traversal and separators out of the scene ID", () => {
  for (const bad of [
    "https://superspl.at/scene/..%2f..%2fadmin",
    "https://superspl.at/scene/a%2Fb",
    "https://superspl.at/scene/a.b",
    "https://superspl.at/scene/a:b",
    "https://superspl.at/scene/a%5Cb",
    `https://superspl.at/s?id=${encodeURIComponent("../../etc/passwd")}`,
    `https://superspl.at/s?id=${encodeURIComponent("a/b")}`,
  ]) {
    assert.equal(parseSuperSplatUrl(bad), null, bad);
  }
  // `..` はURL正規化で畳まれるので、そもそも /scene/ に残らない。
  assert.equal(parseSuperSplatUrl("https://superspl.at/scene/../admin"), null);
});

test("round-trips a scene ID through the canonical page URL", () => {
  assert.ok(isSuperSplatSceneId(SCENE_ID));
  assert.equal(parseSuperSplatUrl(sceneUrlFromSceneId(SCENE_ID) ?? "")?.sceneId, SCENE_ID);
});

// --- asset host allow list -------------------------------------------------

test("only fetches assets from the expected public hosts", () => {
  assert.ok(isSuperSplatAssetUrl(`${CDN}/meta.json`));
  assert.ok(isSuperSplatAssetUrl("https://superspl.at/assets/scene.sog"));
  for (const bad of [
    "https://evil.example/meta.json",
    "http://localhost:8080/meta.json",
    "https://127.0.0.1/meta.json",
    "https://169.254.169.254/latest/meta-data/",
    "https://10.0.0.5/meta.json",
    "https://192.168.1.1/meta.json",
    "https://[::1]/meta.json",
    "https://cloudfront.net.evil.example/meta.json",
  ]) {
    assert.equal(isSuperSplatAssetUrl(bad), false, bad);
  }
});

// --- page parser -----------------------------------------------------------

test("reads a downloadable scene licensed CC BY", () => {
  const meta = readSuperSplatSceneMeta(scenePage());
  assert.equal(meta.downloadable, true);
  assert.deepEqual(meta.license, { code: "CC-BY-4.0", label: "CC BY 4.0" });
  assert.equal(meta.title, "Lion");
  assert.equal(meta.author, "splat-artist");
});

test("keeps the specific Creative Commons terms instead of flattening them", () => {
  const cases: [string, string, string][] = [
    ["https://creativecommons.org/licenses/by-nc/4.0/", "CC-BY-NC-4.0", "CC BY-NC 4.0"],
    ["https://creativecommons.org/licenses/by-sa/4.0/", "CC-BY-SA-4.0", "CC BY-SA 4.0"],
    ["https://creativecommons.org/licenses/by-nd/4.0/", "CC-BY-ND-4.0", "CC BY-ND 4.0"],
    ["https://creativecommons.org/licenses/by-nc-sa/4.0/", "CC-BY-NC-SA-4.0", "CC BY-NC-SA 4.0"],
    ["https://creativecommons.org/licenses/by-nc-nd/4.0/", "CC-BY-NC-ND-4.0", "CC BY-NC-ND 4.0"],
    ["https://creativecommons.org/publicdomain/zero/1.0/", "CC0-1.0", "CC0 1.0"],
  ];
  for (const [href, code, label] of cases) {
    const meta = readSuperSplatSceneMeta(scenePage({ licenseHref: href }));
    assert.deepEqual(meta.license, { code, label }, href);
  }
});

test("reads a license given as a code in the embedded scene data", () => {
  const meta = readSuperSplatSceneMeta(
    scenePage({ licenseHref: null, licenseCode: "CC BY-NC 4.0" }),
  );
  assert.deepEqual(meta.license, { code: "CC-BY-NC-4.0", label: "CC BY-NC 4.0" });
});

test("reports a scene the author has not made downloadable", () => {
  const meta = readSuperSplatSceneMeta(scenePage({ downloadable: false }));
  assert.equal(meta.downloadable, false);
});

test("reports downloadable as unknown when the page says nothing", () => {
  // 「分からない」は `false` と区別して持つ。読み込まない点は同じ。
  const meta = readSuperSplatSceneMeta(scenePage({ downloadable: null }));
  assert.equal(meta.downloadable, null);
});

test("does not treat the word Download in the markup as permission", () => {
  const page = `<!doctype html><html><body>
    <button>Download</button><a href="/download">Download this splat</a>
  </body></html>`;
  assert.equal(readSuperSplatSceneMeta(page).downloadable, null);
});

test("reports a missing license instead of guessing one", () => {
  const meta = readSuperSplatSceneMeta(scenePage({ licenseHref: null }));
  assert.equal(meta.downloadable, true);
  assert.equal(meta.license, null);
});

test("survives a malformed page without throwing", () => {
  for (const page of [
    "",
    "<html",
    "<html><body>not a scene page</body></html>",
    '<script type="application/json" id="sse-bootstrap">{not json</script>',
    "<script>window.__SCENE__ = {broken</script>",
  ]) {
    const meta = readSuperSplatSceneMeta(page);
    assert.equal(meta.downloadable, null, page.slice(0, 24));
    assert.equal(meta.license, null, page.slice(0, 24));
  }
});

test("reads structured blocks without executing the page", () => {
  const blocks = embeddedJsonBlocks(scenePage());
  assert.ok(blocks.some((block) => (block as { contentUrl?: string }).contentUrl));
  assert.ok(blocks.some((block) => (block as { title?: string }).title === "Lion"));
});

// --- asset discovery -------------------------------------------------------

test("takes the content URL the page publishes", () => {
  const urls = findSuperSplatContentUrls(scenePage(), SCENE_URL);
  assert.deepEqual(urls, [`${CDN}/meta.json`]);
});

test("also reads the older inline contentUrl assignment", () => {
  const page = `<html><head><script>
    const contentUrl = '${CDN}/meta.json';
  </script></head></html>`;
  assert.deepEqual(findSuperSplatContentUrls(page, SCENE_URL), [`${CDN}/meta.json`]);
});

test("selects unbundled SOG when that is what the page serves", () => {
  const asset = selectSuperSplatAsset([`${CDN}/meta.json`]);
  assert.deepEqual(asset, { format: "sog-meta", url: `${CDN}/meta.json`, revision: "v3" });
});

test("prefers a bundled .sog over an unbundled meta.json", () => {
  const asset = selectSuperSplatAsset([`${CDN}/meta.json`, `${CDN}/scene.sog`]);
  assert.equal(asset?.format, "sog");
  assert.equal(asset?.url, `${CDN}/scene.sog`);
});

test("flags streamed SOG as its own format rather than guessing", () => {
  const asset = selectSuperSplatAsset([`${CDN}/lod-meta.json`]);
  assert.deepEqual(asset, {
    format: "streamed-sog",
    url: `${CDN}/lod-meta.json`,
    revision: "v3",
  });
});

test("prefers a directly loadable asset over the streamed one", () => {
  const asset = selectSuperSplatAsset([`${CDN}/lod-meta.json`, `${CDN}/meta.json`]);
  assert.equal(asset?.format, "sog-meta");
});

test("drops asset URLs pointing at hosts we do not fetch from", () => {
  assert.equal(selectSuperSplatAsset(["https://evil.example/meta.json"]), null);
  assert.equal(selectSuperSplatAsset(["http://127.0.0.1/meta.json"]), null);
  // 許可ホストでも、読めない形式なら選ばない。
  assert.equal(selectSuperSplatAsset([`${CDN}/scene.ply`]), null);
  assert.equal(selectSuperSplatAsset([]), null);
});

test("reads the delivery revision out of the content URL", () => {
  assert.equal(revisionOf(`${CDN}/meta.json`), "v3");
  assert.equal(revisionOf("https://d1.cloudfront.net/splats/56155c3f/v12/scene.sog"), "v12");
  assert.equal(revisionOf("https://d1.cloudfront.net/splats/56155c3f/meta.json"), null);
  assert.equal(revisionOf("not a url"), null);
});

test("never builds a CDN URL of its own", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(new URL("../app/supersplat.ts", import.meta.url), "utf8");
  // リビジョン探索も含め、当て推量でURLを組み立てる処理は持たない。
  assert.doesNotMatch(source, /https:\/\/[a-z0-9]+\.cloudfront\.net/i);
  assert.doesNotMatch(source, /\$\{[^}]*revision[^}]*\}/i);
});

test("separates internal error codes from the Japanese wording", () => {
  assert.match(
    SUPERSPLAT_ERROR_MESSAGES.SUPERSPLAT_NOT_DOWNLOADABLE,
    /ダウンロードが許可されていない/,
  );
  assert.match(
    SUPERSPLAT_ERROR_MESSAGES.SUPERSPLAT_STREAMED_SOG_UNSUPPORTED,
    /ストリーミング形式/,
  );
});
