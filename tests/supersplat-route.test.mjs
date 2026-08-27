import assert from "node:assert/strict";
import test from "node:test";

const SCENE_ID = "56155c3f";
const SCENE_URL = `https://superspl.at/scene/${SCENE_ID}`;
const CDN = "https://d1abcxyz0000.cloudfront.net/splats/56155c3f/v3";
const META_URL = `${CDN}/meta.json`;

/**
 * 公開ページの形を模したfixture。`tests/supersplat.test.mts` と同じ考え方で、
 * SuperSplatが機械可読に置いているものだけを写している。
 */
function scenePageHtml({
  downloadable = true,
  license = '<link rel="license" href="https://creativecommons.org/licenses/by/4.0/" />',
  contentUrl = META_URL,
} = {}) {
  const scene = { id: SCENE_ID, title: "Lion", author: "splat-artist" };
  if (downloadable !== null) scene.downloadable = downloadable;
  const bootstrap = contentUrl === null ? {} : { contentUrl, contentFilename: "meta.json" };
  return `<!doctype html><html><head>
    <title>Lion | SuperSplat</title>
    ${license}
    <script type="application/json" id="sse-bootstrap">${JSON.stringify(bootstrap)}</script>
    <script>window.__SCENE__ = ${JSON.stringify(scene)};</script>
  </head><body></body></html>`;
}

/** 公開ページとCDNを差し替えて、Workerのルートだけを検証する。 */
function stubSuperSplat(overrides = {}) {
  const original = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = typeof input === "string" ? input : input.url;
    overrides.record?.push(url);
    if (url.startsWith(SCENE_URL)) {
      return (
        overrides.scenePage?.() ??
        new Response(scenePageHtml(overrides.page), {
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
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request(`http://localhost/api/supersplat?${query}`),
    { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } },
    { waitUntil() {}, passThroughOnException() {} },
  );
}

test("resolves a downloadable SuperSplat scene to its published asset", async () => {
  const restore = stubSuperSplat();
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
  } finally {
    restore();
  }
});

test("accepts the /s?id= form and reports the canonical page URL", async () => {
  const restore = stubSuperSplat();
  try {
    const response = await callRoute(
      `url=${encodeURIComponent(`https://superspl.at/s?id=${SCENE_ID}`)}`,
    );
    assert.equal(response.status, 200);
    assert.equal((await response.json()).pageUrl, SCENE_URL);
  } finally {
    restore();
  }
});

test("checks downloadable before looking for any asset", async () => {
  const seen = [];
  const restore = stubSuperSplat({ record: seen, page: { downloadable: false } });
  try {
    const response = await callRoute(`url=${encodeURIComponent(SCENE_URL)}`);
    assert.equal(response.status, 403);
    const body = await response.json();
    assert.equal(body.code, "SUPERSPLAT_NOT_DOWNLOADABLE");
    assert.match(body.error, /ダウンロードが許可されていない/);
    // ここが肝心。公開ページ以外へは一切出て行かない。
    assert.deepEqual(seen, [SCENE_URL]);
    assert.ok(!seen.some((url) => url.includes("cloudfront")));
  } finally {
    restore();
  }
});

test("refuses a scene whose downloadable state cannot be confirmed", async () => {
  const seen = [];
  const restore = stubSuperSplat({ record: seen, page: { downloadable: null } });
  try {
    const response = await callRoute(`url=${encodeURIComponent(SCENE_URL)}`);
    // 判定できないものは読み込まない（fail-closed）。
    assert.equal(response.status, 403);
    assert.equal((await response.json()).code, "SUPERSPLAT_NOT_DOWNLOADABLE");
    assert.deepEqual(seen, [SCENE_URL]);
  } finally {
    restore();
  }
});

test("refuses a downloadable scene whose license cannot be read", async () => {
  const seen = [];
  const restore = stubSuperSplat({ record: seen, page: { license: "" } });
  try {
    const response = await callRoute(`url=${encodeURIComponent(SCENE_URL)}`);
    assert.equal(response.status, 422);
    assert.equal((await response.json()).code, "SUPERSPLAT_LICENSE_NOT_FOUND");
    // ライセンスが読めない時点で止まるので、ここでもCDNへは行かない。
    assert.deepEqual(seen, [SCENE_URL]);
  } finally {
    restore();
  }
});

test("reports a downloadable scene with no loadable asset", async () => {
  const restore = stubSuperSplat({ page: { contentUrl: null } });
  try {
    const response = await callRoute(`url=${encodeURIComponent(SCENE_URL)}`);
    assert.equal(response.status, 422);
    assert.equal((await response.json()).code, "SUPERSPLAT_ASSET_NOT_FOUND");
  } finally {
    restore();
  }
});

test("does not follow a content URL pointing somewhere else", async () => {
  const restore = stubSuperSplat({
    page: { contentUrl: "http://169.254.169.254/latest/meta-data/meta.json" },
  });
  try {
    const response = await callRoute(`url=${encodeURIComponent(SCENE_URL)}`);
    assert.equal(response.status, 422);
    assert.equal((await response.json()).code, "SUPERSPLAT_ASSET_NOT_FOUND");
  } finally {
    restore();
  }
});

test("hands back streamed SOG as its own format for the viewer to judge", async () => {
  const restore = stubSuperSplat({ page: { contentUrl: `${CDN}/lod-meta.json` } });
  try {
    const response = await callRoute(`url=${encodeURIComponent(SCENE_URL)}`);
    // resolverは見つけたものをそのまま返す。表示できるかはViewerが決める。
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

test("returns the asset URL instead of proxying the SOG", async () => {
  const seen = [];
  const restore = stubSuperSplat({ record: seen });
  try {
    const response = await callRoute(`url=${encodeURIComponent(SCENE_URL)}`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /application\/json/);
    // SOGもWebPもWorkerは取りに行かない。
    assert.deepEqual(seen, [SCENE_URL]);
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
    const restore = stubSuperSplat({
      scenePage: () => new Response("nope", { status }),
    });
    try {
      const response = await callRoute(`url=${encodeURIComponent(SCENE_URL)}`);
      assert.equal(response.status, expected, code);
      assert.equal((await response.json()).code, code);
    } finally {
      restore();
    }
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

  // 解決ロジックはアプリ本体のWorkerと共有する。二重実装にしない。
  assert.match(worker, /from "\.\.\/app\/supersplat-resolver"/);
  assert.match(worker, /url\.pathname === "\/api\/supersplat"/);
  assert.match(worker, /handleSuperSplatOptions\(\)/);
  // 既存のInsta360エンドポイントも同じWorkerに残っている。
  assert.match(worker, /url\.pathname === "\/api\/insta360"/);
  assert.match(route, /handleSuperSplatRequest\(request\)/);
});

test("keeps SuperSplat CDN structure out of the viewer component", async () => {
  const { readFile } = await import("node:fs/promises");
  const viewer = await readFile(new URL("../app/SogViewer.tsx", import.meta.url), "utf8");
  // 配信CDNのホストはViewerに出てこない。
  assert.doesNotMatch(viewer, /cloudfront/i);
  // シーンURLも自前で組み立てない。組み立ては supersplat.ts の中だけ。
  assert.doesNotMatch(viewer, /`https:\/\/superspl\.at/);
  assert.doesNotMatch(viewer, /"https:\/\/superspl\.at\/scene\/" \+/);
  assert.match(viewer, /sceneUrlFromSceneId\(deepLink\.id\)/);
  // 入力欄の例示にURLが出るのは構わない。これは組み立てではない。
  assert.match(viewer, /placeholder=/);
});
