/**
 * The Claudex service a build points at when nothing else chose one: the
 * address the ZecousAI handoff (shared/zecous-handoff.ts, used by Claudex
 * and by the Windows bridge in tools/zecous-bridge) writes into
 * `backend/sub2api.json`. This is the one place to change it for a build;
 * operators still choose any other service with `backend/sub2api.json` or
 * `CLAUDEX_SUB2API_URL`.
 */
export const defaultClaudexServiceUrl = "https://claudex.zecous.cn";
