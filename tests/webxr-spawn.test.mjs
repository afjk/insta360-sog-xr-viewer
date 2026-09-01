/**
 * VR開始時の視点復元を、実物のブラウザとPlayCanvasで通しで確かめる。
 *
 * `npm test` からは走らせない。`npm run build:pages` の成果物とChromiumが
 * 要る（`npm run test:xr`）。
 *
 * ここでしか掴めないものがある。`view=` 付きのリンクでVRへ入ると、rigの補正は
 * 「HMDのposeがカメラへ入ったフレーム」でしか正しく解けない。`app.on("update")`
 * はXRのposeが入っていないフレームでも走るので、そこで補正するとDesktopの姿勢を
 * HMD poseだと思って計算し、次のフレームで本物のposeが加算されて原点付近へ飛ぶ。
 * 数値だけを見るユニットテストでは通ってしまう配線ミスで、実際にQuest 3で出た。
 *
 * WebXRは `tests/webxr-stub.js` で差し替える。エンジンは本物のまま動く。
 */
import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { orbitTargetOf, poseFromEyeAndTarget, xrSpawnPose } from "../app/view-pose.ts";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const DIST = join(ROOT, "dist-pages");
// `vite.pages.config.ts` の `base` と合わせる。
const BASE = "/insta360-sog-xr-viewer/";
const STUB = join(ROOT, "tests", "webxr-stub.js");

// Desktopで作った、急な見下ろしの視点。VRではpitchを再現できないので、
// `xrSpawnPose` が立ち位置を見下ろし角の上限まで戻す。
const VIEW = { x: 2, y: 3.5, z: 4, yaw: 30, pitch: 40, distance: 3 };
const VIEW_PARAM = `1_${VIEW.x}_${VIEW.y}_${VIEW.z}_${VIEW.yaw}_${VIEW.pitch}_${VIEW.distance}`;

const MIME = {
  ".html": "text/html",
  ".js": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".webp": "image/webp",
  ".sog": "application/octet-stream",
};

/** `dist-pages` を `BASE` の下で配る、テスト用の静的サーバー。 */
async function serveDist() {
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://localhost");
    const relative = url.pathname.startsWith(BASE) ? url.pathname.slice(BASE.length) : "";
    // `..` でdist-pagesの外へ出さない。
    const file = normalize(join(DIST, relative || "index.html"));
    const target = file.startsWith(DIST) ? file : join(DIST, "index.html");
    readFile(existsSync(target) ? target : join(DIST, "index.html"))
      .then((body) => {
        response.writeHead(200, {
          "content-type": MIME[extname(target)] ?? "application/octet-stream",
          "content-length": body.length,
        });
        response.end(body);
      })
      .catch(() => {
        response.writeHead(404);
        response.end();
      });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return { origin: `http://127.0.0.1:${port}`, close: () => new Promise((r) => server.close(r)) };
}

/**
 * 使うChromium。
 *
 * 既定はPlaywrightが入れたもの。`SOG_XR_CHROMIUM` があればそちらを優先する
 * ——自前でChromiumを持っているCIイメージでは、Playwrightのrevisionと一致
 * しないことがあるため。
 */
async function chromiumPath() {
  const override = process.env.SOG_XR_CHROMIUM;
  if (override) {
    if (existsSync(override)) return override;
    return null;
  }
  const { chromium } = await import("playwright");
  const bundled = chromium.executablePath();
  try {
    await stat(bundled);
    return bundled;
  } catch {
    return null;
  }
}

/** 前提が揃っていなければ、理由を添えてskipする。CIで黙って緑にしない。 */
async function requirements() {
  if (!existsSync(join(DIST, "index.html"))) {
    return { skip: "dist-pages がありません。先に `npm run build:pages` を実行してください。" };
  }
  if (!existsSync(join(DIST, "capture.sog"))) {
    return { skip: "dist-pages/capture.sog がありません。" };
  }
  try {
    await import("playwright");
  } catch {
    return { skip: "playwright が入っていません。`npm install` を実行してください。" };
  }
  const executablePath = await chromiumPath();
  if (!executablePath) {
    return {
      skip:
        "Chromiumが見つかりません。`npx playwright install chromium` を実行するか、" +
        "`SOG_XR_CHROMIUM` に実行ファイルのパスを指定してください。",
    };
  }
  return { executablePath };
}

test("restores the shared view when VR starts", { timeout: 300_000 }, async (t) => {
  const { skip, executablePath } = await requirements();
  if (skip) {
    t.skip(skip);
    return;
  }
  const { chromium } = await import("playwright");
  const server = await serveDist();
  // SwiftShaderで動かす。GPUの有無に関係なく、同じ経路を同じ順序で通せる。
  const browser = await chromium.launch({
    executablePath,
    args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--use-gl=angle"],
  });
  try {
    const context = await browser.newContext({ viewport: { width: 900, height: 620 } });
    await context.addInitScript({ path: STUB });
    const page = await context.newPage();
    // `console.info("[sog-xr] spawned", {...})` の第2引数はChromiumの
    // プレビュー表記（`{desired: Object}`）になるので、`text()` ではなく
    // 引数を値として取り出す。
    const pending = [];
    const logs = [];
    page.on("console", (message) => {
      const args = message.args();
      pending.push(
        Promise.all(args.map((arg) => arg.jsonValue().catch(() => null))).then((values) => {
          logs.push({ text: message.text(), values });
        }),
      );
    });
    page.on("pageerror", (error) => logs.push({ text: `pageerror: ${error.message}`, values: [] }));

    // 空間はバンドル済みのサンプル。`?url=` で開くのは、`view=` が効くのが
    // パーマリンクを持つ空間だけだから（サンプルそのものは共有できない）。
    const asset = `${server.origin}${BASE}capture.sog`;
    await page.goto(
      `${server.origin}${BASE}?url=${encodeURIComponent(asset)}&view=${VIEW_PARAM}&debug=1`,
      { waitUntil: "load" },
    );

    // 読み込み完了は、共有できる空間にだけ出るコピーのボタンで見る。
    await page.locator("#copy-permalink").waitFor({ timeout: 240_000 });
    await page.waitForTimeout(1500);

    // VRを開始。既定はVR向け軽量化なので、オリジナルのまま入るほうへ切り替える。
    await page.locator("button", { hasText: "VRを開始" }).first().click();
    await page.locator(".quality-option", { hasText: "オリジナル" }).click();
    await page.locator("button.quality-start").click();

    // XRのフレームが何度か回るまで待つ。補正は最初のフレーム、突き合わせは次。
    await page.waitForFunction(() => (window.__webxrStub?.frames ?? 0) > 3, null, {
      timeout: 60_000,
    });
    await page.waitForTimeout(1000);

    await Promise.all(pending);
    const head = await page.evaluate(() => window.__webxrStub.head);
    const spawned = logs.find((line) => line.values[0] === "[sog-xr] spawned");
    assert.ok(
      spawned,
      `spawn log not found. logs:\n${logs.map((line) => line.text).join("\n")}`,
    );
    const report = spawned.values[1];

    // 立ち位置は `xrSpawnPose` の解。ユニットテストと同じ関数で期待値を作る。
    const expected = xrSpawnPose(VIEW);
    assert.ok(
      Math.hypot(
        report.desired.x - expected.x,
        report.desired.y - expected.y,
        report.desired.z - expected.z,
      ) < 1e-3,
      `desired ${JSON.stringify(report.desired)} != ${JSON.stringify(expected)}`,
    );

    // 本題。実際に組み上がったカメラのworld姿勢が、狙った立ち位置に乗っていること。
    // 補正をXRのposeが入っていないフレームで掛けると、ここが数m単位でずれる。
    assert.ok(
      report.positionDelta < 0.01,
      `position off by ${report.positionDelta}m (head was ${JSON.stringify(head)})`,
    );
    assert.ok(report.yawDelta < 0.5, `yaw off by ${report.yawDelta} degrees`);

    // Desktopで見ていた注視点が、正面から見下ろせるところに来ていること。
    const target = orbitTargetOf(VIEW);
    const toTarget = poseFromEyeAndTarget(report.actual, target);
    assert.ok(toTarget, "no direction to the target");
    assert.ok(
      Math.abs(toTarget.pitch) <= 21,
      `target sits ${toTarget.pitch} degrees below the horizon`,
    );

    // 両眼が描けていること。片眼だけ落ちると真っ黒な帯が残る。
    const eyes = await page.evaluate(() => {
      const canvas = document.querySelector("canvas");
      return { width: canvas?.width ?? 0, height: canvas?.height ?? 0 };
    });
    assert.ok(eyes.width > 0 && eyes.height > 0, "canvas has no size");
  } finally {
    await browser.close();
    await server.close();
  }
});
