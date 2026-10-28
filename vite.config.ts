import { readFileSync } from "node:fs";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { previewRuntimes } from "./scripts/vite-preview-runtimes.ts";
import { webLightPalettePlugin } from "./scripts/vite-web-light-palette.ts";

const { version } = JSON.parse(readFileSync("package.json", "utf8"));

export default defineConfig({
  plugins: [
    // The web variant on this dev server gets the web's light palette too.
    ...(process.env.CLAUDEX_SURFACE === "web" ? [webLightPalettePlugin()] : []),
    react(),
    previewRuntimes(),
  ],
  base: "./",
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
    // backend/ is the vendored Sub2API fork with its own Vue toolchain.
    watch: { ignored: ["**/backend/**"] },
  },
  // Keep Vite's default "every .html file" dependency scan, minus backend/.
  // Explicit entries drop Vite's built-in __tests__/coverage ignores, so they
  // are restated here.
  optimizeDeps: {
    entries: [
      "**/*.html",
      "!backend/**",
      "!**/__tests__/**",
      "!**/coverage/**",
    ],
  },
  build: {
    rolldownOptions: {
      // The app, and its small extra pages with their own preloads
      // (electron/extra-pages.ts): the find bar and the Quick Entry composer.
      input: { index: "index.html", find: "find.html", quick: "quick.html" },
    },
  },
  define: {
    __APP_VERSION__: JSON.stringify(version),
    __CLAUDEX_SERVICE_URL__: JSON.stringify(
      process.env.CLAUDEX_SERVICE_URL ?? "",
    ),
    // The desktop build; the web build (vite.web.config.ts) sets "web".
    // CLAUDEX_SURFACE=web renders the web variant here too (web fidelity
    // fixtures on the dev server).
    __CLAUDEX_SURFACE__: JSON.stringify(
      process.env.CLAUDEX_SURFACE === "web" ? "web" : "desktop",
    ),
  },
});
