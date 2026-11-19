/** package.json version, injected by vite.config.ts. */
declare const __APP_VERSION__: string;
/** Script text of a sandboxed preview runtime (scripts/vite-preview-runtimes.ts). */
declare module "virtual:preview-runtime/*" {
  const source: string;
  export default source;
}
