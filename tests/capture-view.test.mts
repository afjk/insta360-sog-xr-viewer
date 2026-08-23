import assert from "node:assert/strict";
import test from "node:test";
import {
  captureFovOf,
  captureHomeView,
  parseCaptureCameras,
  responsiveFovDegrees,
  splatPlacement,
  worldFromCapturePoint,
} from "../app/capture-view.ts";
import { orbitTargetOf } from "../app/view-pose.ts";

// 実データ（共有ID `GS3DGbfd…8a4d` の `2_cameras.json`）から抜いた3件。
// 撮り始め（`frame_00000`）と、途中と、最後のフレーム。`rotation` は初期視点の
// 計算に使わないが、実データと同じ形を通せることを見るために残してある。
const CAMERAS = [
  {
    id: 0,
    img_name: "frame_00000_cam1_center",
    width: 1000,
    height: 1000,
    position: [-2.759717355135194, -0.007002549036883566, -4.442664956382061],
    rotation: [
      [0.29531630268897857, 0.06211364681552457, 0.9533782965042723],
      [0.0038792624490005933, 0.9977982170172723, -0.06620928514947284],
      [-0.9553916645486099, 0.023251085919343793, 0.2944251251415339],
    ],
    fy: 500.00000000000006,
    fx: 500.00000000000006,
  },
  {
    id: 400,
    img_name: "frame_00040_cam1_center",
    width: 1000,
    height: 1000,
    position: [-0.8374383406705506, 0.035516201333993, 6.041140008124338],
    rotation: [
      [-0.2071226769650618, -0.06278981953499492, -0.9762979234073933],
      [-0.024458331309009804, 0.9979586624719066, -0.05899405077515628],
      [0.9780091956195526, 0.011659612345433135, -0.2082356038806737],
    ],
    fy: 500.00000000000006,
    fx: 500.00000000000006,
  },
  {
    id: 795,
    img_name: "frame_00079_cam2_center",
    width: 1000,
    height: 1000,
    position: [1.4673737656512094, 0.01839454051293591, 1.3369275728520542],
    rotation: [
      [0.509239836385119, -0.004563982666749891, -0.8606125487701621],
      [0.027593145247902524, 0.9995584195995288, 0.011026519986836554],
      [0.8601821942901313, -0.029362150294376575, 0.5091409006908648],
    ],
    fy: 500.00000000000006,
    fx: 500.00000000000006,
  },
];

// 配置用バウンズ。`splatPlacement` は中心を(0, *, 0)へ、`max.y`（Y下向きの
// 撮影座標では床）をy=0へ持っていく。
const BOUNDS = { min: { x: -4, y: -1.5, z: -5 }, max: { x: 3, y: 1.6, z: 7 } };

const close = (actual: number, expected: number, tolerance = 1e-6, message = "") =>
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `${message} expected ${actual} to be within ${tolerance} of ${expected}`,
  );

test("reads the real cameras.json shape", () => {
  const cameras = parseCaptureCameras(CAMERAS);
  assert.ok(cameras);
  assert.equal(cameras.length, 3);
  assert.deepEqual(cameras[0].position, {
    x: -2.759717355135194,
    y: -0.007002549036883566,
    z: -4.442664956382061,
  });
  assert.deepEqual(cameras[0].intrinsics, {
    width: 1000,
    height: 1000,
    fx: 500.00000000000006,
    fy: 500.00000000000006,
  });
});

test("rejects anything that is not a usable camera list", () => {
  assert.equal(parseCaptureCameras(null), null);
  assert.equal(parseCaptureCameras({ cameras: CAMERAS }), null);
  // 1件では軌跡の中心が撮影地点と重なり、向きが決まらない。
  assert.equal(parseCaptureCameras(CAMERAS.slice(0, 1)), null);
  assert.equal(parseCaptureCameras([{ position: [0, 0] }, { position: [1, 1, 1] }]), null);
  assert.equal(parseCaptureCameras([{ position: [0, 0, "1"] }, { position: [1, 1, 1] }]), null);
  assert.equal(
    parseCaptureCameras([{ position: [0, Number.NaN, 0] }, { position: [1, 1, 1] }]),
    null,
  );
});

test("keeps cameras whose intrinsics are missing or unusable", () => {
  const cameras = parseCaptureCameras([
    { position: [0, 0, 0] },
    { position: [1, 1, 1], width: 0, height: 100, fx: 50, fy: 50 },
  ]);
  assert.ok(cameras);
  assert.equal(cameras[0].intrinsics, null);
  assert.equal(cameras[1].intrinsics, null);
});

test("places the room centred on the origin with the floor at y=0", () => {
  const placement = splatPlacement(BOUNDS);
  assert.deepEqual(placement, { x: 0.5, y: 1.6, z: 1 });
  // 撮影座標のバウンズの角は、world空間では中心を挟んで対称に来る。
  const min = worldFromCapturePoint(BOUNDS.min, placement);
  const max = worldFromCapturePoint(BOUNDS.max, placement);
  close(min.x + max.x, 0, 1e-12, "x is centred");
  close(min.z + max.z, 0, 1e-12, "z is centred");
  // Y下向きなので、撮影座標で一番大きいyが床。
  close(max.y, 0, 1e-12, "floor sits at y=0");
  assert.ok(min.y > 0, "the ceiling is above the floor");
});

test("starts where the capture started, looking at the middle of the walk", () => {
  const cameras = parseCaptureCameras(CAMERAS);
  assert.ok(cameras);
  const pose = captureHomeView(cameras, splatPlacement(BOUNDS));
  assert.ok(pose);
  // eyeは `cameras[0]` をそのままworldへ移したもの。
  close(pose.x, -2.259717355, 1e-9, "eye x");
  close(pose.y, 1.607002549, 1e-9, "eye y");
  close(pose.z, 5.442664956, 1e-9, "eye z");
  close(pose.yaw, -20.712158644, 1e-9, "yaw");
  close(pose.pitch, 0.223801604, 1e-9, "pitch");
  close(pose.distance, 5.795759596, 1e-9, "distance");
});

test("puts the orbit centre on the average camera position", () => {
  const cameras = parseCaptureCameras(CAMERAS);
  assert.ok(cameras);
  const placement = splatPlacement(BOUNDS);
  const pose = captureHomeView(cameras, placement);
  assert.ok(pose);
  // yaw / pitch / distance から注視点へ戻すと、カメラ位置の平均に一致する。
  const target = orbitTargetOf(pose);
  const average = {
    x: (CAMERAS[0].position[0] + CAMERAS[1].position[0] + CAMERAS[2].position[0]) / 3,
    y: (CAMERAS[0].position[1] + CAMERAS[1].position[1] + CAMERAS[2].position[1]) / 3,
    z: (CAMERAS[0].position[2] + CAMERAS[1].position[2] + CAMERAS[2].position[2]) / 3,
  };
  const expected = worldFromCapturePoint(average, placement);
  close(target.x, expected.x, 1e-9, "target x");
  close(target.y, expected.y, 1e-9, "target y");
  close(target.z, expected.z, 1e-9, "target z");
});

test("has no view when every camera sits on the same spot", () => {
  // 実データでも `frame_00000` の5面は同じ位置に並ぶ。そこだけを渡すと
  // 注視点がeyeと重なり、向きが決められない。
  const cameras = parseCaptureCameras([
    { position: [1, 2, 3] },
    { position: [1, 2, 3] },
  ]);
  assert.ok(cameras);
  assert.equal(captureHomeView(cameras, splatPlacement(BOUNDS)), null);
});

test("recovers the capture field of view from the first camera", () => {
  const cameras = parseCaptureCameras(CAMERAS);
  assert.ok(cameras);
  const fov = captureFovOf(cameras);
  assert.ok(fov);
  // 1000×1000 / fx=fy=500 は水平垂直とも90°。実データのInsta360はこの値。
  close(fov.horizontal, 90, 1e-9, "horizontal");
  close(fov.vertical, 90, 1e-9, "vertical");
  assert.equal(captureFovOf(parseCaptureCameras([{ position: [0, 0, 0] }, { position: [1, 1, 1] }])!), null);
});

test("fits the capture field of view to the viewport", () => {
  const square = { horizontal: 90, vertical: 90 };
  // 正方形の撮影画角なら、どんな縦横比でも垂直90°のまま（横長では水平が
  // 撮影時より広く、縦長では水平基準に切り替わってやはり90°で頭打ち）。
  close(responsiveFovDegrees(square, 1920, 1080), 90, 1e-9, "landscape");
  close(responsiveFovDegrees(square, 390, 844), 90, 1e-9, "portrait");

  // 横長の撮影画角では、縦長の画面で垂直画角が広がる。
  const wide = { horizontal: 70, vertical: 55 };
  close(responsiveFovDegrees(wide, 1920, 1080), 55, 1e-9, "vertical fits");
  const portrait = responsiveFovDegrees(wide, 900, 1100);
  assert.ok(portrait > 55, "portrait widens the vertical angle");
  close(
    portrait,
    (2 * Math.atan((Math.tan((70 * Math.PI) / 360) * 1100) / 900) * 180) / Math.PI,
    1e-9,
    "portrait matches the horizontal fit",
  );
  // 縦に細長い画面でも、垂直画角は90°で頭打ちにする（公式Viewerと同じ）。
  close(responsiveFovDegrees(wide, 800, 1600), 90, 1e-9, "capped at 90");
  // 画面の大きさが取れないうちは撮影時の垂直画角をそのまま使う。
  close(responsiveFovDegrees(wide, 0, 0), 55, 1e-9, "no viewport yet");
});
