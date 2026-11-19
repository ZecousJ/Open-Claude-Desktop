/** Public fixed shell. Never interpolate artifact data, IDs, tokens or credentials. */
export const staticPreviewShell =
  '<!doctype html><html><head><meta charset="utf-8"><title>Static preview</title></head><body><p id="status">Static preview — scripts, links, forms and network access are disabled.</p><main id="preview"></main></body></html>';
export const staticPreviewShellCsp =
  "default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; img-src 'none'; connect-src 'none'; frame-src about:; object-src 'none'; form-action 'none'; base-uri 'none'; worker-src 'none'; frame-ancestors 'none'";
