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

test("keeps the PlayCanvas SOG and WebXR controls wired up", async () => {
  const [viewer, packageJson, sampleSog] = await Promise.all([
    readFile(new URL("../app/SogViewer.tsx", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
    readFile(new URL("../public/capture.sog", import.meta.url)),
  ]);

  assert.match(packageJson, /"playcanvas": "\^2\.21\.0"/);
  assert.doesNotMatch(packageJson, /@sparkjsdev\/spark|"three"/);
  assert.match(viewer, /const SAMPLE_URL = "capture\.sog"/);
  assert.match(viewer, /GSPLAT_RENDERER_RASTER_CPU_SORT/);
  assert.match(viewer, /xr\.start\(camera, XRTYPE_VR, XRSPACE_LOCALFLOOR/);
  assert.match(viewer, /framebufferScaleFactor: profile\.framebufferScaleFactor/);
  assert.match(viewer, /optimized: \{ framebufferScaleFactor: 0\.52, foveation: 0\.82 \}/);
  assert.match(viewer, /original: \{ framebufferScaleFactor: 0\.78, foveation: 0\.55 \}/);
  assert.match(viewer, /"KeyW"/);
  assert.match(viewer, /"KeyE"/);
  assert.match(viewer, /XRHAND_LEFT/);
  assert.match(viewer, /XRHAND_RIGHT/);
  assert.match(viewer, /inputSource\.squeezing \|\| gamepadButtonPressed\(gamepad\.buttons, 1\)/);
  assert.match(viewer, /moveX \+= rightStickX/);
  assert.match(viewer, /moveY \+= rightStickY/);
  assert.match(viewer, /gamepadButtonPressed\(gamepad\.buttons, 4\)/);
  assert.match(viewer, /gamepadButtonPressed\(gamepad\.buttons, 5\)/);
  assert.match(viewer, /heightDirection \* 1\.2 \* deltaSeconds/);
  assert.match(viewer, /A 上昇 \/ B 下降/);
  assert.match(viewer, /Grip＋右スティック/);
  assert.equal(sampleSog.subarray(0, 2).toString(), "PK");
});

test("generates the VR variant in the browser instead of shipping a second SOG", async () => {
  const [viewer, worker, cache, image] = await Promise.all([
    readFile(new URL("../app/SogViewer.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/sog-optimizer.worker.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/sog-cache.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/sog-image.ts", import.meta.url), "utf8"),
  ]);

  // capture-vr.sog stays in the repo as a reference, but the viewer no longer
  // ships it as the VR variant — that now comes from the optimizer.
  assert.doesNotMatch(viewer, /capture-vr\.sog/);

  // Desktop keeps the original; VR offers original or optimized.
  assert.match(viewer, /オリジナル/);
  assert.match(viewer, /VR向けに最適化/);
  assert.match(viewer, /最適化してVRを開始/);
  assert.match(viewer, /TARGET_SPLAT_PRESETS\.map/);

  // Conversion runs off the UI thread and never leaves the browser.
  assert.match(viewer, /new Worker\(new URL\("\.\/sog-optimizer\.worker\.ts", import\.meta\.url\)/);
  assert.match(viewer, /SOGを外部へ送信することはありません/);
  assert.match(worker, /worker\.postMessage\(result, \[result\.buffer\]\)/);
  assert.match(worker, /SOGを解析中/);
  assert.match(worker, /Gaussianを削減中/);
  assert.match(worker, /SOGを圧縮中/);

  // Results are cached in IndexedDB against the SOG contents, not the URL.
  assert.match(viewer, /cacheKey\(original\.hash, settings\)/);
  assert.match(viewer, /readCachedOptimization/);
  assert.match(viewer, /writeCachedOptimization/);
  assert.match(viewer, /キャッシュへ保存中/);
  assert.match(cache, /indexedDB\.open/);

  // Missing browser capabilities degrade to the original rather than breaking.
  assert.match(image, /optimizationUnsupportedReason/);
  assert.match(viewer, /オリジナルのままVRを開始できます/);
});

test("loads arbitrary SOG sources while keeping the bundled sample as default", async () => {
  const [viewer, route, resolver] = await Promise.all([
    readFile(new URL("../app/SogViewer.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/api/insta360/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/insta360-resolver.ts", import.meta.url), "utf8"),
  ]);

  // The bundled sample stays the auto-loaded default.
  assert.match(viewer, /useState<ViewerSource>\(\{ kind: "sample", label: SAMPLE_LABEL \}\)/);
  assert.match(viewer, /else void loadSample\(true\);/);

  // One "空間を開く" panel offers URL, drag & drop and the file picker.
  assert.match(viewer, /空間を開く/);
  assert.match(viewer, /読み込む/);
  assert.match(viewer, /ファイルを選択/);
  assert.match(viewer, /SOGファイルをドロップして開く/);
  assert.match(viewer, /accept="\.sog"/);
  assert.match(viewer, /window\.addEventListener\("drop", onDrop\)/);
  assert.match(viewer, /window\.addEventListener\("dragover", onDragOver\)/);
  assert.match(viewer, /await file\.arrayBuffer\(\)/);
  assert.match(viewer, /URL\.revokeObjectURL/);
  assert.match(viewer, /サンプルに戻す/);

  // Swapping sources replaces the GSplat and reports progress and errors.
  assert.match(viewer, /splatComponent\.asset = asset/);
  assert.match(viewer, /app\.assets\.remove\(entry\.asset\)/);
  assert.match(viewer, /releaseAsset\(previous\)/);
  assert.match(viewer, /setSourceProgress/);
  assert.match(viewer, /setSourceError/);

  // Share URLs are resolved server-side because Insta360 does not send CORS headers,
  // but the signed SOG it hands back is fetched straight from the browser.
  assert.match(viewer, /parseInsta360ShareUrl/);
  assert.match(viewer, /resolverConfig\(\)/);
  assert.match(viewer, /return \{ assetUrl: payload\.assetUrl, camerasUrl: payload\.camerasUrl \?\? "" \}/);
  assert.match(route, /export function GET/);
  assert.match(route, /handleInsta360Request/);
  assert.match(resolver, /access-control-allow-origin/);
  assert.match(resolver, /isPubliclyRoutableHost/);
  assert.match(resolver, /resolveAssetsFromHtml/);
  // 初期視点のもとになるカメラ情報のURLも一緒に返す。取れなくてもSOGは表示できる。
  assert.match(resolver, /camerasUrl/);
  // カメラ情報はSOGと並行して取り、失敗しても表示は止めない。
  assert.match(viewer, /const camerasRequest = camerasUrl/);
  assert.match(viewer, /return parseCaptureCameras\(await response\.json\(\)\);/);
});

test("opens a shared space straight from ?id= without touching the sample", async () => {
  const viewer = await readFile(new URL("../app/SogViewer.tsx", import.meta.url), "utf8");

  // 起動時の分岐はどちらか一方だけを呼ぶ。`?id=` のときにサンプルを読むと
  // fetch・decode・GPU転送が二重に走るので、そこを固定しておく。
  assert.match(viewer, /const deepLinkShareUrl = shareUrlFromShareId\(readShareId\(window\.location\.href\) \?\? ""\)/);
  assert.match(viewer, /if \(deepLinkShareUrl\) void loadSource\(\{ kind: "url", value: deepLinkShareUrl \}, true\);/);
  assert.match(viewer, /else void loadSample\(true\);/);
  // サンプルの取得はこの1箇所だけ。深いリンク経路からは辿り着けない。
  assert.equal(viewer.match(/downloadSog\(SAMPLE_URL/g)?.length, 1);

  // 共有IDは表示中のソースに残し、ラベルの読み直しでは判断しない。
  assert.match(viewer, /type ViewerSource = \{ kind: SourceKind; label: string; shareId\?: string \}/);
  assert.match(
    viewer,
    /showOriginal\(\s*\n\s*\{ kind: request\.kind === "file" \? "file" : "url", label, shareId \},\s*\n\s*buffer,\s*\n\s*await camerasRequest,/,
  );
  // サンプルは共有IDを持たない。ローカルファイルと直接URLも shareId が undefined のまま。
  assert.match(viewer, /showOriginal\(\{ kind: "sample", label: SAMPLE_LABEL \}, buffer\)/);
  assert.match(viewer, /shareId = share\.shareId/);

  // 成功したロードのたびにアドレスバーを合わせる。Insta360由来でなければ id を消す。
  assert.match(viewer, /const next = shareId \? permalinkFor\(href, shareId, pose\) : hrefWithoutShareId\(href\)/);
  assert.match(viewer, /window\.history\.replaceState\(null, "", next\)/);
  // アドレスバーへ残すのはユーザーが指定した視点だけ。公式Home Viewは載せない。
  assert.match(viewer, /syncPermalink\(next\.shareId, linkedView\)/);
  // 署名付きURLはアドレスバーへ出さない。載せるのは共有IDだけ。
  assert.doesNotMatch(viewer, /replaceState\([^)]*assetUrl/);

  // 同じ空間を二度読まない。共有IDとSOGのURLで鍵を作り、表示中／読み込み中を見る。
  assert.match(viewer, /return `share:\$\{share\.shareId\}`/);
  assert.match(viewer, /if \(key && \(key === loadingKey \|\| key === shownKey\)\)/);

  // 共有由来のときだけリンクのコピーを出す。空間そのものと、いまの視点の2種類。
  assert.match(viewer, /source\.shareId && \(/);
  assert.match(viewer, /この空間のリンクをコピー/);
  assert.match(viewer, /この視点のリンクをコピー/);
  assert.match(viewer, /navigator\.clipboard\.writeText\(permalink\)/);
  assert.match(viewer, /permalinkFor\(window\.location\.href, shareId, pose\)/);
  assert.match(viewer, /✓ コピーしました/);
});

test("restores the linked view on desktop and spawns XR from the rig", async () => {
  const [viewer, pose, capture] = await Promise.all([
    readFile(new URL("../app/SogViewer.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/view-pose.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/capture-view.ts", import.meta.url), "utf8"),
  ]);

  // 初期視点の優先順位は `view=` → 公式Home View → bounds。Desktopもここを通る。
  assert.match(viewer, /const linkedView = linkedViewFor\(next\.shareId\);/);
  assert.match(viewer, /const initialView = linkedView \?\? homeViewFor\(cameras, framedBounds\);/);
  assert.match(viewer, /if \(initialView\) applyViewPose\(initialView\);\s*\n\s*else frameBounds\(framedBounds\);/);
  // `view=` は共有IDが一致する空間にだけ効く。別の空間へ持ち越さない。
  assert.match(viewer, /if \(readShareId\(href\) !== shareId\) return null;/);
  assert.match(viewer, /return readViewPose\(href\);/);

  // リンクに載せるのはworld空間の姿勢。rig移動やpanのあとでも同じ値になる。
  assert.match(viewer, /const eye = cameraEntity\.getPosition\(\)/);
  assert.match(viewer, /yaw: yawDegreesFromBasis\(forward, cameraEntity\.up\)/);
  assert.match(viewer, /pitch: pitchDegreesFromForward\(forward\)/);
  // 復元はrigを原点へ戻し、eyeから注視点を割り出す。
  assert.match(viewer, /const target = orbitTargetOf\(\{/);

  // XRはDesktopで見えている視点から始める。開始時に控え、rigは一度identityへ。
  assert.match(viewer, /const desktopView = currentViewPose\(\);\s*\n\s*pendingXrSpawn = desktopView;/);
  // HMD poseが入ったフレームで1回だけrigを補正する。camera へは書かない。
  assert.match(viewer, /logXrSpawn\(\);\s*\n\s*applyXrSpawn\(\);/);
  assert.match(viewer, /const head = cameraEntity\.getLocalPosition\(\)/);
  assert.match(viewer, /const rigPose = xrRigOffset\(desired, \{/);
  assert.match(viewer, /rig\.setLocalPosition\(rigPose\.x, rigPose\.y, rigPose\.z\)/);
  assert.match(viewer, /rig\.setLocalEulerAngles\(0, rigPose\.yaw, 0\)/);
  assert.match(viewer, /pendingXrSpawn = null;/);
  // XR中の姿勢はXRセッションのものだけ。保存poseをcameraへ直接書かない。
  assert.doesNotMatch(viewer, /cameraEntity\.setPosition\(/);
  assert.doesNotMatch(viewer, /cameraEntity\.setRotation\(/);
  // 合わせるのは水平yawだけ。pitch / roll はHMDのまま。
  assert.match(pose, /const yaw = normalizeYawDegrees\(desired\.yaw - head\.yaw\)/);
  assert.match(pose, /y: desired\.y - rotated\.y/);
  // local-floorはXRSPACE_LOCALFLOORのまま。高さは差分で入れる。
  assert.match(viewer, /XRSPACE_LOCALFLOOR/);
  // VR開始前のDesktop視点は別に控え、XR終了・開始失敗の両方でそこへ戻す。
  // rigをゼロにするだけだと、WASDで入っていた移動量ごと視点を失う。
  assert.match(viewer, /let desktopReturnView: ViewPose \| null = null;/);
  assert.match(viewer, /desktopReturnView = desktopView;/);
  assert.match(viewer, /const restoreDesktopView = \(\) => \{/);
  assert.match(viewer, /desktopReturnView = null;\s*\n\s*applyViewPose\(view\);/);
  assert.equal(viewer.match(/restoreDesktopView\(\);/g)?.length, 2);
  assert.doesNotMatch(viewer, /setInXr\(false\);[\s\S]{0,400}rig\.setLocalPosition\(0, 0, 0\)/);

  // 公式Home Viewは `cameras.json` から組み立てる。splatと同じ変換を通すので、
  // 配置は `applyPlacement` と同じ `splatPlacement` を見る。
  assert.match(viewer, /captureHomeView\(cameras, splatPlacement\(bounds\)\)/);
  assert.match(viewer, /const placement = splatPlacement\(bounds\);/);
  assert.match(capture, /export function captureHomeView\(/);
  assert.match(capture, /worldFromCapturePoint\(cameras\[0\]\.position, placement\)/);
  // 画角も撮影時のものへ合わせる。取れない空間では既定値のまま。
  assert.match(viewer, /applyCaptureFov\(cameras \? captureFovOf\(cameras\) : null\)/);
  assert.match(viewer, /camera\.fov = captureFov \? responsiveFovDegrees\(captureFov, width, height\) : DEFAULT_FOV;/);

  // 実機の突き合わせ用ログは `?debug=1` のときだけ。既定では何も出さない。
  assert.match(viewer, /const xrDebug = new URLSearchParams\(window\.location\.search\)\.get\("debug"\) === "1"/);
  assert.match(viewer, /if \(xrDebug\) \{/);
  // 初期視点の根拠（`cameras.json` が届いたか）も同じフラグで出す。
  assert.match(viewer, /console\.info\("\[sog-xr\] initial"/);
  assert.equal(viewer.match(/console\.info/g)?.length, 3);
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
