"use client";

import { useEffect, useRef, useState } from "react";
import {
  Application,
  Asset,
  CameraComponent,
  Color,
  Entity,
  FILLMODE_NONE,
  GSPLAT_RENDERER_RASTER_CPU_SORT,
  RESOLUTION_AUTO,
  Vec3,
  XRHAND_LEFT,
  XRHAND_RIGHT,
  XRSPACE_LOCALFLOOR,
  XRTYPE_VR,
} from "playcanvas";

type ViewerStatus = "loading" | "ready" | "error";

const SPLAT_COUNT = 1_000_000;
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

export function SogViewer() {
  const viewportRef = useRef<HTMLDivElement>(null);
  const startVrRef = useRef<() => void>(() => undefined);
  const [status, setStatus] = useState<ViewerStatus>("loading");
  const [progress, setProgress] = useState(0);
  const [xrAvailable, setXrAvailable] = useState(false);
  const [inXr, setInXr] = useState(false);
  const [errorMessage, setErrorMessage] = useState("");

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

    const captureAsset = new Asset("Insta360 Spatial Capture", "gsplat", {
      url: "/capture.sog",
      filename: "capture.sog",
      size: 16_241_776,
    });
    captureAsset.on("progress", (receivedBytes: number, totalBytes: number) => {
      if (disposed || totalBytes <= 0) return;
      setProgress(Math.min(99, Math.round((receivedBytes / totalBytes) * 100)));
    });
    captureAsset.on("error", (error: unknown) => {
      if (disposed) return;
      setStatus("error");
      setErrorMessage(
        error instanceof Error
          ? error.message
          : typeof error === "string"
            ? error
            : "SOGファイルを読み込めませんでした。",
      );
    });
    captureAsset.ready(() => {
      if (disposed) return;
      splatEntity.addComponent("gsplat", {
        asset: captureAsset,
        unified: true,
      });
      setProgress(100);
      setStatus("ready");
    });
    app.assets.add(captureAsset);

    const onXrAvailability = (available: boolean) => {
      if (!disposed) setXrAvailable(available);
    };
    const onXrStart = () => {
      if (disposed) return;
      xr.fixedFoveation = 0.6;
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

    startVrRef.current = () => {
      if (disposed || !xr.isAvailable(XRTYPE_VR) || !captureAsset.loaded) return;
      setErrorMessage("");
      pressedKeys.clear();
      rig.setLocalPosition(0, 0, 0);
      rig.setLocalEulerAngles(0, 0, 0);
      xr.start(camera, XRTYPE_VR, XRSPACE_LOCALFLOOR, {
        framebufferScaleFactor: 0.72,
        optionalFeatures: ["hand-tracking"],
        callback: (error) => {
          if (disposed || !error) return;
          setErrorMessage(`VRを開始できませんでした: ${error.message}`);
        },
      });
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
      for (const source of xr.input.inputSources) {
        const axes = source.gamepad?.axes;
        if (!axes) continue;
        if (source.handedness === XRHAND_LEFT) {
          moveX = stickAxis(axes, "x");
          moveY = stickAxis(axes, "y");
        } else if (source.handedness === XRHAND_RIGHT) {
          rotateX = stickAxis(axes, "x");
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
    app.assets.load(captureAsset);
    setXrAvailable(xr.isAvailable(XRTYPE_VR));

    return () => {
      disposed = true;
      startVrRef.current = () => undefined;
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
          PLAYCANVAS · SOG v2 · {SPLAT_COUNT.toLocaleString("ja-JP")} SPLATS
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
          onClick={() => startVrRef.current()}
        >
          <span className="vr-icon" aria-hidden="true">◫</span>
          VRを開始
        </button>
        <p className="control-hint">
          <span>左スティック</span> 移動&nbsp;&nbsp;·&nbsp;&nbsp;<span>右スティック</span> 旋回
        </p>
      </div>

      {status === "loading" && (
        <div className="loading-card" role="status" aria-live="polite">
          <div className="loading-row">
            <span>空間データを読み込み中</span>
            <span>{progress}%</span>
          </div>
          <div className="progress-track">
            <span style={{ width: `${Math.max(4, progress)}%` }} />
          </div>
          <p>15.5 MB · PLAYCANVAS STANDARD SOG LOADER</p>
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
