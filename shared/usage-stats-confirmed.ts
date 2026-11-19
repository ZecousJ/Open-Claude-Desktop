/** Read-only accounting validation before legacy DTO normalization; missing money is not zero. */
import { overviewFrom, breakdownFrom, recordsFrom } from './usage-stats-api';
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Error('Invalid usage response.');
  return value as Record<string, unknown>;
}
function amounts(row: Record<string, unknown>, fields: string[]) {
  for (const field of fields) {
    const value = row[field];
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0)
      throw Error('Usage costs could not be read.');
  }
}
function list(value: unknown, limit?: number): Record<string, unknown>[] {
  if (!Array.isArray(value) || (limit !== undefined && value.length > limit)) throw Error('Invalid usage response.');
  return value.map(object);
}
export function confirmedUsageOverview(stats: unknown, quotas: unknown) {
  const s = object(stats);
  amounts(s, ['total_actual_cost', 'today_actual_cost', 'total_cost', 'today_cost']);
  if (s.by_platform !== undefined)
    for (const p of list(s.by_platform, 200)) amounts(p, ['total_actual_cost', 'today_actual_cost']);
  if (quotas !== undefined && quotas !== null) {
    const q = object(quotas);
    if (q.platform_quotas !== undefined) for (const row of list(q.platform_quotas, 200)) {
      for (const window of ['daily', 'weekly', 'monthly']) {
        const limit = row[`${window}_limit_usd`];
        // Explicit null/absent limit means no displayed window in the existing API.
        if (limit === null || limit === undefined) continue;
        amounts(row, [`${window}_limit_usd`, `${window}_usage_usd`]);
      }
    }
  }
  return overviewFrom(s, quotas);
}
export function confirmedUsageBreakdown(trend: unknown, models: unknown) {
  for (const p of list(object(trend).trend)) amounts(p, ['actual_cost', 'cost']);
  for (const m of list(object(models).models, 200)) amounts(m, ['actual_cost', 'cost']);
  return breakdownFrom(trend, models);
}
export function confirmedUsageRecords(raw: unknown) {
  const page = object(raw);
  for (const key of ['total', 'page', 'pages']) {
    const n = page[key];
    if (!Number.isSafeInteger(n) || (n as number) < (key === 'total' ? 0 : 1)) throw Error('Invalid usage page.');
  }
  for (const r of list(page.items, 100)) {
    if (!Number.isSafeInteger(r.id) || typeof r.model !== 'string' || !r.model ||
        typeof r.created_at !== 'string' || !Number.isFinite(Date.parse(r.created_at)))
      throw Error('Invalid usage record.');
    amounts(r, ['actual_cost', 'total_cost', 'input_cost', 'output_cost', 'cache_read_cost', 'cache_creation_cost']);
    // Image cost fields predate some text-only services; absence is allowed only without images.
    if (r.image_count !== undefined && r.image_count !== 0)
      amounts(r, ['image_input_cost', 'image_output_cost']);
    else for (const key of ['image_input_cost', 'image_output_cost']) if (r[key] !== undefined) amounts(r, [key]);
  }
  return recordsFrom(raw);
}
