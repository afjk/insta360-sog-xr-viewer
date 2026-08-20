"use client";

import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { SparkRenderer, SparkXr, SplatMesh } from "@sparkjsdev/spark";

type ViewerStatus = "loading" | "ready" | "error";

const SPLAT_COUNT = 1_000_000;

export function SogViewer() {
  const viewportRef = useRef<HTMLDivElement>(null);
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
    let distance = 6.4;

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x05070a);

    const rig = new THREE.Group();
    const camera = new THREE.PerspectiveCamera(58, 1, 0.01, 500);
    rig.add(camera);
    scene.add(rig);

    const renderer = new THREE.WebGLRenderer({
      antialias: false,
      powerPreference: "high-performance",
    });
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
    renderer.domElement.className = "sog-canvas";
    renderer.domElement.setAttribute(
      "aria-label",
      "Insta360 Spatial Capture 3D viewer",
    );
    viewport.appendChild(renderer.domElement);

    const spark = new SparkRenderer({
      renderer,
      maxStdDev: Math.sqrt(5),
      lodSplatScale: 0.82,
      sortRadial: true,
    });
    scene.add(spark);

    const splat = new SplatMesh({
      url: "/capture.sog",
      onProgress: (event) => {
        if (disposed) return;
        if (event.lengthComputable && event.total > 0) {
          setProgress(Math.min(99, Math.round((event.loaded / event.total) * 100)));
        }
      },
    });
    scene.add(splat);

    const target = new THREE.Vector3(0, 1.45, -1.7);
    const updateDesktopCamera = () => {
      const cosPitch = Math.cos(pitch);
      camera.position.set(
        target.x + distance * Math.sin(yaw) * cosPitch,
        target.y + distance * Math.sin(pitch),
        target.z + distance * Math.cos(yaw) * cosPitch,
      );
      camera.lookAt(target);
    };
    updateDesktopCamera();

    void splat.initialized
      .then(() => {
        if (disposed) return;

        const bounds = splat.getBoundingBox();
        const center = bounds.getCenter(new THREE.Vector3());
        const size = bounds.getSize(new THREE.Vector3());
        const longestSide = Math.max(size.x, size.y, size.z, 1);
        const sceneScale = 5.2 / longestSide;

        splat.scale.setScalar(sceneScale);
        splat.position.set(
          -center.x * sceneScale,
          1.45 - center.y * sceneScale,
          -1.7 - center.z * sceneScale,
        );

        setProgress(100);
        setStatus("ready");
      })
      .catch((error: unknown) => {
        if (disposed) return;
        setStatus("error");
        setErrorMessage(
          error instanceof Error ? error.message : "SOGファイルを読み込めませんでした。",
        );
      });

    const xr = new SparkXr({
      renderer,
      elementId: "enter-vr",
      mode: "vr",
      referenceSpaceType: "local-floor",
      fixedFoveation: 0.6,
      frameBufferScaleFactor: 0.72,
      sessionInit: { optionalFeatures: ["hand-tracking"] },
      controllers: {
        moveDirection: true,
        moveSpeed: 0.9,
        rotateSpeed: 2.6,
      },
      onReady: (supported) => {
        if (!disposed) setXrAvailable(supported);
      },
      onEnterXr: () => {
        setInXr(true);
        rig.position.set(0, 0, 3.9);
      },
      onExitXr: () => {
        setInXr(false);
        rig.position.set(0, 0, 0);
        updateDesktopCamera();
      },
    });

    const resize = () => {
      const width = Math.max(1, viewport.clientWidth);
      const height = Math.max(1, viewport.clientHeight);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
      renderer.setSize(width, height, false);
    };
    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(viewport);
    resize();

    const onPointerDown = (event: PointerEvent) => {
      if (renderer.xr.isPresenting) return;
      dragging = true;
      lastX = event.clientX;
      lastY = event.clientY;
      renderer.domElement.setPointerCapture(event.pointerId);
    };
    const onPointerMove = (event: PointerEvent) => {
      if (!dragging || renderer.xr.isPresenting) return;
      yaw -= (event.clientX - lastX) * 0.006;
      pitch = THREE.MathUtils.clamp(
        pitch + (event.clientY - lastY) * 0.004,
        -0.75,
        0.75,
      );
      lastX = event.clientX;
      lastY = event.clientY;
      updateDesktopCamera();
    };
    const onPointerUp = (event: PointerEvent) => {
      dragging = false;
      if (renderer.domElement.hasPointerCapture(event.pointerId)) {
        renderer.domElement.releasePointerCapture(event.pointerId);
      }
    };
    const onWheel = (event: WheelEvent) => {
      if (renderer.xr.isPresenting) return;
      event.preventDefault();
      distance = THREE.MathUtils.clamp(distance + event.deltaY * 0.005, 2.2, 16);
      updateDesktopCamera();
    };

    renderer.domElement.addEventListener("pointerdown", onPointerDown);
    renderer.domElement.addEventListener("pointermove", onPointerMove);
    renderer.domElement.addEventListener("pointerup", onPointerUp);
    renderer.domElement.addEventListener("pointercancel", onPointerUp);
    renderer.domElement.addEventListener("wheel", onWheel, { passive: false });

    renderer.setAnimationLoop((_time, xrFrame) => {
      if (xrFrame) xr.updateControllers(camera);
      renderer.render(scene, camera);
    });

    return () => {
      disposed = true;
      resizeObserver.disconnect();
      renderer.setAnimationLoop(null);
      renderer.domElement.removeEventListener("pointerdown", onPointerDown);
      renderer.domElement.removeEventListener("pointermove", onPointerMove);
      renderer.domElement.removeEventListener("pointerup", onPointerUp);
      renderer.domElement.removeEventListener("pointercancel", onPointerUp);
      renderer.domElement.removeEventListener("wheel", onWheel);
      if (xr.session) void xr.session.end();
      splat.dispose();
      renderer.dispose();
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
          SOG v2 · {SPLAT_COUNT.toLocaleString("ja-JP")} SPLATS
        </div>
      </header>

      <section className="intro" aria-label="Spatial Capture viewer">
        <p className="eyebrow">INSTA360 SPATIAL CAPTURE</p>
        <h1>記憶の中へ、<br />一歩踏み込む。</h1>
        <p className="intro-copy">
          Questブラウザで開き、VRを開始してください。頭の動きと両眼視差で、
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
          <p>15.5 MB · SOG v2</p>
        </div>
      )}

      {status === "error" && (
        <div className="error-card" role="alert">
          <strong>読み込みに失敗しました</strong>
          <span>{errorMessage}</span>
        </div>
      )}

      <footer className="footer-bar">
        <div>
          <span className="desktop-label">DESKTOP</span>
          ドラッグで回転 · ホイールでズーム
        </div>
        <div className="secure-label">WEBXR · SECURE SESSION</div>
      </footer>
    </main>
  );
}
