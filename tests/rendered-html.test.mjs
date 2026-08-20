import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request("http://localhost/", {
      headers: { accept: "text/html" },
    }),
    {
      ASSETS: {
        fetch: async () => new Response("Not found", { status: 404 }),
      },
    },
    {
      waitUntil() {},
      passThroughOnException() {},
    },
  );
}

test("server-renders the PlayCanvas SOG viewer shell", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<title>SOG XR Viewer \| Insta360 Spatial Capture<\/title>/i);
  assert.match(html, /PLAYCANVAS · SOG v2/);
  assert.match(html, /PICO 4 UltraやQuest/);
  assert.match(html, /空間データを読み込み中/);
  assert.match(html, /VRを開始/);
  assert.match(html, /WASD 移動 · E\/Q 上下/);
  assert.match(html, /role="status"/);
});

test("uses selectable PlayCanvas SOG quality modes and WebXR", async () => {
  const [viewer, packageJson, smoothSog] = await Promise.all([
    readFile(new URL("../app/SogViewer.tsx", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
    readFile(new URL("../public/capture-vr.sog", import.meta.url)),
  ]);

  assert.match(packageJson, /"playcanvas": "\^2\.21\.0"/);
  assert.doesNotMatch(packageJson, /@sparkjsdev\/spark|"three"/);
  assert.match(viewer, /new Asset\("Insta360 Spatial Capture — High", "gsplat"/);
  assert.match(viewer, /url: "\/capture\.sog"/);
  assert.match(viewer, /url: "\/capture-vr\.sog"/);
  assert.match(viewer, /滑らかさ優先/);
  assert.match(viewer, /高画質/);
  assert.match(viewer, /framebufferScaleFactor: quality === "smooth" \? 0\.52 : 0\.78/);
  assert.match(viewer, /GSPLAT_RENDERER_RASTER_CPU_SORT/);
  assert.match(viewer, /xr\.start\(camera, XRTYPE_VR, XRSPACE_LOCALFLOOR/);
  assert.match(viewer, /"KeyW"/);
  assert.match(viewer, /"KeyE"/);
  assert.match(viewer, /XRHAND_LEFT/);
  assert.match(viewer, /XRHAND_RIGHT/);
  assert.match(viewer, /gamepadButtonPressed\(gamepad\.buttons, 4\)/);
  assert.match(viewer, /gamepadButtonPressed\(gamepad\.buttons, 5\)/);
  assert.match(viewer, /heightDirection \* 1\.2 \* deltaSeconds/);
  assert.match(viewer, /A 上昇 \/ B 下降/);
  assert.equal(smoothSog.subarray(0, 2).toString(), "PK");
  assert.ok(smoothSog.byteLength < 7_000_000);
});
