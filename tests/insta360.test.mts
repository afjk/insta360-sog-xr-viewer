import assert from "node:assert/strict";
import test from "node:test";
import {
  findFollowUpApiUrls,
  findSpatialAssetUrl,
  isInsta360Host,
  isPubliclyRoutableHost,
  isSpatialAssetUrl,
  parseInsta360ShareUrl,
  toAbsoluteUrl,
} from "../app/insta360.ts";

const SHARE_URL =
  "https://app.insta360.com/3dspace/detail/GS3DGabb2ca6d41b14dccb9ec1ca4139af0e2?showTitle=0&useImmersive=1&isDark=1&source=cloud3dspace";

test("parses an Insta360 Spatial Capture share URL", () => {
  const share = parseInsta360ShareUrl(SHARE_URL);
  assert.equal(share?.shareId, "GS3DGabb2ca6d41b14dccb9ec1ca4139af0e2");
  assert.equal(share?.shareUrl, SHARE_URL);
});

test("accepts share URLs pasted without a scheme and via query id", () => {
  assert.equal(
    parseInsta360ShareUrl("app.insta360.com/3dspace/detail/GS3DGabc")?.shareId,
    "GS3DGabc",
  );
  assert.equal(
    parseInsta360ShareUrl("https://www.insta360.com/3dspace/share?id=GS3DGxyz")?.shareId,
    "GS3DGxyz",
  );
});

test("rejects non-Insta360 and malformed share URLs", () => {
  assert.equal(parseInsta360ShareUrl("https://example.com/3dspace/detail/GS3DGabc"), null);
  assert.equal(parseInsta360ShareUrl("https://app.insta360.com/gallery"), null);
  assert.equal(parseInsta360ShareUrl("   "), null);
  assert.equal(toAbsoluteUrl("javascript:alert(1)"), null);
});

test("recognises host suffixes without matching lookalike domains", () => {
  assert.ok(isInsta360Host("app.insta360.com"));
  assert.ok(isInsta360Host("cdn.arashivision.com"));
  assert.ok(!isInsta360Host("insta360.com.evil.example"));
});

test("recognises directly loadable SOG asset URLs", () => {
  assert.ok(isSpatialAssetUrl("https://cdn.example.com/spaces/room.sog"));
  assert.ok(isSpatialAssetUrl("https://cdn.example.com/spaces/room/meta.json"));
  assert.ok(!isSpatialAssetUrl("https://cdn.example.com/spaces/room.ply"));
  assert.ok(!isSpatialAssetUrl("not a url at all"));
});

test("finds the SOG bundle inside share page markup", () => {
  const html = `<script>window.__DATA__={"model":{"sog_url":"https:\\/\\/cdn.insta360.com\\/spaces\\/abc\\/capture.sog?auth=1"}}</script>`;
  assert.equal(
    findSpatialAssetUrl(html, SHARE_URL),
    "https://cdn.insta360.com/spaces/abc/capture.sog?auth=1",
  );
});

test("falls back to a SOG directory manifest and resolves relative paths", () => {
  const html = `<link rel="preload" href="/assets/space/meta.json" as="fetch">`;
  assert.equal(
    findSpatialAssetUrl(html, SHARE_URL),
    "https://app.insta360.com/assets/space/meta.json",
  );
});

test("ignores unrelated JSON files when looking for an asset", () => {
  assert.equal(findSpatialAssetUrl(`<script src="/manifest.json"></script>`, SHARE_URL), null);
});

test("collects only same-brand API URLs that mention the share id", () => {
  const shareId = "GS3DGabc";
  const html = `
    <script>
      var api = "https://app.insta360.com/api/3dspace/GS3DGabc/detail";
      var other = "https://evil.example/api/GS3DGabc.json";
      var unrelated = "https://app.insta360.com/api/user/profile";
    </script>`;
  assert.deepEqual(findFollowUpApiUrls(html, SHARE_URL, shareId), [
    "https://app.insta360.com/api/3dspace/GS3DGabc/detail",
  ]);
});

test("blocks loopback and private hosts from being proxied", () => {
  assert.ok(isPubliclyRoutableHost("cdn.insta360.com"));
  assert.ok(!isPubliclyRoutableHost("localhost"));
  assert.ok(!isPubliclyRoutableHost("127.0.0.1"));
  assert.ok(!isPubliclyRoutableHost("10.1.2.3"));
  assert.ok(!isPubliclyRoutableHost("172.16.0.9"));
  assert.ok(!isPubliclyRoutableHost("192.168.1.1"));
  assert.ok(!isPubliclyRoutableHost("169.254.169.254"));
});
