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
 * splatをworldへ置くときの座標系変換。提供元ごとに違う。
 *
 * 3D Gaussian Splatは撮影・書き出しパイプラインごとに軸の向きが違い、
 * PlayCanvasのY-up / Z-back へ持っていくには提供元に応じた回転が要る。
 * どちらも180°回転なので、実体は「どの軸の符号を反転するか」に尽きる。
 * `signs` はその反転を表し、`eulerAngles` は同じ回転をPlayCanvasの
 * entityへ入れるための表現。2つは必ず同じ回転を指す。
 */
export type PlacementTransform = {
  /** `splatEntity.setLocalEulerAngles` に入れる値（度）。 */
  eulerAngles: { x: number; y: number; z: number };
  /** 撮影座標の各軸をworldへ移すときの符号。 */
  signs: { x: 1 | -1; y: 1 | -1; z: 1 | -1 };
};

/**
 * Insta360 Spatial Captureの配置。X軸まわり180°。
 *
 * Insta360's capture axes are Y-down / Z-forward. A 180° X rotation makes
 * the room Y-up / Z-back without using a negative scale in stereo XR.
 *
 * サンプル・ローカルファイル・`.sog` の直接URLもこれを使う。Viewerが最初から
 * この向きで表示してきたので、既に配ってあるリンクの見え方を変えないため。
 */
export const INSTA360_PLACEMENT: PlacementTransform = {
  eulerAngles: { x: 180, y: 0, z: 0 },
  signs: { x: 1, y: -1, z: -1 },
};

/**
 * SuperSplat公開シーンの配置。Z軸まわり180°。
 *
 * SuperSplat自身の公開Viewerが、公開されている全シーンに対して無条件で
 * `entity.setLocalEulerAngles(0, 0, 180)` を掛けている
 * （`playcanvas/supersplat-viewer` の `src/index.ts`、gsplatを読み込んだ直後）。
 * SuperSplatが配るSOGはY-downで書き出されていて、Z軸まわり180°——
 * つまり X と Y の符号反転——でPlayCanvasのY-upに揃う。X軸まわり180°
 * （Insta360の変換）ではYと**Z**が反転するので、前後が逆になってしまう。
 *
 * ここを identity にはしない。identityだと上下が逆さまに出る。superspl.at で
 * 見えている向きと同じにするには、本家と同じ回転を掛けるのが唯一の根拠のある
 * 選択で、「見た目で合わせた」値ではない。
 */
export const SUPERSPLAT_PLACEMENT: PlacementTransform = {
  eulerAngles: { x: 0, y: 0, z: 180 },
  signs: { x: -1, y: -1, z: 1 },
};

/**
 * splatをworldへ置くときのローカル位置。
 *
 * Viewerはsplatへ `transform` の回転を掛けてから、この位置を足している。
 * 回転後に x / z が原点に中心し、床が y=0 に来るように決める。撮影座標の点を
 * worldへ持っていく計算（`worldFromCapturePoint`）と表裏なので、両方が同じ値を
 * 見るようにここへ切り出してある。
 *
 * yは「回転後に低いほうの端」を床として0に合わせる。Y-downのまま180°回して
 * いる提供元では元の `max.y` が床になり、その分だけ持ち上げる形になる。
 */
export function splatPlacementFor(
  bounds: CaptureBounds,
  transform: PlacementTransform,
): SplatPlacement {
  const { signs } = transform;
  return {
    x: -signs.x * (bounds.min.x + bounds.max.x) * 0.5,
    y: -Math.min(signs.y * bounds.min.y, signs.y * bounds.max.y),
    z: -signs.z * (bounds.min.z + bounds.max.z) * 0.5,
  };
}

/**
 * 撮影座標系の点をViewerのworld座標へ移す。
 *
 * splatに掛かっているのと同じ変換（`transform` の回転＋`splatPlacementFor` の
 * 平行移動）。カメラ位置を部屋と同じ場所へ重ねるには、splatと同じ変換を
 * 通すしかない。
 */
export function worldFromCapturePointFor(
  point: Vec3Like,
  placement: SplatPlacement,
  transform: PlacementTransform,
): Vec3Like {
  const { signs } = transform;
  return {
    x: signs.x * point.x + placement.x,
    y: signs.y * point.y + placement.y,
    z: signs.z * point.z + placement.z,
  };
}

/** Insta360配置での `splatPlacementFor`。既存の呼び出し向けの薄い別名。 */
export function splatPlacement(bounds: CaptureBounds): SplatPlacement {
  return splatPlacementFor(bounds, INSTA360_PLACEMENT);
}

/** Insta360配置での `worldFromCapturePointFor`。 */
export function worldFromCapturePoint(point: Vec3Like, placement: SplatPlacement): Vec3Like {
  return worldFromCapturePointFor(point, placement, INSTA360_PLACEMENT);
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
