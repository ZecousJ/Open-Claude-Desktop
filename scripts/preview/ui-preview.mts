/**
 * The whole web app on synthetic fixture data, for side-by-side checks with
 * the live pages: `node --import tsx scripts/preview/ui-preview.mts [port]`.
 * The real AuthGate, BootShell, routes and renderer run unchanged; only the
 * entry is swapped for scripts/preview/app-preview.tsx. The fixture profile
 * fills in any query key the URL leaves out, so a refresh keeps the profile.
 */
import { createServer, loadConfigFromFile } from "vite";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const port = Number(process.argv[2] ?? 5198);
const loaded = await loadConfigFromFile(
  { command: "serve", mode: "development" },
  `${root}/vite.web.config.ts`,
  root,
);
if (!loaded) throw new Error("Could not load the web configuration");
const profile = {
  weekly: "none",
  cloud: "cowork,code",
  projects: "some",
  knowledge: "some",
  memory: "generated",
  skills: "some",
  connectors: "1",
  routines: "some",
  artifacts: "1",
  previewTransport: "data",
  environments: "some",
  sidebarWidth: "288",
};
const initialize = `<script>(()=>{const q=new URLSearchParams(location.search);for(const [k,v] of Object.entries(${JSON.stringify(profile)}))if(!q.has(k))q.set(k,v);history.replaceState(history.state,"",location.pathname+"?"+q.toString()+location.hash);})();</script>`;
const entry = {
  name: "claudex-ui-preview",
  configureServer(server: any) {
    server.middlewares.use(async (request: any, response: any, next: any) => {
      // The single-component pages under preview/ are served as they are.
      if (
        request.method !== "GET" ||
        !request.url ||
        request.url.startsWith("/preview/") ||
        !request.headers.accept?.includes("text/html")
      )
        return next();
      try {
        let html = readFileSync(`${root}/web.html`, "utf8");
        if (!html.includes('src="/src-web/main.tsx"'))
          throw new Error("The web entry changed");
        html = html
          .replace(
            'src="/src-web/main.tsx"',
            'src="/scripts/preview/app-preview.tsx"',
          )
          .replace("<head>", "<head>" + initialize);
        response.statusCode = 200;
        response.setHeader("Content-Type", "text/html; charset=utf-8");
        response.setHeader("Cache-Control", "no-store");
        response.end(await server.transformIndexHtml(request.url, html));
      } catch (error) {
        next(error);
      }
    });
  },
};
const config = loaded.config;
const server = await createServer({
  ...config,
  configFile: false,
  root,
  cacheDir: `${root}/node_modules/.vite-ui-preview`,
  plugins: [entry, ...(config.plugins ?? [])],
  server: {
    ...config.server,
    host: "127.0.0.1",
    port,
    strictPort: true,
    proxy: {},
  },
});
await server.listen();
process.stdout.write(
  `${JSON.stringify({ preview: `http://127.0.0.1:${port}/new` })}\n`,
);
const close = async () => {
  await server.close();
  process.exit(0);
};
process.once("SIGINT", close);
process.once("SIGTERM", close);
