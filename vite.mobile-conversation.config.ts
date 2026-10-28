import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { previewRuntimes } from "./scripts/vite-preview-runtimes";
import path from "node:path";
import { webLightPalettePlugin } from "./scripts/vite-web-light-palette";
export default defineConfig({
  root: path.resolve("src/mobile-conversation"),
  base: "./",
  plugins: [react(), previewRuntimes(), webLightPalettePlugin()],
  define: {
    __CLAUDEX_SURFACE__: JSON.stringify("web"),
    __APP_VERSION__: JSON.stringify("0.0.1"),
  },
  build: {
    outDir: path.resolve("dist-mobile-conversation"),
    emptyOutDir: true,
    target: ["es2022", "safari16.4"],
    sourcemap: "hidden",
  },
  server: { host: "127.0.0.1", port: 5198, fs: { allow: [path.resolve(".")] } },
});
