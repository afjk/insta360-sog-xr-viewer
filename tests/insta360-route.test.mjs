import assert from "node:assert/strict";
import test from "node:test";

const SHARE_ID = "GS3DGabc";
const SHARE_URL = `https://app.insta360.com/3dspace/detail/${SHARE_ID}?useImmersive=1`;
const SIGNED_QUERY = "?x-oss-date=20260822T000000Z&x-oss-expires=604800&x-oss-signature=XXX";
const SOG_URL = `https://p2-app.insta360.com/3dgs/${SHARE_ID}/1_3DGS.sog${SIGNED_QUERY}`;
const API_URL = `https://service-g.insta360.com/app-service/app/service/gs3d/task/detail?taskOrderNo=${SHARE_ID}`;
const API_SOG_URL = `https://p2-app.insta360.com/3dgs/${SHARE_ID}/1_3DGS.sog?from=api`;

/** 実際の共有ページと同じく、署名付きURLを __NEXT_DATA__ に埋めたHTMLを作る。 */
function sharePageHtml() {
  const payload = {
    props: {
      pageProps: {
        taskDetail: {
          id: SHARE_ID,
          outputs: [
            {
              name: "0_3DGS.ply",
              type: "model",
              fileFormat: "ply",
              url: `https://p2-app.insta360.com/3dgs/${SHARE_ID}/0_3DGS.ply${SIGNED_QUERY}`,
            },
            { name: "1_3DGS.sog", type: "model", fileFormat: "sog", url: SOG_URL },
          ],
        },
      },
    },
  };
  const json = JSON.stringify(payload).replace(/&/g, "\\u0026");
  return `<!doctype html><html><body><script id="__NEXT_DATA__" type="application/json">${json}</script></body></html>`;
}

/** 共有ページのHTMLと同じ `outputs` を返す、タスク詳細APIのレスポンス。 */
function taskDetailBody() {
  return {
    code: 0,
    data: {
      taskOrderNo: SHARE_ID,
      outputs: [
        { fileFormat: "ply", type: "model", url: `https://p2-app.insta360.com/3dgs/${SHARE_ID}/0_3DGS.ply?from=api` },
        { fileFormat: "sog", type: "model", url: API_SOG_URL },
      ],
    },
  };
}

/** 共有ページ・タスク詳細API・CDNを差し替えて、Workerのルートだけを検証する。 */
function stubInsta360(overrides = {}) {
  const original = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = typeof input === "string" ? input : input.url;
    overrides.record?.push(url);
    if (url.startsWith("https://service-")) {
      return (
        overrides.taskDetail?.() ??
        Response.json(taskDetailBody(), { status: 200 })
      );
    }
    if (url.startsWith(SHARE_URL)) {
      return (
        overrides.sharePage?.() ??
        new Response(sharePageHtml(), { status: 200, headers: { "content-type": "text/html" } })
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
    new Request(`http://localhost/api/insta360?${query}`),
    { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } },
    { waitUntil() {}, passThroughOnException() {} },
  );
}

test("resolves an Insta360 share URL through the task detail API", async () => {
  const seen = [];
  const restore = stubInsta360({ record: seen });
  try {
    const response = await callRoute(`url=${encodeURIComponent(SHARE_URL)}`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("access-control-allow-origin"), "*");
    assert.deepEqual(await response.json(), { shareId: SHARE_ID, assetUrl: API_SOG_URL });
    // APIで解決できたら共有ページのHTMLは取りに行かない。
    assert.ok(seen.includes(API_URL));
    assert.ok(!seen.some((url) => url.startsWith(SHARE_URL)));
  } finally {
    restore();
  }
});

test("falls back to the share page when the task detail API fails", async () => {
  const restore = stubInsta360({
    taskDetail: () => new Response("nope", { status: 500 }),
  });
  try {
    const response = await callRoute(`url=${encodeURIComponent(SHARE_URL)}`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { shareId: SHARE_ID, assetUrl: SOG_URL });
  } finally {
    restore();
  }
});

test("hands back the signed URL instead of proxying the SOG", async () => {
  const seen = [];
  const restore = stubInsta360({ record: seen });
  try {
    // 中継していた頃の呼び方をされても、URLを返すだけで本体は取りに行かない。
    const response = await callRoute(`url=${encodeURIComponent(SHARE_URL)}&mode=asset`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /application\/json/);
    assert.deepEqual(await response.json(), { shareId: SHARE_ID, assetUrl: API_SOG_URL });
    assert.ok(!seen.includes(API_SOG_URL));
  } finally {
    restore();
  }
});

test("rejects URLs that are not Insta360 share pages", async () => {
  const response = await callRoute(`url=${encodeURIComponent("https://evil.example/3dspace/detail/x")}`);
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /Insta360の共有URL/);
});

test("reports a readable error when the share page has no SOG", async () => {
  const restore = stubInsta360({
    taskDetail: () => Response.json({ code: 0, data: { outputs: [] } }, { status: 200 }),
    sharePage: () =>
      new Response("<html><body>expired</body></html>", {
        status: 200,
        headers: { "content-type": "text/html" },
      }),
  });
  try {
    const response = await callRoute(`url=${encodeURIComponent(SHARE_URL)}`);
    assert.equal(response.status, 422);
    assert.match((await response.json()).error, /SOGのURLを見つけられませんでした/);
  } finally {
    restore();
  }
});

test("the dedicated Pages resolver Worker serves the same endpoint", async () => {
  const { readFile } = await import("node:fs/promises");
  const [worker, config, packageJson] = await Promise.all([
    readFile(new URL("../resolver-worker/index.ts", import.meta.url), "utf8"),
    readFile(new URL("../resolver-worker/wrangler.toml", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
  ]);

  // 解決ロジックはアプリ本体のWorkerと共有する。二重実装にしない。
  assert.match(worker, /from "\.\.\/app\/insta360-resolver"/);
  assert.match(worker, /url\.pathname === "\/api\/insta360"/);
  assert.match(worker, /handleInsta360Options\(\)/);
  assert.match(config, /name = "insta360-sog-resolver"/);
  assert.match(packageJson, /"resolver:deploy": "wrangler deploy --config resolver-worker\/wrangler\.toml"/);

  const route = await readFile(new URL("../app/api/insta360/route.ts", import.meta.url), "utf8");
  assert.match(route, /handleInsta360Request\(request\)/);
});
