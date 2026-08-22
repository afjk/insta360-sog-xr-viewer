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

type ViewerStatus = "loading" | "ready" | "error";
type VrQuality = "smooth" | "high";

const HIGH_SPLAT_COUNT = 1_000_000;
const SMOOTH_SPLAT_COUNT = 500_000;
// Percentile bounds (2–98%) decoded from capture.sog. A handful of distant
// outliers in the raw bounds are intentionally ignored when placing the room.
const CAPTURE_MIN = new Vec3(-6.911, -1.263, -3.762);
const CAPTURE_MAX = new Vec3(6.178, 1.654, 3.802);
const CAPTURE_CENTER = new Vec3().add2(CAPTURE_MIN, CAPTURE_MAX).mulScalar(0.5);
const DESKTOP_TARGET = new Vec3(0, 1.35, -2.8);
const UP = new Vec3(0, 1, 0);

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

export function SogViewer() {
  const viewportRef = useRef<HTMLDivElement>(null);
  const chooseQualityRef = useRef<(quality: VrQuality) => void>(() => undefined);
  const startPreparedVrRef = useRef<() => void>(() => undefined);
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

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;

    let disposed = false;
    let dragging = false;
    let lastX = 0;
    let lastY = 0;
    let yaw = 0;
    let pitch = 0.08;
    let distance = 2.8;
    const pressedKeys = new Set<string>();

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
        DESKTOP_TARGET.x + distance * Math.sin(yaw) * cosPitch,
        DESKTOP_TARGET.y + distance * Math.sin(pitch),
        DESKTOP_TARGET.z + distance * Math.cos(yaw) * cosPitch,
      );
      worldTarget.add2(DESKTOP_TARGET, rig.getPosition());
      cameraEntity.lookAt(worldTarget);
    };
    updateDesktopCamera();

    const splatEntity = new Entity("insta360-sog");
    // Insta360's capture axes are Y-down / Z-forward. A 180° X rotation makes
    // the room Y-up / Z-back without using a negative scale in stereo XR.
    splatEntity.setLocalEulerAngles(180, 0, 0);
    splatEntity.setLocalPosition(
      -CAPTURE_CENTER.x,
      CAPTURE_MAX.y,
      CAPTURE_CENTER.z,
    );
    app.root.addChild(splatEntity);

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
    const prefersSmoothInitially = /Pico|PICO|OculusBrowser|Quest/i.test(navigator.userAgent);
    const initialAsset = prefersSmoothInitially ? smoothAsset : captureAsset;
    const initialQuality: VrQuality = prefersSmoothInitially ? "smooth" : "high";
    setActiveQuality(initialQuality);
    let initialLoadComplete = false;
    let loadingQuality: VrQuality | null = null;
    let currentQuality: VrQuality = initialQuality;
    let currentAsset = initialAsset;
    let splatComponent: GSplatComponent | null = null;
    let pendingFoveation = 0.55;

    captureAsset.on("progress", (receivedBytes: number, totalBytes: number) => {
      if (disposed || totalBytes <= 0) return;
      const nextProgress = Math.min(99, Math.round((receivedBytes / totalBytes) * 100));
      if (!initialLoadComplete && initialAsset === captureAsset) setProgress(nextProgress);
      else if (loadingQuality === "high") setQualityProgress(nextProgress);
    });
    smoothAsset.on("progress", (receivedBytes: number, totalBytes: number) => {
      if (disposed || totalBytes <= 0) return;
      const nextProgress = Math.min(99, Math.round((receivedBytes / totalBytes) * 100));
      if (!initialLoadComplete && initialAsset === smoothAsset) setProgress(nextProgress);
      else if (loadingQuality === "smooth") setQualityProgress(nextProgress);
    });

    const assetErrorMessage = (error: unknown) =>
      error instanceof Error
        ? error.message
        : typeof error === "string"
          ? error
          : "SOGファイルを読み込めませんでした。";
    const onAssetError = (error: unknown) => {
      if (disposed) return;
      loadingQuality = null;
      setPreparingQuality(null);
      setPreparedQuality(null);
      setErrorMessage(assetErrorMessage(error));
      if (!splatComponent) setStatus("error");
    };
    captureAsset.on("error", onAssetError);
    smoothAsset.on("error", onAssetError);

    initialAsset.ready(() => {
      if (disposed) return;
      splatComponent = splatEntity.addComponent("gsplat", {
        asset: initialAsset,
        unified: true,
      }) as GSplatComponent;
      initialLoadComplete = true;
      setActiveQuality(initialQuality);
      setProgress(100);
      setStatus("ready");
    });
    app.assets.add(captureAsset);
    app.assets.add(smoothAsset);

    const activateAsset = (quality: VrQuality, asset: Asset) => {
      if (!splatComponent) return false;
      const previousAsset = currentAsset;
      splatComponent.asset = asset;
      currentAsset = asset;
      currentQuality = quality;
      loadingQuality = null;
      setActiveQuality(quality);
      setPreparingQuality(null);
      setPreparedQuality(quality);
      setQualityProgress(100);
      if (previousAsset !== asset && previousAsset.loaded) previousAsset.unload();
      return true;
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
      const asset = quality === "smooth" ? smoothAsset : captureAsset;
      if (disposed || !xr.isAvailable(XRTYPE_VR) || !asset.loaded || currentAsset !== asset) return;
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
      const asset = quality === "smooth" ? smoothAsset : captureAsset;
      setErrorMessage("");
      setPreparedQuality(null);

      if (asset.loaded) {
        if (currentAsset !== asset && !activateAsset(quality, asset)) return;
        startVr(quality);
        return;
      }

      loadingQuality = quality;
      setPreparingQuality(quality);
      setQualityProgress(0);
      asset.ready(() => {
        if (disposed || loadingQuality !== quality) return;
        activateAsset(quality, asset);
      });
      app.assets.load(asset);
    };
    startPreparedVrRef.current = () => startVr(currentQuality);

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

    resize();
    app.start();
    app.assets.load(initialAsset);
    setXrAvailable(xr.isAvailable(XRTYPE_VR));

    return () => {
      disposed = true;
      chooseQualityRef.current = () => undefined;
      startPreparedVrRef.current = () => undefined;
      resizeObserver.disconnect();
      canvas.removeEventListener("pointerdown", onPointerDown);
      canvas.removeEventListener("pointermove", onPointerMove);
      canvas.removeEventListener("pointerup", onPointerUp);
      canvas.removeEventListener("pointercancel", onPointerUp);
      canvas.removeEventListener("wheel", onWheel);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", clearPressedKeys);
      if (xr.active) xr.end();
      app.destroy();
      viewport.replaceChildren();
    };
  }, []);

  return (
    <main className={`viewer-shell${inXr ? " is-xr" : ""}`}>
      <div ref={viewportRef} className="viewport" />
      <div className="atmosphere" aria-hidden="true" />

      <header className="topbar">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">◉</span>
          <span>SOG XR VIEWER</span>
        </div>
        <div className="format-pill">
          <span className="live-dot" />
          PLAYCANVAS · SOG v2 · {(activeQuality === "smooth"
            ? SMOOTH_SPLAT_COUNT
            : HIGH_SPLAT_COUNT).toLocaleString("ja-JP")} SPLATS
        </div>
      </header>

      <section className="intro" aria-label="Spatial Capture viewer">
        <p className="eyebrow">INSTA360 SPATIAL CAPTURE</p>
        <h1>記憶の中へ、<br />一歩踏み込む。</h1>
        <p className="intro-copy">
          PICO 4 UltraやQuestのブラウザで開き、VRを開始してください。頭の動きと両眼視差で、
          空間をそのまま立体的に体験できます。
        </p>
      </section>

      <div className="viewer-actions">
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
                <span>50万点 · 軽量カラー · VR解像度 52%</span>
              </button>
              <button
                className={`quality-option${activeQuality === "high" ? " is-active" : ""}`}
                type="button"
                disabled={preparingQuality !== null}
                onClick={() => chooseQualityRef.current("high")}
              >
                <span className="quality-badge is-neutral">DETAIL</span>
                <strong>高画質</strong>
                <span>100万点 · フルカラー · VR解像度 78%</span>
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

      {status === "loading" && (
        <div className="loading-card" role="status" aria-live="polite">
          <div className="loading-row">
            <span>空間データを読み込み中</span>
            <span>{progress}%</span>
          </div>
          <div className="progress-track">
            <span style={{ width: `${Math.max(4, progress)}%` }} />
          </div>
          <p>
            {activeQuality === "smooth" ? "5.9 MB · 500K" : "15.5 MB · 1M"}
            {" · PLAYCANVAS STANDARD SOG LOADER"}
          </p>
        </div>
      )}

      {status === "error" && (
        <div className="error-card" role="alert">
          <strong>読み込みに失敗しました</strong>
          <span>{errorMessage}</span>
        </div>
      )}

      {status !== "error" && errorMessage && (
        <div className="error-card" role="alert">
          <strong>VRを開始できませんでした</strong>
          <span>{errorMessage}</span>
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
