/**
 * The Claudex service a build points at when nothing else chose one. A
 * build sets it with the CLAUDEX_SERVICE_URL environment variable (the
 * build scripts define `__CLAUDEX_SERVICE_URL__`); without it a build has
 * none, and the desktop asks for the service's address on its sign-in page.
 * People and operators still choose any other service with
 * `backend/sub2api.json` or `CLAUDEX_SUB2API_URL`.
 */
declare const __CLAUDEX_SERVICE_URL__: string | undefined;

export const defaultClaudexServiceUrl: string =
  typeof __CLAUDEX_SERVICE_URL__ === "string" ? __CLAUDEX_SERVICE_URL__ : "";
