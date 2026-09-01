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
  assert.match(
    viewer,
    /useState<ViewerSource>\(\{\s*\n\s*kind: "sample",\s*\n\s*provider: "sample",\s*\n\s*format: "sog",\s*\n\s*label: SAMPLE_LABEL,\s*\n\s*\}\)/,
  );
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
  assert.match(viewer, /splatComponent\.asset = entry\.asset/);
  assert.match(viewer, /app\.assets\.remove\(entry\.asset\)/);
  assert.match(viewer, /releaseEntry\(previous\)/);
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
  assert.match(viewer, /const deepLink = readSpaceRef\(window\.location\.href\);/);
  assert.match(viewer, /\? shareUrlFromShareId\(deepLink\.id\)/);
  assert.match(viewer, /\? sceneUrlFromSceneId\(deepLink\.id\)/);
  // URL参照はそのまま `loadSource` へ渡す。`.sog` かコンテナかは通常の
  // 読み込みと同じ経路が決める。
  assert.match(viewer, /: deepLink\.url;/);
  assert.match(viewer, /if \(deepLinkUrl\) void loadSource\(\{ kind: "url", value: deepLinkUrl \}, true\);/);
  assert.match(viewer, /else void loadSample\(true\);/);
  // サンプルの取得はこの1箇所だけ。深いリンク経路からは辿り着けない。
  assert.equal(viewer.match(/downloadSog\(SAMPLE_URL/g)?.length, 1);

  // 出どころは表示中のソースにproviderとして残し、ラベルの読み直しでは判断しない。
  assert.match(
    viewer,
    /type SourceProvider = "sample" \| "file" \| "direct" \| "insta360" \| "supersplat" \| "kiss-gs";/,
  );
  assert.match(viewer, /provider: SourceProvider;/);
  // 中身の形式も同じように明示で持つ。SOGとSOG-XTはどちらも `meta.json` を
  // 名乗るので、後からURLやラベルの文字列で見分けにいかない。
  assert.match(viewer, /type SourceFormat = "sog" \| "sog-xt";/);
  assert.match(viewer, /format: SourceFormat;/);
  assert.match(viewer, /const next: ViewerSource = \{\s*\n\s*kind: request\.kind === "file" \? "file" : "url",\s*\n\s*provider,/);
  // サンプルは共有IDを持たない。ローカルファイルと直接URLも shareId が undefined のまま。
  assert.match(
    viewer,
    /\{ kind: "sample", provider: "sample", format: "sog", label: SAMPLE_LABEL \},/,
  );
  assert.match(viewer, /shareId = share\.shareId/);

  // resolverを通さない空間は、正規化したアセットURLで指す。KISS-GS専用の
  // 分岐は増やさず、`?url=` ひとつに寄せる。
  assert.match(viewer, /canonicalUrl\?: string;/);
  assert.match(
    viewer,
    /if \(source\.kind === "url" && source\.canonicalUrl\) \{\s*\n(?:\s*\/\/.*\n)*\s*const url = canonicalSpaceUrl\(source\.canonicalUrl\);/,
  );
  assert.match(viewer, /if \(url\) return \{ provider: "url", url \};/);
  // SOG-XTは入力がディレクトリでも、解決した meta.json のURLを共有する。
  assert.match(viewer, /canonicalUrl = metadataUrl;/);
  assert.match(viewer, /fetchUrl = direct\.toString\(\);\s*\n\s*canonicalUrl = fetchUrl;/);
  // サンプルとローカルファイルは共有しない。どちらも canonicalUrl を持たない。
  assert.doesNotMatch(viewer, /canonicalUrl: SAMPLE_URL|canonicalUrl = file/);

  // 成功したロードのたびにアドレスバーを合わせる。載せられない空間では id / ss を消す。
  assert.match(viewer, /const next = space \? permalinkFor\(href, space, pose\) : hrefWithoutSpace\(href\)/);
  assert.match(viewer, /window\.history\.replaceState\(null, "", next\)/);
  // アドレスバーへ残すのはユーザーが指定した視点だけ。公式Home Viewは載せない。
  assert.match(viewer, /syncPermalink\(space, linkedView\)/);
  // 署名付きURLはアドレスバーへ出さない。載せるのは共有IDか、ユーザーが
  // 入力したアセットURLを正規化したものだけ。
  assert.doesNotMatch(viewer, /replaceState\([^)]*assetUrl/);

  // 同じ空間を二度読まない。共有ID・シーンID・SOGのURLで鍵を作り、表示中／読み込み中を見る。
  assert.match(viewer, /return `share:\$\{share\.shareId\}`/);
  assert.match(viewer, /return `supersplat:\$\{scene\.sceneId\}`/);
  assert.match(viewer, /if \(key && \(key === loadingKey \|\| key === shownKey\)\)/);

  // 共有由来のときだけリンクのコピーを出す。空間そのものと、いまの視点の2種類。
  assert.match(viewer, /\{space && \(/);
  assert.match(viewer, /この空間のリンクをコピー/);
  assert.match(viewer, /この視点のリンクをコピー/);
  assert.match(viewer, /navigator\.clipboard\.writeText\(permalink\)/);
  assert.match(viewer, /permalinkFor\(window\.location\.href, space, pose\)/);
  assert.match(viewer, /✓ コピーしました/);
});

test("restores the linked view on desktop and spawns XR from the rig", async () => {
  const [viewer, pose, capture] = await Promise.all([
    readFile(new URL("../app/SogViewer.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/view-pose.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/capture-view.ts", import.meta.url), "utf8"),
  ]);

  // 初期視点の優先順位は `view=` → 公式Home View → bounds。Desktopもここを通る。
  assert.match(viewer, /const linkedView = linkedViewFor\(space\);/);
  assert.match(viewer, /const initialView = linkedView \?\? homeViewFor\(cameras, framedBounds\);/);
  assert.match(viewer, /if \(initialView\) applyViewPose\(initialView\);\s*\n\s*else frameBounds\(framedBounds\);/);
  // `view=` は共有IDが一致する空間にだけ効く。別の空間へ持ち越さない。
  assert.match(viewer, /if \(!isSameSpace\(readSpaceRef\(href\), space\)\) return null;/);
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
  // 立たせる先はDesktopのeyeそのものではなく、見下ろし角を見られる範囲まで
  // 戻した位置。pitchはHMDが持つので再現できず、急な見下ろし視点をeyeへ
  // そのまま置くと被写体の上を通り越してしまう。
  assert.match(viewer, /const desired = xrSpawnPose\(pendingXrSpawn\);/);
  assert.match(viewer, /const rigPose = xrRigOffset\(desired, \{/);
  // 上限内の視点はeyeのまま返す。既に配ってあるリンクの立ち位置は変わらない。
  assert.match(pose, /export const XR_SPAWN_PITCH_LIMIT = \d+;/);
  assert.match(
    pose,
    /if \(pitch === pose\.pitch\) return \{ x: pose\.x, y: pose\.y, z: pose\.z, yaw: pose\.yaw \};/,
  );
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
  assert.match(viewer, /const placement = splatPlacementFor\(bounds, placementTransform\);/);
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
  // SOG-XTの内訳とベンチマークも同じフラグの下だけ。
  assert.match(viewer, /console\.info\("\[sog-xr\] sog-xt"/);
  assert.match(viewer, /console\.info\("\[sog-xr\] benchmark"/);
  assert.equal(viewer.match(/console\.info/g)?.length, 5);
});

test("decodes KISS-GS SOG-XT in a worker and hands PlayCanvas the attributes directly", async () => {
  const [viewer, decoder, bridge, worker, image] = await Promise.all([
    readFile(new URL("../app/SogViewer.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/sog-xt.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/sog-xt-playcanvas.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/sog-xt.worker.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/sog-image.ts", import.meta.url), "utf8"),
  ]);

  // SOG-XT固有の処理はSogViewer.tsxの外。ここが薄いままであることを縛る。
  assert.match(viewer, /import \{ createSogXtResource \} from "\.\/sog-xt-playcanvas"/);
  assert.match(viewer, /await showSogXt\(\s*\n\s*next,\s*\n\s*sogXtMetadataUrl,/);
  assert.doesNotMatch(viewer, /signedExpm1|observedRange|centroidSide/);

  // 判定は取得した meta.json の `format`。URLやラベルの文字列では決めない。
  assert.match(viewer, /const isSogXt = await probeSogXt\(metadataUrl\)|isSogXt = await probeSogXt\(metadataUrl\)/);
  assert.match(viewer, /return isSogXtMetadata\(payload\)/);
  assert.match(decoder, /export const SOG_XT_FORMAT = "sog-xt"/);
  assert.match(decoder, /input\.format !== SOG_XT_FORMAT/);
  // PlayCanvas標準のSOGは従来どおりPlayCanvasのローダーへ回す。
  assert.match(viewer, /remote = \{ url: metadataUrl, filename: "meta\.json" \}/);

  // デコードはWorkerで、画素の読み出しは既存のImageReaderを共有する。
  assert.match(viewer, /new Worker\(new URL\("\.\/sog-xt\.worker\.ts", import\.meta\.url\)/);
  assert.match(worker, /import \{ createImageReader, type ImageReader \} from "\.\/sog-image\.ts"/);
  assert.match(image, /export function createImageReader\(\)/);
  assert.match(image, /UNPACK_PREMULTIPLY_ALPHA_WEBGL, false/);
  // 属性配列はTransferableで返す。main threadでのコピーは起きない。
  assert.match(worker, /worker\.postMessage\(result, transferablesOf\(result\.decoded\)\)/);
  // Workerは読み込みごとの使い捨て。使い回すと、途中で空間を切り替えたときに
  // 前の読み込みの応答が後の読み込みのハンドラへ届く。
  assert.match(viewer, /cancelSogXt\(new Error\(SOG_XT_SUPERSEDED\)\);\s*\n\s*const worker = new Worker/);
  assert.match(viewer, /if \(!isCurrent\(\)\) return;\s*\n\s*onStage\("PlayCanvasへ転送中"/);
  // デコード中は描画を止める。表示中の空間を描いているコンテキストとGPUを
  // 取り合うと、Workerの `readPixels` が桁で遅くなる。
  assert.match(viewer, /const wasAutoRendering = app\.autoRender;\s*\n\s*app\.autoRender = false;/);
  assert.match(viewer, /\} finally \{\s*\n\s*app\.autoRender = wasAutoRendering;/);

  // 中間PLYは作らない。GSplatData / GSplatResource をそのまま使う。
  assert.match(bridge, /import \{ GSplatData, GSplatResource \} from "playcanvas"/);
  assert.match(bridge, /return new GSplatResource\(device, data\)/);
  assert.match(viewer, /splatComponent\.resource = entry\.resource/);
  // 中間表現を作っていないことは「Blob・object URL・Assetを一切作らない」で縛る。
  // PLYを挟むならこのどれかが必ず要る。
  assert.doesNotMatch(bridge, /new Blob|createObjectURL|new Asset/);
  assert.doesNotMatch(worker, /new Blob|createObjectURL|new Asset/);

  // activated形式で渡す。落とすとscaleがexpで巨大になり、opacityが飽和する。
  assert.match(bridge, /data\.activated = true/);
  // quaternionはxyzwで持ち、PlayCanvasのwxyz（rot_0 = w）へ並べ替える。
  assert.match(bridge, /prop\("rot_0", slice\(decoded\.rotation, 3\)\)/);

  // 既存のVR optimizerはSOG-XTには掛けない。理由は画面に出す。
  assert.match(viewer, /const SOG_XT_OPTIMIZE_REASON =/);
  assert.match(viewer, /SOG_XT_OPTIMIZE_REASON,/);
  // 既存のoptimizerとその経路はそのまま残っている。
  assert.match(viewer, /new Worker\(new URL\("\.\/sog-optimizer\.worker\.ts", import\.meta\.url\)/);
  assert.match(viewer, /chooseSplatIndices|runOptimizer/);

  // エラーは段階ごとに区別する。表示は日本語、元のエラーはdebug consoleへ。
  for (const code of [
    "METADATA_DOWNLOAD_FAILED",
    "METADATA_INVALID",
    "UNSUPPORTED_VERSION",
    "IMAGE_DOWNLOAD_FAILED",
    "IMAGE_DECODE_FAILED",
    "INCONSISTENT_SPLAT_COUNT",
    "UNSUPPORTED_SH",
    "RESOURCE_CREATION_FAILED",
  ]) {
    assert.match(decoder, new RegExp(`${code}:`));
  }
  assert.match(viewer, /console\.warn\("\[sog-xr\] sog-xt error", message\.code, message\.detail\)/);

  // 計測は performance.mark / measure も併用する。
  assert.match(viewer, /performance\.measure\?\.\("sog-xt:load"/);
  assert.match(worker, /performance\.measure\?\.\("sog-xt:worker"/);
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
