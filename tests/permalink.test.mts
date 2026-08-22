import assert from "node:assert/strict";
import test from "node:test";
import { isInsta360ShareId, shareUrlFromShareId } from "../app/insta360.ts";
import {
  SHARE_ID_PARAM,
  hrefWithoutShareId,
  permalinkFor,
  readShareId,
} from "../app/permalink.ts";

// 実データの共有ID。`GS3D` + リージョン1文字 + 32桁の16進。
const SHARE_ID = "GS3DGbfd0ddd0dd4a47ccba4d3d2c2eed8a4d";
const PAGES = "https://afjk.github.io/insta360-sog-xr-viewer/";

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
