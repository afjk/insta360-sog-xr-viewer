import assert from "node:assert/strict";
import test from "node:test";
import {
  RESOLVER_DISABLED,
  resolverConfigFor,
} from "../app/resolver-config.ts";

test("falls back to the same origin when nothing is configured", () => {
  const config = resolverConfigFor("");
  assert.equal(config.available, true);
  assert.equal(config.available && config.endpoints.insta360, "/api/insta360");
  assert.equal(config.available && config.endpoints.supersplat, "/api/supersplat");
});

test("disables share URLs when the deployment has no resolver", () => {
  const config = resolverConfigFor(RESOLVER_DISABLED);
  assert.equal(config.available, false);
  assert.match(config.available ? "" : config.reason, /エンドポイントがありません/);
});

test("points at a dedicated resolver origin when one is configured", () => {
  const config = resolverConfigFor("https://sog-resolver.example.workers.dev");
  assert.equal(
    config.available && config.endpoints.insta360,
    "https://sog-resolver.example.workers.dev/api/insta360",
  );
  assert.equal(
    config.available && config.endpoints.supersplat,
    "https://sog-resolver.example.workers.dev/api/supersplat",
  );
});

test("both providers hang off the one configured origin", () => {
  // オリジンは1つ。提供元が増えてもビルド設定は増やさない。
  const config = resolverConfigFor("https://sog-resolver.example.workers.dev");
  assert.equal(config.available && config.origin, "https://sog-resolver.example.workers.dev");
});

test("tolerates a trailing slash and surrounding whitespace", () => {
  const config = resolverConfigFor("  https://sog-resolver.example.workers.dev/  ");
  assert.equal(
    config.available && config.endpoints.insta360,
    "https://sog-resolver.example.workers.dev/api/insta360",
  );
});

test("does not hardcode any deployment host", async () => {
  const { readFile } = await import("node:fs/promises");
  const [config, viewer] = await Promise.all([
    readFile(new URL("../app/resolver-config.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/SogViewer.tsx", import.meta.url), "utf8"),
  ]);
  for (const source of [config, viewer]) {
    assert.doesNotMatch(source, /chatgpt\.site/);
    assert.doesNotMatch(source, /workers\.dev/);
    assert.doesNotMatch(source, /https:\/\/[^\s"'`]*insta360-sog-xr-viewer/);
  }
});

test("the GitHub Pages build ships without a resolver unless one is given", async () => {
  const { readFile } = await import("node:fs/promises");
  const [pagesConfig, workflow] = await Promise.all([
    readFile(new URL("../vite.pages.config.ts", import.meta.url), "utf8"),
    readFile(new URL("../.github/workflows/pages.yml", import.meta.url), "utf8"),
  ]);
  assert.match(pagesConfig, /VITE_SOG_RESOLVER_ORIGIN\?\.trim\(\) \|\| "none"/);
  assert.match(pagesConfig, /__SOG_RESOLVER_ORIGIN__: JSON\.stringify\(resolverOrigin\)/);
  assert.match(workflow, /VITE_SOG_RESOLVER_ORIGIN: \$\{\{ vars\.SOG_RESOLVER_ORIGIN \}\}/);
});
