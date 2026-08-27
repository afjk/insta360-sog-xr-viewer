"use client";

import { useEffect, useRef, useState } from "react";
import {
  Application,
  Asset,
  CameraComponent,
  Color,
  Entity,
  FILLMODE_NONE,
  GSplatComponent,
  GSPLAT_RENDERER_RASTER_CPU_SORT,
  RESOLUTION_AUTO,
  Vec3,
  XRHAND_LEFT,
  XRHAND_RIGHT,
  XRSPACE_LOCALFLOOR,
  XRTYPE_VR,
} from "playcanvas";
import {
  isSpatialAssetUrl,
  parseInsta360ShareUrl,
  shareUrlFromShareId,
  toAbsoluteUrl,
} from "./insta360";
import {
  SUPERSPLAT_ERROR_MESSAGES,
  parseSuperSplatUrl,
  sceneUrlFromSceneId,
  type SuperSplatErrorCode,
  type SuperSplatLicense,
  type SuperSplatResolution,
} from "./supersplat";
import { resolverConfig } from "./resolver-config";
import {
  hrefWithoutSpace,
  isSameSpace,
  permalinkFor,
  readSpaceRef,
  readViewPose,
  type SpaceRef,
} from "./permalink";
import {
  normalizeYawDegrees,
  orbitTargetOf,
  pitchDegreesFromForward,
  xrRigOffset,
  yawDegreesFromBasis,
  type HorizontalPose,
  type ViewPose,
} from "./view-pose";
import {
  INSTA360_PLACEMENT,
  SUPERSPLAT_PLACEMENT,
  boxCentre,
  captureFovOf,
  captureHomeView,
  parseCaptureCameras,
  responsiveFovDegrees,
  splatBoundsFromCenters,
  splatPlacement,
  splatPlacementFor,
  worldFromCapturePointFor,
  type CaptureCamera,
  type CaptureFov,
  type PlacementTransform,
  type SplatBounds,
} from "./capture-view";
import { optimizationUnsupportedReason } from "./sog-image";
import {
  DEFAULT_TARGET_SPLATS,
  OPTIMIZER_VERSION,
  TARGET_SPLAT_PRESETS,
  cacheKey,
  sha256Hex,
  type OptimizeSettings,
} from "./sog-optimizer";
import type { OptimizeMessage, OptimizeRequest } from "./sog-optimizer.worker";
import { readCachedOptimization, writeCachedOptimization } from "./sog-cache";

type ViewerStatus = "loading" | "ready" | "error";
type VrVariant = "original" | "optimized";
type SourceKind = "sample" | "url" | "file";
/**
 * 空間の出どころ。
 *
 * `kind` は「どう渡されたか」、`provider` は「どこの何か」。座標変換・
 * パーマリンク・ライセンス表示はすべて `provider` で決める。ラベル文字列や
 * URLの形から後で提供元を推測しない。
 */
type SourceProvider = "sample" | "file" | "direct" | "insta360" | "supersplat";
/** SuperSplat由来の空間に付く、公開ページから取れた情報。 */
type SuperSplatSource = {
  sceneId: string;
  pageUrl: string;
  title: string;
  author: string;
  license: SuperSplatLicense | null;
};
type ViewerSource = {
  kind: SourceKind;
  provider: SourceProvider;
  label: string;
  /** Insta360共有由来のときだけ入る。 */
  shareId?: string;
  /** SuperSplat由来のときだけ入る。 */
  supersplat?: SuperSplatSource;
};
type LoadRequest = { kind: "url"; value: string } | { kind: "file"; file: File };
type Bounds = SplatBounds;
// コピーできるリンクは2種類。「この空間のリンク」(`?id=`) と
// 「この視点のリンク」(`?id=…&view=`)。結果の表示はボタンごとに出し分ける。
type CopyTarget = "space" | "view";
type CopyState = { target: CopyTarget; state: "done" | "error" } | null;
type OptimizedInfo = { splats: number; bytes: number; fromCache: boolean; targetSplats: number };

const SAMPLE_URL = "capture.sog";
const SAMPLE_KEY = "sample";
const SAMPLE_LABEL = "サンプル空間 capture.sog";
// Percentile bounds (2–98%) decoded from capture.sog. A handful of distant
// outliers in the raw bounds are intentionally ignored when placing the room.
const CAPTURE_MIN = new Vec3(-6.911, -1.263, -3.762);
const CAPTURE_MAX = new Vec3(6.178, 1.654, 3.802);
// サンプルは中央値を持たないので、箱の中点をそのまま中心として使う。
const CAPTURE_BOUNDS: Bounds = {
  min: CAPTURE_MIN,
  max: CAPTURE_MAX,
  centre: boxCentre({ min: CAPTURE_MIN, max: CAPTURE_MAX }),
};
const INITIAL_PITCH = 0.08;
// 撮影画角が分からない空間で使う既定の垂直画角。Insta360共有から
// `cameras.json` が取れたときは、そちらの画角へ置き換える。
const DEFAULT_FOV = 58;
const UP = new Vec3(0, 1, 0);
const RAD_TO_DEG = 180 / Math.PI;
const DEG_TO_RAD = Math.PI / 180;
// Desktopの視点操作。回転の中心は部屋の中心に置き、そこから部屋の半径に対する
// 比率だけカメラを引く。360度キャプチャの内側に留まったまま中心を軸に回れる距離。
// サンプル（半径約6.5m）で約2mになる比率。
const ORBIT_DISTANCE_RATIO = 0.3;
const ORBIT_DISTANCE_RANGE = { min: 1, max: 6 };
const DOLLY_RANGE = { min: 0.35, max: 48 };
// 真上・真下でカメラの向きが定まらなくなるので、その手前で止める。
const MAX_PITCH = 1.45;
const ORBIT_SPEED = { yaw: 0.006, pitch: 0.004 };
// ホイール1ノッチ（deltaY≈100）で距離が約13%変わる。
const DOLLY_SPEED = 0.0012;
const WHEEL_LINE_HEIGHT = 16;
// 描画設定はVRで表示する版に合わせる。軽量版は解像度を下げてフォービエイションを強める。
const VR_RENDER_PROFILE: Record<VrVariant, { framebufferScaleFactor: number; foveation: number }> = {
  original: { framebufferScaleFactor: 0.78, foveation: 0.55 },
  optimized: { framebufferScaleFactor: 0.52, foveation: 0.82 },
};

// 解決エンドポイントの有無はビルド時に決まるので、一度だけ読めばよい。
const SHARE_RESOLVER = resolverConfig();

// unbundled SOG（`meta.json` ＋ WebP群）はViewerが元データをひと続きのバイト列
// として持っていない。いまのoptimizerはArrayBufferを前提にしているので、この
// 形の空間では軽量化を出さない。Originalのままなら通常どおり表示できる。
const UNBUNDLED_OPTIMIZE_REASON =
  "このSuperSplat形式（meta.json + WebP）では現在VR向け軽量化を利用できません。";

/**
 * 表示中の空間をパーマリンクの形で指す。載せられない出どころでは `null`。
 *
 * サンプル・ローカルファイル・`.sog` の直接URLは、別の端末で開き直せる
 * 恒久的な識別子を持たないのでリンクを作らない。
 */
const spaceRefOf = (source: ViewerSource): SpaceRef | null => {
  if (source.provider === "insta360" && source.shareId) {
    return { provider: "insta360", id: source.shareId };
  }
  if (source.provider === "supersplat" && source.supersplat) {
    return { provider: "supersplat", id: source.supersplat.sceneId };
  }
  return null;
};

/**
 * 提供元ごとの座標変換。
 *
 * SuperSplatだけ別の回転で、それ以外——サンプル・ローカルファイル・`.sog` の
 * 直接URL・Insta360共有——は従来どおりInsta360の変換のまま。既に配ってある
 * リンクの見え方を変えないため。
 */
const placementTransformOf = (provider: SourceProvider): PlacementTransform =>
  provider === "supersplat" ? SUPERSPLAT_PLACEMENT : INSTA360_PLACEMENT;

/** resolverのエラー応答を、画面に出す日本語へ直す。 */
const superSplatErrorMessage = (
  payload: { error?: string; code?: string } | null,
  status: number,
): string => {
  const code = payload?.code;
  if (code && Object.prototype.hasOwnProperty.call(SUPERSPLAT_ERROR_MESSAGES, code)) {
    return SUPERSPLAT_ERROR_MESSAGES[code as SuperSplatErrorCode];
  }
  return payload?.error ?? `SuperSplatのシーンを解決できませんでした (HTTP ${status})`;
};

const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value));

const formatSplats = (count: number | null) =>
  count === null ? "—" : count.toLocaleString("ja-JP");

const formatBytes = (bytes: number) => `${(bytes / 1_048_576).toFixed(1)} MB`;

const stickAxis = (axes: readonly number[], axis: "x" | "y") => {
  const value = axes.length >= 4 ? axes[axis === "x" ? 2 : 3] : axes[axis === "x" ? 0 : 1];
  return Math.abs(value ?? 0) < 0.16 ? 0 : (value ?? 0);
};

const gamepadButtonPressed = (buttons: readonly GamepadButton[], index: number) => {
  const button = buttons[index];
  return Boolean(button?.pressed || (button?.value ?? 0) > 0.5);
};

const boundsFromResource = (resource: unknown): Bounds | null => {
  const splat = resource as
    | { centers?: Float32Array | null; aabb?: { getMin(): Vec3; getMax(): Vec3 } | null }
    | null
    | undefined;
  const centers = splat?.centers;
  if (centers && centers.length >= 3) {
    const bounds = splatBoundsFromCenters(centers);
    if (bounds) return bounds;
  }
  const aabb = splat?.aabb;
  if (!aabb) return null;
  const box = { min: aabb.getMin().clone(), max: aabb.getMax().clone() };
  return { ...box, centre: boxCentre(box) };
};

const splatCountOf = (resource: unknown): number | null => {
  const splat = resource as
    | { gsplatData?: { numSplats?: number } | null; centers?: Float32Array | null }
    | null
    | undefined;
  const declared = splat?.gsplatData?.numSplats;
  if (typeof declared === "number" && declared > 0) return declared;
  const centers = splat?.centers;
  return centers ? Math.floor(centers.length / 3) : null;
};

export function SogViewer() {
  const viewportRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  // 「この視点のリンクをコピー」から、いま見えている視点を読むための橋渡し。
  const currentViewRef = useRef<() => ViewPose | null>(() => null);
  const prepareVrRef = useRef<(variant: VrVariant) => void>(() => undefined);
  const startVrRef = useRef<() => void>(() => undefined);
  const loadSourceRef = useRef<(request: LoadRequest) => void>(() => undefined);
  const restoreSampleRef = useRef<() => void>(() => undefined);
  // 目標splat数とVRの選択はエフェクトを作り直さずに読みたいのでrefで渡す。
  const targetSplatsRef = useRef(DEFAULT_TARGET_SPLATS);
  const vrVariantRef = useRef<VrVariant>("optimized");
  const [status, setStatus] = useState<ViewerStatus>("loading");
  const [progress, setProgress] = useState(0);
  const [xrAvailable, setXrAvailable] = useState(false);
  const [inXr, setInXr] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");
  const [vrOpen, setVrOpen] = useState(false);
  const [vrVariant, setVrVariant] = useState<VrVariant>("optimized");
  const [vrReady, setVrReady] = useState(false);
  const [targetSplats, setTargetSplats] = useState(DEFAULT_TARGET_SPLATS);
  const [originalSplats, setOriginalSplats] = useState<number | null>(null);
  const [optimized, setOptimized] = useState<OptimizedInfo | null>(null);
  const [optimizeStage, setOptimizeStage] = useState("");
  const [optimizeRatio, setOptimizeRatio] = useState(0);
  const [optimizeError, setOptimizeError] = useState("");
  const [optimizeUnsupported, setOptimizeUnsupported] = useState<string | null>(null);
  // 表示中の空間の形が理由でVR向け軽量化を出せない場合の説明。端末側の理由
  // (`optimizeUnsupported`) とは別に持ち、空間を切り替えるたびに更新する。
  const [optimizeSourceReason, setOptimizeSourceReason] = useState<string | null>(null);
  const [source, setSource] = useState<ViewerSource>({
    kind: "sample",
    provider: "sample",
    label: SAMPLE_LABEL,
  });
  const [openOpen, setOpenOpen] = useState(false);
  const [openInput, setOpenInput] = useState("");
  // 読み込み中の対象名。表示中の空間 (`source`) はロードが終わってから
  // 差し替わるので、その間の見出しはこちらを使う。
  const [pendingLabel, setPendingLabel] = useState("");
  const [copyState, setCopyState] = useState<CopyState>(null);
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [sourceStage, setSourceStage] = useState("");
  const [sourceProgress, setSourceProgress] = useState(0);
  const [sourceError, setSourceError] = useState("");
  const [dragActive, setDragActive] = useState(false);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;

    let disposed = false;
    // 左ドラッグは回転、右／中ドラッグとShift+左ドラッグは平行移動。
    let dragMode: "orbit" | "pan" | null = null;
    let dragPointerId = -1;
    let lastX = 0;
    let lastY = 0;
    let yaw = 0;
    let pitch = INITIAL_PITCH;
    let distance = 2.8;
    const pressedKeys = new Set<string>();
    // 回転の中心。rigの子であるカメラと同じ座標系なので、rig座標で持つ。
    const desktopTarget = new Vec3(0, 1.5, 0);

    const canvas = document.createElement("canvas");
    canvas.className = "sog-canvas";
    canvas.setAttribute("aria-label", "Insta360 Spatial Capture 3D viewer");
    viewport.appendChild(canvas);

    const app = new Application(canvas, {
      graphicsDeviceOptions: {
        antialias: false,
        alpha: false,
        powerPreference: "high-performance",
      },
    });
    app.setCanvasFillMode(FILLMODE_NONE);
    app.setCanvasResolution(RESOLUTION_AUTO);
    app.graphicsDevice.maxPixelRatio = Math.min(window.devicePixelRatio, 1.5);
    app.scene.gsplat.renderer = GSPLAT_RENDERER_RASTER_CPU_SORT;
    app.scene.gsplat.radialSorting = true;
    const xr = app.xr;
    if (!xr) throw new Error("WebXR manager could not be initialized.");

    const rig = new Entity("viewer-rig");
    app.root.addChild(rig);

    const cameraEntity = new Entity("xr-camera");
    cameraEntity.addComponent("camera", {
      clearColor: new Color(0.0196, 0.0275, 0.0392),
      fov: DEFAULT_FOV,
      nearClip: 0.01,
      farClip: 500,
    });
    rig.addChild(cameraEntity);
    const camera = cameraEntity.camera as CameraComponent;
    // 表示中の空間の撮影画角。`cameras.json` が取れたときだけ入る。
    let captureFov: CaptureFov | null = null;

    /**
     * 表示領域に合わせて垂直画角を決め直す。
     *
     * 撮影画角は水平・垂直の組で来るので、画面の縦横比によってどちらを
     * 基準にするかが変わる。撮影画角が無い空間では既定値のまま。
     * XR中は画角をHMDが決めるので、ここでは触らない。
     */
    const applyFov = (width: number, height: number) => {
      camera.fov = captureFov ? responsiveFovDegrees(captureFov, width, height) : DEFAULT_FOV;
    };

    /** 読み込んだ空間の撮影画角へ切り替える。無ければ既定値へ戻す。 */
    const applyCaptureFov = (fov: CaptureFov | null) => {
      captureFov = fov;
      applyFov(Math.max(1, viewport.clientWidth), Math.max(1, viewport.clientHeight));
    };

    const worldTarget = new Vec3();
    const updateDesktopCamera = () => {
      const cosPitch = Math.cos(pitch);
      cameraEntity.setLocalPosition(
        desktopTarget.x + distance * Math.sin(yaw) * cosPitch,
        desktopTarget.y + distance * Math.sin(pitch),
        desktopTarget.z + distance * Math.cos(yaw) * cosPitch,
      );
      worldTarget.add2(desktopTarget, rig.getPosition());
      cameraEntity.lookAt(worldTarget);
    };
    updateDesktopCamera();

    /**
     * いま見えている視点を、リンクにもXRにも使える一意な形で取り出す。
     *
     * Viewerの内部状態は `desktopTarget`（rig座標）と rig の位置に分かれていて、
     * WASDで移動したあとは同じ `desktopTarget` でも別の場所を指す。ここでは
     * カメラのworld姿勢そのものから読むので、どう動かしたあとでも
     * 「実際に見えている場所」が取れる。
     */
    const currentViewPose = (): ViewPose => {
      const eye = cameraEntity.getPosition();
      const forward = cameraEntity.forward;
      return {
        x: eye.x,
        y: eye.y,
        z: eye.z,
        yaw: yawDegreesFromBasis(forward, cameraEntity.up),
        pitch: pitchDegreesFromForward(forward),
        distance,
      };
    };

    const splatEntity = new Entity("sog-space");
    // 表示中の空間の座標変換。読み込むたびにその提供元のものへ差し替える。
    // 既定はInsta360（サンプルもこの向きで表示してきた）。
    let placementTransform: PlacementTransform = INSTA360_PLACEMENT;
    splatEntity.setLocalEulerAngles(
      placementTransform.eulerAngles.x,
      placementTransform.eulerAngles.y,
      placementTransform.eulerAngles.z,
    );
    app.root.addChild(splatEntity);

    /** 回転後に部屋が原点に中心し、床がy=0に来るよう配置する。 */
    const applyPlacement = (bounds: Bounds) => {
      const placement = splatPlacementFor(bounds, placementTransform);
      const { x, y, z } = placementTransform.eulerAngles;
      splatEntity.setLocalEulerAngles(x, y, z);
      splatEntity.setLocalPosition(placement.x, placement.y, placement.z);
    };

    const resetView = (target: Vec3, nextDistance: number) => {
      desktopTarget.copy(target);
      distance = nextDistance;
      yaw = 0;
      pitch = INITIAL_PITCH;
      pressedKeys.clear();
      rig.setLocalPosition(0, 0, 0);
      rig.setLocalEulerAngles(0, 0, 0);
      updateDesktopCamera();
    };

    /**
     * 保存されたworld空間の視点をDesktopのカメラへ戻す。
     *
     * rigを原点へ戻したうえで、rig座標＝world座標として組み直す。カメラは
     * 注視点からの相対で置かれているので、保存したeyeとyaw/pitch/distanceから
     * 逆に注視点を割り出して `desktopTarget` に入れる。こうすると復元直後の
     * Orbit操作も、リンクを作った側と同じ中心を回る。
     */
    const applyViewPose = (pose: ViewPose) => {
      yaw = pose.yaw * DEG_TO_RAD;
      pitch = clamp(pose.pitch * DEG_TO_RAD, -MAX_PITCH, MAX_PITCH);
      distance = clamp(pose.distance, DOLLY_RANGE.min, DOLLY_RANGE.max);
      pressedKeys.clear();
      rig.setLocalPosition(0, 0, 0);
      rig.setLocalEulerAngles(0, 0, 0);
      const target = orbitTargetOf({
        ...pose,
        pitch: pitch * RAD_TO_DEG,
        distance,
      });
      desktopTarget.set(target.x, target.y, target.z);
      updateDesktopCamera();
    };

    /**
     * VRへ入る直前のDesktop視点へ戻す。
     *
     * XR中のlocomotionはrigを動かすので、rigをゼロに戻すだけでは足りない。
     * VR開始前にWASDでrigへ入っていた移動量まで消えて、Desktopの視点が
     * 空間の初期位置へ飛んでしまう。控えておいたworld視点を`applyViewPose`で
     * 組み直せば、rigは原点に戻ったまま見え方は開始前と同じになる。
     *
     * XR終了と `xr.start()` 失敗の両方から呼ぶ。二度目は何もしない。
     */
    const restoreDesktopView = () => {
      const view = desktopReturnView;
      if (!view) return;
      desktopReturnView = null;
      applyViewPose(view);
    };

    /**
     * URLの `view=` に入っている視点。初期視点の第一優先。
     *
     * `view=` は空間に紐づくので、アドレスバーが指している空間といま読み込んだ
     * 空間が一致するときだけ使う。別の空間へ切り替えたときに前の視点を持ち込まない。
     * 提供元まで含めて突き合わせるので、`?id=` と `?ss=` を取り違えることはない。
     */
    const linkedViewFor = (space: SpaceRef | null): ViewPose | null => {
      if (!space) return null;
      const href = window.location.href;
      if (!isSameSpace(readSpaceRef(href), space)) return null;
      return readViewPose(href);
    };

    /**
     * `cameras.json` から組み立てた、公式Viewerと同じ初期視点。第二優先。
     *
     * 撮影を始めた地点から軌跡の中心を見る構図で、公式の共有ページを開いた
     * 直後と同じ場所・同じ向きになる。Insta360共有のときだけ入る。
     *
     * 初期視点の優先順位はDesktopでもXRでも同じで、
     * 1. URLの `view=`（`linkedViewFor`）→ 2. これ → 3. `frameBounds()` の既定視点。
     */
    const homeViewFor = (cameras: CaptureCamera[] | null, bounds: Bounds): ViewPose | null =>
      cameras ? captureHomeView(cameras, splatPlacement(bounds)) : null;

    /**
     * 読み込んだ空間に合わせて視点を組み直す。`cameras.json` が無いときの既定視点。
     *
     * 回転の中心は目線の高さの「splatが集まっているところ」に置く。カメラは
     * そこから空間の半径の3割ほど引いた位置に構えるので、360度キャプチャの
     * 内側に留まったまま中心を軸に回れる。
     *
     * 中心に箱の中点ではなく重心の中央値を使うのは、屋外のキャプチャでは
     * 分位点バウンズでさえ大半が遠景（向かいのビルや空）で埋まり、中点が
     * 歩いた範囲の外——建物の中——へ落ちるため。中央値なら撮影した場所の
     * 近くに留まる。配置（`applyPlacement`）は箱の中点のままにしてあり、
     * 既に配ったリンクの `view=` が別の場所を指すことはない。
     */
    const frameBounds = (bounds: Bounds) => {
      const eyeHeight = clamp((bounds.max.y - bounds.min.y) * 0.54, 1, 2.2);
      const radius = Math.max(bounds.max.x - bounds.min.x, bounds.max.z - bounds.min.z) * 0.5;
      const centre = worldFromCapturePointFor(
        bounds.centre,
        splatPlacementFor(bounds, placementTransform),
        placementTransform,
      );
      resetView(
        new Vec3(centre.x, eyeHeight, centre.z),
        clamp(radius * ORBIT_DISTANCE_RATIO, ORBIT_DISTANCE_RANGE.min, ORBIT_DISTANCE_RANGE.max),
      );
    };

    // ダブルクリックで視点を戻せるよう、いま表示している空間の広がりを覚えておく。
    let framedBounds: Bounds = CAPTURE_BOUNDS;
    // VR開始時に合わせたいworld視点。HMDのposeが届く前は補正できないので、
    // ここへ置いて最初の有効なフレームで1回だけ適用する。
    let pendingXrSpawn: ViewPose | null = null;
    // VRへ入る直前のDesktop視点。役割が違うので `pendingXrSpawn` とは分けてある
    // （あちらは最初のHMD poseで消える。こちらはVRを抜けるまで持つ）。
    let desktopReturnView: ViewPose | null = null;
    // `?debug=1` で開いたときだけ、spawn結果をconsoleへ出す。実機でDesktopと
    // Questの視点を突き合わせるための確認用で、既定では何も出さない。
    const xrDebug = new URLSearchParams(window.location.search).get("debug") === "1";
    let xrSpawnDebug: ViewPose | null = null;

    applyPlacement(framedBounds);
    frameBounds(framedBounds);

    let loadToken = 0;
    let optimizeToken = 0;
    // 表示中のOriginal SOG。バイト列はVR最適化とハッシュ計算に使い回す。
    // `blob` はbundled SOG（ローカル・Insta360・直接URL）でだけ入る。unbundled
    // SOGはPlayCanvasが直接取りに行くので、Viewerの手元にバイト列が残らない。
    let original:
      | { asset: Asset; objectUrl: string; blob: Blob | null; hash: string | null }
      | null = null;
    let optimizedEntry: { asset: Asset; objectUrl: string; key: string } | null = null;
    let splatComponent: GSplatComponent | null = null;
    let pendingFoveation = VR_RENDER_PROFILE.original.foveation;
    let optimizeWorker: Worker | null = null;

    const unsupportedReason = optimizationUnsupportedReason();
    setOptimizeUnsupported(unsupportedReason);

    const assetErrorMessage = (error: unknown) =>
      error instanceof Error
        ? error.message
        : typeof error === "string"
          ? error
          : "SOGファイルを読み込めませんでした。";

    const attachAsset = (asset: Asset) => {
      if (splatComponent) splatComponent.asset = asset;
      else {
        splatComponent = splatEntity.addComponent("gsplat", {
          asset,
          unified: true,
        }) as GSplatComponent;
      }
    };

    const releaseAsset = (entry: { asset: Asset; objectUrl: string } | null) => {
      if (!entry) return;
      app.assets.remove(entry.asset);
      entry.asset.off();
      if (entry.asset.loaded) entry.asset.unload();
      // リモートURLから直接読んだアセットにはobject URLが無い。
      if (entry.objectUrl) URL.revokeObjectURL(entry.objectUrl);
    };

    const releaseOptimized = () => {
      releaseAsset(optimizedEntry);
      optimizedEntry = null;
      setOptimized(null);
      setVrReady(false);
    };

    /** バイト列からGSplatアセットを作り、読み込み完了まで待つ。 */
    const loadSplatAsset = (name: string, blob: Blob, filename: string) =>
      new Promise<{ asset: Asset; objectUrl: string }>((resolve, reject) => {
        const objectUrl = URL.createObjectURL(blob);
        const asset = new Asset(name, "gsplat", { url: objectUrl, filename });
        asset.once("error", (error: unknown) => {
          URL.revokeObjectURL(objectUrl);
          reject(new Error(assetErrorMessage(error)));
        });
        asset.ready(() => resolve({ asset, objectUrl }));
        app.assets.add(asset);
        app.assets.load(asset);
      });

    /**
     * リモートのURLをそのままPlayCanvasへ渡してGSplatアセットを作る。
     *
     * unbundled SOG（`meta.json`）用。`meta.json` は同じディレクトリのWebPを
     * **相対パスで**参照しているので、いったんBlobにしてobject URLで読ませると
     * 相対解決の基準が `blob:` になり、WebPを取りに行けなくなる。PlayCanvasの
     * SOGパーサーは相対URLを「読み込みに使ったURL」基準で解決する
     * （`new URL(filename, url.load)`）ため、CDNのURLをそのまま渡せば
     * `meta.json` と同じ場所のWebPが引ける。
     *
     * `filename` はパーサーの選択にしか使われない（拡張子が `json` なら
     * SOGパーサー、`sog` ならバンドルパーサー）。取得先は `url` のままなので、
     * クエリ付きのCDN URLでも取り違えない。
     *
     * WebPはtextureアセットとして `crossOrigin: "anonymous"` で読まれるので、
     * 配信元がCORSを許可している必要がある。
     */
    const loadRemoteGsplatAsset = (name: string, url: string, filename: string) =>
      new Promise<{ asset: Asset; objectUrl: string }>((resolve, reject) => {
        const asset = new Asset(name, "gsplat", { url, filename });
        asset.once("error", (error: unknown) => reject(new Error(assetErrorMessage(error))));
        asset.ready(() => resolve({ asset, objectUrl: "" }));
        app.assets.add(asset);
        app.assets.load(asset);
      });

    /** 進捗を出しながらSOGを丸ごと取得する。バイト列はハッシュと最適化に使う。 */
    const downloadSog = async (url: string, onProgress: (percent: number) => void) => {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`SOGを取得できませんでした (HTTP ${response.status})`);
      const total = Number(response.headers.get("content-length") ?? 0);
      if (!response.body) return response.arrayBuffer();
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let received = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        received += value.byteLength;
        onProgress(total > 0 ? Math.min(99, Math.round((received / total) * 100)) : -1);
      }
      return new Blob(chunks as BlobPart[]).arrayBuffer();
    };

    /**
     * 撮影時のカメラ情報（`cameras.json`）を取りに行く。取れなければ `null`。
     *
     * 署名付きURLは `access-control-allow-origin: *` を返すので、SOGと同じく
     * ブラウザから直接取れる。使い道は初期視点と画角だけなので、失敗しても
     * 空間の表示は止めない（既定の視点へ落ちる）。
     */
    const downloadCaptureCameras = async (url: string): Promise<CaptureCamera[] | null> => {
      try {
        const response = await fetch(url);
        if (!response.ok) return null;
        return parseCaptureCameras(await response.json());
      } catch {
        return null;
      }
    };

    /**
     * アドレスバーを表示中の空間に合わせる。
     *
     * Insta360由来なら共有IDだけを載せ、それ以外なら残っている `id` を落とす。
     * 署名付きURLはここには出さない。ページ遷移もしないので、
     * `history.replaceState` で書き換えるだけ。
     *
     * `pose` は復元に使った視点。`view=` 付きで開かれたときはそのまま残すので、
     * リロードしても同じ画角に戻る。視点を使わなかった空間では落とす。
     */
    const syncPermalink = (space: SpaceRef | null, pose: ViewPose | null) => {
      const href = window.location.href;
      const next = space ? permalinkFor(href, space, pose) : hrefWithoutSpace(href);
      if (next && next !== href) window.history.replaceState(null, "", next);
    };

    /**
     * 読み込み終わったアセットを表示中の空間として据える。
     *
     * bundled SOG（バイト列を持っている）とunbundled SOG（PlayCanvasが直接
     * 取りに行く）で共通の後始末。`bytes` が `null` の空間ではVR向け軽量化を
     * 出さない——optimizerが元のバイト列を必要とするため。
     */
    const showSplat = async (
      next: ViewerSource,
      loaded: { asset: Asset; objectUrl: string },
      bytes: { blob: Blob; hash: string | null } | null,
      cameras: CaptureCamera[] | null,
    ) => {
      const isSample = next.kind === "sample";
      // 配置は提供元ごとに違うので、バウンズを測る前に切り替える。
      placementTransform = placementTransformOf(next.provider);
      const bounds = boundsFromResource(loaded.asset.resource) ?? CAPTURE_BOUNDS;
      framedBounds = isSample ? CAPTURE_BOUNDS : bounds;
      applyPlacement(framedBounds);
      applyCaptureFov(cameras ? captureFovOf(cameras) : null);
      // `view=` で開かれていればその視点。無ければ公式と同じ初期視点、
      // それも無ければ空間の広がりから決める既定視点へ落ちる。
      // SuperSplatには `cameras.json` に当たるものが無いので、実質
      // 「`view=` があればそれ、無ければ `frameBounds()`」になる。
      const space = spaceRefOf(next);
      const linkedView = linkedViewFor(space);
      const initialView = linkedView ?? homeViewFor(cameras, framedBounds);
      // `?debug=1` のときだけ、何を根拠に初期視点を決めたかを出す。`cameras` が
      // `null` のまま既定視点へ落ちていないか（resolverが `camerasUrl` を返して
      // いるか）を、実際に配信されている版で確かめるための出力。
      if (xrDebug) {
        console.info("[sog-xr] initial", {
          provider: next.provider,
          bounds: { ...framedBounds },
          placement: splatPlacementFor(framedBounds, placementTransform),
          cameraCount: cameras?.length ?? null,
          linkedView,
          initialView,
          fov: camera.fov,
        });
      }
      if (initialView) applyViewPose(initialView);
      else frameBounds(framedBounds);
      attachAsset(loaded.asset);
      const previous = original;
      original = { ...loaded, blob: bytes?.blob ?? null, hash: bytes?.hash ?? null };
      releaseAsset(previous);
      releaseOptimized();
      setOriginalSplats(splatCountOf(loaded.asset.resource));
      setSource(next);
      setOptimizeSourceReason(bytes ? null : UNBUNDLED_OPTIMIZE_REASON);
      // アドレスバーへ残すのはユーザーが指定した視点だけ。こちらで決めた
      // 初期視点まで載せると、空間だけのリンクが視点付きに化けてしまう。
      syncPermalink(space, linkedView);
      setStatus("ready");
    };

    /** Original SOGをバイト列から差し替える。VR最適化済みの結果は入力が変わるので捨てる。 */
    const showOriginal = async (
      next: ViewerSource,
      buffer: ArrayBuffer,
      cameras: CaptureCamera[] | null = null,
    ) => {
      const hash = typeof crypto?.subtle === "undefined" ? null : await sha256Hex(buffer);
      const blob = new Blob([buffer]);
      const loaded = await loadSplatAsset(next.label, blob, "space.sog");
      await showSplat(next, loaded, { blob, hash }, cameras);
    };

    const onXrAvailability = (available: boolean) => {
      if (!disposed) setXrAvailable(available);
    };
    const onXrStart = () => {
      if (disposed) return;
      xr.fixedFoveation = pendingFoveation;
      setInXr(true);
    };
    const onXrEnd = () => {
      if (disposed) return;
      setInXr(false);
      pendingXrSpawn = null;
      // Desktop表示はOriginalに戻す。
      if (original) attachAsset(original.asset);
      restoreDesktopView();
    };
    const onXrError = (error: Error) => {
      if (disposed) return;
      setErrorMessage(error.message);
    };

    xr.on(`available:${XRTYPE_VR}`, onXrAvailability);
    xr.on("start", onXrStart);
    xr.on("end", onXrEnd);
    xr.on("error", onXrError);

    const startVr = (variant: VrVariant) => {
      const entry = variant === "optimized" ? optimizedEntry : original;
      if (disposed || !xr.isAvailable(XRTYPE_VR) || !entry?.asset.loaded) return;
      setErrorMessage("");
      setVrOpen(false);
      pressedKeys.clear();
      // VRはいまDesktopに見えている視点から始める（`view=` で開いていれば
      // その視点、無ければ `frameBounds()` の既定視点）。rigは一度identityへ
      // 戻し、HMDのposeが届いた最初のフレームでこの視点へ合わせ直す。ここで
      // 0のままにすると、リンクで指定された場所を見失う。
      const desktopView = currentViewPose();
      pendingXrSpawn = desktopView;
      // VRを抜けたときに戻る先。rigをゼロにするので、控えておかないと
      // WASDで移動した分がここで失われる。
      desktopReturnView = desktopView;
      rig.setLocalPosition(0, 0, 0);
      rig.setLocalEulerAngles(0, 0, 0);
      attachAsset(entry.asset);
      const profile = VR_RENDER_PROFILE[variant];
      pendingFoveation = profile.foveation;
      xr.start(camera, XRTYPE_VR, XRSPACE_LOCALFLOOR, {
        framebufferScaleFactor: profile.framebufferScaleFactor,
        optionalFeatures: ["hand-tracking"],
        callback: (error) => {
          if (disposed || !error) return;
          pendingXrSpawn = null;
          if (original) attachAsset(original.asset);
          // 開始に失敗した場合も、rigはすでにゼロへ戻してある。
          restoreDesktopView();
          setErrorMessage(error.message);
        },
      });
    };

    /** SOGをWorkerで軽量化する。UIスレッドは進捗を受け取るだけ。 */
    const runOptimizer = (buffer: ArrayBuffer, settings: OptimizeSettings) =>
      new Promise<{ buffer: ArrayBuffer; splats: number; sourceSplats: number; bytes: number }>(
        (resolve, reject) => {
          if (!optimizeWorker) {
            optimizeWorker = new Worker(new URL("./sog-optimizer.worker.ts", import.meta.url), {
              type: "module",
            });
          }
          const worker = optimizeWorker;
          const cleanup = () => {
            worker.onmessage = null;
            worker.onerror = null;
          };
          worker.onmessage = (event: MessageEvent<OptimizeMessage>) => {
            const message = event.data;
            if (message.type === "progress") {
              setOptimizeStage(message.stage);
              setOptimizeRatio(Math.round(message.ratio * 100));
              return;
            }
            cleanup();
            if (message.type === "error") reject(new Error(message.message));
            else resolve(message);
          };
          worker.onerror = (event) => {
            cleanup();
            reject(new Error(event.message || "VR向けSOGを生成できませんでした。"));
          };
          worker.postMessage({ buffer, settings } satisfies OptimizeRequest, [buffer]);
        },
      );

    /**
     * VR最適化版を用意する。キャッシュに当たれば変換せずそのまま使う。
     * 失敗してもOriginalの表示はそのまま維持する。
     */
    const prepareVariant = async (variant: VrVariant) => {
      if (disposed || !original) return;
      setErrorMessage("");
      setOptimizeError("");

      if (variant === "original") {
        setVrReady(true);
        startVr("original");
        return;
      }

      // unbundled SOGでは元のバイト列が手元に無い。UI側でも選べないように
      // してあるが、ここでも念のため止める。
      if (!original.blob) {
        setOptimizeError(UNBUNDLED_OPTIMIZE_REASON);
        return;
      }
      const sourceBlob = original.blob;

      const settings: OptimizeSettings = {
        targetSplats: targetSplatsRef.current,
        dropSphericalHarmonics: true,
      };
      const key = original.hash ? cacheKey(original.hash, settings) : null;
      if (optimizedEntry && optimizedEntry.key === key) {
        startVr("optimized");
        return;
      }

      optimizeToken += 1;
      const token = optimizeToken;
      setVrReady(false);
      setOptimizeStage("キャッシュを確認中");
      setOptimizeRatio(0);
      // 変換中は描画を止める。ユーザーはモーダルを見ているので見た目の損はなく、
      // WorkerのWebGL読み出しとPNG圧縮にCPU/GPUを回せる。
      app.autoRender = false;

      try {
        const cached = key ? await readCachedOptimization(key) : null;
        let blob: Blob;
        let splats: number;
        let bytes: number;

        if (cached) {
          blob = cached.blob;
          splats = cached.splats;
          bytes = cached.bytes;
        } else {
          const source = await sourceBlob.arrayBuffer();
          if (disposed || token !== optimizeToken) return;
          const result = await runOptimizer(source, settings);
          if (disposed || token !== optimizeToken) return;
          blob = new Blob([result.buffer]);
          splats = result.splats;
          bytes = result.bytes;
          if (key && original.hash) {
            setOptimizeStage("キャッシュへ保存中");
            setOptimizeRatio(99);
            await writeCachedOptimization({
              key,
              sourceHash: original.hash,
              targetSplats: settings.targetSplats,
              dropSphericalHarmonics: settings.dropSphericalHarmonics,
              optimizerVersion: OPTIMIZER_VERSION,
              splats,
              sourceSplats: result.sourceSplats,
              bytes,
              createdAt: Date.now(),
              blob,
            });
          }
        }

        if (disposed || token !== optimizeToken) return;
        setOptimizeStage("VR向けSOGを読み込み中");
        const loaded = await loadSplatAsset("VR optimized SOG", blob, "vr-optimized.sog");
        if (disposed || token !== optimizeToken) {
          releaseAsset(loaded);
          return;
        }
        releaseAsset(optimizedEntry);
        optimizedEntry = { ...loaded, key: key ?? `${settings.targetSplats}` };
        setOptimized({
          splats,
          bytes,
          fromCache: Boolean(cached),
          targetSplats: settings.targetSplats,
        });
        setOptimizeStage("");
        setOptimizeRatio(100);
        setVrReady(true);
      } catch (error) {
        if (disposed || token !== optimizeToken) return;
        setOptimizeStage("");
        setOptimizeError(assetErrorMessage(error));
      } finally {
        app.autoRender = true;
      }
    };

    currentViewRef.current = () => (disposed ? null : currentViewPose());
    prepareVrRef.current = (variant) => {
      void prepareVariant(variant);
    };
    startVrRef.current = () => startVr(vrVariantRef.current);

    /**
     * 共有URLをサーバー経由でSOGのURLへ解決する。
     *
     * 解決だけをサーバーに任せ、SOG本体はここから直接取りに行く。署名付きURLは
     * `access-control-allow-origin: *` を返すので中継させる理由がない。
     */
    const resolveShare = async (shareUrl: string) => {
      const resolver = resolverConfig();
      if (!resolver.available) throw new Error(resolver.reason);

      let response: Response;
      try {
        response = await fetch(`${resolver.endpoints.insta360}?url=${encodeURIComponent(shareUrl)}`, {
          headers: { accept: "application/json" },
        });
      } catch {
        throw new Error("共有URLの解決サービスに接続できませんでした。");
      }
      const payload = (await response.json().catch(() => null)) as
        | { assetUrl?: string; camerasUrl?: string | null; error?: string }
        | null;
      if (!response.ok || !payload?.assetUrl) {
        throw new Error(payload?.error ?? `共有URLを解決できませんでした (HTTP ${response.status})`);
      }
      return { assetUrl: payload.assetUrl, camerasUrl: payload.camerasUrl ?? "" };
    };

    /**
     * SuperSplatの公開シーンURLをサーバー経由で解決する。
     *
     * resolverが確かめるのは、作者がダウンロードを許可しているか（Downloadable）と
     * ライセンスが読み取れるか。そこを通ったシーンだけがアセットのURLを返す。
     * ブラウザ側でその判断をやり直さない。
     */
    const resolveSuperSplat = async (sceneUrl: string): Promise<SuperSplatResolution> => {
      const resolver = resolverConfig();
      if (!resolver.available) throw new Error(resolver.reason);

      let response: Response;
      try {
        response = await fetch(
          `${resolver.endpoints.supersplat}?url=${encodeURIComponent(sceneUrl)}`,
          { headers: { accept: "application/json" } },
        );
      } catch {
        throw new Error("SuperSplatのシーンURLの解決サービスに接続できませんでした。");
      }
      const payload = (await response.json().catch(() => null)) as
        | (Partial<SuperSplatResolution> & { error?: string; code?: string })
        | null;
      if (!response.ok || !payload?.asset?.url) {
        throw new Error(superSplatErrorMessage(payload ?? null, response.status));
      }
      // Streamed SOGはresolverが見つけても、このViewerではまだ描画できない。
      // resolverの応答はそのままなので、対応を足すのはViewer側だけで済む。
      if (payload.asset.format === "streamed-sog") {
        throw new Error(SUPERSPLAT_ERROR_MESSAGES.SUPERSPLAT_STREAMED_SOG_UNSUPPORTED);
      }
      return payload as SuperSplatResolution;
    };

    /**
     * 同じ空間を二重に読み込まないための鍵。
     *
     * 共有ID・シーンID・SOGのURLが同じなら、解決もダウンロードもデコードも
     * やり直す必要がない。ファイルは同じ名前でも中身が違いうるので鍵を
     * 作らない（毎回読み直す）。
     */
    const sourceKeyOf = (request: LoadRequest): string => {
      if (request.kind === "file") return "";
      const input = request.value.trim();
      const share = parseInsta360ShareUrl(input);
      if (share) return `share:${share.shareId}`;
      const scene = parseSuperSplatUrl(input);
      if (scene) return `supersplat:${scene.sceneId}`;
      const direct = isSpatialAssetUrl(input) ? toAbsoluteUrl(input) : null;
      return direct ? `sog:${direct.toString()}` : "";
    };
    // 表示中／読み込み中の鍵。effectの再実行や同じURLの再入力を弾く。
    let shownKey = "";
    let loadingKey = "";

    const loadSource = async (request: LoadRequest, initial = false) => {
      if (disposed) return;

      const key = sourceKeyOf(request);
      if (key && (key === loadingKey || key === shownKey)) {
        // すでに出ている／取りに行っている空間。何もせずダイアログだけ畳む。
        setSourceError("");
        setOpenOpen(false);
        return;
      }

      loadToken += 1;
      const token = loadToken;
      loadingKey = key;
      setSourceError("");
      // 初回はページ全体のローディングカードが出ているので、そちらへ進捗を送る。
      const reportProgress = initial ? setProgress : setSourceProgress;
      const reportFailure = (error: unknown) => {
        const message = assetErrorMessage(error);
        if (initial) {
          setErrorMessage(message);
          setStatus("error");
        } else {
          setSourceError(message);
        }
      };

      let label = "";
      let provider: SourceProvider = "direct";
      let shareId: string | undefined;
      let supersplat: SuperSplatSource | undefined;
      let fetchUrl = "";
      // PlayCanvasに直接読ませるアセット。unbundled SOGのときだけ入る。
      let remote: { url: string; filename: string } | null = null;
      // 撮影時のカメラ情報。Insta360共有を解決したときだけ入る。
      let camerasUrl = "";
      let file: File | null = null;

      if (request.kind === "file") {
        if (!/\.sog$/i.test(request.file.name)) {
          setSourceError("SOGファイル (.sog) を選択してください。");
          loadingKey = "";
          return;
        }
        file = request.file;
        provider = "file";
        label = request.file.name;
      } else {
        // 判定の順番は Insta360共有URL → SuperSplatシーンURL → 直接URL。
        const input = request.value.trim();
        const share = parseInsta360ShareUrl(input);
        const scene = share ? null : parseSuperSplatUrl(input);
        const direct = !share && !scene && isSpatialAssetUrl(input) ? toAbsoluteUrl(input) : null;
        if (share) {
          const resolver = resolverConfig();
          if (!resolver.available) {
            reportFailure(new Error(resolver.reason));
            loadingKey = "";
            return;
          }
          provider = "insta360";
          shareId = share.shareId;
          label = `Insta360共有 ${share.shareId}`;
          setPendingLabel(label);
          setSourceStage("共有URLを解決中");
          reportProgress(-1);
          try {
            const resolved = await resolveShare(share.shareUrl);
            fetchUrl = resolved.assetUrl;
            camerasUrl = resolved.camerasUrl;
          } catch (error) {
            if (disposed || token !== loadToken) return;
            setSourceStage("");
            setPendingLabel("");
            loadingKey = "";
            reportFailure(error);
            return;
          }
        } else if (scene) {
          const resolver = resolverConfig();
          if (!resolver.available) {
            reportFailure(new Error(resolver.reason));
            loadingKey = "";
            return;
          }
          provider = "supersplat";
          label = `SuperSplat ${scene.sceneId}`;
          setPendingLabel(label);
          setSourceStage("SuperSplatのシーンを確認中");
          reportProgress(-1);
          try {
            const resolved = await resolveSuperSplat(scene.sceneUrl);
            supersplat = {
              sceneId: resolved.sceneId,
              pageUrl: resolved.pageUrl,
              title: resolved.title,
              author: resolved.author,
              license: resolved.license,
            };
            label = resolved.title ? `SuperSplat ${resolved.title}` : label;
            // bundled SOGはバイト列で取ればVR向け軽量化まで使える。
            // unbundled SOG (`meta.json`) は相対参照を保つためURLのまま渡す。
            if (resolved.asset.format === "sog") fetchUrl = resolved.asset.url;
            else remote = { url: resolved.asset.url, filename: "meta.json" };
          } catch (error) {
            if (disposed || token !== loadToken) return;
            setSourceStage("");
            setPendingLabel("");
            loadingKey = "";
            reportFailure(error);
            return;
          }
        } else if (direct) {
          fetchUrl = direct.toString();
          label = direct.pathname.split("/").pop() || "space.sog";
        } else {
          setSourceError(
            "Insta360の共有URL、SuperSplatのシーンURL、または .sog のURLを入力してください。",
          );
          loadingKey = "";
          return;
        }
      }

      const next: ViewerSource = {
        kind: request.kind === "file" ? "file" : "url",
        provider,
        label,
        shareId,
        supersplat,
      };

      setPendingLabel(label);
      setSourceStage(`${label} を読み込み中`);
      reportProgress(remote ? -1 : 0);
      // カメラ情報はSOGと並行して取る。SOGより桁違いに小さいので、
      // 待ち時間は増えない。
      const camerasRequest = camerasUrl
        ? downloadCaptureCameras(camerasUrl)
        : Promise.resolve(null);
      try {
        if (remote) {
          // 取得と展開はPlayCanvasの中で進むので、こちらは進捗を出せない。
          const loaded = await loadRemoteGsplatAsset(label, remote.url, remote.filename);
          // 読み込んでいる間に別の空間へ切り替えられていたら、出さずに捨てる。
          if (disposed || token !== loadToken) {
            releaseAsset(loaded);
            return;
          }
          await showSplat(next, loaded, null, null);
        } else {
          const buffer = file
            ? await file.arrayBuffer()
            : await downloadSog(fetchUrl, reportProgress);
          if (disposed || token !== loadToken) return;
          setSourceStage(`${label} を展開中`);
          reportProgress(-1);
          await showOriginal(next, buffer, await camerasRequest);
        }
        if (disposed || token !== loadToken) return;
        shownKey = key;
        setSourceStage("");
        setPendingLabel("");
        reportProgress(100);
        setErrorMessage("");
        setOpenOpen(false);
      } catch (error) {
        if (disposed || token !== loadToken) return;
        setSourceStage("");
        setPendingLabel("");
        reportFailure(error);
      } finally {
        if (loadingKey === key) loadingKey = "";
      }
    };
    loadSourceRef.current = (request) => {
      void loadSource(request);
    };

    const loadSample = async (initial: boolean) => {
      loadToken += 1;
      const token = loadToken;
      loadingKey = SAMPLE_KEY;
      setSourceError("");
      if (!initial) {
        setPendingLabel(SAMPLE_LABEL);
        setSourceStage(`${SAMPLE_LABEL} を読み込み中`);
        setSourceProgress(0);
      }
      try {
        const buffer = await downloadSog(SAMPLE_URL, initial ? setProgress : setSourceProgress);
        if (disposed || token !== loadToken) return;
        await showOriginal({ kind: "sample", provider: "sample", label: SAMPLE_LABEL }, buffer);
        if (disposed || token !== loadToken) return;
        shownKey = SAMPLE_KEY;
        setPendingLabel("");
        setProgress(100);
        setSourceStage("");
        setSourceProgress(100);
      } catch (error) {
        if (disposed || token !== loadToken) return;
        setSourceStage("");
        setPendingLabel("");
        const message = assetErrorMessage(error);
        if (initial) {
          setErrorMessage(message);
          setStatus("error");
        } else {
          setSourceError(message);
        }
      } finally {
        if (loadingKey === SAMPLE_KEY) loadingKey = "";
      }
    };
    restoreSampleRef.current = () => {
      void loadSample(false);
    };

    const movementCodes = new Set([
      "KeyW",
      "KeyA",
      "KeyS",
      "KeyD",
      "KeyE",
      "KeyQ",
      "ShiftLeft",
      "ShiftRight",
    ]);
    const onKeyDown = (event: KeyboardEvent) => {
      if (xr.active || event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.target instanceof HTMLInputElement) return;
      if (!movementCodes.has(event.code)) return;
      pressedKeys.add(event.code);
      event.preventDefault();
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (!movementCodes.has(event.code)) return;
      pressedKeys.delete(event.code);
      event.preventDefault();
    };
    const clearPressedKeys = () => pressedKeys.clear();

    /**
     * 回転の中心をカメラの向いている平面に沿って動かす。
     *
     * 1pxあたりの移動量を注視点の距離での画角から出すので、つかんだ場所が
     * カーソルに追従する。desktopTargetはrig座標だが、Desktopではrigを回転
     * させないので、カメラのworld方向ベクトルをそのまま使える。
     */
    const panBy = (deltaX: number, deltaY: number) => {
      const height = Math.max(1, canvas.clientHeight);
      const perPixel = (2 * distance * Math.tan((camera.fov * Math.PI) / 360)) / height;
      desktopTarget
        .addScaled(cameraEntity.right, -deltaX * perPixel)
        .addScaled(cameraEntity.up, deltaY * perPixel);
    };

    const onPointerDown = (event: PointerEvent) => {
      if (xr.active || dragMode !== null) return;
      // 一般的な3Dソフトに合わせる。左=回転、右/中=平行移動、Shift+左=平行移動。
      if (event.button === 0) dragMode = event.shiftKey ? "pan" : "orbit";
      else if (event.button === 1 || event.button === 2) dragMode = "pan";
      else return;
      dragPointerId = event.pointerId;
      lastX = event.clientX;
      lastY = event.clientY;
      canvas.setPointerCapture(event.pointerId);
      event.preventDefault();
    };
    const onPointerMove = (event: PointerEvent) => {
      if (dragMode === null || event.pointerId !== dragPointerId || xr.active) return;
      const deltaX = event.clientX - lastX;
      const deltaY = event.clientY - lastY;
      if (dragMode === "orbit") {
        yaw -= deltaX * ORBIT_SPEED.yaw;
        pitch = clamp(pitch + deltaY * ORBIT_SPEED.pitch, -MAX_PITCH, MAX_PITCH);
      } else {
        panBy(deltaX, deltaY);
      }
      lastX = event.clientX;
      lastY = event.clientY;
      updateDesktopCamera();
    };
    const onPointerUp = (event: PointerEvent) => {
      if (event.pointerId !== dragPointerId) return;
      dragMode = null;
      dragPointerId = -1;
      if (canvas.hasPointerCapture(event.pointerId)) {
        canvas.releasePointerCapture(event.pointerId);
      }
    };
    // 右ドラッグを平行移動に使うので、コンテキストメニューは出さない。
    const onContextMenu = (event: MouseEvent) => event.preventDefault();
    // 平行移動で空間の外へ出てしまっても、ダブルクリックで戻れるようにする。
    const onDoubleClick = () => {
      if (xr.active) return;
      frameBounds(framedBounds);
    };
    const onWheel = (event: WheelEvent) => {
      if (xr.active) return;
      event.preventDefault();
      // 行単位で飛んでくるブラウザがあるので、px相当に揃えてから使う。
      const deltaY = event.deltaMode === 1 ? event.deltaY * WHEEL_LINE_HEIGHT : event.deltaY;
      // 近いほど細かく動くよう、加算ではなく倍率で寄せる。
      distance = clamp(distance * Math.exp(deltaY * DOLLY_SPEED), DOLLY_RANGE.min, DOLLY_RANGE.max);
      updateDesktopCamera();
    };

    // ページ全体をドロップ先にする。dragenter/dragleave の入れ子を数えて
    // 子要素をまたいだときにオーバーレイがちらつかないようにする。
    let dragDepth = 0;
    const carriesFiles = (event: DragEvent) =>
      Array.from(event.dataTransfer?.types ?? []).includes("Files");
    const onDragEnter = (event: DragEvent) => {
      if (!carriesFiles(event)) return;
      event.preventDefault();
      dragDepth += 1;
      setDragActive(true);
    };
    const onDragOver = (event: DragEvent) => {
      if (!carriesFiles(event)) return;
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
    };
    const onDragLeave = (event: DragEvent) => {
      if (!carriesFiles(event)) return;
      dragDepth = Math.max(0, dragDepth - 1);
      if (dragDepth === 0) setDragActive(false);
    };
    const onDrop = (event: DragEvent) => {
      if (!carriesFiles(event)) return;
      event.preventDefault();
      dragDepth = 0;
      setDragActive(false);
      const file = event.dataTransfer?.files?.[0];
      if (file) void loadSource({ kind: "file", file });
    };

    const desktopMovement = new Vec3();
    const xrMovement = new Vec3();
    const flatForward = new Vec3();
    const flatRight = new Vec3();
    const updateDesktopMovement = (deltaSeconds: number) => {
      const forwardAmount = Number(pressedKeys.has("KeyW")) - Number(pressedKeys.has("KeyS"));
      const rightAmount = Number(pressedKeys.has("KeyD")) - Number(pressedKeys.has("KeyA"));
      const upAmount = Number(pressedKeys.has("KeyE")) - Number(pressedKeys.has("KeyQ"));
      if (forwardAmount === 0 && rightAmount === 0 && upAmount === 0) return;

      flatForward.set(-Math.sin(yaw), 0, -Math.cos(yaw));
      flatRight.cross(flatForward, UP).normalize();
      desktopMovement
        .set(0, 0, 0)
        .addScaled(flatForward, forwardAmount)
        .addScaled(flatRight, rightAmount)
        .addScaled(UP, upAmount)
        .normalize();
      const isFast = pressedKeys.has("ShiftLeft") || pressedKeys.has("ShiftRight");
      rig.setLocalPosition(
        rig.getLocalPosition().addScaled(desktopMovement, (isFast ? 6 : 2.4) * deltaSeconds),
      );
      updateDesktopCamera();
    };

    // XR中のHMD姿勢を読むための作業用ベクトル。毎フレーム作らない。
    const LOCAL_FORWARD = new Vec3(0, 0, -1);
    const LOCAL_UP = new Vec3(0, 1, 0);
    const headForward = new Vec3();
    const headUp = new Vec3();

    /**
     * HMDのposeが届いた最初のフレームで、rigを目的の視点へ合わせる。
     *
     * XR中のcameraEntityの位置・回転はXRセッションがrig相対で毎フレーム
     * 上書きするので、カメラへ直接書いても消える。動かせるのは親のrigだけ。
     * `xrRigOffset` が `rig * HMD pose = 目的の視点` を解くので、その結果を
     * そのままrigへ入れる。合わせるのは位置と水平yawだけで、pitch / rollは
     * HMDのものを尊重する（VRではユーザー本人が頭を動かしている）。
     *
     * PlayCanvasはviewer poseを取れなかったフレームでは `app.update` ごと
     * 飛ばすので、このハンドラが呼ばれた時点でカメラには有効なposeが
     * 入っている。適用は1回だけで、あとは通常のlocomotionがrigを動かす。
     */
    const applyXrSpawn = () => {
      if (!pendingXrSpawn) return;
      const head = cameraEntity.getLocalPosition();
      if (!Number.isFinite(head.x) || !Number.isFinite(head.y) || !Number.isFinite(head.z)) return;
      const rotation = cameraEntity.getLocalRotation();
      rotation.transformVector(LOCAL_FORWARD, headForward);
      rotation.transformVector(LOCAL_UP, headUp);
      const desired: HorizontalPose = {
        x: pendingXrSpawn.x,
        y: pendingXrSpawn.y,
        z: pendingXrSpawn.z,
        yaw: pendingXrSpawn.yaw,
      };
      const rigPose = xrRigOffset(desired, {
        x: head.x,
        y: head.y,
        z: head.z,
        yaw: yawDegreesFromBasis(headForward, headUp),
      });
      rig.setLocalPosition(rigPose.x, rigPose.y, rigPose.z);
      rig.setLocalEulerAngles(0, rigPose.yaw, 0);
      if (xrDebug) {
        xrSpawnDebug = pendingXrSpawn;
        console.info("[sog-xr] spawn", {
          desired: desired,
          head: { x: head.x, y: head.y, z: head.z, yaw: yawDegreesFromBasis(headForward, headUp) },
          rig: rigPose,
        });
      }
      pendingXrSpawn = null;
    };

    /**
     * 補正の結果を、次のフレームの実際のカメラworld姿勢と突き合わせて出す。
     *
     * 見るのは `view=` に入っている値との差。位置で数cm〜10cm、yawで数度に
     * 収まっていれば実機でも合っている。大きくずれるときは、local-floorの
     * HMD poseをrigへ単純加算していないかを疑う。
     */
    const logXrSpawn = () => {
      if (!xrSpawnDebug) return;
      const actual = currentViewPose();
      const desired = xrSpawnDebug;
      xrSpawnDebug = null;
      console.info("[sog-xr] spawned", {
        desired,
        actual,
        positionDelta: Math.hypot(actual.x - desired.x, actual.y - desired.y, actual.z - desired.z),
        yawDelta: Math.abs(normalizeYawDegrees(actual.yaw - desired.yaw)),
      });
    };

    const updateXrMovement = (deltaSeconds: number) => {
      let moveX = 0;
      let moveY = 0;
      let rotateX = 0;
      let heightDirection = 0;
      for (const inputSource of xr.input.inputSources) {
        const gamepad = inputSource.gamepad;
        if (!gamepad) continue;
        const axes = gamepad.axes;
        if (inputSource.handedness === XRHAND_LEFT) {
          moveX += stickAxis(axes, "x");
          moveY += stickAxis(axes, "y");
        } else if (inputSource.handedness === XRHAND_RIGHT) {
          const rightStickX = stickAxis(axes, "x");
          const rightStickY = stickAxis(axes, "y");
          // Holding Grip temporarily changes the right stick from smooth turn
          // to gaze-relative locomotion. Left-stick locomotion stays enabled.
          const gripPressed =
            inputSource.squeezing || gamepadButtonPressed(gamepad.buttons, 1);
          if (gripPressed) {
            moveX += rightStickX;
            moveY += rightStickY;
          } else {
            rotateX = rightStickX;
          }
          // PICO 4 / PICO 4 Ultra's xr-standard layout exposes A and B at
          // indices 4 and 5. Hold A to rise and B to descend.
          heightDirection =
            Number(gamepadButtonPressed(gamepad.buttons, 4)) -
            Number(gamepadButtonPressed(gamepad.buttons, 5));
        }
      }

      if (moveX !== 0 || moveY !== 0) {
        flatForward.set(cameraEntity.forward.x, 0, cameraEntity.forward.z);
        if (flatForward.lengthSq() > 0.0001) flatForward.normalize();
        flatRight.set(cameraEntity.right.x, 0, cameraEntity.right.z);
        if (flatRight.lengthSq() > 0.0001) flatRight.normalize();
        xrMovement
          .set(0, 0, 0)
          .addScaled(flatRight, moveX)
          .addScaled(flatForward, -moveY);
        if (xrMovement.lengthSq() > 1) xrMovement.normalize();
        rig.setLocalPosition(rig.getLocalPosition().addScaled(xrMovement, 1.8 * deltaSeconds));
      }
      if (rotateX !== 0) {
        rig.rotateLocal(0, -rotateX * 105 * deltaSeconds, 0);
      }
      if (heightDirection !== 0) {
        rig.setLocalPosition(
          rig.getLocalPosition().addScaled(UP, heightDirection * 1.2 * deltaSeconds),
        );
      }
    };

    const onUpdate = (deltaSeconds: number) => {
      if (xr.active) {
        // 突き合わせは補正の次のフレーム。実際のHMD poseで組み上がった
        // world姿勢を見たいので、適用より先に置く。
        logXrSpawn();
        applyXrSpawn();
        updateXrMovement(Math.min(deltaSeconds, 0.05));
      } else {
        updateDesktopMovement(Math.min(deltaSeconds, 0.05));
      }
    };
    app.on("update", onUpdate);

    const resize = () => {
      if (xr.active) return;
      const width = Math.max(1, viewport.clientWidth);
      const height = Math.max(1, viewport.clientHeight);
      app.resizeCanvas(width, height);
      applyFov(width, height);
      updateDesktopCamera();
    };
    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(viewport);

    canvas.addEventListener("pointerdown", onPointerDown);
    canvas.addEventListener("pointermove", onPointerMove);
    canvas.addEventListener("pointerup", onPointerUp);
    canvas.addEventListener("pointercancel", onPointerUp);
    canvas.addEventListener("contextmenu", onContextMenu);
    canvas.addEventListener("dblclick", onDoubleClick);
    canvas.addEventListener("wheel", onWheel, { passive: false });
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", clearPressedKeys);
    window.addEventListener("dragenter", onDragEnter);
    window.addEventListener("dragover", onDragOver);
    window.addEventListener("dragleave", onDragLeave);
    window.addEventListener("drop", onDrop);

    resize();
    app.start();
    // `?id=` / `?ss=` 付きで開かれたら、サンプルには一切触れずにその空間だけを読む。
    // サンプル→本番の二重ロード（fetch・decode・GPU転送）を起こさないため、
    // ここで分岐してどちらか一方だけを呼ぶ。
    const deepLink = readSpaceRef(window.location.href);
    const deepLinkUrl =
      deepLink === null
        ? null
        : deepLink.provider === "insta360"
          ? shareUrlFromShareId(deepLink.id)
          : sceneUrlFromSceneId(deepLink.id);
    if (deepLinkUrl) void loadSource({ kind: "url", value: deepLinkUrl }, true);
    else void loadSample(true);
    setXrAvailable(xr.isAvailable(XRTYPE_VR));

    return () => {
      disposed = true;
      currentViewRef.current = () => null;
      prepareVrRef.current = () => undefined;
      startVrRef.current = () => undefined;
      loadSourceRef.current = () => undefined;
      restoreSampleRef.current = () => undefined;
      resizeObserver.disconnect();
      canvas.removeEventListener("pointerdown", onPointerDown);
      canvas.removeEventListener("pointermove", onPointerMove);
      canvas.removeEventListener("pointerup", onPointerUp);
      canvas.removeEventListener("pointercancel", onPointerUp);
      canvas.removeEventListener("contextmenu", onContextMenu);
      canvas.removeEventListener("dblclick", onDoubleClick);
      canvas.removeEventListener("wheel", onWheel);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", clearPressedKeys);
      window.removeEventListener("dragenter", onDragEnter);
      window.removeEventListener("dragover", onDragOver);
      window.removeEventListener("dragleave", onDragLeave);
      window.removeEventListener("drop", onDrop);
      if (xr.active) xr.end();
      optimizeWorker?.terminate();
      if (original?.objectUrl) URL.revokeObjectURL(original.objectUrl);
      if (optimizedEntry?.objectUrl) URL.revokeObjectURL(optimizedEntry.objectUrl);
      app.destroy();
      viewport.replaceChildren();
    };
  }, []);

  targetSplatsRef.current = targetSplats;

  useEffect(() => () => {
    if (copyTimerRef.current !== null) clearTimeout(copyTimerRef.current);
  }, []);

  /**
   * 表示中の空間のViewerリンクをクリップボードへ入れる。
   *
   * 共有ID／シーンIDから今のorigin/pathnameで組み立てるので、GitHub Pagesでも
   * localhostでも、開いているのと同じ配信先のURLになる。
   *
   * `view` を選ぶと、いま見えている視点（world空間の位置・yaw・pitch）を
   * `view=` に足したリンクになる。受け取った側はDesktopでもQuestでも
   * 同じ場所・同じ向きから始まる。
   */
  const copyPermalink = async (target: CopyTarget) => {
    const space = spaceRefOf(source);
    if (!space) return;
    const pose = target === "view" ? currentViewRef.current() : null;
    if (target === "view" && !pose) return;
    const permalink = permalinkFor(window.location.href, space, pose);
    if (!permalink) return;
    // 視点リンクはアドレスバーも合わせておく。Clipboard APIが使えない環境でも
    // 同じURLをアドレスバーから拾えるようにするため。
    if (target === "view") window.history.replaceState(null, "", permalink);
    if (copyTimerRef.current !== null) clearTimeout(copyTimerRef.current);
    try {
      await navigator.clipboard.writeText(permalink);
      setCopyState({ target, state: "done" });
    } catch {
      // 非セキュアコンテキストなどでClipboard APIが使えない場合。
      // 同じURLはアドレスバーに出ているので、そちらを案内する。
      setCopyState({ target, state: "error" });
    }
    copyTimerRef.current = setTimeout(() => setCopyState(null), 2400);
  };

  /** コピーボタンの表示。押されたボタンにだけ結果を出す。 */
  const copyLabel = (target: CopyTarget, idle: string) =>
    copyState?.target !== target
      ? idle
      : copyState.state === "done"
        ? "✓ コピーしました"
        : "コピーできませんでした（アドレスバーのURLをお使いください）";

  const isSample = source.kind === "sample";
  // リンクを配れる空間かどうか。ラベルではなくproviderで決まる。
  const space = spaceRefOf(source);
  // VR向け軽量化を出せない理由。端末側の制約が先、次に表示中の空間の形。
  const optimizeBlocked = optimizeUnsupported ?? optimizeSourceReason;
  // 実際にVRへ持っていく版。軽量化を出せないときは、選択がどうであれOriginal。
  // 選択そのもの (`vrVariant`) は残すので、表示できる空間へ戻れば元の選択に戻る。
  const effectiveVrVariant: VrVariant = optimizeBlocked ? "original" : vrVariant;
  const sourceBusy = sourceStage !== "";
  const optimizing = optimizeStage !== "";
  const optimizedMatches = optimized !== null && optimized.targetSplats === targetSplats;
  const notice = sourceError && !openOpen
    ? { title: "空間を読み込めませんでした", body: sourceError }
    : status === "error"
      ? { title: "読み込みに失敗しました", body: errorMessage }
      : errorMessage
        ? { title: "VRを開始できませんでした", body: errorMessage }
        : null;

  vrVariantRef.current = effectiveVrVariant;

  const submitFile = (file: File | undefined) => {
    if (file) loadSourceRef.current({ kind: "file", file });
  };

  return (
    <main className={`viewer-shell${inXr ? " is-xr" : ""}`}>
      <div ref={viewportRef} className="viewport" />
      <div className="atmosphere" aria-hidden="true" />

      <header className="topbar">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">◉</span>
          <span>SOG XR VIEWER</span>
        </div>
        <div className="topbar-meta">
          <div className={`source-pill${!pendingLabel && isSample ? " is-sample" : ""}`}>
            {pendingLabel ? "OPENING" : isSample ? "SAMPLE" : "OPENED"}
            <span className="source-name">{pendingLabel || source.label}</span>
          </div>
          <div className="format-pill">
            <span className="live-dot" />
            PLAYCANVAS · SOG v2
            {originalSplats ? ` · ${formatSplats(originalSplats)} SPLATS` : ""}
          </div>
          {source.supersplat && (
            <div className="source-credit">
              <span className="source-provider">SUPERSPLAT</span>
              {source.supersplat.title && (
                <span className="source-credit-title">{source.supersplat.title}</span>
              )}
              {source.supersplat.author && (
                <span className="source-credit-author">{source.supersplat.author}</span>
              )}
              {source.supersplat.license && (
                <span className="source-credit-license">{source.supersplat.license.label}</span>
              )}
              <a
                className="source-credit-link"
                href={source.supersplat.pageUrl}
                target="_blank"
                rel="noreferrer noopener"
              >
                Original ↗
              </a>
            </div>
          )}
        </div>
      </header>

      <section className="intro" aria-label="Spatial Capture viewer">
        <p className="eyebrow">INSTA360 SPATIAL CAPTURE</p>
        <h1>記憶の中へ、<br />一歩踏み込む。</h1>
        <p className="intro-copy">
          PICO 4 UltraやQuestのブラウザで開き、VRを開始してください。VR用の軽量SOGは
          ブラウザ内で生成してキャッシュするので、2回目からは待ち時間なく入れます。
        </p>
      </section>

      <div className="viewer-actions">
        <button
          id="open-space"
          className="open-button"
          type="button"
          disabled={status === "loading"}
          aria-label="別の空間を開く"
          onClick={() => {
            setSourceError("");
            setOpenOpen(true);
          }}
        >
          <span className="open-icon" aria-hidden="true">＋</span>
          空間を開く
        </button>
        <button
          id="enter-vr"
          className="vr-button"
          type="button"
          disabled={!xrAvailable || status !== "ready"}
          aria-label="VR表示を開始"
          onClick={() => {
            setOptimizeError("");
            setVrOpen(true);
          }}
        >
          <span className="vr-icon" aria-hidden="true">◫</span>
          VRを開始
        </button>
        {space && (
          <>
            <button
              id="copy-permalink"
              className="copy-link-button"
              type="button"
              aria-label="この空間のリンクをコピー"
              onClick={() => void copyPermalink("space")}
            >
              {copyLabel("space", "この空間のリンクをコピー")}
            </button>
            <button
              id="copy-view-permalink"
              className="copy-link-button"
              type="button"
              aria-label="この視点のリンクをコピー"
              onClick={() => void copyPermalink("view")}
            >
              {copyLabel("view", "この視点のリンクをコピー")}
            </button>
          </>
        )}
        <p className="control-hint">
          <span>左スティック</span> 移動&nbsp;&nbsp;·&nbsp;&nbsp;<span>右スティック</span> 旋回
          &nbsp;&nbsp;·&nbsp;&nbsp;<span>Grip＋右スティック</span> 視線方向に移動
          &nbsp;&nbsp;·&nbsp;&nbsp;<span>A 上昇 / B 下降</span>
        </p>
      </div>

      {openOpen && (
        <div className="quality-backdrop">
          <section
            className="quality-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="open-title"
          >
            <button
              className="quality-close"
              type="button"
              aria-label="空間を開くパネルを閉じる"
              disabled={sourceBusy}
              onClick={() => {
                setOpenOpen(false);
                setSourceError("");
              }}
            >
              ×
            </button>
            <p className="quality-eyebrow">OPEN SPACE</p>
            <h2 id="open-title">空間を開く</h2>
            <p className="quality-copy">
              {SHARE_RESOLVER.available
                ? "Insta360 Spatial Captureの共有URL、またはSuperSplatの公開シーンURLを貼り付けるか、SOGファイルをドラッグ＆ドロップ、またはファイル選択から読み込みます。SuperSplatは作者がダウンロードを許可したシーンのみ開けます。"
                : "SOGファイルをドラッグ＆ドロップするか、.sog のURLを指定して読み込みます。"}
            </p>

            <form
              className="open-url"
              onSubmit={(event) => {
                event.preventDefault();
                loadSourceRef.current({ kind: "url", value: openInput });
              }}
            >
              <input
                className="open-input"
                type="text"
                inputMode="url"
                autoComplete="off"
                spellCheck={false}
                placeholder={
                  SHARE_RESOLVER.available
                    ? "https://superspl.at/scene/... または https://app.insta360.com/3dspace/detail/..."
                    : "https://example.com/space.sog"
                }
                aria-label={
                  SHARE_RESOLVER.available
                    ? "Insta360の共有URL、SuperSplatのシーンURL、またはSOGのURL"
                    : "SOGのURL"
                }
                value={openInput}
                disabled={sourceBusy}
                onChange={(event) => setOpenInput(event.target.value)}
              />
              <button className="open-submit" type="submit" disabled={sourceBusy}>
                読み込む
              </button>
            </form>

            {!SHARE_RESOLVER.available && (
              <p className="open-note" role="note">
                {SHARE_RESOLVER.reason}
              </p>
            )}

            <div className={`open-dropzone${dragActive ? " is-active" : ""}`}>
              <strong>SOGファイルをドロップして開く</strong>
              <span>ページのどこにドロップしても読み込めます</span>
              <button
                className="open-file"
                type="button"
                disabled={sourceBusy}
                onClick={() => fileInputRef.current?.click()}
              >
                ファイルを選択
              </button>
              <input
                ref={fileInputRef}
                className="open-file-input"
                type="file"
                accept=".sog"
                aria-label="SOGファイルを選択"
                onChange={(event) => {
                  submitFile(event.target.files?.[0]);
                  event.target.value = "";
                }}
              />
            </div>

            <div className="open-current">
              <span>
                表示中: {source.label}
                {isSample ? "（サンプル）" : ""}
              </span>
              <button
                className="open-reset"
                type="button"
                disabled={isSample || sourceBusy}
                onClick={() => restoreSampleRef.current()}
              >
                サンプルに戻す
              </button>
            </div>

            {sourceBusy && (
              <div className="quality-preparing" role="status" aria-live="polite">
                <div className="loading-row">
                  <span>{sourceStage}</span>
                  <span>{sourceProgress < 0 ? "…" : `${sourceProgress}%`}</span>
                </div>
                <div className="progress-track">
                  <span style={{ width: `${sourceProgress < 0 ? 100 : Math.max(4, sourceProgress)}%` }} />
                </div>
              </div>
            )}

            {sourceError && (
              <p className="open-error" role="alert">
                {sourceError}
              </p>
            )}
          </section>
        </div>
      )}

      {vrOpen && (
        <div className="quality-backdrop">
          <section
            className="quality-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="vr-title"
          >
            <button
              className="quality-close"
              type="button"
              aria-label="VR設定を閉じる"
              disabled={optimizing}
              onClick={() => setVrOpen(false)}
            >
              ×
            </button>
            <p className="quality-eyebrow">VR QUALITY</p>
            <h2 id="vr-title">VRで表示</h2>
            <p className="quality-copy">
              オリジナルのまま入るか、VR向けに軽量化したSOGで入るかを選べます。
              軽量化はこのブラウザの中だけで行い、SOGを外部へ送信することはありません。
            </p>

            <div className="quality-options">
              <button
                className={`quality-option${effectiveVrVariant === "original" ? " is-active" : ""}`}
                type="button"
                disabled={optimizing}
                onClick={() => setVrVariant("original")}
              >
                <span className="quality-badge is-neutral">ORIGINAL</span>
                <strong>オリジナル</strong>
                <span>{formatSplats(originalSplats)} splats · VR解像度 78%</span>
              </button>
              <button
                className={`quality-option${effectiveVrVariant === "optimized" ? " is-active" : ""}`}
                type="button"
                disabled={optimizing || optimizeBlocked !== null}
                onClick={() => setVrVariant("optimized")}
              >
                <span className="quality-badge">PICO推奨</span>
                <strong>VR向けに最適化</strong>
                <span>
                  {optimizedMatches
                    ? `✓ 生成済み ${formatSplats(optimized.splats)} splats · ${formatBytes(optimized.bytes)}`
                    : `${formatSplats(targetSplats)} splats へ削減 · VR解像度 52%`}
                </span>
              </button>
            </div>

            {effectiveVrVariant === "optimized" && optimizeBlocked === null && (
              <label className="vr-target">
                <span>目標splat数</span>
                <select
                  value={targetSplats}
                  disabled={optimizing}
                  onChange={(event) => setTargetSplats(Number(event.target.value))}
                >
                  {TARGET_SPLAT_PRESETS.map((preset) => (
                    <option key={preset} value={preset}>
                      {formatSplats(preset)}
                    </option>
                  ))}
                </select>
              </label>
            )}

            {optimizeBlocked && (
              <p className="open-error" role="status">
                {optimizeBlocked}VR向けSOGの生成はできませんが、オリジナルのままVRを開始できます。
              </p>
            )}

            {optimizing && (
              <div className="quality-preparing" role="status" aria-live="polite">
                <div className="loading-row">
                  <span>
                    VR向けに最適化しています… {optimizeStage}
                  </span>
                  <span>{optimizeRatio}%</span>
                </div>
                <div className="progress-track">
                  <span style={{ width: `${Math.max(4, optimizeRatio)}%` }} />
                </div>
                <p>
                  {formatSplats(originalSplats)} → {formatSplats(targetSplats)} splats
                </p>
              </div>
            )}

            {optimizeError && (
              <p className="open-error" role="alert">
                {optimizeError}
              </p>
            )}

            {!optimizing && (
              <button
                className="quality-start"
                type="button"
                onClick={() => {
                  if (effectiveVrVariant === "optimized" && vrReady && optimizedMatches) {
                    startVrRef.current();
                  } else {
                    prepareVrRef.current(effectiveVrVariant);
                  }
                }}
              >
                {effectiveVrVariant === "original" || (vrReady && optimizedMatches)
                  ? "VRを開始"
                  : "最適化してVRを開始"}
              </button>
            )}
          </section>
        </div>
      )}

      {dragActive && (
        <div className="drop-overlay" aria-hidden="true">
          <div className="drop-overlay-card">
            <span className="drop-icon">⤓</span>
            <strong>SOGファイルをドロップして開く</strong>
            <span>.sog 形式に対応しています</span>
          </div>
        </div>
      )}

      {status === "loading" && (
        <div className="loading-card" role="status" aria-live="polite">
          <div className="loading-row">
            <span>空間データを読み込み中</span>
            <span>{progress < 0 ? "…" : `${progress}%`}</span>
          </div>
          <div className="progress-track">
            <span style={{ width: `${progress < 0 ? 100 : Math.max(4, progress)}%` }} />
          </div>
          <p>15.5 MB · 1M · SAMPLE · PLAYCANVAS STANDARD SOG LOADER</p>
        </div>
      )}

      {status !== "loading" && sourceBusy && !openOpen && (
        <div className="loading-card" role="status" aria-live="polite">
          <div className="loading-row">
            <span>{sourceStage}</span>
            <span>{sourceProgress < 0 ? "…" : `${sourceProgress}%`}</span>
          </div>
          <div className="progress-track">
            <span style={{ width: `${sourceProgress < 0 ? 100 : Math.max(4, sourceProgress)}%` }} />
          </div>
          <p>PLAYCANVAS STANDARD SOG LOADER</p>
        </div>
      )}

      {notice && (
        <div className="error-card" role="alert">
          <strong>{notice.title}</strong>
          <span>{notice.body}</span>
        </div>
      )}

      <footer className="footer-bar">
        <div>
          <span className="desktop-label">DESKTOP</span>
          左ドラッグ 回転 · 右ドラッグ 平行移動 · ホイール ズーム · ダブルクリック
          視点リセット · WASD 移動 · E/Q 上下 · Shift 高速
        </div>
        <div className="secure-label">PLAYCANVAS · WEBXR · SECURE SESSION</div>
      </footer>
    </main>
  );
}
