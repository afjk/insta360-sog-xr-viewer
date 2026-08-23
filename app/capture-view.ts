/**
 * Insta360が生成する `2_cameras.json`（撮影時のカメラ姿勢）から、
 * 公式Viewerと同じ初期視点を組み立てるための純粋関数群。
 *
 * 公式Viewer（`app.insta360.com/3dspace/detail/...`）は、SOGと同じ `outputs` に
 * 並んでいるこのファイルを読み、
 *
 *   - eye    … `cameras[0]`（撮影を始めた場所）
 *   - target … 全カメラ位置の平均（歩き回った軌跡の中心）
 *   - 画角   … `cameras[0]` の `fx / fy / width / height` から復元した撮影画角
 *
 * を初期状態にしている。向きは `cameras[0].rotation` ではなく eye→target の
 * 向きで決まる点に注意（最初のフレームがどこを向いていたかではなく、
 * 「撮り歩いた範囲の中心を見る」構図になる）。
 *
 * DOMにもPlayCanvasにも依存しない。Viewerからも、Nodeのテストからも読める。
 */
// 拡張子を明示しているのは、このモジュールをテストからNodeで直接importするため。
// バンドラは付いていても解決できる。
import { poseFromEyeAndTarget, type Vec3Like, type ViewPose } from "./view-pose.ts";

/** `cameras.json` の1件のうち、初期視点に必要なぶんだけ。 */
export type CaptureCamera = {
  /** 撮影座標系でのカメラ位置。SOGの重心と同じ座標系に載っている。 */
  position: Vec3Like;
  /** 画角の復元に使う内部パラメータ。先頭のカメラ以外では欠けていてもよい。 */
  intrinsics: CaptureIntrinsics | null;
};

/** 撮影画角。水平・垂直それぞれの全画角（度）。 */
export type CaptureFov = { horizontal: number; vertical: number };

type CaptureIntrinsics = { width: number; height: number; fx: number; fy: number };

/** `applyPlacement` がsplatへ入れるローカル位置。撮影座標→world変換の平行移動分。 */
export type SplatPlacement = { x: number; y: number; z: number };

/** 配置に使う空間の広がり。SOGの重心分布から求めた分位点バウンズ。 */
export type CaptureBounds = { min: Vec3Like; max: Vec3Like };

const RAD_TO_DEG = 180 / Math.PI;
const DEG_TO_RAD = Math.PI / 180;

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

/**
 * splatをworldへ置くときのローカル位置。
 *
 * Viewerはsplatへ X軸まわり180°（＝ y と z の符号反転）を掛けてから、この位置を
 * 足している。撮影座標の点をworldへ持っていく計算（`worldFromCapturePoint`）と
 * 表裏なので、両方が同じ値を見るようにここへ切り出してある。
 */
export function splatPlacement(bounds: CaptureBounds): SplatPlacement {
  return {
    x: -(bounds.min.x + bounds.max.x) * 0.5,
    y: bounds.max.y,
    z: (bounds.min.z + bounds.max.z) * 0.5,
  };
}

/**
 * 撮影座標系の点をViewerのworld座標へ移す。
 *
 * splatに掛かっているのと同じ変換（X軸180°回転＋`splatPlacement` の平行移動）。
 * カメラ位置を部屋と同じ場所へ重ねるには、splatと同じ変換を通すしかない。
 */
export function worldFromCapturePoint(point: Vec3Like, placement: SplatPlacement): Vec3Like {
  return {
    x: point.x + placement.x,
    y: -point.y + placement.y,
    z: -point.z + placement.z,
  };
}

/** 配置と既定視点に使う、SOGの重心分布の要約。 */
export type SplatBounds = {
  /** 外れ値を落とした広がり（分位点）。配置と距離の目安に使う。 */
  min: Vec3Like;
  max: Vec3Like;
  /** 重心の中央値。「splatが実際に集まっている場所」。 */
  centre: Vec3Like;
};

// 外れ値を無視するための分位点と、走査するサンプル数の上限。
const BOUNDS_PERCENTILE = 0.02;
const BOUNDS_MAX_SAMPLES = 60_000;

const quantile = (sorted: number[], ratio: number) =>
  sorted[Math.round((sorted.length - 1) * ratio)];

/**
 * 読み込んだSOGの重心分布から、配置用のバウンズと中央値を求める。
 *
 * 広がり（`min` / `max`）は2–98%の分位点で、遠くに散った少数のsplatに
 * 引きずられないようにしている。ただし屋外のキャプチャでは、その範囲でも
 * 大半が遠景（向かいのビルや空）で埋まり、**箱の中点は撮影した場所から
 * 大きく外れる**。既定視点の回転中心にはそこではなく `centre`（重心の
 * 中央値＝splatが密なところ）を使う。
 */
export function splatBoundsFromCenters(centers: Float32Array): SplatBounds | null {
  const count = Math.floor(centers.length / 3);
  if (count < 1) return null;
  const stride = Math.max(1, Math.ceil(count / BOUNDS_MAX_SAMPLES));
  const axes: [number[], number[], number[]] = [[], [], []];
  for (let index = 0; index < count; index += stride) {
    axes[0].push(centers[index * 3]);
    axes[1].push(centers[index * 3 + 1]);
    axes[2].push(centers[index * 3 + 2]);
  }
  const [xs, ys, zs] = axes.map((values) => values.sort((a, b) => a - b));
  return {
    min: { x: quantile(xs, BOUNDS_PERCENTILE), y: quantile(ys, BOUNDS_PERCENTILE), z: quantile(zs, BOUNDS_PERCENTILE) },
    max: {
      x: quantile(xs, 1 - BOUNDS_PERCENTILE),
      y: quantile(ys, 1 - BOUNDS_PERCENTILE),
      z: quantile(zs, 1 - BOUNDS_PERCENTILE),
    },
    centre: { x: quantile(xs, 0.5), y: quantile(ys, 0.5), z: quantile(zs, 0.5) },
  };
}

/** バウンズの箱の中点。中央値が取れないときの中心の代わり。 */
export function boxCentre(bounds: CaptureBounds): Vec3Like {
  return {
    x: (bounds.min.x + bounds.max.x) * 0.5,
    y: (bounds.min.y + bounds.max.y) * 0.5,
    z: (bounds.min.z + bounds.max.z) * 0.5,
  };
}

const readIntrinsics = (record: Record<string, unknown>): CaptureIntrinsics | null => {
  const { width, height, fx, fy } = record;
  if (!isFiniteNumber(width) || !isFiniteNumber(height)) return null;
  if (!isFiniteNumber(fx) || !isFiniteNumber(fy)) return null;
  if (width <= 0 || height <= 0 || fx <= 0 || fy <= 0) return null;
  return { width, height, fx, fy };
};

const readCamera = (entry: unknown): CaptureCamera | null => {
  if (!entry || typeof entry !== "object") return null;
  const record = entry as Record<string, unknown>;
  const position = record.position;
  if (!Array.isArray(position) || position.length !== 3) return null;
  if (!position.every(isFiniteNumber)) return null;
  return {
    position: { x: position[0], y: position[1], z: position[2] },
    intrinsics: readIntrinsics(record),
  };
};

/**
 * `cameras.json` を読む。形が違えば `null`。
 *
 * 初期視点にしか使わないので、壊れていても空間の表示は止めない。呼び出し側は
 * `null` のとき従来の既定視点へ落ちる。公式Viewerに合わせて2件未満は受け付け
 * ない（1件では軌跡の中心が撮影地点と重なり、向きが決まらない）。
 */
export function parseCaptureCameras(data: unknown): CaptureCamera[] | null {
  if (!Array.isArray(data) || data.length < 2) return null;
  const cameras: CaptureCamera[] = [];
  for (const entry of data) {
    const camera = readCamera(entry);
    if (!camera) return null;
    cameras.push(camera);
  }
  return cameras;
}

/**
 * 撮影画角を内部パラメータから復元する。取れなければ `null`。
 *
 * 公式Viewerと同じく先頭のカメラだけを見る。Insta360の書き出しは全カメラが
 * 同じ内部パラメータ（実データでは 1000×1000, fx=fy=500 → 水平垂直とも90°）。
 */
export function captureFovOf(cameras: readonly CaptureCamera[]): CaptureFov | null {
  const intrinsics = cameras[0]?.intrinsics;
  if (!intrinsics) return null;
  return {
    horizontal: 2 * Math.atan(intrinsics.width / (2 * intrinsics.fx)) * RAD_TO_DEG,
    vertical: 2 * Math.atan(intrinsics.height / (2 * intrinsics.fy)) * RAD_TO_DEG,
  };
}

/**
 * 表示領域の縦横比に合わせて、カメラへ入れる垂直画角を決める。
 *
 * 撮影画角をそのまま垂直画角にすると、横長の画面では水平方向が撮影時より
 * 広く、縦長では狭くなる。公式Viewerは「垂直を合わせても水平が撮影画角を
 * 下回らないなら垂直基準、下回るなら水平基準（ただし90°まで）」という
 * 決め方をしていて、ここもそれに合わせてある。
 */
export function responsiveFovDegrees(fov: CaptureFov, width: number, height: number): number {
  if (!(width > 0) || !(height > 0)) return fov.vertical;
  const horizontalFromVertical =
    2 * Math.atan((Math.tan((fov.vertical * DEG_TO_RAD) / 2) * width) / height) * RAD_TO_DEG;
  if (horizontalFromVertical >= fov.horizontal) return fov.vertical;
  const verticalFromHorizontal =
    2 * Math.atan((Math.tan((fov.horizontal * DEG_TO_RAD) / 2) * height) / width) * RAD_TO_DEG;
  return Math.min(90, verticalFromHorizontal);
}

/**
 * 公式Viewerと同じ初期視点をworld座標で組み立てる。
 *
 * eyeは撮影を始めた地点、注視点は全カメラ位置の平均。距離が出ない
 * （全カメラが同じ場所にある）ときだけ `null` を返す。
 */
export function captureHomeView(
  cameras: readonly CaptureCamera[],
  placement: SplatPlacement,
): ViewPose | null {
  if (cameras.length < 2) return null;
  let sumX = 0;
  let sumY = 0;
  let sumZ = 0;
  for (const camera of cameras) {
    sumX += camera.position.x;
    sumY += camera.position.y;
    sumZ += camera.position.z;
  }
  const centre = { x: sumX / cameras.length, y: sumY / cameras.length, z: sumZ / cameras.length };
  return poseFromEyeAndTarget(
    worldFromCapturePoint(cameras[0].position, placement),
    worldFromCapturePoint(centre, placement),
  );
}
