/** Real readonly activity adapter; immutable account/activation throughout each query. */
import type http from 'node:http';
import { officialUsageActivityQuery } from '../../../shared/official-usage-activity';
import { organizationUuid, reply, type AdapterContext } from './context';
export async function usageActivityRoute(req: http.IncomingMessage, res: http.ServerResponse, p: string, url: URL, ctx: AdapterContext) {
  if (!/\/claudex_usage_activity\//.test(p)) return false;
  let query;
  try { query = officialUsageActivityQuery(p,url.search); } catch { return reply(res,{error:'Invalid usage query.'},400); }
  if (!query) return false;
  if (req.method !== 'GET') return reply(res,{error:'Read-only endpoint'},405,{Allow:'GET'});
  const owner=ctx.account()?.id, activation=ctx.sessionIdentity?.();
  if (!owner) return reply(res,{error:'Sign in to continue.'},401);
  if (query.org !== organizationUuid(owner)) return reply(res,{error:'Not found.'},404);
  const current=()=>activation !== undefined && activation !== null && ctx.account()?.id===owner && ctx.sessionIdentity?.()===activation && ctx.isCurrent?.()!==false;
  if (!current()) return reply(res,{error:'Account activation changed'},409);
  try {
    const result=await ctx.call(query.method,...query.args);
    if (!current()) return reply(res,{error:'Account activation changed'},409);
    if (result === null || result === undefined) return reply(res,{error:'Usage is unavailable for this account.'},503);
    if (Buffer.byteLength(JSON.stringify(result))>512*1024) throw Error('Too large');
    return reply(res,{account_uuid:owner,organization_uuid:query.org,data:result});
  } catch {
    return reply(res,{error:current()?'Usage could not be read.':'Account activation changed'},current()?503:409);
  }
}
