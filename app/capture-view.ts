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
