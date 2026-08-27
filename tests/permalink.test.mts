import assert from "node:assert/strict";
import test from "node:test";
import { isInsta360ShareId, shareUrlFromShareId } from "../app/insta360.ts";
import { isSuperSplatSceneId, sceneUrlFromSceneId } from "../app/supersplat.ts";
import {
  SCENE_ID_PARAM,
  SHARE_ID_PARAM,
  VIEW_PARAM,
  hrefWithoutSpace,
  isSameSpace,
  permalinkFor,
  readSpaceRef,
  readViewPose,
  type SpaceRef,
} from "../app/permalink.ts";
import { formatViewPose, type ViewPose } from "../app/view-pose.ts";

// 実データの共有ID。`GS3D` + リージョン1文字 + 32桁の16進。
const SHARE_ID = "GS3DGbfd0ddd0dd4a47ccba4d3d2c2eed8a4d";
const PAGES = "https://afjk.github.io/insta360-sog-xr-viewer/";
// Desktopで作った視点。world空間のeye位置と、水平向き・見下ろし角・Orbit半径。
const POSE: ViewPose = { x: -1.234, y: 1.62, z: 3.5, yaw: 137.5, pitch: -4.58, distance: 2.8 };
const VIEW = formatViewPose(POSE) ?? "";
// 実データのSuperSplatシーンID。公開ページは https://superspl.at/scene/56155c3f 。
const SCENE_ID = "56155c3f";
const SHARE: SpaceRef = { provider: "insta360", id: SHARE_ID };
const SCENE: SpaceRef = { provider: "supersplat", id: SCENE_ID };
/** Insta360の共有IDだけを読む小道具。提供元が違うURLでは `null`。 */
const readShareId = (href: string) => {
  const space = readSpaceRef(href);
  return space?.provider === "insta360" ? space.id : null;
};

test("builds a viewer permalink from a share ID", () => {
  assert.equal(permalinkFor(PAGES, SHARE), `${PAGES}?${SHARE_ID_PARAM}=${SHARE_ID}`);
});

test("keeps the deployment's origin and path so subpath hosting survives", () => {
  // GitHub Pagesのサブパスも、localhostの別ポートも、開いている配信先のまま返す。
  assert.equal(
    permalinkFor("http://localhost:4173/insta360-sog-xr-viewer/", SHARE),
    `http://localhost:4173/insta360-sog-xr-viewer/?id=${SHARE_ID}`,
  );
});

test("replaces a stale share ID instead of appending a second one", () => {
  const stale = `${PAGES}?id=GS3DGaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa`;
  assert.equal(permalinkFor(stale, SHARE), `${PAGES}?id=${SHARE_ID}`);
});

test("leaves other query parameters alone and drops the hash", () => {
  const url = new URL(permalinkFor(`${PAGES}?debug=1#section`, SHARE) ?? "");
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
    assert.equal(permalinkFor(PAGES, { provider: "insta360", id: bad }), null, bad);
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
  assert.equal(hrefWithoutSpace(`${PAGES}?id=${SHARE_ID}`), PAGES);
  assert.equal(hrefWithoutSpace(`${PAGES}?debug=1&id=${SHARE_ID}`), `${PAGES}?debug=1`);
  assert.equal(hrefWithoutSpace(PAGES), PAGES);
});

test("returns null instead of throwing on an unusable location", () => {
  assert.equal(permalinkFor("not a url", SHARE), null);
  assert.equal(readShareId("not a url"), null);
  assert.equal(hrefWithoutSpace("not a url"), null);
});

test("builds a view permalink that carries the camera pose", () => {
  const link = permalinkFor(PAGES, SHARE, POSE);
  assert.equal(link, `${PAGES}?${SHARE_ID_PARAM}=${SHARE_ID}&${VIEW_PARAM}=${VIEW}`);
  // 区切りにパーセントエンコードが入らないこと。リンクは目で追える長さに保つ。
  assert.doesNotMatch(link ?? "", /%/);
  assert.ok((link ?? "").length < 160);
});

test("reads the pose back out of a view permalink", () => {
  const link = permalinkFor(PAGES, SHARE, POSE) ?? "";
  assert.equal(readShareId(link), SHARE_ID);
  assert.deepEqual(readViewPose(link), POSE);
});

test("keeps the space link free of a stale view", () => {
  // 「この空間のリンク」はその空間の既定視点で開く。前の視点は持ち込まない。
  const withView = `${PAGES}?id=${SHARE_ID}&view=${VIEW}`;
  assert.equal(permalinkFor(withView, SHARE), `${PAGES}?id=${SHARE_ID}`);
  assert.equal(permalinkFor(withView, SHARE, null), `${PAGES}?id=${SHARE_ID}`);
  assert.equal(readViewPose(`${PAGES}?id=${SHARE_ID}`), null);
});

test("replaces a stale view instead of appending a second one", () => {
  const stale = `${PAGES}?id=${SHARE_ID}&view=${VIEW}`;
  const moved = { ...POSE, x: 4.5 };
  assert.equal(
    permalinkFor(stale, SHARE, moved),
    `${PAGES}?id=${SHARE_ID}&view=${formatViewPose(moved)}`,
  );
});

test("drops a view that cannot be restored instead of shipping it", () => {
  assert.equal(permalinkFor(PAGES, SHARE, { ...POSE, y: Number.NaN }), `${PAGES}?id=${SHARE_ID}`);
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
  assert.equal(hrefWithoutSpace(`${PAGES}?id=${SHARE_ID}&view=${VIEW}`), PAGES);
});

test("carries no signed asset URL or credential into a view permalink", () => {
  const link = permalinkFor(PAGES, SHARE, POSE) ?? "";
  const params = [...new URL(link).searchParams.keys()];
  assert.deepEqual(params, [SHARE_ID_PARAM, VIEW_PARAM]);
  for (const secret of ["x-oss-signature", "Expires", "Signature", "token", "http"]) {
    assert.doesNotMatch(link.slice(PAGES.length), new RegExp(secret, "i"), secret);
  }
});

// --- SuperSplat (`?ss=`) ---------------------------------------------------

test("builds a viewer permalink from a SuperSplat scene ID", () => {
  assert.equal(permalinkFor(PAGES, SCENE), `${PAGES}?${SCENE_ID_PARAM}=${SCENE_ID}`);
});

test("reads the scene ID back out of a SuperSplat permalink", () => {
  assert.deepEqual(readSpaceRef(`${PAGES}?ss=${SCENE_ID}`), SCENE);
  assert.deepEqual(readSpaceRef(`${PAGES}?debug=1&ss=${SCENE_ID}#x`), SCENE);
  assert.deepEqual(readSpaceRef(`${PAGES}?ss=%20${SCENE_ID}%20`), SCENE);
});

test("carries a view pose on a SuperSplat permalink too", () => {
  const link = permalinkFor(PAGES, SCENE, POSE);
  assert.equal(link, `${PAGES}?${SCENE_ID_PARAM}=${SCENE_ID}&${VIEW_PARAM}=${VIEW}`);
  assert.deepEqual(readSpaceRef(link ?? ""), SCENE);
  assert.deepEqual(readViewPose(link ?? ""), POSE);
});

test("rejects scene IDs that could escape the scene path", () => {
  // `?ss=` は外から任意の文字列で来る。ここを通った値だけが
  // https://superspl.at/scene/<id> に組み立てられる。
  for (const bad of [
    "",
    "   ",
    "../../etc/passwd",
    "56155c3f/../../admin",
    "56155c3f%2f..",
    "a".repeat(65),
    "scene?id=x",
    "https://evil.example/scene/56155c3f",
    "56155c3f:8080",
    "56155c3f.json",
  ]) {
    assert.equal(isSuperSplatSceneId(bad), false, bad);
    assert.equal(readSpaceRef(`${PAGES}?ss=${encodeURIComponent(bad)}`), null, bad);
    assert.equal(permalinkFor(PAGES, { provider: "supersplat", id: bad }), null, bad);
    assert.equal(sceneUrlFromSceneId(bad), null, bad);
  }
});

test("turns a scene ID into the page URL the resolver understands", () => {
  assert.equal(sceneUrlFromSceneId(SCENE_ID), `https://superspl.at/scene/${SCENE_ID}`);
  assert.equal(sceneUrlFromSceneId(` ${SCENE_ID} `), `https://superspl.at/scene/${SCENE_ID}`);
});

test("prefers the existing ?id= when a URL carries both id and ss", () => {
  // 異常なURL。既に配ってある `?id=` のリンクを壊さないほうを採る。
  const both = `${PAGES}?id=${SHARE_ID}&ss=${SCENE_ID}`;
  assert.deepEqual(readSpaceRef(both), SHARE);
  // `id` が壊れていれば、`ss` へ落ちずに不正として扱う。片方だけが有効。
  assert.equal(readSpaceRef(`${PAGES}?id=broken&ss=${SCENE_ID}`), null);
});

test("never emits a permalink carrying both providers", () => {
  // 提供元を切り替えたら、前の提供元のパラメータは必ず落とす。
  const both = `${PAGES}?id=${SHARE_ID}&ss=${SCENE_ID}`;
  assert.equal(permalinkFor(both, SCENE), `${PAGES}?${SCENE_ID_PARAM}=${SCENE_ID}`);
  assert.equal(permalinkFor(both, SHARE), `${PAGES}?${SHARE_ID_PARAM}=${SHARE_ID}`);
});

test("drops a stale scene ID when switching to a space with no permalink", () => {
  assert.equal(hrefWithoutSpace(`${PAGES}?ss=${SCENE_ID}`), PAGES);
  assert.equal(hrefWithoutSpace(`${PAGES}?ss=${SCENE_ID}&view=${VIEW}`), PAGES);
  assert.equal(hrefWithoutSpace(`${PAGES}?debug=1&ss=${SCENE_ID}`), `${PAGES}?debug=1`);
});

test("tells spaces apart by provider, not by ID alone", () => {
  assert.ok(isSameSpace(SCENE, { provider: "supersplat", id: SCENE_ID }));
  assert.ok(!isSameSpace(SCENE, { provider: "insta360", id: SCENE_ID }));
  assert.ok(!isSameSpace(SCENE, null));
  assert.ok(!isSameSpace(null, null));
});

test("carries no CDN URL or revision into a SuperSplat permalink", () => {
  const link = permalinkFor(PAGES, SCENE, POSE) ?? "";
  const params = [...new URL(link).searchParams.keys()];
  assert.deepEqual(params, [SCENE_ID_PARAM, VIEW_PARAM]);
  for (const leak of ["cloudfront", "meta.json", ".sog", "http"]) {
    assert.doesNotMatch(link.slice(PAGES.length), new RegExp(leak, "i"), leak);
  }
});
