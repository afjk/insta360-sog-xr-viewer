import assert from "node:assert/strict";
import test from "node:test";
import {
  SUPERSPLAT_ERROR_MESSAGES,
  embeddedJsonBlocks,
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
 * scene page (`/scene/{id}`) を模したfixture。許可・ライセンス・帰属を持つ。
 *
 * **実ページのHTMLそのものではない。** このfixtureを書いた環境からは
 * `superspl.at` へ到達できず（egress遮断）、実際のHTTP応答を確認できていない。
 * ここで再現しているのはparserが解釈できる「形」であって、SuperSplatが本当に
 * この形で配っている確証はない。実構造は `npm run probe:supersplat -- --dump`
 * で採取し、判明し次第このfixtureを実物へ置き換えること。
 *
 * 既定はDownload UI経由（ダウンロード操作とライセンスが同じ要素にある形）。
 * 埋め込みJSONのbooleanを持つページは `sceneWithFlag()` で別に用意する。
 */
function scenePage(options: {
  downloadHtml?: string | null;
  licenseLabel?: string;
  title?: string;
  author?: string;
} = {}) {
  const {
    licenseLabel = "CC BY 4.0",
    title = "Lion",
    author = "splat-artist",
  } = options;
  const downloadHtml =
    options.downloadHtml === undefined
      ? `<a class="download" href="/api/splats/${SCENE_ID}/download" download>` +
        `Download<span class="license">${licenseLabel}</span></a>`
      : options.downloadHtml;

  return `<!doctype html><html><head>
    <title>${title} | SuperSplat</title>
    <meta property="og:title" content="${title}" />
    <meta name="author" content="${author}" />
  </head><body>
    <main><h1>${title}</h1>${downloadHtml ?? ""}</main>
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

test("reads permission from the download control and its license", () => {
  const permission = readSuperSplatDownloadPermission(scenePage());
  assert.equal(permission.downloadable, true);
  assert.deepEqual(permission.license, { code: "CC-BY-4.0", label: "CC BY 4.0" });
  assert.equal(permission.reason, "download-control-with-license");
});

test("keeps the specific Creative Commons terms instead of flattening them", () => {
  const cases: [string, string, string][] = [
    ["CC BY 4.0", "CC-BY-4.0", "CC BY 4.0"],
    ["CC BY-NC 4.0", "CC-BY-NC-4.0", "CC BY-NC 4.0"],
    ["CC BY-SA 4.0", "CC-BY-SA-4.0", "CC BY-SA 4.0"],
    ["CC BY-ND 4.0", "CC-BY-ND-4.0", "CC BY-ND 4.0"],
    ["CC BY-NC-SA 4.0", "CC-BY-NC-SA-4.0", "CC BY-NC-SA 4.0"],
    ["CC0 1.0", "CC0-1.0", "CC0 1.0"],
  ];
  for (const [label, code, expected] of cases) {
    const permission = readSuperSplatDownloadPermission(scenePage({ licenseLabel: label }));
    assert.deepEqual(permission.license, { code, label: expected }, label);
    assert.equal(permission.downloadable, true, label);
  }
});

test("reads a Creative Commons link inside the download control", () => {
  const html = scenePage({
    downloadHtml:
      `<a class="download" href="/api/splats/${SCENE_ID}/download" download>Download` +
      `<a rel="license" href="https://creativecommons.org/licenses/by-nc/4.0/">CC BY-NC 4.0</a></a>`,
  });
  const permission = readSuperSplatDownloadPermission(html);
  assert.equal(permission.downloadable, true);
  assert.deepEqual(permission.license, { code: "CC-BY-NC-4.0", label: "CC BY-NC 4.0" });
});

test("prefers an embedded boolean over the rendered UI", () => {
  // 真偽値が読めるなら、それが一番強い根拠。UIの形に左右されない。
  const yes = readSuperSplatDownloadPermission(sceneWithFlag(true));
  assert.equal(yes.downloadable, true);
  assert.equal(yes.reason, "downloadable-flag");

  const no = readSuperSplatDownloadPermission(sceneWithFlag(false));
  assert.equal(no.downloadable, false);
  assert.equal(no.reason, "downloadable-flag-false");
});

test("refuses a scene with no download control at all", () => {
  const permission = readSuperSplatDownloadPermission(scenePage({ downloadHtml: null }));
  assert.equal(permission.downloadable, null);
  assert.equal(permission.reason, "download-control-not-found");
});

test("refuses a download control that carries no license", () => {
  const html = scenePage({
    downloadHtml: `<a class="download" href="/api/splats/${SCENE_ID}/download" download>Download</a>`,
  });
  const permission = readSuperSplatDownloadPermission(html);
  assert.equal(permission.downloadable, null);
  assert.equal(permission.reason, "download-control-without-license");
});

test("does not treat the word Download in prose as permission", () => {
  // ここが今回の肝。文字列一致だけでtrueにしない。
  for (const html of [
    "<html><body><p>You can Download this splat from the author's site.</p></body></html>",
    "<html><body><h2>Download</h2><p>Coming soon</p></body></html>",
    `<html><body><a href="/about">Read about Download options</a></body></html>`,
  ]) {
    const permission = readSuperSplatDownloadPermission(html);
    assert.notEqual(permission.downloadable, true, html.slice(0, 40));
  }
});

test("does not treat a bare CC label as permission", () => {
  // ライセンス表記があっても、配布が許可されているとは限らない。
  const html = `<html><head>
    <link rel="license" href="https://creativecommons.org/licenses/by/4.0/" />
  </head><body><p>CC BY 4.0</p></body></html>`;
  const permission = readSuperSplatDownloadPermission(html);
  assert.notEqual(permission.downloadable, true);
  // ライセンス自体は読めているが、それは許可の根拠にはしない。
  assert.deepEqual(permission.license, { code: "CC-BY-4.0", label: "CC BY 4.0" });
});

test("survives a malformed scene page without throwing", () => {
  for (const html of [
    "",
    "<html",
    "<html><body>not a scene page</body></html>",
    '<script type="application/json" id="scene-state">{not json</script>',
    "<a download>",
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
