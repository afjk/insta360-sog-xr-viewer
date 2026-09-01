/**
 * PlayCanvas 2.21が要求する範囲だけを満たすWebXRの差し替え。
 *
 * ブラウザテストでVR経路を通すためのもの。HMDが無い環境でも
 * `xr.start()` → セッション開始 → 毎フレームの `getViewerPose` → 両眼描画
 * までを、**実物のPlayCanvasエンジンをそのまま**走らせて確かめられる。
 *
 * ここで再現したいのは「XRのposeがいつカメラへ入るか」というタイミングで、
 * そこを取り違えるとrig補正が的を外す（`applyXrSpawn` のコメントを参照）。
 * 実機でしか出ないその手の配線ミスを、ユニットテストでは掴めない。
 *
 * ページのどのスクリプトより先に評価する必要がある（PlayCanvasは
 * `XrManager` を作る時点で `navigator.xr` の有無を見る）。Playwrightなら
 * `context.addInitScript({ path })` で読ませる。
 *
 * 頭の姿勢は `window.__webxrStub.head` で差し替えられる。既定値は
 * local-floorの原点から少しずれた、いかにも実機らしい立ち位置。
 */
(() => {
  const DEFAULT_HEAD = { x: 0.31, y: 1.63, z: -0.87, yawDeg: 24 };

  const quatFromYaw = (deg) => {
    const half = ((deg * Math.PI) / 180) / 2;
    return { x: 0, y: Math.sin(half), z: 0, w: Math.cos(half) };
  };

  /** 位置と回転から列優先の4x4行列。WebXRの `transform.matrix` と同じ並び。 */
  const matrixOf = (p, q) => {
    const { x, y, z, w } = q;
    const x2 = x + x;
    const y2 = y + y;
    const z2 = z + z;
    const xx = x * x2;
    const xy = x * y2;
    const xz = x * z2;
    const yy = y * y2;
    const yz = y * z2;
    const zz = z * z2;
    const wx = w * x2;
    const wy = w * y2;
    const wz = w * z2;
    return new Float32Array([
      1 - (yy + zz), xy + wz, xz - wy, 0,
      xy - wz, 1 - (xx + zz), yz + wx, 0,
      xz + wy, yz - wx, 1 - (xx + yy), 0,
      p.x, p.y, p.z, 1,
    ]);
  };

  /** 剛体変換の逆行列。回転は転置、平行移動は回転を戻してから符号反転。 */
  const inverseOf = (m) => {
    const out = new Float32Array(16);
    for (let row = 0; row < 3; row++) {
      for (let col = 0; col < 3; col++) out[row * 4 + col] = m[col * 4 + row];
    }
    out[12] = -(out[0] * m[12] + out[4] * m[13] + out[8] * m[14]);
    out[13] = -(out[1] * m[12] + out[5] * m[13] + out[9] * m[14]);
    out[14] = -(out[2] * m[12] + out[6] * m[13] + out[10] * m[14]);
    out[15] = 1;
    return out;
  };

  const perspective = (fovYRadians, aspect, near, far) => {
    const f = 1 / Math.tan(fovYRadians / 2);
    const nf = 1 / (near - far);
    return new Float32Array([
      f / aspect, 0, 0, 0,
      0, f, 0, 0,
      0, 0, (far + near) * nf, -1,
      0, 0, 2 * far * near * nf, 0,
    ]);
  };

  const transformOf = (p, q) => {
    const matrix = matrixOf(p, q);
    return {
      position: { x: p.x, y: p.y, z: p.z, w: 1 },
      orientation: q,
      matrix,
      inverse: { matrix: inverseOf(matrix) },
    };
  };

  /** `XRWebGLLayer` の代わり。`framebuffer` が `null` だと既定の描画先になる。 */
  class StubWebGLLayer {
    constructor(session, gl) {
      this.framebuffer = null;
      this.framebufferWidth = gl.drawingBufferWidth || 1024;
      this.framebufferHeight = gl.drawingBufferHeight || 1024;
    }
    getViewport(view) {
      const half = Math.floor(this.framebufferWidth / 2);
      return {
        x: view.eye === "right" ? half : 0,
        y: 0,
        width: half,
        height: this.framebufferHeight,
      };
    }
  }

  class StubSession extends EventTarget {
    constructor(mode) {
      super();
      this.mode = mode;
      this.visibilityState = "visible";
      this.renderState = { baseLayer: null, depthNear: 0.1, depthFar: 1000 };
      this.inputSources = [];
      this.enabledFeatures = ["local-floor"];
      this.environmentBlendMode = "opaque";
      this.ended = false;
    }
    updateRenderState(state) {
      Object.assign(this.renderState, state);
    }
    async requestReferenceSpace(type) {
      return { referenceSpaceType: type };
    }
    /**
     * XRのフレームループ。ブラウザの `requestAnimationFrame` に乗せつつ、
     * コールバックへ `XRFrame` を渡す——ここが実物と同じであることが肝心で、
     * `XRFrame` を伴わないフレームでPlayCanvasはカメラへposeを書かない。
     */
    requestAnimationFrame(callback) {
      return window.requestAnimationFrame((time) => {
        if (this.ended) return;
        const head = window.__webxrStub.head;
        const orientation = quatFromYaw(head.yawDeg);
        const position = { x: head.x, y: head.y, z: head.z };
        const viewer = transformOf(position, orientation);
        const projection = perspective((100 * Math.PI) / 180, 1, 0.1, 1000);
        const eyeOf = (eye, offsetX) => ({
          eye,
          projectionMatrix: projection,
          transform: transformOf({ ...position, x: position.x + offsetX }, orientation),
        });
        window.__webxrStub.frames += 1;
        callback(time, {
          session: this,
          getViewerPose: () => ({
            transform: viewer,
            views: [eyeOf("left", -0.032), eyeOf("right", 0.032)],
          }),
          getPose: () => null,
        });
      });
    }
    cancelAnimationFrame(id) {
      window.cancelAnimationFrame(id);
    }
    async end() {
      this.ended = true;
      this.dispatchEvent(new Event("end"));
    }
  }

  window.__webxrStub = { head: { ...DEFAULT_HEAD }, frames: 0, session: null };
  window.XRWebGLLayer = StubWebGLLayer;
  // `XRWebGLBinding` は無いものとして扱う（PlayCanvasは有無を見て分岐する）。
  delete window.XRWebGLBinding;
  Object.defineProperty(navigator, "xr", {
    configurable: true,
    value: {
      isSessionSupported: async (mode) => mode === "immersive-vr",
      requestSession: async (mode) => {
        const session = new StubSession(mode);
        window.__webxrStub.session = session;
        return session;
      },
      addEventListener() {},
      removeEventListener() {},
    },
  });
})();
