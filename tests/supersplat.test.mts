import assert from "node:assert/strict";
import test from "node:test";
import {
  SUPERSPLAT_ERROR_MESSAGES,
  embeddedJsonBlocks,
  findDownloadControl,
  findSuperSplatContentUrls,
  findSuperSplatViewerUrl,
  isSuperSplatAssetUrl,
  isSuperSplatSceneId,
  parseSuperSplatUrl,
  readSuperSplatDownloadPermission,
  readSuperSplatSceneMeta,
  revisionOf,
  sceneUrlFromSceneId,
  selectSuperSplatAsset,
} from "../app/supersplat.ts";

// テスト対象の実シーン。https://superspl.at/scene/56155c3f
const SCENE_ID = "56155c3f";
const SCENE_URL = `https://superspl.at/scene/${SCENE_ID}`;
const CDN = "https://d1abcxyz0000.cloudfront.net/splats/56155c3f/v3";

const VIEWER_URL = `https://superspl.at/s?id=${SCENE_ID}`;

/**
 * scene page (`/scene/{id}`) を模したfixture。
 *
 * 実際に配信されているSSR HTMLの最小形。2026-08時点で確認した構造:
 *
 *   <head>
 *     <link rel="license" href="https://creativecommons.org/licenses/by/4.0/">
 *   <body>
 *     <div class="flex flex-wrap items-center gap-2">
 *       <button><svg class="lucide lucide-download ..."/>Download</button>
 *       <span title="Attribution">CC BY 4.0</span>
 *     </div>
 *
 * ライセンスはDownloadボタンの中ではなく `<head>` にある。ボタン隣の
 * `<span title="Attribution">` は同じ値の表示用。
 */
function scenePage(options: {
  downloadHtml?: string | null;
  licenseHref?: string | null;
  attributionLabel?: string | null;
  title?: string;
  author?: string;
  extraBody?: string;
} = {}) {
  const {
    licenseHref = "https://creativecommons.org/licenses/by/4.0/",
    attributionLabel = "CC BY 4.0",
    title = "Lion",
    author = "splat-artist",
    extraBody = "",
  } = options;
  const downloadHtml =
    options.downloadHtml === undefined
      ? `<button class="inline-flex items-center gap-1.5">` +
        `<svg class="lucide lucide-download h-4 w-4"></svg>Download</button>`
      : options.downloadHtml;

  return `<!doctype html><html><head>
    <title>${title} | SuperSplat</title>
    <meta property="og:title" content="${title}" />
    <meta name="author" content="${author}" />
    ${licenseHref ? `<link rel="license" href="${licenseHref}">` : ""}
  </head><body>
    <main><h1>${title}</h1>
      <div class="flex flex-wrap items-center gap-2">
        ${downloadHtml ?? ""}
        ${attributionLabel ? `<span class="text-xs" title="Attribution">${attributionLabel}</span>` : ""}
      </div>
      ${extraBody}
    </main>
  </body></html>`;
}

/** 埋め込みJSONに真偽値を持つscene page。第一優先の経路を確かめるためのもの。 */
function sceneWithFlag(downloadable: boolean | null, license = "CC BY 4.0") {
  const scene: Record<string, unknown> = { id: SCENE_ID, title: "Lion", license };
  if (downloadable !== null) scene.downloadable = downloadable;
  return `<!doctype html><html><head><title>Lion | SuperSplat</title>
    <script type="application/json" id="scene-state">${JSON.stringify(scene)}</script>
  </head><body></body></html>`;
}

/**
 * viewer page (`/s?id={id}`) を模したfixture。アセットのURLだけを持つ。
 *
 * `sse-bootstrap` はSuperSplat公式Viewer (`playcanvas/supersplat-viewer` の
 * `src/module/render-html.ts`) が差し込む唯一の口。こちらは実装が公開されて
 * いるぶん確度が高いが、実HTTP応答での確認は同じくできていない。
 */
function viewerPage(contentUrl: string | null = `${CDN}/meta.json`) {
  const bootstrap =
    contentUrl === null ? {} : { contentUrl, contentFilename: contentUrl.split("/").pop() };
  return `<!doctype html><html><head>
    <script type="application/json" id="sse-bootstrap">${JSON.stringify(bootstrap)}</script>
  </head><body><canvas id="canvas"></canvas></body></html>`;
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

// --- scene page: permission ------------------------------------------------

test("reads permission from the real scene page shape", () => {
  // Downloadボタンは <body>、ライセンスは <head> の rel="license"。
  const permission = readSuperSplatDownloadPermission(scenePage());
  assert.equal(permission.downloadable, true);
  assert.deepEqual(permission.license, { code: "CC-BY-4.0", label: "CC BY 4.0" });
  assert.equal(permission.reason, "download-control-with-page-license");
});

test("keeps the specific Creative Commons terms instead of flattening them", () => {
  const cases: [string, string, string][] = [
    ["https://creativecommons.org/licenses/by/4.0/", "CC-BY-4.0", "CC BY 4.0"],
    ["https://creativecommons.org/licenses/by-nc/4.0/", "CC-BY-NC-4.0", "CC BY-NC 4.0"],
    ["https://creativecommons.org/licenses/by-sa/4.0/", "CC-BY-SA-4.0", "CC BY-SA 4.0"],
    ["https://creativecommons.org/licenses/by-nd/4.0/", "CC-BY-ND-4.0", "CC BY-ND 4.0"],
    ["https://creativecommons.org/licenses/by-nc-sa/4.0/", "CC-BY-NC-SA-4.0", "CC BY-NC-SA 4.0"],
    ["https://creativecommons.org/publicdomain/zero/1.0/", "CC0-1.0", "CC0 1.0"],
  ];
  for (const [href, code, label] of cases) {
    const permission = readSuperSplatDownloadPermission(scenePage({ licenseHref: href }));
    assert.deepEqual(permission.license, { code, label }, href);
    assert.equal(permission.downloadable, true, href);
  }
});

test("falls back to the label beside the button when rel=license is absent", () => {
  const permission = readSuperSplatDownloadPermission(
    scenePage({ licenseHref: null, attributionLabel: "CC BY-NC 4.0" }),
  );
  assert.equal(permission.downloadable, true);
  assert.deepEqual(permission.license, { code: "CC-BY-NC-4.0", label: "CC BY-NC 4.0" });
  assert.equal(permission.reason, "download-control-with-license");
});

test("prefers rel=license over the label rendered beside the button", () => {
  // `<head>` の rel="license" がSuperSplat自身の設定値。表示用のラベルより優先。
  const permission = readSuperSplatDownloadPermission(
    scenePage({
      licenseHref: "https://creativecommons.org/licenses/by/4.0/",
      attributionLabel: "CC BY-NC 4.0",
    }),
  );
  assert.deepEqual(permission.license, { code: "CC-BY-4.0", label: "CC BY 4.0" });
});

test("prefers an embedded boolean over the rendered UI", () => {
  const yes = readSuperSplatDownloadPermission(sceneWithFlag(true));
  assert.equal(yes.downloadable, true);
  assert.equal(yes.reason, "downloadable-flag");

  const no = readSuperSplatDownloadPermission(sceneWithFlag(false));
  assert.equal(no.downloadable, false);
  assert.equal(no.reason, "downloadable-flag-false");
});

// --- negative cases: none of these may grant permission --------------------

test("refuses a page that only carries rel=license", () => {
  // ライセンスは設定されているが、配布は許可していない状態。
  const permission = readSuperSplatDownloadPermission(scenePage({ downloadHtml: null }));
  assert.notEqual(permission.downloadable, true);
  assert.equal(permission.reason, "download-control-not-found");
  // ライセンス自体は読めているが、それは許可の根拠にしない。
  assert.deepEqual(permission.license, { code: "CC-BY-4.0", label: "CC BY 4.0" });
});

test("refuses a download control with no license anywhere", () => {
  const permission = readSuperSplatDownloadPermission(
    scenePage({ licenseHref: null, attributionLabel: null }),
  );
  assert.notEqual(permission.downloadable, true);
  assert.equal(permission.reason, "download-control-without-license");
  assert.equal(permission.license, null);
});

test("ignores a CC-BY mention in the author's description", () => {
  // 作者が説明文へ書いた文字列。SuperSplatのライセンス設定とは別物。
  const html = `<!doctype html><html><head><title>Lion | SuperSplat</title></head><body>
    <article><h1>Lion</h1><p># CC-BY - Joanna Kobierska</p></article>
  </body></html>`;
  const permission = readSuperSplatDownloadPermission(html);
  assert.notEqual(permission.downloadable, true);
  assert.equal(permission.reason, "download-control-not-found");
  assert.equal(permission.license, null);
});

test("does not mistake the download-count statistic for a download control", () => {
  // 実ページにはlucideの同じアイコンを使った「27 downloads」という統計がある。
  const stats =
    `<div class="stats"><span class="inline-flex"><svg class="lucide lucide-download h-3 w-3"></svg>` +
    `27 downloads</span></div>`;
  const permission = readSuperSplatDownloadPermission(
    scenePage({ downloadHtml: null, extraBody: stats }),
  );
  assert.notEqual(permission.downloadable, true);
  assert.equal(permission.reason, "download-control-not-found");
  assert.equal(findDownloadControl(stats), null);
  // ボタンに入っていても、テキストが統計なら操作とは読まない。
  assert.equal(
    findDownloadControl(`<button><svg class="lucide lucide-download"></svg>27 downloads</button>`),
    null,
  );
});

test("does not mistake a bundled asset filename for a download control", () => {
  const html = `<html><head>
    <link rel="license" href="https://creativecommons.org/licenses/by/4.0/">
    <script type="module" src="/assets/download-a1b2c3d4.js"></script>
    <link rel="modulepreload" href="/assets/download-a1b2c3d4.js">
  </head><body><div id="root"></div></body></html>`;
  const permission = readSuperSplatDownloadPermission(html);
  assert.notEqual(permission.downloadable, true);
  assert.equal(permission.reason, "download-control-not-found");
});

test("does not treat the word Download in prose as permission", () => {
  for (const body of [
    "<p>You can Download this splat from the author's site.</p>",
    "<h2>Download</h2><p>Coming soon</p>",
    `<a href="/about">Read about Download options</a>`,
  ]) {
    const html = `<html><head><title>x</title></head><body>${body}</body></html>`;
    const permission = readSuperSplatDownloadPermission(html);
    assert.notEqual(permission.downloadable, true, body.slice(0, 40));
  }
});

test("survives a malformed scene page without throwing", () => {
  for (const html of [
    "",
    "<html",
    "<html><body>not a scene page</body></html>",
    '<script type="application/json" id="scene-state">{not json</script>',
    "<a download>",
    "<button>Download",
  ]) {
    const permission = readSuperSplatDownloadPermission(html);
    assert.notEqual(permission.downloadable, true, html.slice(0, 24));
  }
});

// --- scene page: attribution -----------------------------------------------

test("reads title and author for display", () => {
  const meta = readSuperSplatSceneMeta(scenePage());
  assert.equal(meta.title, "Lion");
  assert.equal(meta.author, "splat-artist");
});

test("drops the site name that the document title carries", () => {
  assert.equal(readSuperSplatSceneMeta("<html><head><title>Lion | SuperSplat</title></head></html>").title, "Lion");
});

test("reads structured blocks without executing the page", () => {
  const blocks = embeddedJsonBlocks(viewerPage());
  assert.ok(blocks.some((block) => (block as { contentUrl?: string }).contentUrl));
});

// --- viewer page -----------------------------------------------------------

test("uses the canonical viewer URL for a scene", () => {
  assert.equal(findSuperSplatViewerUrl(scenePage(), SCENE_ID), VIEWER_URL);
});

test("prefers a viewer URL the scene page itself points at", () => {
  const html = `<html><body><iframe src="/s?id=${SCENE_ID}&amp;embed=1"></iframe></body></html>`;
  const found = findSuperSplatViewerUrl(html, SCENE_ID);
  assert.equal(new URL(found ?? "").searchParams.get("id"), SCENE_ID);
  assert.equal(new URL(found ?? "").hostname, "superspl.at");
});

test("ignores a viewer URL pointing off-site or at another scene", () => {
  for (const html of [
    `<html><body><iframe src="https://evil.example/s?id=${SCENE_ID}"></iframe></body></html>`,
    `<html><body><iframe src="/s?id=deadbeef"></iframe></body></html>`,
    `<html><body><iframe src="http://superspl.at/s?id=${SCENE_ID}"></iframe></body></html>`,
  ]) {
    // 採らずに canonical へ落ちる。ページに書いてあった任意のURLは追わない。
    assert.equal(findSuperSplatViewerUrl(html, SCENE_ID), VIEWER_URL, html.slice(0, 50));
  }
});

test("refuses to build a viewer URL from an unsafe scene ID", () => {
  for (const bad of ["../../admin", "a/b", "", "a".repeat(65)]) {
    assert.equal(findSuperSplatViewerUrl(scenePage(), bad), null, bad);
  }
});

test("takes the content URL the viewer page publishes", () => {
  assert.deepEqual(findSuperSplatContentUrls(viewerPage(), VIEWER_URL), [`${CDN}/meta.json`]);
});

test("also reads the older inline contentUrl assignment", () => {
  const page = `<html><head><script>
    const contentUrl = '${CDN}/meta.json';
  </script></head></html>`;
  assert.deepEqual(findSuperSplatContentUrls(page, VIEWER_URL), [`${CDN}/meta.json`]);
});

test("resolves a relative content URL against the viewer page URL", () => {
  const page = viewerPage("./v3/meta.json");
  const resolved = findSuperSplatContentUrls(page, "https://superspl.at/s/56155c3f/index.html");
  assert.deepEqual(resolved, ["https://superspl.at/s/56155c3f/v3/meta.json"]);
});

test("reports no content URL when the viewer page has none", () => {
  assert.deepEqual(findSuperSplatContentUrls(viewerPage(null), VIEWER_URL), []);
});

// --- asset selection -------------------------------------------------------

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
