/**
 * Serves the local Claude installation's display fonts to the fixture
 * preview (fidelity/app.html), as the desktop app's `referenceFonts` call
 * does, so captures are measured in the same type as the app. Dev server
 * only: nothing is bundled, copied or stored.
 */
import type { Plugin } from "vite";
import { referenceFonts } from "../../electron/app/reference-fonts.ts";

export function fixtureReferenceFonts(): Plugin {
  return {
    name: "claudex-fixture-reference-fonts",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use(
        "/@fixture/reference-fonts",
        (_request, response) => {
          const fonts = referenceFonts().map((font) => ({
            family: font.family,
            style: font.style,
            data: Buffer.from(font.data).toString("base64"),
          }));
          response.setHeader("Content-Type", "application/json");
          response.setHeader("Cache-Control", "no-store");
          response.end(JSON.stringify(fonts));
        },
      );
    },
  };
}
