import assert from "node:assert/strict";
import test from "node:test";

const SHARE_URL = "https://app.insta360.com/3dspace/detail/GS3DGabc?useImmersive=1";
const SOG_URL = "https://cdn.insta360.com/spaces/abc/capture.sog";
const SOG_BYTES = new Uint8Array([0x50, 0x4b, 0x03, 0x04]);

/** 共有ページとCDNを差し替えて、Workerのルートだけを検証する。 */
function stubInsta360(overrides = {}) {
  const original = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = typeof input === "string" ? input : input.url;
    if (url.startsWith(SHARE_URL)) {
      return (
        overrides.sharePage?.() ??
        new Response(
          `<script>window.__D__={"sog":"https:\\/\\/cdn.insta360.com\\/spaces\\/abc\\/capture.sog"}</script>`,
          { status: 200, headers: { "content-type": "text/html" } },
        )
      );
    }
    if (url === SOG_URL) {
      return new Response(SOG_BYTES, {
        status: 200,
        headers: { "content-type": "application/zip", "content-length": String(SOG_BYTES.length) },
      });
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

test("resolves an Insta360 share URL to its SOG asset", async () => {
  const restore = stubInsta360();
  try {
    const response = await callRoute(`url=${encodeURIComponent(SHARE_URL)}`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("access-control-allow-origin"), "*");
    assert.deepEqual(await response.json(), { shareId: "GS3DGabc", assetUrl: SOG_URL });
  } finally {
    restore();
  }
});

test("streams the resolved SOG with CORS headers", async () => {
  const restore = stubInsta360();
  try {
    const response = await callRoute(`url=${encodeURIComponent(SHARE_URL)}&mode=asset`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("access-control-allow-origin"), "*");
    assert.equal(response.headers.get("content-length"), String(SOG_BYTES.length));
    assert.deepEqual(new Uint8Array(await response.arrayBuffer()), SOG_BYTES);
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
