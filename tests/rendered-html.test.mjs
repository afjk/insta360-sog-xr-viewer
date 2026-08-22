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
  assert.match(html, /空間を開く/);
  assert.match(html, /SAMPLE/);
  assert.match(html, /サンプル空間 capture\.sog/);
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
  assert.match(viewer, /url: "capture\.sog"/);
  assert.match(viewer, /url: "capture-vr\.sog"/);
  assert.match(viewer, /滑らかさ優先/);
  assert.match(viewer, /高画質/);
  assert.match(viewer, /framebufferScaleFactor: quality === "smooth" \? 0\.52 : 0\.78/);
  assert.match(viewer, /GSPLAT_RENDERER_RASTER_CPU_SORT/);
  assert.match(viewer, /xr\.start\(camera, XRTYPE_VR, XRSPACE_LOCALFLOOR/);
  assert.match(viewer, /"KeyW"/);
  assert.match(viewer, /"KeyE"/);
  assert.match(viewer, /XRHAND_LEFT/);
  assert.match(viewer, /XRHAND_RIGHT/);
  assert.match(viewer, /source\.squeezing \|\| gamepadButtonPressed\(gamepad\.buttons, 1\)/);
  assert.match(viewer, /moveX \+= rightStickX/);
  assert.match(viewer, /moveY \+= rightStickY/);
  assert.match(viewer, /gamepadButtonPressed\(gamepad\.buttons, 4\)/);
  assert.match(viewer, /gamepadButtonPressed\(gamepad\.buttons, 5\)/);
  assert.match(viewer, /heightDirection \* 1\.2 \* deltaSeconds/);
  assert.match(viewer, /A 上昇 \/ B 下降/);
  assert.match(viewer, /Grip＋右スティック/);
  assert.equal(smoothSog.subarray(0, 2).toString(), "PK");
  assert.ok(smoothSog.byteLength < 7_000_000);
});

test("loads arbitrary SOG sources while keeping the bundled sample as default", async () => {
  const [viewer, route] = await Promise.all([
    readFile(new URL("../app/SogViewer.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/api/insta360/route.ts", import.meta.url), "utf8"),
  ]);

  // The bundled sample stays the auto-loaded default.
  assert.match(viewer, /useState<ViewerSource>\(\{ kind: "sample", label: SAMPLE_LABEL \}\)/);
  assert.match(viewer, /app\.assets\.load\(initialAsset\)/);

  // One "空間を開く" panel offers URL, drag & drop and the file picker.
  assert.match(viewer, /空間を開く/);
  assert.match(viewer, /読み込む/);
  assert.match(viewer, /ファイルを選択/);
  assert.match(viewer, /SOGファイルをドロップして開く/);
  assert.match(viewer, /accept="\.sog"/);
  assert.match(viewer, /window\.addEventListener\("drop", onDrop\)/);
  assert.match(viewer, /window\.addEventListener\("dragover", onDragOver\)/);
  assert.match(viewer, /URL\.createObjectURL\(request\.file\)/);
  assert.match(viewer, /URL\.revokeObjectURL/);
  assert.match(viewer, /サンプルに戻す/);

  // Swapping sources replaces the GSplat and reports progress and errors.
  assert.match(viewer, /splatComponent\.asset = asset/);
  assert.match(viewer, /app\.assets\.remove\(entry\.asset\)/);
  assert.match(viewer, /setSourceProgress/);
  assert.match(viewer, /setSourceError/);

  // Share URLs are resolved server-side because Insta360 does not send CORS headers.
  assert.match(viewer, /parseInsta360ShareUrl/);
  assert.match(viewer, /\/api\/insta360\?mode=asset/);
  assert.match(route, /export async function GET/);
  assert.match(route, /access-control-allow-origin/);
  assert.match(route, /isPubliclyRoutableHost/);
});

test("builds and deploys a repository-relative GitHub Pages site", async () => {
  const [pagesConfig, pagesEntry, workflow, packageJson] = await Promise.all([
    readFile(new URL("../vite.pages.config.ts", import.meta.url), "utf8"),
    readFile(new URL("../github-pages-src/main.tsx", import.meta.url), "utf8"),
    readFile(new URL("../.github/workflows/pages.yml", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
  ]);

  assert.match(pagesConfig, /base: "\/insta360-sog-xr-viewer\/"/);
  assert.match(pagesConfig, /publicDir: resolve\(projectRoot, "public"\)/);
  assert.match(pagesEntry, /<SogViewer \/>/);
  assert.match(packageJson, /"build:pages": "vite build --config vite\.pages\.config\.ts"/);
  assert.match(workflow, /actions\/configure-pages@v5/);
  assert.match(workflow, /actions\/upload-pages-artifact@v4/);
  assert.match(workflow, /actions\/deploy-pages@v4/);
});
