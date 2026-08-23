import assert from "node:assert/strict";
import test from "node:test";
import { isInsta360ShareId, shareUrlFromShareId } from "../app/insta360.ts";
import {
  SHARE_ID_PARAM,
  VIEW_PARAM,
  hrefWithoutShareId,
  permalinkFor,
  readShareId,
  readViewPose,
} from "../app/permalink.ts";
import { formatViewPose, type ViewPose } from "../app/view-pose.ts";

// 実データの共有ID。`GS3D` + リージョン1文字 + 32桁の16進。
const SHARE_ID = "GS3DGbfd0ddd0dd4a47ccba4d3d2c2eed8a4d";
const PAGES = "https://afjk.github.io/insta360-sog-xr-viewer/";
// Desktopで作った視点。world空間のeye位置と、水平向き・見下ろし角・Orbit半径。
const POSE: ViewPose = { x: -1.234, y: 1.62, z: 3.5, yaw: 137.5, pitch: -4.58, distance: 2.8 };
const VIEW = formatViewPose(POSE) ?? "";

test("builds a viewer permalink from a share ID", () => {
  assert.equal(permalinkFor(PAGES, SHARE_ID), `${PAGES}?${SHARE_ID_PARAM}=${SHARE_ID}`);
});

test("keeps the deployment's origin and path so subpath hosting survives", () => {
  // GitHub Pagesのサブパスも、localhostの別ポートも、開いている配信先のまま返す。
  assert.equal(
    permalinkFor("http://localhost:4173/insta360-sog-xr-viewer/", SHARE_ID),
    `http://localhost:4173/insta360-sog-xr-viewer/?id=${SHARE_ID}`,
  );
});

test("replaces a stale share ID instead of appending a second one", () => {
  const stale = `${PAGES}?id=GS3DGaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa`;
  assert.equal(permalinkFor(stale, SHARE_ID), `${PAGES}?id=${SHARE_ID}`);
});

test("leaves other query parameters alone and drops the hash", () => {
  const url = new URL(permalinkFor(`${PAGES}?debug=1#section`, SHARE_ID) ?? "");
  assert.equal(url.searchParams.get("debug"), "1");
  assert.equal(url.searchParams.get("id"), SHARE_ID);
  assert.equal(url.hash, "");
});

test("reads the share ID back out of a permalink", () => {
  assert.equal(readShareId(`${PAGES}?id=${SHARE_ID}`), SHARE_ID);
  assert.equal(readShareId(`${PAGES}?debug=1&id=${SHARE_ID}#x`), SHARE_ID);
  assert.equal(readShareId(`${PAGES}?id=%20${SHARE_ID}%20`), SHARE_ID);
});

test("reports no share ID for a plain visit", () => {
  assert.equal(readShareId(PAGES), null);
  assert.equal(readShareId(`${PAGES}?id=`), null);
});

test("rejects IDs that are not Insta360 share IDs", () => {
  // ここを通ったIDだけが共有URLに組み立てられるので、通信前の最後の関門。
  for (const bad of [
    "",
    "   ",
    "GS3DG",
    "GS3DGabc",
    `${SHARE_ID}x`,
    SHARE_ID.replace("b", "z"),
    "../../etc/passwd",
    "https://evil.example/3dspace/detail/GS3DGabc",
    "GS3DG bfd0ddd0dd4a47ccba4d3d2c2eed8a4d",
  ]) {
    assert.equal(isInsta360ShareId(bad), false, bad);
    assert.equal(readShareId(`${PAGES}?id=${encodeURIComponent(bad)}`), null, bad);
    assert.equal(permalinkFor(PAGES, bad), null, bad);
    assert.equal(shareUrlFromShareId(bad), null, bad);
  }
});

test("turns a share ID into the share page URL the resolver understands", () => {
  assert.equal(
    shareUrlFromShareId(SHARE_ID),
    `https://app.insta360.com/3dspace/detail/${SHARE_ID}`,
  );
  assert.equal(shareUrlFromShareId(` ${SHARE_ID} `), `https://app.insta360.com/3dspace/detail/${SHARE_ID}`);
});

test("drops a stale share ID when switching to a non-Insta360 space", () => {
  assert.equal(hrefWithoutShareId(`${PAGES}?id=${SHARE_ID}`), PAGES);
  assert.equal(hrefWithoutShareId(`${PAGES}?debug=1&id=${SHARE_ID}`), `${PAGES}?debug=1`);
  assert.equal(hrefWithoutShareId(PAGES), PAGES);
});

test("returns null instead of throwing on an unusable location", () => {
  assert.equal(permalinkFor("not a url", SHARE_ID), null);
  assert.equal(readShareId("not a url"), null);
  assert.equal(hrefWithoutShareId("not a url"), null);
});

test("builds a view permalink that carries the camera pose", () => {
  const link = permalinkFor(PAGES, SHARE_ID, POSE);
  assert.equal(link, `${PAGES}?${SHARE_ID_PARAM}=${SHARE_ID}&${VIEW_PARAM}=${VIEW}`);
  // 区切りにパーセントエンコードが入らないこと。リンクは目で追える長さに保つ。
  assert.doesNotMatch(link ?? "", /%/);
  assert.ok((link ?? "").length < 160);
});

test("reads the pose back out of a view permalink", () => {
  const link = permalinkFor(PAGES, SHARE_ID, POSE) ?? "";
  assert.equal(readShareId(link), SHARE_ID);
  assert.deepEqual(readViewPose(link), POSE);
});

test("keeps the space link free of a stale view", () => {
  // 「この空間のリンク」はその空間の既定視点で開く。前の視点は持ち込まない。
  const withView = `${PAGES}?id=${SHARE_ID}&view=${VIEW}`;
  assert.equal(permalinkFor(withView, SHARE_ID), `${PAGES}?id=${SHARE_ID}`);
  assert.equal(permalinkFor(withView, SHARE_ID, null), `${PAGES}?id=${SHARE_ID}`);
  assert.equal(readViewPose(`${PAGES}?id=${SHARE_ID}`), null);
});

test("replaces a stale view instead of appending a second one", () => {
  const stale = `${PAGES}?id=${SHARE_ID}&view=${VIEW}`;
  const moved = { ...POSE, x: 4.5 };
  assert.equal(
    permalinkFor(stale, SHARE_ID, moved),
    `${PAGES}?id=${SHARE_ID}&view=${formatViewPose(moved)}`,
  );
});

test("drops a view that cannot be restored instead of shipping it", () => {
  assert.equal(permalinkFor(PAGES, SHARE_ID, { ...POSE, y: Number.NaN }), `${PAGES}?id=${SHARE_ID}`);
});

test("falls back to the default view when the URL's view is broken", () => {
  for (const bad of ["", "   ", "1", "1_0_0_0_0_0", "9_0_0_0_0_0_2", "1_NaN_0_0_0_0_2", "1_0_0_0_0_0_0"]) {
    const href = `${PAGES}?id=${SHARE_ID}&view=${encodeURIComponent(bad)}`;
    assert.equal(readViewPose(href), null, bad);
    // 視点が読めなくても、空間そのものは開ける。
    assert.equal(readShareId(href), SHARE_ID, bad);
  }
});

test("drops the view along with the share ID for a non-Insta360 space", () => {
  assert.equal(hrefWithoutShareId(`${PAGES}?id=${SHARE_ID}&view=${VIEW}`), PAGES);
});

test("carries no signed asset URL or credential into a view permalink", () => {
  const link = permalinkFor(PAGES, SHARE_ID, POSE) ?? "";
  const params = [...new URL(link).searchParams.keys()];
  assert.deepEqual(params, [SHARE_ID_PARAM, VIEW_PARAM]);
  for (const secret of ["x-oss-signature", "Expires", "Signature", "token", "http"]) {
    assert.doesNotMatch(link.slice(PAGES.length), new RegExp(secret, "i"), secret);
  }
});
