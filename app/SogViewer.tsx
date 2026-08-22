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
import { resolverConfig } from "./resolver-config";
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
type ViewerSource = { kind: SourceKind; label: string };
type LoadRequest = { kind: "url"; value: string } | { kind: "file"; file: File };
type Bounds = { min: Vec3; max: Vec3 };
type OptimizedInfo = { splats: number; bytes: number; fromCache: boolean; targetSplats: number };

const SAMPLE_URL = "capture.sog";
const SAMPLE_LABEL = "サンプル空間 capture.sog";
// Percentile bounds (2–98%) decoded from capture.sog. A handful of distant
// outliers in the raw bounds are intentionally ignored when placing the room.
const CAPTURE_MIN = new Vec3(-6.911, -1.263, -3.762);
const CAPTURE_MAX = new Vec3(6.178, 1.654, 3.802);
const SAMPLE_DESKTOP_TARGET = new Vec3(0, 1.35, -2.8);
const SAMPLE_DESKTOP_DISTANCE = 2.8;
const INITIAL_PITCH = 0.08;
const UP = new Vec3(0, 1, 0);
// 任意SOGの床合わせに使う分位点。外れ値を無視して部屋の広がりを求める。
const BOUNDS_PERCENTILE = 0.02;
const BOUNDS_MAX_SAMPLES = 60_000;
// 描画設定はVRで表示する版に合わせる。軽量版は解像度を下げてフォービエイションを強める。
const VR_RENDER_PROFILE: Record<VrVariant, { framebufferScaleFactor: number; foveation: number }> = {
  original: { framebufferScaleFactor: 0.78, foveation: 0.55 },
  optimized: { framebufferScaleFactor: 0.52, foveation: 0.82 },
};

// 解決エンドポイントの有無はビルド時に決まるので、一度だけ読めばよい。
const SHARE_RESOLVER = resolverConfig();

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
  const [source, setSource] = useState<ViewerSource>({ kind: "sample", label: SAMPLE_LABEL });
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

    let loadToken = 0;
    let optimizeToken = 0;
    // 表示中のOriginal SOG。バイト列はVR最適化とハッシュ計算に使い回す。
    let original: { asset: Asset; objectUrl: string; blob: Blob; hash: string | null } | null = null;
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
      URL.revokeObjectURL(entry.objectUrl);
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

    /** Original SOGを差し替える。VR最適化済みの結果は入力が変わるので捨てる。 */
    const showOriginal = async (
      label: string,
      buffer: ArrayBuffer,
      kind: SourceKind,
      isSample: boolean,
    ) => {
      const hash = typeof crypto?.subtle === "undefined" ? null : await sha256Hex(buffer);
      const blob = new Blob([buffer]);
      const loaded = await loadSplatAsset(label, blob, "space.sog");
      const bounds = boundsFromResource(loaded.asset.resource) ?? { min: CAPTURE_MIN, max: CAPTURE_MAX };
      if (isSample) {
        applyPlacement({ min: CAPTURE_MIN, max: CAPTURE_MAX });
        resetView(SAMPLE_DESKTOP_TARGET, SAMPLE_DESKTOP_DISTANCE);
      } else {
        applyPlacement(bounds);
        frameBounds(bounds);
      }
      attachAsset(loaded.asset);
      const previous = original;
      original = { ...loaded, blob, hash };
      releaseAsset(previous);
      releaseOptimized();
      setOriginalSplats(splatCountOf(loaded.asset.resource));
      setSource({ kind, label });
      setStatus("ready");
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
      // Desktop表示はOriginalに戻す。
      if (original) attachAsset(original.asset);
      rig.setLocalPosition(0, 0, 0);
      rig.setLocalEulerAngles(0, 0, 0);
      updateDesktopCamera();
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
          if (original) attachAsset(original.asset);
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
          const source = await original.blob.arrayBuffer();
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
        response = await fetch(`${resolver.endpoint}?url=${encodeURIComponent(shareUrl)}`, {
          headers: { accept: "application/json" },
        });
      } catch {
        throw new Error("共有URLの解決サービスに接続できませんでした。");
      }
      const payload = (await response.json().catch(() => null)) as
        | { assetUrl?: string; error?: string }
        | null;
      if (!response.ok || !payload?.assetUrl) {
        throw new Error(payload?.error ?? `共有URLを解決できませんでした (HTTP ${response.status})`);
      }
      return payload.assetUrl;
    };

    const loadSource = async (request: LoadRequest) => {
      if (disposed) return;
      loadToken += 1;
      const token = loadToken;
      setSourceError("");

      let label = "";
      let fetchUrl = "";
      let file: File | null = null;

      if (request.kind === "file") {
        if (!/\.sog$/i.test(request.file.name)) {
          setSourceError("SOGファイル (.sog) を選択してください。");
          return;
        }
        file = request.file;
        label = request.file.name;
      } else {
        const input = request.value.trim();
        const share = parseInsta360ShareUrl(input);
        const direct = isSpatialAssetUrl(input) ? toAbsoluteUrl(input) : null;
        if (share) {
          const resolver = resolverConfig();
          if (!resolver.available) {
            setSourceError(resolver.reason);
            return;
          }
          label = `Insta360共有 ${share.shareId}`;
          setSourceStage("共有URLを解決中");
          setSourceProgress(-1);
          try {
            fetchUrl = await resolveShare(share.shareUrl);
          } catch (error) {
            if (disposed || token !== loadToken) return;
            setSourceStage("");
            setSourceError(assetErrorMessage(error));
            return;
          }
        } else if (direct) {
          fetchUrl = direct.toString();
          label = direct.pathname.split("/").pop() || "space.sog";
        } else {
          setSourceError("Insta360の共有URL、または .sog のURLを入力してください。");
          return;
        }
      }

      setSourceStage(`${label} を読み込み中`);
      setSourceProgress(0);
      try {
        const buffer = file
          ? await file.arrayBuffer()
          : await downloadSog(fetchUrl, setSourceProgress);
        if (disposed || token !== loadToken) return;
        setSourceStage(`${label} を展開中`);
        setSourceProgress(-1);
        await showOriginal(label, buffer, request.kind === "file" ? "file" : "url", false);
        if (disposed || token !== loadToken) return;
        setSourceStage("");
        setSourceProgress(100);
        setErrorMessage("");
        setOpenOpen(false);
      } catch (error) {
        if (disposed || token !== loadToken) return;
        setSourceStage("");
        setSourceError(assetErrorMessage(error));
      }
    };
    loadSourceRef.current = (request) => {
      void loadSource(request);
    };

    const loadSample = async (initial: boolean) => {
      loadToken += 1;
      const token = loadToken;
      setSourceError("");
      if (!initial) {
        setSourceStage(`${SAMPLE_LABEL} を読み込み中`);
        setSourceProgress(0);
      }
      try {
        const buffer = await downloadSog(SAMPLE_URL, initial ? setProgress : setSourceProgress);
        if (disposed || token !== loadToken) return;
        await showOriginal(SAMPLE_LABEL, buffer, "sample", true);
        if (disposed || token !== loadToken) return;
        setProgress(100);
        setSourceStage("");
        setSourceProgress(100);
      } catch (error) {
        if (disposed || token !== loadToken) return;
        setSourceStage("");
        const message = assetErrorMessage(error);
        if (initial) {
          setErrorMessage(message);
          setStatus("error");
        } else {
          setSourceError(message);
        }
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
    void loadSample(true);
    setXrAvailable(xr.isAvailable(XRTYPE_VR));

    return () => {
      disposed = true;
      prepareVrRef.current = () => undefined;
      startVrRef.current = () => undefined;
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
      optimizeWorker?.terminate();
      if (original) URL.revokeObjectURL(original.objectUrl);
      if (optimizedEntry) URL.revokeObjectURL(optimizedEntry.objectUrl);
      app.destroy();
      viewport.replaceChildren();
    };
  }, []);

  targetSplatsRef.current = targetSplats;
  vrVariantRef.current = vrVariant;

  const isSample = source.kind === "sample";
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
            {originalSplats ? ` · ${formatSplats(originalSplats)} SPLATS` : ""}
          </div>
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
                ? "Insta360 Spatial Captureの共有URLを貼り付けるか、SOGファイルをドラッグ＆ドロップ、またはファイル選択から読み込みます。"
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
                    ? "https://app.insta360.com/3dspace/detail/..."
                    : "https://example.com/space.sog"
                }
                aria-label={
                  SHARE_RESOLVER.available ? "Insta360共有URLまたはSOGのURL" : "SOGのURL"
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
                className={`quality-option${vrVariant === "original" ? " is-active" : ""}`}
                type="button"
                disabled={optimizing}
                onClick={() => setVrVariant("original")}
              >
                <span className="quality-badge is-neutral">ORIGINAL</span>
                <strong>オリジナル</strong>
                <span>{formatSplats(originalSplats)} splats · VR解像度 78%</span>
              </button>
              <button
                className={`quality-option${vrVariant === "optimized" ? " is-active" : ""}`}
                type="button"
                disabled={optimizing || optimizeUnsupported !== null}
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

            {vrVariant === "optimized" && optimizeUnsupported === null && (
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

            {optimizeUnsupported && (
              <p className="open-error" role="status">
                {optimizeUnsupported}VR向けSOGの生成はできませんが、オリジナルのままVRを開始できます。
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
                  if (vrVariant === "optimized" && vrReady && optimizedMatches) startVrRef.current();
                  else prepareVrRef.current(vrVariant);
                }}
              >
                {vrVariant === "original" || (vrReady && optimizedMatches)
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
          WASD 移動 · E/Q 上下 · Shift 高速 · ドラッグで回転
        </div>
        <div className="secure-label">PLAYCANVAS · WEBXR · SECURE SESSION</div>
      </footer>
    </main>
  );
}
