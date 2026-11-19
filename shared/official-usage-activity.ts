import { usageTimezone } from './usage-stats-api';

/** Exact readonly activity routes. No payment or account mutation methods. */
export function officialUsageActivityQuery(pathname: string, search: string) {
  const match = /^\/api\/organizations\/([a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12})\/claudex_usage_activity\/(overview|breakdown|records)$/.exec(pathname);
  if (!match) return undefined;
  const params = new URLSearchParams(search);
  const fields = Object.fromEntries(params);
  if ([...params.keys()].length !== Object.keys(fields).length) throw Error('Duplicate query.');
  const kind = match[2];
  const allowed = kind === 'overview' ? [] : kind === 'breakdown' ? ['start','end','granularity'] : ['page','pageSize','start','end','model'];
  if (Object.keys(fields).some(k => k !== 'timezone' && !allowed.includes(k))) throw Error('Unsupported query.');
  const timezone = fields.timezone === undefined ? undefined : usageTimezone(fields.timezone);
  if (fields.timezone !== undefined && timezone === undefined) throw Error('Invalid time zone.');
  const calendar = timezone === undefined ? {} : { timezone };
  const day = (value: string | undefined) => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0,10) === value;
  if (kind === 'overview') return { org: match[1], method: 'usageOverview', args: timezone === undefined ? [] : [calendar] };
  if (!day(fields.start) || !day(fields.end) || fields.start > fields.end) throw Error('Invalid date range.');
  if (kind === 'breakdown') {
    if (!['day','hour'].includes(fields.granularity)) throw Error('Invalid granularity.');
    return { org: match[1], method: 'usageBreakdown', args: [{start:fields.start,end:fields.end,granularity:fields.granularity,...calendar}] };
  }
  if (!/^[1-9]\d{0,5}$/.test(fields.page ?? '') || Number(fields.page)>100000 || !/^[1-9]\d{0,2}$/.test(fields.pageSize ?? '') || Number(fields.pageSize)>100 || (fields.model?.length ?? 0)>200) throw Error('Invalid page.');
  return { org: match[1], method: 'usageRecords', args: [{page:Number(fields.page),pageSize:Number(fields.pageSize),start:fields.start,end:fields.end,...(fields.model ? {model:fields.model}: {}),...calendar}] };
}
