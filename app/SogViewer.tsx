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
  toAbsoluteUrl,
} from "./insta360";

type ViewerStatus = "loading" | "ready" | "error";
type VrQuality = "smooth" | "high";
type SourceKind = "sample" | "url" | "file";
type ViewerSource = { kind: SourceKind; label: string };
type LoadRequest = { kind: "url"; value: string } | { kind: "file"; file: File };
type Bounds = { min: Vec3; max: Vec3 };

const HIGH_SPLAT_COUNT = 1_000_000;
const SMOOTH_SPLAT_COUNT = 500_000;
const SAMPLE_LABEL = "サンプル空間 capture.sog";
// Percentile bounds (2–98%) decoded from capture.sog. A handful of distant
// outliers in the raw bounds are intentionally ignored when placing the room.
const CAPTURE_MIN = new Vec3(-6.911, -1.263, -3.762);
const CAPTURE_MAX = new Vec3(6.178, 1.654, 3.802);
const SAMPLE_DESKTOP_TARGET = new Vec3(0, 1.35, -2.8);
const SAMPLE_DESKTOP_DISTANCE = 2.8;
const INITIAL_PITCH = 0.08;
const UP = new Vec3(0, 1, 0);
// Insta360の共有ページはCORSを許可していないため、解決とSOGの中継はサーバー側で行う。
// GitHub Pagesのような静的ホスティングには /api が無いので、Worker版へフォールバックする。
const RESOLVER_FALLBACK_ORIGIN = "https://insta360-sog-xr-viewer.afjk01.chatgpt.site";
// 任意SOGの床合わせに使う分位点。外れ値を無視して部屋の広がりを求める。
const BOUNDS_PERCENTILE = 0.02;
const BOUNDS_MAX_SAMPLES = 60_000;

const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value));

const stickAxis = (axes: readonly number[], axis: "x" | "y") => {
  const value = axes.length >= 4 ? axes[axis === "x" ? 2 : 3] : axes[axis === "x" ? 0 : 1];
  return Math.abs(value ?? 0) < 0.16 ? 0 : (value ?? 0);
};

const gamepadButtonPressed = (buttons: readonly GamepadButton[], index: number) => {
  const button = buttons[index];
  return Boolean(button?.pressed || (button?.value ?? 0) > 0.5);
};

const resolverOrigins = () => {
  const origins = [""];
  if (typeof window !== "undefined" && window.location.origin !== RESOLVER_FALLBACK_ORIGIN) {
    origins.push(RESOLVER_FALLBACK_ORIGIN);
  }
  return origins;
};

/** 読み込んだSOGの重心分布から、外れ値に引きずられない配置用バウンズを求める。 */
const percentileBounds = (centers: Float32Array): Bounds | null => {
  const count = Math.floor(centers.length / 3);
  if (count < 1) return null;
  const stride = Math.max(1, Math.ceil(count / BOUNDS_MAX_SAMPLES));
  const xs: number[] = [];
  const ys: number[] = [];
  const zs: number[] = [];
  for (let index = 0; index < count; index += stride) {
    xs.push(centers[index * 3]);
    ys.push(centers[index * 3 + 1]);
    zs.push(centers[index * 3 + 2]);
  }
  const range = (values: number[]) => {
    values.sort((a, b) => a - b);
    const last = values.length - 1;
    return [
      values[Math.round(last * BOUNDS_PERCENTILE)],
      values[Math.round(last * (1 - BOUNDS_PERCENTILE))],
    ] as const;
  };
  const [minX, maxX] = range(xs);
  const [minY, maxY] = range(ys);
  const [minZ, maxZ] = range(zs);
  return { min: new Vec3(minX, minY, minZ), max: new Vec3(maxX, maxY, maxZ) };
};

const boundsFromResource = (resource: unknown): Bounds | null => {
  const splat = resource as
    | { centers?: Float32Array | null; aabb?: { getMin(): Vec3; getMax(): Vec3 } | null }
    | null
    | undefined;
  const centers = splat?.centers;
  if (centers && centers.length >= 3) {
    const bounds = percentileBounds(centers);
    if (bounds) return bounds;
  }
  const aabb = splat?.aabb;
  if (aabb) return { min: aabb.getMin().clone(), max: aabb.getMax().clone() };
  return null;
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
  const chooseQualityRef = useRef<(quality: VrQuality) => void>(() => undefined);
  const startPreparedVrRef = useRef<() => void>(() => undefined);
  const loadSourceRef = useRef<(request: LoadRequest) => void>(() => undefined);
  const restoreSampleRef = useRef<() => void>(() => undefined);
  const [status, setStatus] = useState<ViewerStatus>("loading");
  const [progress, setProgress] = useState(0);
  const [xrAvailable, setXrAvailable] = useState(false);
  const [inXr, setInXr] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");
  const [qualityOpen, setQualityOpen] = useState(false);
  const [activeQuality, setActiveQuality] = useState<VrQuality>("high");
  const [preparingQuality, setPreparingQuality] = useState<VrQuality | null>(null);
  const [preparedQuality, setPreparedQuality] = useState<VrQuality | null>(null);
  const [qualityProgress, setQualityProgress] = useState(0);
  const [source, setSource] = useState<ViewerSource>({ kind: "sample", label: SAMPLE_LABEL });
  const [sourceSplats, setSourceSplats] = useState<number | null>(null);
  const [openOpen, setOpenOpen] = useState(false);
  const [openInput, setOpenInput] = useState("");
  const [sourceStage, setSourceStage] = useState("");
  const [sourceProgress, setSourceProgress] = useState(0);
  const [sourceError, setSourceError] = useState("");
  const [dragActive, setDragActive] = useState(false);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;

    let disposed = false;
    let dragging = false;
    let lastX = 0;
    let lastY = 0;
    let yaw = 0;
    let pitch = INITIAL_PITCH;
    let distance = SAMPLE_DESKTOP_DISTANCE;
    const pressedKeys = new Set<string>();
    const desktopTarget = new Vec3().copy(SAMPLE_DESKTOP_TARGET);

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
      fov: 58,
      nearClip: 0.01,
      farClip: 500,
    });
    rig.addChild(cameraEntity);
    const camera = cameraEntity.camera as CameraComponent;

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

    const splatEntity = new Entity("insta360-sog");
    // Insta360's capture axes are Y-down / Z-forward. A 180° X rotation makes
    // the room Y-up / Z-back without using a negative scale in stereo XR.
    splatEntity.setLocalEulerAngles(180, 0, 0);
    app.root.addChild(splatEntity);

    /** 180°回転後に部屋が原点に中心し、床がy=0に来るよう配置する。 */
    const applyPlacement = (bounds: Bounds) => {
      splatEntity.setLocalEulerAngles(180, 0, 0);
      splatEntity.setLocalPosition(
        -(bounds.min.x + bounds.max.x) * 0.5,
        bounds.max.y,
        (bounds.min.z + bounds.max.z) * 0.5,
      );
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

    // 360度キャプチャは撮影位置＝部屋の中心なので、外から回り込むのではなく
    // 中心の目線の高さにカメラを置き、外側を向かせる。軌道中心を前方に置いた
    // サンプルの手動調整値を、任意のSOGの高さへ一般化したもの。
    const frameBounds = (bounds: Bounds) => {
      const eyeHeight = clamp((bounds.max.y - bounds.min.y) * 0.54, 1, 2.2);
      const orbit = SAMPLE_DESKTOP_DISTANCE;
      resetView(
        new Vec3(0, eyeHeight - orbit * Math.sin(INITIAL_PITCH), -orbit * Math.cos(INITIAL_PITCH)),
        orbit,
      );
    };

    applyPlacement({ min: CAPTURE_MIN, max: CAPTURE_MAX });

    const captureAsset = new Asset("Insta360 Spatial Capture — High", "gsplat", {
      url: "capture.sog",
      filename: "capture.sog",
      size: 16_241_776,
    });
    const smoothAsset = new Asset("Insta360 Spatial Capture — Smooth", "gsplat", {
      url: "capture-vr.sog",
      filename: "capture-vr.sog",
      size: 6_188_721,
    });
    const isSampleAsset = (asset: Asset | null) => asset === captureAsset || asset === smoothAsset;
    const prefersSmoothInitially = /Pico|PICO|OculusBrowser|Quest/i.test(navigator.userAgent);
    const initialAsset = prefersSmoothInitially ? smoothAsset : captureAsset;
    const initialQuality: VrQuality = prefersSmoothInitially ? "smooth" : "high";
    setActiveQuality(initialQuality);
    let loadToken = 0;
    let sampleActive = true;
    let currentQuality: VrQuality = initialQuality;
    let currentAsset: Asset | null = null;
    let customEntry: { asset: Asset; objectUrl: string | null } | null = null;
    let splatComponent: GSplatComponent | null = null;
    let pendingFoveation = 0.55;
    // 進捗はカード・画質ダイアログ・空間パネルで表示先が変わるので一箇所で束ねる。
    let progressSink: ((percent: number) => void) | null = setProgress;

    const onAssetProgress = (receivedBytes: number, totalBytes: number) => {
      if (disposed || !progressSink) return;
      progressSink(totalBytes > 0 ? Math.min(99, Math.round((receivedBytes / totalBytes) * 100)) : -1);
    };
    captureAsset.on("progress", onAssetProgress);
    smoothAsset.on("progress", onAssetProgress);

    const assetErrorMessage = (error: unknown) =>
      error instanceof Error
        ? error.message
        : typeof error === "string"
          ? error
          : "SOGファイルを読み込めませんでした。";
    const onSampleError = (error: unknown) => {
      if (disposed) return;
      progressSink = null;
      setPreparingQuality(null);
      setPreparedQuality(null);
      setErrorMessage(assetErrorMessage(error));
      if (!splatComponent) setStatus("error");
    };
    captureAsset.on("error", onSampleError);
    smoothAsset.on("error", onSampleError);

    /** GSplatを差し替える。直前がサンプルなら解放してVRAMを空ける。 */
    const attachAsset = (asset: Asset) => {
      const previous = currentAsset;
      if (splatComponent) splatComponent.asset = asset;
      else {
        splatComponent = splatEntity.addComponent("gsplat", {
          asset,
          unified: true,
        }) as GSplatComponent;
      }
      currentAsset = asset;
      if (previous && previous !== asset && previous.loaded && isSampleAsset(previous)) {
        previous.unload();
      }
    };

    const releaseCustom = (entry: { asset: Asset; objectUrl: string | null } | null) => {
      if (!entry) return;
      app.assets.remove(entry.asset);
      entry.asset.off();
      if (entry.asset.loaded) entry.asset.unload();
      if (entry.objectUrl) URL.revokeObjectURL(entry.objectUrl);
    };

    initialAsset.ready(() => {
      if (disposed || !sampleActive) return;
      attachAsset(initialAsset);
      progressSink = null;
      setActiveQuality(initialQuality);
      setProgress(100);
      setStatus("ready");
    });
    app.assets.add(captureAsset);
    app.assets.add(smoothAsset);

    const activateSampleAsset = (quality: VrQuality, asset: Asset) => {
      attachAsset(asset);
      currentQuality = quality;
      progressSink = null;
      setActiveQuality(quality);
      setPreparingQuality(null);
      setPreparedQuality(quality);
      setQualityProgress(100);
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
      rig.setLocalPosition(0, 0, 0);
      rig.setLocalEulerAngles(0, 0, 0);
      updateDesktopCamera();
    };
    const onXrError = (error: Error) => {
      if (disposed) return;
      setErrorMessage(`VRを開始できませんでした: ${error.message}`);
    };

    xr.on(`available:${XRTYPE_VR}`, onXrAvailability);
    xr.on("start", onXrStart);
    xr.on("end", onXrEnd);
    xr.on("error", onXrError);

    const startVr = (quality: VrQuality) => {
      if (disposed || !xr.isAvailable(XRTYPE_VR) || !currentAsset?.loaded) return;
      setErrorMessage("");
      setQualityOpen(false);
      setPreparedQuality(null);
      pressedKeys.clear();
      rig.setLocalPosition(0, 0, 0);
      rig.setLocalEulerAngles(0, 0, 0);
      pendingFoveation = quality === "smooth" ? 0.82 : 0.55;
      xr.start(camera, XRTYPE_VR, XRSPACE_LOCALFLOOR, {
        framebufferScaleFactor: quality === "smooth" ? 0.52 : 0.78,
        optionalFeatures: ["hand-tracking"],
        callback: (error) => {
          if (disposed || !error) return;
          setErrorMessage(`VRを開始できませんでした: ${error.message}`);
        },
      });
    };

    chooseQualityRef.current = (quality) => {
      if (disposed || !splatComponent) return;
      setErrorMessage("");
      setPreparedQuality(null);

      // 任意のSOGでは差し替えるアセットが無いので、描画負荷だけを切り替える。
      if (!sampleActive) {
        currentQuality = quality;
        setActiveQuality(quality);
        startVr(quality);
        return;
      }

      const asset = quality === "smooth" ? smoothAsset : captureAsset;
      if (asset.loaded) {
        if (currentAsset !== asset) activateSampleAsset(quality, asset);
        startVr(quality);
        return;
      }

      loadToken += 1;
      const token = loadToken;
      progressSink = setQualityProgress;
      setPreparingQuality(quality);
      setQualityProgress(0);
      asset.ready(() => {
        if (disposed || token !== loadToken || !sampleActive) return;
        activateSampleAsset(quality, asset);
      });
      app.assets.load(asset);
    };
    startPreparedVrRef.current = () => startVr(currentQuality);

    /** 共有URLをサーバー経由でSOGへ解決し、中継エンドポイントのURLを返す。 */
    const resolveShare = async (shareUrl: string) => {
      let lastMessage = "";
      for (const origin of resolverOrigins()) {
        const query = `url=${encodeURIComponent(shareUrl)}`;
        try {
          const response = await fetch(`${origin}/api/insta360?${query}`, {
            headers: { accept: "application/json" },
          });
          const payload = (await response.json().catch(() => null)) as
            | { assetUrl?: string; error?: string }
            | null;
          if (response.ok && payload?.assetUrl) {
            return `${origin}/api/insta360?mode=asset&${query}`;
          }
          lastMessage = payload?.error ?? `共有URLを解決できませんでした (HTTP ${response.status})`;
        } catch {
          lastMessage = "共有URLの解決サービスに接続できませんでした。";
        }
      }
      throw new Error(lastMessage || "共有URLを解決できませんでした。");
    };

    const loadSource = async (request: LoadRequest) => {
      if (disposed) return;
      loadToken += 1;
      const token = loadToken;
      setSourceError("");

      let url = "";
      let filename = "space.sog";
      let label = "";
      let objectUrl: string | null = null;

      if (request.kind === "file") {
        if (!/\.sog$/i.test(request.file.name)) {
          setSourceError("SOGファイル (.sog) を選択してください。");
          return;
        }
        objectUrl = URL.createObjectURL(request.file);
        url = objectUrl;
        filename = request.file.name;
        label = request.file.name;
      } else {
        const input = request.value.trim();
        const share = parseInsta360ShareUrl(input);
        const direct = isSpatialAssetUrl(input) ? toAbsoluteUrl(input) : null;
        if (share) {
          label = `Insta360共有 ${share.shareId}`;
          setSourceStage("共有URLを解決中");
          setSourceProgress(-1);
          try {
            url = await resolveShare(share.shareUrl);
          } catch (error) {
            if (disposed || token !== loadToken) return;
            setSourceStage("");
            setSourceError(assetErrorMessage(error));
            return;
          }
          filename = "insta360-share.sog";
        } else if (direct) {
          url = direct.toString();
          filename = direct.pathname.split("/").pop() || "space.sog";
          label = filename;
        } else {
          setSourceError("Insta360の共有URL、または .sog のURLを入力してください。");
          return;
        }
      }

      if (disposed || token !== loadToken) {
        if (objectUrl) URL.revokeObjectURL(objectUrl);
        return;
      }

      const asset = new Asset(label, "gsplat", { url, filename });
      const entry = { asset, objectUrl };
      progressSink = setSourceProgress;
      setSourceStage(`${label} を読み込み中`);
      setSourceProgress(0);

      asset.on("progress", onAssetProgress);
      asset.once("error", (error: unknown) => {
        if (disposed || token !== loadToken) return;
        progressSink = null;
        setSourceStage("");
        setSourceError(assetErrorMessage(error));
        releaseCustom(entry);
      });
      asset.ready(() => {
        if (disposed || token !== loadToken) {
          releaseCustom(entry);
          return;
        }
        const bounds = boundsFromResource(asset.resource) ?? { min: CAPTURE_MIN, max: CAPTURE_MAX };
        applyPlacement(bounds);
        frameBounds(bounds);
        const previous = customEntry;
        attachAsset(asset);
        customEntry = entry;
        sampleActive = false;
        releaseCustom(previous);
        progressSink = null;
        setSourceSplats(splatCountOf(asset.resource));
        setSourceStage("");
        setSourceProgress(100);
        setSource({ kind: request.kind === "file" ? "file" : "url", label });
        setStatus("ready");
        setErrorMessage("");
        setOpenOpen(false);
      });
      app.assets.add(asset);
      app.assets.load(asset);
    };
    loadSourceRef.current = (request) => {
      void loadSource(request);
    };

    const restoreSample = () => {
      if (disposed || sampleActive) return;
      loadToken += 1;
      const token = loadToken;
      setSourceError("");
      const asset = currentQuality === "smooth" ? smoothAsset : captureAsset;
      const show = () => {
        applyPlacement({ min: CAPTURE_MIN, max: CAPTURE_MAX });
        resetView(SAMPLE_DESKTOP_TARGET, SAMPLE_DESKTOP_DISTANCE);
        const previous = customEntry;
        attachAsset(asset);
        customEntry = null;
        sampleActive = true;
        releaseCustom(previous);
        progressSink = null;
        setSourceSplats(null);
        setSourceStage("");
        setSourceProgress(100);
        setSource({ kind: "sample", label: SAMPLE_LABEL });
        setStatus("ready");
      };

      if (asset.loaded) {
        show();
        return;
      }
      progressSink = setSourceProgress;
      setSourceStage(`${SAMPLE_LABEL} を読み込み中`);
      setSourceProgress(0);
      asset.ready(() => {
        if (disposed || token !== loadToken) return;
        show();
      });
      app.assets.load(asset);
    };
    restoreSampleRef.current = restoreSample;

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

    const onPointerDown = (event: PointerEvent) => {
      if (xr.active) return;
      dragging = true;
      lastX = event.clientX;
      lastY = event.clientY;
      canvas.setPointerCapture(event.pointerId);
    };
    const onPointerMove = (event: PointerEvent) => {
      if (!dragging || xr.active) return;
      yaw -= (event.clientX - lastX) * 0.006;
      pitch = clamp(pitch + (event.clientY - lastY) * 0.004, -0.75, 0.75);
      lastX = event.clientX;
      lastY = event.clientY;
      updateDesktopCamera();
    };
    const onPointerUp = (event: PointerEvent) => {
      dragging = false;
      if (canvas.hasPointerCapture(event.pointerId)) {
        canvas.releasePointerCapture(event.pointerId);
      }
    };
    const onWheel = (event: WheelEvent) => {
      if (xr.active) return;
      event.preventDefault();
      distance = clamp(distance + event.deltaY * 0.01, 2.2, 48);
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

    const updateXrMovement = (deltaSeconds: number) => {
      let moveX = 0;
      let moveY = 0;
      let rotateX = 0;
      let heightDirection = 0;
      for (const source of xr.input.inputSources) {
        const gamepad = source.gamepad;
        if (!gamepad) continue;
        const axes = gamepad.axes;
        if (source.handedness === XRHAND_LEFT) {
          moveX += stickAxis(axes, "x");
          moveY += stickAxis(axes, "y");
        } else if (source.handedness === XRHAND_RIGHT) {
          const rightStickX = stickAxis(axes, "x");
          const rightStickY = stickAxis(axes, "y");
          // Holding Grip temporarily changes the right stick from smooth turn
          // to gaze-relative locomotion. Left-stick locomotion stays enabled.
          const gripPressed =
            source.squeezing || gamepadButtonPressed(gamepad.buttons, 1);
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
      if (xr.active) updateXrMovement(Math.min(deltaSeconds, 0.05));
      else updateDesktopMovement(Math.min(deltaSeconds, 0.05));
    };
    app.on("update", onUpdate);

    const resize = () => {
      if (xr.active) return;
      const width = Math.max(1, viewport.clientWidth);
      const height = Math.max(1, viewport.clientHeight);
      app.resizeCanvas(width, height);
      updateDesktopCamera();
    };
    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(viewport);

    canvas.addEventListener("pointerdown", onPointerDown);
    canvas.addEventListener("pointermove", onPointerMove);
    canvas.addEventListener("pointerup", onPointerUp);
    canvas.addEventListener("pointercancel", onPointerUp);
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
    app.assets.load(initialAsset);
    setXrAvailable(xr.isAvailable(XRTYPE_VR));

    return () => {
      disposed = true;
      chooseQualityRef.current = () => undefined;
      startPreparedVrRef.current = () => undefined;
      loadSourceRef.current = () => undefined;
      restoreSampleRef.current = () => undefined;
      resizeObserver.disconnect();
      canvas.removeEventListener("pointerdown", onPointerDown);
      canvas.removeEventListener("pointermove", onPointerMove);
      canvas.removeEventListener("pointerup", onPointerUp);
      canvas.removeEventListener("pointercancel", onPointerUp);
      canvas.removeEventListener("wheel", onWheel);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", clearPressedKeys);
      window.removeEventListener("dragenter", onDragEnter);
      window.removeEventListener("dragover", onDragOver);
      window.removeEventListener("dragleave", onDragLeave);
      window.removeEventListener("drop", onDrop);
      if (xr.active) xr.end();
      if (customEntry?.objectUrl) URL.revokeObjectURL(customEntry.objectUrl);
      app.destroy();
      viewport.replaceChildren();
    };
  }, []);

  const isSample = source.kind === "sample";
  const splatCount = isSample
    ? activeQuality === "smooth"
      ? SMOOTH_SPLAT_COUNT
      : HIGH_SPLAT_COUNT
    : sourceSplats;
  const sourceBusy = sourceStage !== "";
  const notice = sourceError && !openOpen
    ? { title: "空間を読み込めませんでした", body: sourceError }
    : status === "error"
      ? { title: "読み込みに失敗しました", body: errorMessage }
      : errorMessage
        ? { title: "VRを開始できませんでした", body: errorMessage }
        : null;

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
          <div className={`source-pill${isSample ? " is-sample" : ""}`}>
            {isSample ? "SAMPLE" : "OPENED"}
            <span className="source-name">{source.label}</span>
          </div>
          <div className="format-pill">
            <span className="live-dot" />
            PLAYCANVAS · SOG v2
            {splatCount ? ` · ${splatCount.toLocaleString("ja-JP")} SPLATS` : ""}
          </div>
        </div>
      </header>

      <section className="intro" aria-label="Spatial Capture viewer">
        <p className="eyebrow">INSTA360 SPATIAL CAPTURE</p>
        <h1>記憶の中へ、<br />一歩踏み込む。</h1>
        <p className="intro-copy">
          PICO 4 UltraやQuestのブラウザで開き、VRを開始してください。頭の動きと両眼視差で、
          空間をそのまま立体的に体験できます。表示中はサンプルの空間です。お手持ちのSOGや
          Insta360の共有URLは「空間を開く」から読み込めます。
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
            setPreparedQuality(null);
            setQualityOpen(true);
          }}
        >
          <span className="vr-icon" aria-hidden="true">◫</span>
          VRを開始
        </button>
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
              Insta360 Spatial Captureの共有URLを貼り付けるか、SOGファイルをドラッグ＆ドロップ、
              またはファイル選択から読み込みます。
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
                placeholder="https://app.insta360.com/3dspace/detail/..."
                aria-label="Insta360共有URLまたはSOGのURL"
                value={openInput}
                disabled={sourceBusy}
                onChange={(event) => setOpenInput(event.target.value)}
              />
              <button className="open-submit" type="submit" disabled={sourceBusy}>
                読み込む
              </button>
            </form>

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

      {qualityOpen && (
        <div className="quality-backdrop">
          <section
            className="quality-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="quality-title"
          >
            <button
              className="quality-close"
              type="button"
              aria-label="画質選択を閉じる"
              disabled={preparingQuality !== null}
              onClick={() => {
                setQualityOpen(false);
                setPreparedQuality(null);
              }}
            >
              ×
            </button>
            <p className="quality-eyebrow">VR QUALITY</p>
            <h2 id="quality-title">画質を選択</h2>
            <p className="quality-copy">
              PICOでは「滑らかさ優先」がおすすめです。細部を確認したいときは高画質を選べます。
              {isSample ? "" : "読み込んだ空間では描画解像度のみが変わります。"}
            </p>

            <div className="quality-options">
              <button
                className={`quality-option${activeQuality === "smooth" ? " is-active" : ""}`}
                type="button"
                disabled={preparingQuality !== null}
                onClick={() => chooseQualityRef.current("smooth")}
              >
                <span className="quality-badge">PICO推奨</span>
                <strong>滑らかさ優先</strong>
                <span>{isSample ? "50万点 · 軽量カラー · VR解像度 52%" : "VR解像度 52% · 高フォービエイション"}</span>
              </button>
              <button
                className={`quality-option${activeQuality === "high" ? " is-active" : ""}`}
                type="button"
                disabled={preparingQuality !== null}
                onClick={() => chooseQualityRef.current("high")}
              >
                <span className="quality-badge is-neutral">DETAIL</span>
                <strong>高画質</strong>
                <span>{isSample ? "100万点 · フルカラー · VR解像度 78%" : "VR解像度 78% · 低フォービエイション"}</span>
              </button>
            </div>

            {preparingQuality && (
              <div className="quality-preparing" role="status" aria-live="polite">
                <div className="loading-row">
                  <span>{preparingQuality === "smooth" ? "滑らかさ優先" : "高画質"}を準備中</span>
                  <span>{qualityProgress}%</span>
                </div>
                <div className="progress-track">
                  <span style={{ width: `${Math.max(4, qualityProgress)}%` }} />
                </div>
              </div>
            )}

            {preparedQuality && !preparingQuality && (
              <button
                className="quality-start"
                type="button"
                onClick={() => startPreparedVrRef.current()}
              >
                {preparedQuality === "smooth" ? "滑らかさ優先" : "高画質"}でVRを開始
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
          <p>
            {activeQuality === "smooth" ? "5.9 MB · 500K" : "15.5 MB · 1M"}
            {" · SAMPLE · PLAYCANVAS STANDARD SOG LOADER"}
          </p>
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
          WASD 移動 · E/Q 上下 · Shift 高速 · ドラッグで回転
        </div>
        <div className="secure-label">PLAYCANVAS · WEBXR · SECURE SESSION</div>
      </footer>
    </main>
  );
}
