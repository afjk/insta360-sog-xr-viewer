import react from "@vitejs/plugin-react";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const projectRoot = fileURLToPath(new URL(".", import.meta.url));

// このリポジトリ唯一のビルド。エントリは `github-pages-src/`、出力は `dist-pages/`。
// GitHub Pagesは静的配信で `/api` を持たないため、共有URLの解決先は既定で無効。
// 専用のCloudflare Workerを用意したら VITE_SOG_RESOLVER_ORIGIN に渡してビルドする。
const resolverOrigin = process.env.VITE_SOG_RESOLVER_ORIGIN?.trim() || "none";

export default defineConfig({
  root: resolve(projectRoot, "github-pages-src"),
  base: "/insta360-sog-xr-viewer/",
  publicDir: resolve(projectRoot, "public"),
  plugins: [react()],
  define: {
    __SOG_RESOLVER_ORIGIN__: JSON.stringify(resolverOrigin),
  },
  build: {
    outDir: resolve(projectRoot, "dist-pages"),
    emptyOutDir: true,
  },
});
