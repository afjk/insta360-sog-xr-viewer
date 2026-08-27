import assert from "node:assert/strict";
import test from "node:test";

const SCENE_ID = "56155c3f";
const SCENE_URL = `https://superspl.at/scene/${SCENE_ID}`;
const VIEWER_URL = `https://superspl.at/s?id=${SCENE_ID}`;
const CDN = "https://d1abcxyz0000.cloudfront.net/splats/56155c3f/v3";
const META_URL = `${CDN}/meta.json`;

/**
 * scene page を模したfixture。`tests/supersplat.test.mts` と同じ形。
 *
 * **実ページのHTMLそのものではない。** 作業環境から `superspl.at` へ到達できず
 * 実HTTP応答を確認できていないため、parserが解釈できる形の再現に留まる。
 * 実構造は `npm run probe:supersplat -- --dump <dir>` で採取できる。
 */
function scenePageHtml({
  downloadHtml = `<a class="download" href="/api/splats/${SCENE_ID}/download" download>` +
    `Download<span class="license">CC BY 4.0</span></a>`,
  title = "Lion",
  author = "splat-artist",
} = {}) {
  return `<!doctype html><html><head>
    <title>${title} | SuperSplat</title>
    <meta name="author" content="${author}" />
  </head><body><main>${downloadHtml ?? ""}</main></body></html>`;
}

/** viewer page を模したfixture。アセットのURLだけを持つ。 */
function viewerPageHtml({ contentUrl = META_URL } = {}) {
  const bootstrap =
    contentUrl === null ? {} : { contentUrl, contentFilename: contentUrl.split("/").pop() };
  return `<!doctype html><html><head>
    <script type="application/json" id="sse-bootstrap">${JSON.stringify(bootstrap)}</script>
  </head><body></body></html>`;
}

/** scene page / viewer page / CDN を差し替えて、Workerのルートだけを検証する。 */
function stubSuperSplat(overrides = {}) {
  const original = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = typeof input === "string" ? input : input.url;
    overrides.record?.push(url);
    if (url.startsWith(SCENE_URL)) {
      return (
        overrides.scenePage?.() ??
        new Response(scenePageHtml(overrides.scene), {
          status: 200,
          headers: { "content-type": "text/html" },
        })
      );
    }
    // scene pageを先に判定していること。`/scene/…` も "…/s" 前方一致する。
    if (url.startsWith("https://superspl.at/s?id=")) {
      return (
        overrides.viewerPage?.() ??
        new Response(viewerPageHtml(overrides.viewer), {
          status: 200,
          headers: { "content-type": "text/html" },
        })
      );
    }
    return new Response("not found", { status: 404 });
  };
  return () => {
    globalThis.fetch = original;
  };
}

async function callRoute(query) {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}-${Math.random()}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request(`http://localhost/api/supersplat?${query}`),
    { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } },
    { waitUntil() {}, passThroughOnException() {} },
  );
}

test("resolves a downloadable scene through scene page then viewer page", async () => {
  const seen = [];
  const restore = stubSuperSplat({ record: seen });
  try {
    const response = await callRoute(`url=${encodeURIComponent(SCENE_URL)}`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("access-control-allow-origin"), "*");
    assert.deepEqual(await response.json(), {
      provider: "supersplat",
      sceneId: SCENE_ID,
      pageUrl: SCENE_URL,
      title: "Lion",
      author: "splat-artist",
      downloadable: true,
      license: { code: "CC-BY-4.0", label: "CC BY 4.0" },
      asset: { format: "sog-meta", url: META_URL, revision: "v3" },
    });
    // 処理順の固定: scene page → viewer page。この2件だけ。
    assert.deepEqual(seen, [SCENE_URL, VIEWER_URL]);
  } finally {
    restore();
  }
});

test("never touches the viewer page when the scene is not downloadable", async () => {
  const seen = [];
  const restore = stubSuperSplat({ record: seen, scene: { downloadHtml: null } });
  try {
    const response = await callRoute(`url=${encodeURIComponent(SCENE_URL)}`);
    assert.equal(response.status, 403);
    const body = await response.json();
    assert.equal(body.code, "SUPERSPLAT_NOT_DOWNLOADABLE");
    assert.match(body.error, /ダウンロードが許可されていない/);
    // ここが肝心。許可を確認できなければscene pageの1件で終わる。
    assert.deepEqual(seen, [SCENE_URL]);
    // `/scene/...` も "…/s" で始まるので、viewer pageは `?id=` 付きで見分ける。
    assert.ok(!seen.some((url) => url.startsWith("https://superspl.at/s?id=")));
    assert.ok(!seen.some((url) => url.includes("cloudfront")));
  } finally {
    restore();
  }
});

test("never touches the viewer page when the license cannot be read", async () => {
  const seen = [];
  const restore = stubSuperSplat({
    record: seen,
    // ダウンロード操作はあるが、ライセンスが併記されていない。
    scene: {
      downloadHtml: `<a class="download" href="/api/splats/${SCENE_ID}/download" download>Download</a>`,
    },
  });
  try {
    const response = await callRoute(`url=${encodeURIComponent(SCENE_URL)}`);
    // ライセンス不明のまま許可とは見なさないので、まず403で止まる。
    assert.equal(response.status, 403);
    assert.deepEqual(seen, [SCENE_URL]);
  } finally {
    restore();
  }
});

test("reports a missing license apart from a missing permission", async () => {
  const seen = [];
  const restore = stubSuperSplat({
    record: seen,
    // 埋め込みの真偽値でDownloadableだけが確定し、ライセンスは無い。
    scenePage: () =>
      new Response(
        `<html><head><script type="application/json" id="s">{"downloadable":true}</script></head><body></body></html>`,
        { status: 200, headers: { "content-type": "text/html" } },
      ),
  });
  try {
    const response = await callRoute(`url=${encodeURIComponent(SCENE_URL)}`);
    assert.equal(response.status, 422);
    assert.equal((await response.json()).code, "SUPERSPLAT_LICENSE_NOT_FOUND");
    // ライセンスが読めない時点で止まるので、ここでもviewer pageへは行かない。
    assert.deepEqual(seen, [SCENE_URL]);
  } finally {
    restore();
  }
});

test("reports a downloadable scene whose viewer page has no asset", async () => {
  const seen = [];
  const restore = stubSuperSplat({ record: seen, viewer: { contentUrl: null } });
  try {
    const response = await callRoute(`url=${encodeURIComponent(SCENE_URL)}`);
    assert.equal(response.status, 422);
    assert.equal((await response.json()).code, "SUPERSPLAT_ASSET_NOT_FOUND");
    // 許可は取れているので、viewer pageまでは行く。CDNへは行かない。
    assert.deepEqual(seen, [SCENE_URL, VIEWER_URL]);
  } finally {
    restore();
  }
});

test("does not follow a content URL pointing somewhere else", async () => {
  const seen = [];
  const restore = stubSuperSplat({
    record: seen,
    viewer: { contentUrl: "http://169.254.169.254/latest/meta-data/meta.json" },
  });
  try {
    const response = await callRoute(`url=${encodeURIComponent(SCENE_URL)}`);
    assert.equal(response.status, 422);
    assert.equal((await response.json()).code, "SUPERSPLAT_ASSET_NOT_FOUND");
    assert.deepEqual(seen, [SCENE_URL, VIEWER_URL]);
  } finally {
    restore();
  }
});

test("hands back streamed SOG as its own format for the viewer to judge", async () => {
  const restore = stubSuperSplat({ viewer: { contentUrl: `${CDN}/lod-meta.json` } });
  try {
    const response = await callRoute(`url=${encodeURIComponent(SCENE_URL)}`);
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).asset, {
      format: "streamed-sog",
      url: `${CDN}/lod-meta.json`,
      revision: "v3",
    });
  } finally {
    restore();
  }
});

test("accepts the /s?id= form and reports the canonical scene page URL", async () => {
  const restore = stubSuperSplat();
  try {
    const response = await callRoute(`url=${encodeURIComponent(VIEWER_URL)}`);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).pageUrl, SCENE_URL);
  } finally {
    restore();
  }
});

test("returns the asset URL instead of proxying the SOG", async () => {
  const seen = [];
  const restore = stubSuperSplat({ record: seen });
  try {
    const response = await callRoute(`url=${encodeURIComponent(SCENE_URL)}`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /application\/json/);
    // SOGもWebPもWorkerは取りに行かない。
    assert.deepEqual(seen, [SCENE_URL, VIEWER_URL]);
  } finally {
    restore();
  }
});

test("rejects URLs that are not SuperSplat scene pages", async () => {
  const seen = [];
  const restore = stubSuperSplat({ record: seen });
  try {
    for (const bad of [
      "https://example.com/scene/56155c3f",
      "https://www.superspl.at/scene/56155c3f",
      "javascript:alert(1)",
      "https://superspl.at/scene/a%2Fb",
      "",
    ]) {
      const response = await callRoute(`url=${encodeURIComponent(bad)}`);
      assert.equal(response.status, 400, bad);
      assert.equal((await response.json()).code, "INVALID_SUPERSPLAT_URL", bad);
    }
    // 不正なURLではネットワークへ一切出ない。
    assert.deepEqual(seen, []);
  } finally {
    restore();
  }
});

test("reports a missing scene apart from an unreachable SuperSplat", async () => {
  for (const [status, code, expected] of [
    [404, "SUPERSPLAT_SCENE_NOT_FOUND", 404],
    [500, "SUPERSPLAT_UNAVAILABLE", 502],
  ]) {
    const restore = stubSuperSplat({ scenePage: () => new Response("nope", { status }) });
    try {
      const response = await callRoute(`url=${encodeURIComponent(SCENE_URL)}`);
      assert.equal(response.status, expected, code);
      assert.equal((await response.json()).code, code);
    } finally {
      restore();
    }
  }
});

test("fails closed when the viewer page cannot be fetched", async () => {
  const restore = stubSuperSplat({ viewerPage: () => new Response("nope", { status: 500 }) });
  try {
    const response = await callRoute(`url=${encodeURIComponent(SCENE_URL)}`);
    assert.equal(response.status, 502);
    assert.equal((await response.json()).code, "SUPERSPLAT_UNAVAILABLE");
  } finally {
    restore();
  }
});

test("answers CORS preflight for the SuperSplat endpoint", async () => {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}-options`);
  const { default: worker } = await import(workerUrl.href);
  const response = await worker.fetch(
    new Request("http://localhost/api/supersplat", { method: "OPTIONS" }),
    { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } },
    { waitUntil() {}, passThroughOnException() {} },
  );
  assert.equal(response.status, 204);
  assert.equal(response.headers.get("access-control-allow-origin"), "*");
});

test("the dedicated Pages resolver Worker serves the SuperSplat endpoint too", async () => {
  const { readFile } = await import("node:fs/promises");
  const [worker, route] = await Promise.all([
    readFile(new URL("../resolver-worker/index.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/supersplat/route.ts", import.meta.url), "utf8"),
  ]);

  assert.match(worker, /from "\.\.\/app\/supersplat-resolver"/);
  assert.match(worker, /url\.pathname === "\/api\/supersplat"/);
  assert.match(worker, /handleSuperSplatOptions\(\)/);
  assert.match(worker, /url\.pathname === "\/api\/insta360"/);
  assert.match(route, /handleSuperSplatRequest\(request\)/);
});

test("keeps SuperSplat page structure out of the viewer component", async () => {
  const { readFile } = await import("node:fs/promises");
  const viewer = await readFile(new URL("../app/SogViewer.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(viewer, /cloudfront/i);
  assert.doesNotMatch(viewer, /`https:\/\/superspl\.at/);
  // HTML解析はresolver側だけ。Viewerはページの形を知らない。
  assert.doesNotMatch(viewer, /sse-bootstrap/);
  assert.doesNotMatch(viewer, /contentUrl/);
  assert.match(viewer, /sceneUrlFromSceneId\(deepLink\.id\)/);
});

test("a real smoke test against SuperSplat is available but not part of CI", async () => {
  const { readFile } = await import("node:fs/promises");
  const [script, packageJson] = await Promise.all([
    readFile(new URL("../scripts/probe-supersplat.mjs", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
  ]);
  assert.match(packageJson, /"probe:supersplat":/);
  // 外部サービスに依存するので `npm test` からは呼ばない。
  assert.doesNotMatch(packageJson, /"test":[^"]*probe-supersplat/);
  // 実構造を採取できること。parserを実物へ合わせるための入口。
  assert.match(script, /--dump/);
  assert.match(script, /readSuperSplatDownloadPermission/);
  assert.match(script, /findSuperSplatViewerUrl/);
});
