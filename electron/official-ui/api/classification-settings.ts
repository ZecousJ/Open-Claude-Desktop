/** Existing Code classification preference, changed only by an explicit native action.
 * Enabling affects future Code sessions and can cause the existing classifier's
 * model usage after a completed turn. Reads never start classification. */
import { preference } from '../../../shared/settings-extras';
import type { AdapterContext } from './context';
import { modelFallbackSettings, modelFallbackWire, type ModelFallbackPatch } from '../../../shared/official-model-fallback';

export const officialClassificationEnabled = (ctx: AdapterContext) =>
  preference(ctx.settings(), 'classifySessionStates');

const failed = (status: number, message: string) => ({
  status,
  body: { type: 'error', error: { type: 'invalid_request_error', message } },
});
export async function saveOfficialClassification(ctx: AdapterContext, body: unknown) {
  if (!body || typeof body !== 'object' || Array.isArray(body) ||
      Object.keys(body).length !== 1 || !Object.hasOwn(body, 'ccr_session_state_buckets') ||
      typeof (body as any).ccr_session_state_buckets !== 'boolean')
    return failed(400, 'Only the boolean session classification preference may be changed.');
  // No new Web capability or general profile write authority is granted.
  if (ctx.readOnly || typeof ctx.localCall !== 'function')
    return failed(403, 'Session classification changes are unavailable on this host.');
  let owner: string | undefined, activation: unknown;
  try { owner = ctx.account()?.id; activation = ctx.sessionIdentity?.(); }
  catch { return failed(409, 'The account activation changed. Reopen settings.'); }
  if (!owner) return failed(401, 'Sign in to change session classification.');
  const current = () => {
    try { return activation != null && activation !== '' && ctx.account()?.id === owner &&
      ctx.sessionIdentity?.() === activation && ctx.isCurrent?.() === true; }
    catch { return false; }
  };
  if (!current()) return failed(409, 'The account activation changed. Reopen settings.');
  const enabled = (body as {ccr_session_state_buckets: boolean}).ccr_session_state_buckets;
  try {
    const settings = ctx.settings();
    if (!current()) return failed(409, 'The account activation changed. Reopen settings.');
    // An already effective choice is an idempotent acknowledgement, not a save.
    // This also preserves an absent value whose existing product default is true.
    if (preference(settings, 'classifySessionStates') === enabled)
      return {status: 200, body: {ccr_session_state_buckets: enabled}};
    // Reuse native saveSettings validation, policy, integration and synchronous
    // local Store flush. Do not write the adapter preference bucket or call a model.
    await ctx.localCall('saveSettings', {...settings, classifySessionStates: enabled});
    if (!current() || officialClassificationEnabled(ctx) !== enabled)
      return failed(409, 'Settings changed while saving. Reload to confirm the result.');
    return {status: 200, body: {ccr_session_state_buckets: enabled}};
  } catch {
    return current()
      ? failed(503, 'The setting could not be confirmed. Reload settings before retrying.')
      : failed(409, 'The account activation changed. Reopen settings.');
  }
}

/** Existing Code-only safeguard preference; saving does not retry a turn. */
export const officialCodeFlaggedSwitchEnabled = (ctx: AdapterContext) =>
  preference(ctx.settings(), 'switchModelsOnFlag');
export async function saveOfficialCodeFlaggedSwitch(ctx: AdapterContext, body: unknown) {
  if (!body || typeof body !== 'object' || Array.isArray(body) ||
      Object.keys(body).length !== 1 || !Object.hasOwn(body, 'ccr_switch_models_on_flag') ||
      typeof (body as any).ccr_switch_models_on_flag !== 'boolean')
    return failed(400, 'Only the boolean session Code model switching preference may be changed.');
  // No new Web capability or general profile write authority is granted.
  if (ctx.readOnly || typeof ctx.localCall !== 'function')
    return failed(403, 'Session Code model switching changes are unavailable on this host.');
  let owner: string | undefined, activation: unknown;
  try { owner = ctx.account()?.id; activation = ctx.sessionIdentity?.(); }
  catch { return failed(409, 'The account activation changed. Reopen settings.'); }
  if (!owner) return failed(401, 'Sign in to change session Code model switching.');
  const current = () => {
    try { return activation != null && activation !== '' && ctx.account()?.id === owner &&
      ctx.sessionIdentity?.() === activation && ctx.isCurrent?.() === true; }
    catch { return false; }
  };
  if (!current()) return failed(409, 'The account activation changed. Reopen settings.');
  const enabled = (body as {ccr_switch_models_on_flag: boolean}).ccr_switch_models_on_flag;
  try {
    const settings = ctx.settings();
    if (!current()) return failed(409, 'The account activation changed. Reopen settings.');
    // An already effective choice is an idempotent acknowledgement, not a save.
    // This also preserves an absent value whose existing product default is true.
    if (preference(settings, 'switchModelsOnFlag') === enabled)
      return {status: 200, body: {ccr_switch_models_on_flag: enabled}};
    // Reuse native saveSettings validation, policy, integration and synchronous
    // local Store flush. Do not write the adapter preference bucket or call a model.
    await ctx.localCall('saveSettings', {...settings, switchModelsOnFlag: enabled});
    if (!current() || officialCodeFlaggedSwitchEnabled(ctx) !== enabled)
      return failed(409, 'Settings changed while saving. Reload to confirm the result.');
    return {status: 200, body: {ccr_switch_models_on_flag: enabled}};
  } catch {
    return current()
      ? failed(503, 'The setting could not be confirmed. Reload settings before retrying.')
      : failed(409, 'The account activation changed. Reopen settings.');
  }
}

export async function saveOfficialModelFallback(ctx: AdapterContext, change: ModelFallbackPatch) {
  if (ctx.readOnly || !ctx.localCall) return failed(403, "Model fallback changes are unavailable on this host.");
  const owner = ctx.account()?.id;
  const activation = ctx.sessionIdentity?.();
  const current = () => !!owner && activation != null && activation !== "" &&
    ctx.isCurrent?.() === true && ctx.account()?.id === owner && ctx.sessionIdentity?.() === activation;
  if (!current()) return failed(409, "The account activation changed. Reopen settings.");
  const settings = ctx.settings();
  if (change.kind === "code" && preference(settings, "modelAutoFallback") !== change.companion)
    return failed(409, "Model fallback settings changed. Reload settings before saving.");
  const patch = modelFallbackSettings(change);
  const saved = () => Object.entries(patch).every(([key, value]) => ctx.settings()[key as keyof typeof settings] === value);
  try {
    if (!saved()) await ctx.localCall("saveSettings", { ...settings, ...patch });
    if (!current() || !saved()) return failed(409, "Settings changed while saving. Reload to confirm the result.");
    return { status: 200, body: modelFallbackWire(change) };
  } catch {
    return current()
      ? failed(503, "The model fallback setting could not be confirmed.")
      : failed(409, "The account activation changed. Reopen settings.");
  }
}
