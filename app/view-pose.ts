/**
 * 視点（カメラの姿勢）をURLへ載せるための正規表現と、復元に必要な計算。
 *
 * Viewerの内部状態は `desktopTarget` / `yaw` / `pitch` / `distance` / rigの位置に
 * 分かれているが、そのまま並べてもリンクとしては使えない。rigはWASD移動でずれ、
 * `desktopTarget` はrig座標なので、同じ数字が別の場所を指してしまう。ここでは
 * 「world空間のどこから、どちらを向いて見ているか」という一意な形へ畳んでから
 * URLへ載せる。DesktopとXRで同じ値を使い回せるのもこの形だからで、XR側は
 * position と yaw だけを見る。
 *
 * DOMにもPlayCanvasにも依存しない。Viewerからも、Nodeのテストからも読める。
 */

/** world空間の点。PlayCanvasの `Vec3` もそのまま渡せる。 */
export type Vec3Like = { x: number; y: number; z: number };

/** 水平面での姿勢。位置と、水平向き（度）だけを持つ。XRのrig補正で使う。 */
export type HorizontalPose = { x: number; y: number; z: number; yaw: number };

/** URLへ載せられる形に畳んだ視点。 */
export type ViewPose = {
  /** world空間の視点（eye）位置。 */
  x: number;
  y: number;
  z: number;
  /** 水平向き。PlayCanvasのY軸オイラー角と同じ符号・単位（度）。 */
  yaw: number;
  /** 見上げ／見下ろし。正で見下ろし（Viewer内部の `pitch` と同じ符号）。度。 */
  pitch: number;
  /** Orbitの回転半径。視点から注視点までの距離（m）。 */
  distance: number;
};

/**
 * `view=` の先頭に付けるフォーマット版数。
 *
 * 表現を変えたときに、古いリンクを黙って別の場所へ復元してしまわないための目印。
 */
export const VIEW_POSE_VERSION = "1";

// `URLSearchParams` がそのまま出せる区切り文字。`,` はパーセントエンコードされて
// リンクが読みにくくなるので、素通しされる `_` を使う。
const SEPARATOR = "_";

// 丸め桁。位置はmm、角度は0.01度まで残せば、見た目の差は分からない。
const POSITION_DIGITS = 3;
const ANGLE_DIGITS = 2;
const DISTANCE_DIGITS = 3;

// 受け付ける範囲。URLは誰でも書き換えられるので、桁あふれや異常値はここで弾く。
const POSITION_LIMIT = 100_000;
const YAW_LIMIT = 1_000_000;
const PITCH_LIMIT = 89;
const DISTANCE_RANGE = { min: 0.001, max: 10_000 };

// 10進の固定小数点だけを受け付ける。`NaN` / `Infinity` / `1e999` / `+1` / 空文字は
// すべてここで落ちる。エンコーダーが出すのもこの形だけ。
const NUMBER_PATTERN = /^-?\d+(?:\.\d+)?$/;

const DEG_TO_RAD = Math.PI / 180;
const RAD_TO_DEG = 180 / Math.PI;

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

/** 水平向きを `[-180, 180)` へ畳む。リンクの中の角度を一意にする。 */
export function normalizeYawDegrees(degrees: number): number {
  if (!Number.isFinite(degrees)) return 0;
  return (((degrees + 180) % 360) + 360) % 360 - 180;
}

const roundTo = (value: number, digits: number) => Number(value.toFixed(digits));

const inRange = (value: number, limit: number) => Number.isFinite(value) && Math.abs(value) <= limit;

/**
 * 視点を `view=` の値へ変換する。
 *
 * 復元できない値（NaNや桁あふれ）は`null`を返し、リンクに載せない。
 */
export function formatViewPose(pose: ViewPose): string | null {
  const { x, y, z, distance } = pose;
  if (!inRange(x, POSITION_LIMIT) || !inRange(y, POSITION_LIMIT) || !inRange(z, POSITION_LIMIT)) {
    return null;
  }
  if (!inRange(pose.yaw, YAW_LIMIT) || !inRange(pose.pitch, PITCH_LIMIT)) return null;
  if (!Number.isFinite(distance) || distance < DISTANCE_RANGE.min || distance > DISTANCE_RANGE.max) {
    return null;
  }
  return [
    VIEW_POSE_VERSION,
    roundTo(x, POSITION_DIGITS),
    roundTo(y, POSITION_DIGITS),
    roundTo(z, POSITION_DIGITS),
    roundTo(normalizeYawDegrees(pose.yaw), ANGLE_DIGITS),
    roundTo(pose.pitch, ANGLE_DIGITS),
    roundTo(distance, DISTANCE_DIGITS),
  ].join(SEPARATOR);
}

const parseNumber = (token: string): number | null => {
  if (!NUMBER_PATTERN.test(token)) return null;
  const value = Number(token);
  return Number.isFinite(value) ? value : null;
};

/**
 * `view=` の値を視点へ戻す。
 *
 * 版数・要素数・数値の形・値域のどれかが合わなければ`null`。呼び出し側は
 * その場合だけ通常の初期視点へ落ちるので、壊れたリンクでも空間は開ける。
 */
export function parseViewPose(text: string): ViewPose | null {
  const tokens = text.trim().split(SEPARATOR);
  if (tokens.length !== 7 || tokens[0] !== VIEW_POSE_VERSION) return null;

  const values = tokens.slice(1).map(parseNumber);
  if (values.some((value) => value === null)) return null;
  const [x, y, z, yaw, pitch, distance] = values as number[];

  if (!inRange(x, POSITION_LIMIT) || !inRange(y, POSITION_LIMIT) || !inRange(z, POSITION_LIMIT)) {
    return null;
  }
  if (!inRange(yaw, YAW_LIMIT) || !inRange(pitch, PITCH_LIMIT)) return null;
  if (distance < DISTANCE_RANGE.min || distance > DISTANCE_RANGE.max) return null;

  return { x, y, z, yaw: normalizeYawDegrees(yaw), pitch, distance };
}

/**
 * yaw / pitch から前方ベクトルを作る。
 *
 * PlayCanvasの回転に合わせて、yaw=0は-Z方向。pitchは正で見下ろしなので
 * Y成分の符号が反転する。
 */
export function forwardFromAngles(yawDegrees: number, pitchDegrees: number): Vec3Like {
  const yaw = yawDegrees * DEG_TO_RAD;
  const pitch = pitchDegrees * DEG_TO_RAD;
  const cosPitch = Math.cos(pitch);
  return {
    x: -Math.sin(yaw) * cosPitch,
    y: -Math.sin(pitch),
    z: -Math.cos(yaw) * cosPitch,
  };
}

/**
 * 前方ベクトルの見下ろし角。`forwardFromAngles` の逆。
 */
export function pitchDegreesFromForward(forward: Vec3Like): number {
  return -Math.asin(clamp(forward.y, -1, 1)) * RAD_TO_DEG;
}

/**
 * 姿勢から水平向きを取り出す。
 *
 * 真下・真上を向いていると前方ベクトルの水平成分が消えてyawが定まらない。
 * HMDは実際に真下を向くので、そのときは上ベクトルへ逃がす。見下ろしている
 * ときの上ベクトルは、頭が向いていた水平方向そのものになる（真上を向いて
 * いるときはその逆向き）。
 */
export function yawDegreesFromBasis(forward: Vec3Like, up: Vec3Like): number {
  let x = forward.x;
  let z = forward.z;
  if (Math.hypot(x, z) < 1e-4) {
    const sign = forward.y < 0 ? 1 : -1;
    x = up.x * sign;
    z = up.z * sign;
    if (Math.hypot(x, z) < 1e-4) return 0;
  }
  return normalizeYawDegrees(Math.atan2(-x, -z) * RAD_TO_DEG);
}

/** 視点とOrbitの半径から、回転の中心（注視点）を求める。 */
export function orbitTargetOf(pose: ViewPose): Vec3Like {
  const forward = forwardFromAngles(pose.yaw, pose.pitch);
  return {
    x: pose.x + forward.x * pose.distance,
    y: pose.y + forward.y * pose.distance,
    z: pose.z + forward.z * pose.distance,
  };
}

/** Y軸まわりの回転をベクトルへ適用する。 */
const rotateAroundY = (point: Vec3Like, yawDegrees: number): Vec3Like => {
  const yaw = yawDegrees * DEG_TO_RAD;
  const sin = Math.sin(yaw);
  const cos = Math.cos(yaw);
  return {
    x: point.x * cos + point.z * sin,
    y: point.y,
    z: -point.x * sin + point.z * cos,
  };
};

/**
 * rigの姿勢とHMDのpose（rigから見たローカル姿勢）から、world姿勢を合成する。
 *
 * XR中のcameraEntityはXRセッションがrig相対で毎フレーム上書きするので、
 * 実際に見える位置と向きはこの合成結果になる。`xrRigOffset` はこの式を
 * 逆に解いたものなので、両方を並べて置いてある。
 */
export function applyRigPose(rig: HorizontalPose, head: HorizontalPose): HorizontalPose {
  const rotated = rotateAroundY(head, rig.yaw);
  return {
    x: rig.x + rotated.x,
    y: rig.y + rotated.y,
    z: rig.z + rotated.z,
    yaw: normalizeYawDegrees(rig.yaw + head.yaw),
  };
}

/**
 * 目的の視点へ立たせるためのrigの姿勢を求める。
 *
 * XRではcameraEntityへ直接位置を書いても、次のフレームでHMDのposeに
 * 上書きされる。動かせるのは親のrigだけなので、
 *
 *     rig * HMD pose = 目的の視点
 *
 * を満たすrigを解く。まず水平向きの差をrigのY回転に入れ、
 * 回転後のHMD位置を目的の位置から引いたものがrigの位置になる。
 *
 * `head` はrigをidentityにした状態で読んだHMDのpose。local-floorの原点や
 * ユーザーの実際の身長がそのまま入っているため、目的の位置をrigへ直接
 * 代入してはいけない（頭の高さの分だけ浮く／沈む）。高さも差分で入れるので、
 * Desktopで1.6mの視点を指定したリンクは、Questでもほぼ同じ目線から始まる。
 * pitchとrollはHMDのものをそのまま尊重するため、ここでは触らない。
 */
export function xrRigOffset(desired: HorizontalPose, head: HorizontalPose): HorizontalPose {
  const yaw = normalizeYawDegrees(desired.yaw - head.yaw);
  const rotated = rotateAroundY(head, yaw);
  return {
    x: desired.x - rotated.x,
    y: desired.y - rotated.y,
    z: desired.z - rotated.z,
    yaw,
  };
}
