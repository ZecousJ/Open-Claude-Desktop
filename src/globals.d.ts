/** package.json version, injected by vite.config.ts. */
declare const __APP_VERSION__: string;
/** Script text of a sandboxed preview runtime. */
declare module "virtual:preview-runtime/*" {
  const source: string;
  export default source;
}
