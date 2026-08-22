import assert from "node:assert/strict";
import test from "node:test";
import {
  VIEW_POSE_VERSION,
  applyRigPose,
  formatViewPose,
  forwardFromAngles,
  normalizeYawDegrees,
  orbitTargetOf,
  parseViewPose,
  pitchDegreesFromForward,
  xrRigOffset,
  yawDegreesFromBasis,
  type HorizontalPose,
  type ViewPose,
} from "../app/view-pose.ts";

const POSE: ViewPose = { x: -1.234, y: 1.62, z: 3.5, yaw: 137.5, pitch: -4.58, distance: 2.8 };

const close = (actual: number, expected: number, tolerance = 1e-6, message = "") =>
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `${message} expected ${actual} to be within ${tolerance} of ${expected}`,
  );

test("encodes a pose into a query-safe value", () => {
  const value = formatViewPose(POSE);
  assert.equal(value, `${VIEW_POSE_VERSION}_-1.234_1.62_3.5_137.5_-4.58_2.8`);
  // `URLSearchParams` がそのまま出せる文字だけ。パーセントエンコードされない。
  assert.equal(new URLSearchParams({ view: value ?? "" }).toString(), `view=${value}`);
});

test("rounds to millimetres and hundredths of a degree", () => {
  const value = formatViewPose({
    x: 1.23456789,
    y: -0.000_04,
    z: 12.987_654,
    yaw: 12.345_6,
    pitch: -1.234_5,
    distance: 2.718_281_8,
  });
  // 丸めて0になった成分に `-0` は残さない。
  assert.equal(value, `${VIEW_POSE_VERSION}_1.235_0_12.988_12.35_-1.23_2.718`);
});

test("round-trips a pose through the URL value", () => {
  const value = formatViewPose(POSE);
  assert.deepEqual(parseViewPose(value ?? ""), POSE);
  assert.equal(formatViewPose(parseViewPose(value ?? "") ?? POSE), value);
});

test("folds the horizontal heading into a single turn", () => {
  assert.equal(normalizeYawDegrees(370), 10);
  assert.equal(normalizeYawDegrees(-370), -10);
  assert.equal(normalizeYawDegrees(180), -180);
  assert.equal(parseViewPose(`${VIEW_POSE_VERSION}_0_0_0_540_0_2`)?.yaw, -180);
});

test("rejects values that cannot be restored", () => {
  for (const bad of [
    "",
    "   ",
    "1",
    `${VIEW_POSE_VERSION}_0_0_0_0_0`,
    `${VIEW_POSE_VERSION}_0_0_0_0_0_2_9`,
    `2_0_0_0_0_0_2`,
    `${VIEW_POSE_VERSION}_NaN_0_0_0_0_2`,
    `${VIEW_POSE_VERSION}_0_Infinity_0_0_0_2`,
    `${VIEW_POSE_VERSION}_0_0_1e400_0_0_2`,
    `${VIEW_POSE_VERSION}_0_0_+1_0_0_2`,
    `${VIEW_POSE_VERSION}_0_0__0_0_2`,
    `${VIEW_POSE_VERSION}_0x10_0_0_0_0_2`,
    // 位置・pitch・distanceの値域外。
    `${VIEW_POSE_VERSION}_1000000_0_0_0_0_2`,
    `${VIEW_POSE_VERSION}_0_0_0_0_120_2`,
    `${VIEW_POSE_VERSION}_0_0_0_0_0_0`,
    `${VIEW_POSE_VERSION}_0_0_0_0_0_-2`,
    `${VIEW_POSE_VERSION}_0_0_0_0_0_100000`,
  ]) {
    assert.equal(parseViewPose(bad), null, bad);
  }
});

test("refuses to put an unusable pose into a link", () => {
  assert.equal(formatViewPose({ ...POSE, x: Number.NaN }), null);
  assert.equal(formatViewPose({ ...POSE, y: Number.POSITIVE_INFINITY }), null);
  assert.equal(formatViewPose({ ...POSE, z: 1e9 }), null);
  assert.equal(formatViewPose({ ...POSE, pitch: 95 }), null);
  assert.equal(formatViewPose({ ...POSE, distance: 0 }), null);
});

test("agrees with PlayCanvas' rotation convention", () => {
  // yaw=0 は -Z 向き。yaw=90 は -X 向き（Y軸まわりの右手回転）。
  const ahead = forwardFromAngles(0, 0);
  close(ahead.x, 0);
  close(ahead.z, -1);
  const left = forwardFromAngles(90, 0);
  close(left.x, -1);
  close(left.z, 0);
  // pitchは正で見下ろし。
  close(forwardFromAngles(0, 30).y, -0.5);
});

test("reads the heading and the tilt back out of a camera basis", () => {
  for (const yaw of [-179, -90, 0, 37.5, 179]) {
    for (const pitch of [-80, -12, 0, 12, 80]) {
      const forward = forwardFromAngles(yaw, pitch);
      // 上ベクトルはpitchを90度足した前方向（見上げる側）。
      const up = forwardFromAngles(yaw, pitch - 90);
      close(yawDegreesFromBasis(forward, up), yaw, 1e-6, `yaw ${yaw}/${pitch}`);
      close(pitchDegreesFromForward(forward), pitch, 1e-6, `pitch ${yaw}/${pitch}`);
    }
  }
});

test("keeps the heading when the head looks straight down or up", () => {
  // HMDは実際に真下を向く。前方ベクトルの水平成分が消えても向きを見失わない。
  close(yawDegreesFromBasis({ x: 0, y: -1, z: 0 }, forwardFromAngles(40, 0)), 40, 1e-6);
  close(
    yawDegreesFromBasis({ x: 0, y: 1, z: 0 }, { x: -forwardFromAngles(40, 0).x, y: 0, z: -forwardFromAngles(40, 0).z }),
    40,
    1e-6,
  );
  // 姿勢が読めないときでも例外は投げない。
  assert.equal(yawDegreesFromBasis({ x: 0, y: -1, z: 0 }, { x: 0, y: 1, z: 0 }), 0);
});

test("puts the orbit centre in front of the saved eye position", () => {
  const target = orbitTargetOf(POSE);
  const forward = forwardFromAngles(POSE.yaw, POSE.pitch);
  close(target.x, POSE.x + forward.x * POSE.distance);
  close(target.y, POSE.y + forward.y * POSE.distance);
  close(target.z, POSE.z + forward.z * POSE.distance);
  close(Math.hypot(target.x - POSE.x, target.y - POSE.y, target.z - POSE.z), POSE.distance);
});

test("solves the rig offset so rig * HMD pose lands on the saved view", () => {
  const desired: HorizontalPose = { x: -2.5, y: 1.6, z: 4.25, yaw: 137.5 };
  // local-floorのHMD pose。原点からずれた場所に、実際の身長で立っている。
  const heads: HorizontalPose[] = [
    { x: 0.4, y: 1.72, z: -0.9, yaw: -20 },
    { x: 0, y: 1.5, z: 0, yaw: 0 },
    { x: -3.2, y: 1.15, z: 2.4, yaw: 175 },
  ];
  for (const head of heads) {
    const rig = xrRigOffset(desired, head);
    const world = applyRigPose(rig, head);
    close(world.x, desired.x, 1e-9, "x");
    close(world.y, desired.y, 1e-9, "y");
    close(world.z, desired.z, 1e-9, "z");
    close(world.yaw, desired.yaw, 1e-9, "yaw");
  }
});

test("never sets the rig to the desired position outright", () => {
  // local-floorのposeには実際の頭の高さと原点からのずれが入っているので、
  // 単純代入すると身長の分だけ浮く。差分で入っていることを確かめる。
  const desired: HorizontalPose = { x: 0, y: 1.6, z: 0, yaw: 0 };
  const head: HorizontalPose = { x: 0.5, y: 1.7, z: -0.25, yaw: 0 };
  const rig = xrRigOffset(desired, head);
  close(rig.y, -0.1);
  close(rig.x, -0.5);
  close(rig.z, 0.25);
  assert.notEqual(rig.y, desired.y);
});

test("turns the rig by the difference in heading only", () => {
  const rig = xrRigOffset(
    { x: 0, y: 1.6, z: 0, yaw: 100 },
    { x: 0, y: 1.6, z: 0, yaw: -170 },
  );
  // 270度ではなく-90度。近い側へ回す。
  close(rig.yaw, -90);
});

/**
 * Viewerのカメラ組み立てをそのまま写したもの。
 *
 * `desktopTarget`（rig座標のOrbit中心）と rig の位置からカメラのworld姿勢を
 * 求める。Viewer側の `updateDesktopCamera` と同じ式で、panは`target`を、
 * WASD移動は`rig`を動かす。
 */
const simulateDesktopCamera = (state: {
  target: { x: number; y: number; z: number };
  rig: { x: number; y: number; z: number };
  yaw: number;
  pitch: number;
  distance: number;
}) => {
  const yaw = state.yaw * (Math.PI / 180);
  const pitch = state.pitch * (Math.PI / 180);
  const cosPitch = Math.cos(pitch);
  const eye = {
    x: state.rig.x + state.target.x + state.distance * Math.sin(yaw) * cosPitch,
    y: state.rig.y + state.target.y + state.distance * Math.sin(pitch),
    z: state.rig.z + state.target.z + state.distance * Math.cos(yaw) * cosPitch,
  };
  // `lookAt` はworldのY軸を上として注視点を向く。rollは入らない。
  return {
    eye,
    forward: forwardFromAngles(state.yaw, state.pitch),
    up: forwardFromAngles(state.yaw, state.pitch - 90),
  };
};

test("restores the same camera after a pan and after WASD movement", () => {
  const states = [
    // 読み込み直後。
    { target: { x: 0, y: 1.5, z: 0 }, rig: { x: 0, y: 0, z: 0 }, yaw: 0, pitch: 4.58, distance: 2.8 },
    // 右ドラッグで注視点をずらしたあと。
    { target: { x: 1.75, y: 0.9, z: -2.2 }, rig: { x: 0, y: 0, z: 0 }, yaw: -62.5, pitch: 12, distance: 3.4 },
    // WASDでrigごと移動したあと。
    { target: { x: 0.4, y: 1.5, z: 0 }, rig: { x: -4.25, y: 0.8, z: 6.1 }, yaw: 148.25, pitch: -8.5, distance: 1.6 },
  ];

  for (const state of states) {
    const before = simulateDesktopCamera(state);
    // 「この視点のリンクをコピー」…world姿勢をそのまま読む。
    const pose: ViewPose = {
      x: before.eye.x,
      y: before.eye.y,
      z: before.eye.z,
      yaw: yawDegreesFromBasis(before.forward, before.up),
      pitch: pitchDegreesFromForward(before.forward),
      distance: state.distance,
    };
    // リンクを経由して復元する。rigは原点へ戻り、注視点を割り出し直す。
    const restored = parseViewPose(formatViewPose(pose) ?? "");
    assert.ok(restored);
    const after = simulateDesktopCamera({
      target: orbitTargetOf(restored),
      rig: { x: 0, y: 0, z: 0 },
      yaw: restored.yaw,
      pitch: restored.pitch,
      distance: restored.distance,
    });
    // 丸めの分（位置1mm・角度0.01度）だけずれうる。見た目には出ない範囲。
    close(after.eye.x, before.eye.x, 2e-3, "eye.x");
    close(after.eye.y, before.eye.y, 2e-3, "eye.y");
    close(after.eye.z, before.eye.z, 2e-3, "eye.z");
    close(after.forward.x, before.forward.x, 2e-4, "forward.x");
    close(after.forward.y, before.forward.y, 2e-4, "forward.y");
    close(after.forward.z, before.forward.z, 2e-4, "forward.z");
  }
});

test("spawns XR at the same place and heading as the restored desktop view", () => {
  // Desktopで復元した視点と、Quest側でrig補正したあとのHMD world poseを突き合わせる。
  const desktop = simulateDesktopCamera({
    target: { x: 1.2, y: 1.4, z: -0.6 },
    rig: { x: -3.1, y: 0.4, z: 2.7 },
    yaw: 118.5,
    pitch: 6.2,
    distance: 2.2,
  });
  const link = formatViewPose({
    x: desktop.eye.x,
    y: desktop.eye.y,
    z: desktop.eye.z,
    yaw: yawDegreesFromBasis(desktop.forward, desktop.up),
    pitch: pitchDegreesFromForward(desktop.forward),
    distance: 2.2,
  });
  const pose = parseViewPose(link ?? "");
  assert.ok(pose);

  // local-floorで立ち上がったQuest。原点からずれた場所で、少し下を向いている。
  const head: HorizontalPose = { x: 0.62, y: 1.71, z: -1.35, yaw: -47.5 };
  const rig = xrRigOffset({ x: pose.x, y: pose.y, z: pose.z, yaw: pose.yaw }, head);
  const spawned = applyRigPose(rig, head);

  // 実機の許容誤差（位置10cm・yaw数度）よりはるかに小さいこと。
  close(Math.hypot(spawned.x - desktop.eye.x, spawned.y - desktop.eye.y, spawned.z - desktop.eye.z), 0, 2e-3);
  close(spawned.yaw, yawDegreesFromBasis(desktop.forward, desktop.up), 0.01);
});

test("returns to the pre-VR desktop view after XR ends", () => {
  // WASDでrigごと移動したあとの視点。VR開始時にrigはidentityへ戻され、
  // XR中はlocomotionがrigを好きに動かす。戻り先はrigではなくこのworld視点。
  const before = simulateDesktopCamera({
    target: { x: 0.4, y: 1.5, z: 0 },
    rig: { x: -4.25, y: 0.8, z: 6.1 },
    yaw: 148.25,
    pitch: -8.5,
    distance: 1.6,
  });
  const saved: ViewPose = {
    x: before.eye.x,
    y: before.eye.y,
    z: before.eye.z,
    yaw: yawDegreesFromBasis(before.forward, before.up),
    pitch: pitchDegreesFromForward(before.forward),
    distance: 1.6,
  };

  // XR終了後の復元。rigは原点、注視点はeyeから割り出し直す。
  const after = simulateDesktopCamera({
    target: orbitTargetOf(saved),
    rig: { x: 0, y: 0, z: 0 },
    yaw: saved.yaw,
    pitch: saved.pitch,
    distance: saved.distance,
  });
  close(after.eye.x, before.eye.x, 1e-9, "eye.x");
  close(after.eye.y, before.eye.y, 1e-9, "eye.y");
  close(after.eye.z, before.eye.z, 1e-9, "eye.z");
  close(yawDegreesFromBasis(after.forward, after.up), saved.yaw, 1e-9, "yaw");
  close(pitchDegreesFromForward(after.forward), saved.pitch, 1e-9, "pitch");

  // rigをゼロへ戻すだけでは、WASDで入った移動量ごと視点が飛ぶ。
  const rigOnly = simulateDesktopCamera({
    target: { x: 0.4, y: 1.5, z: 0 },
    rig: { x: 0, y: 0, z: 0 },
    yaw: 148.25,
    pitch: -8.5,
    distance: 1.6,
  });
  assert.ok(
    Math.hypot(rigOnly.eye.x - before.eye.x, rigOnly.eye.y - before.eye.y, rigOnly.eye.z - before.eye.z) > 1,
    "rigをゼロにするだけの復帰は視点を失う",
  );
});
