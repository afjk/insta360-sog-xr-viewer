import assert from "node:assert/strict";
import test from "node:test";
import {
  extractNextData,
  findSpatialAssetUrl,
  findTaskOutputs,
  isInsta360Host,
  isPubliclyRoutableHost,
  isSpatialAssetUrl,
  parseInsta360ShareUrl,
  resolveSpatialAssetFromHtml,
  selectSpatialOutput,
  toAbsoluteUrl,
  unescapeJsonText,
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

test("blocks loopback and private hosts from being proxied", () => {
  assert.ok(isPubliclyRoutableHost("cdn.insta360.com"));
  assert.ok(!isPubliclyRoutableHost("localhost"));
  assert.ok(!isPubliclyRoutableHost("127.0.0.1"));
  assert.ok(!isPubliclyRoutableHost("10.1.2.3"));
  assert.ok(!isPubliclyRoutableHost("172.16.0.9"));
  assert.ok(!isPubliclyRoutableHost("192.168.1.1"));
  assert.ok(!isPubliclyRoutableHost("169.254.169.254"));
});

/**
 * 共有ページはNext.jsで、生成済みアセットの署名付きURLが `__NEXT_DATA__` に
 * 最初から入っている。Next.jsは `&` を `\u0026` として書き出すので、
 * 素のテキスト走査ではURLが壊れる。ここではその実物に近い形を組み立てる。
 */
const SHARE_ID = "GS3DGbfd0ddd0dd4a47ccba4d3d2c2eed8a4d";
const SIGNED_QUERY =
  "?x-oss-date=20260822T000000Z&x-oss-expires=604800&x-oss-signature-version=OSS4-HMAC-SHA256&x-oss-signature=XXX";
const ASSET_BASE = `https://p2-app.insta360.com/3dgs/${SHARE_ID}`;
const SOG_URL = `${ASSET_BASE}/1_3DGS.sog${SIGNED_QUERY}`;
const PLY_URL = `${ASSET_BASE}/0_3DGS.ply${SIGNED_QUERY}`;

const OUTPUTS = [
  { name: "0_3DGS.ply", type: "model", fileFormat: "ply", url: PLY_URL },
  { name: "1_3DGS.sog", type: "model", fileFormat: "sog", url: SOG_URL },
  { name: "2_cameras.json", type: "camera", fileFormat: "json", url: `${ASSET_BASE}/2_cameras.json${SIGNED_QUERY}` },
  { name: "3_3DGS.voxel.zip", type: "voxel", fileFormat: "zip", url: `${ASSET_BASE}/3_3DGS.voxel.zip${SIGNED_QUERY}` },
  { name: "4_effect_1.mp4", type: "video", fileFormat: "mp4", url: `${ASSET_BASE}/4_effect_1.mp4${SIGNED_QUERY}` },
];

function sharePageHtml(payload: unknown): string {
  // Next.jsは `&` `<` `>` をユニコードエスケープして埋め込む。
  const json = JSON.stringify(payload).replace(/&/g, "\\u0026");
  return [
    "<!doctype html><html lang=\"ja\"><body><div id=\"__next\"></div>",
    `<script id="__NEXT_DATA__" type="application/json">${json}</script>`,
    "</body></html>",
  ].join("");
}

const sharePage = (outputs: unknown = OUTPUTS) =>
  sharePageHtml({ props: { pageProps: { taskDetail: { id: SHARE_ID, outputs } } } });

test("restores escaped ampersands so signed URLs stay intact", () => {
  assert.equal(unescapeJsonText("a\\u0026b\\u002Fc"), "a&b/c");
});

test("reads the signed SOG URL out of __NEXT_DATA__", () => {
  const resolved = resolveSpatialAssetFromHtml(sharePage(), SHARE_URL);
  assert.equal(resolved, SOG_URL);
  assert.match(resolved ?? "", /&x-oss-expires=604800&/, "query separators survive");
  assert.doesNotMatch(resolved ?? "", /\\u0026/);
});

test("prefers the SOG bundle over the PLY the same capture also ships", () => {
  const outputs = findTaskOutputs(extractNextData(sharePage()));
  assert.deepEqual(outputs.map((output) => output.name), OUTPUTS.map((output) => output.name));
  assert.equal(selectSpatialOutput(outputs)?.url, SOG_URL);
});

test("falls back to the file extension when the format field is missing", () => {
  const outputs = findTaskOutputs(
    extractNextData(sharePage([{ name: "1_3DGS.sog", url: SOG_URL }])),
  );
  assert.equal(outputs[0].fileFormat, "sog");
  assert.equal(selectSpatialOutput(outputs)?.url, SOG_URL);
});

test("still finds the outputs when they move off the documented path", () => {
  const html = sharePageHtml({ props: { pageProps: { detail: { result: { files: OUTPUTS } } } } });
  assert.equal(resolveSpatialAssetFromHtml(html, SHARE_URL), SOG_URL);
});

test("reports nothing when the capture has no SOG", () => {
  const withoutSog = OUTPUTS.filter((output) => output.fileFormat !== "sog");
  assert.equal(resolveSpatialAssetFromHtml(sharePage(withoutSog), SHARE_URL), null);
});

test("keeps scanning the markup when the page carries no __NEXT_DATA__", () => {
  const html = `<script>window.__D__={"sog":"https:\\/\\/cdn.insta360.com\\/a\\/capture.sog"}</script>`;
  assert.equal(
    resolveSpatialAssetFromHtml(html, SHARE_URL),
    "https://cdn.insta360.com/a/capture.sog",
  );
});
