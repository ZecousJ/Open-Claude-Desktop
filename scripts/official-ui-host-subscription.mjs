/** Claudex has no vendor subscriptions. Presentation-only; never grants entitlements. */
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {hostAuthenticatedExpression} from './official-ui-host-auth.mjs';
export const hostSubscriptionRevision = 'claudex-no-vendor-subscription-v3';
export const hostSubscriptionInputHashes = {
  'shared-8-B9DjIUqu.js':'a74716a18f1a725f0bb178640fdaef2181c1a23ca8896fedfcf3c3fb045c12a1',
  'shared-100-CDJp2jvs.js':'a8b29effd182aaf0426aab56cc6f5361ead4dc54bf81d922b5b9c77c69ef0b19',
  'shared-19-DSOWNXOA.js':'3e664bbb10541d065a9c9d52c30ed3630fab0cedb43b54c431d11731eea66162',
  'shared-46-BL5bnnMV.js':'5346fff90c0bc2e206c6ab634c8a4468bff4c744de20aa2b177c9be0f213f151',
};
export const hostSubscriptionOriginalHashes = {
  'shared-8-B9DjIUqu.js':'4011115b803a0e8a52b5916a9bde4d1829d476e68d1d19ea1634e08b1fdd1497',
  'shared-100-CDJp2jvs.js':'191584d475019a8f5baff8ee60c4227566111cb83bc1ac83d628de4aa29789ff',
  'shared-19-DSOWNXOA.js':'d0a3ff50f9965c90bf9af2f796bbd291034a7e7427bb2f778f0cd0dff2c32aa3',
  'shared-46-BL5bnnMV.js':'38cd4a49ad26e1fe06c1325c1f7ef2f0f81ac8fd4abfaa592e04169763f5a76c',
};
// Reuse the existing host product marker. This is not a capability or billing API gate.
export const noVendorSubscriptionSource = `function __claudexNoVendorSubscription(e) { return ${hostAuthenticatedExpression}; }\n`;
export const subscriptionRouteSource = `function __claudexSubscriptionRoute(original) {
  return function(props) {
    const {account} = ce();
    return __claudexNoVendorSubscription(account)
      ? tT(Q5, {to: "/new", replace: true}) : tT(original, props);
  };
}\n`;
// Resolve only catalog-listed, actually selectable models. Never changes a plan flag.
export const hostModelSubscriptionSource = `function __claudexHostModelIds(account, catalog, vendor) {
  if (!__claudexNoVendorSubscription(account)) return vendor;
  if (!catalog || !Array.isArray(catalog.models) || typeof catalog.isSelectable !== "function") return [];
  return catalog.models.filter(e => e && typeof e.id === "string" && !e.unsupported && !e.disabled && !e.disabled_reason && catalog.isSelectable(e.id) === true).map(e => e.id);
}
function XA(surface) {
  const vendor = __claudexVendorAvailableModels(), {account} = E_(), catalog = X0(surface);
  return __claudexHostModelIds(account, catalog, vendor);
}
function __claudexModelPresentation(account, entry, intl) {
  if (!__claudexNoVendorSubscription(account) || entry?.selection_notice?.cta?.intent !== "upgrade") return entry;
  const {cta, ...notice} = entry.selection_notice;
  return {...entry, selection_notice: {...notice, text: notice.text || entry.disabled_reason?.message || intl?.formatMessage({defaultMessage: "Unsupported model", id: "PCrwsn"})}};
}
`;
export const hostSubscriptionRules = [
  {file:'shared-8-B9DjIUqu.js',name:'host-model-catalog-not-vendor-free-tier',
   before:'  js as XA,',after:'  js as __claudexVendorAvailableModels,'},
  {file:'shared-8-B9DjIUqu.js',name:'host-model-explicit-surface',
   before:'    H = XA(),',after:'    H = XA(e.catalogSurface),'},
  {file:'shared-8-B9DjIUqu.js',name:'host-disabled-model-no-subscription-cta',
   before:'  let P = N,\n    F = !T && (d || f || A || p),',
   after:'  const __host = __claudexNoVendorSubscription(E_().account), __hostSubscriptionBlocked = __host && j;\n  if (__host && j) { A = true; j = false; N = undefined; } else if (__host && (N === "PRO" || N === "MAX")) N = undefined;\n  let P = N,\n    F = !T && (d || f || A || p),'},
  {file:'shared-8-B9DjIUqu.js',name:'host-disabled-model-no-upgrade-tooltip',
   before:'    W = (A && M?.message) || s || O,',
   after:'    W = __hostSubscriptionBlocked ? M?.message || O || gl(gZ, {defaultMessage: "Unsupported model", id: "PCrwsn"}) : (A && M?.message) || s || O,'},
  {file:'shared-8-B9DjIUqu.js',name:'host-catalog-strip-vendor-action-only',
   before:'                            a && o && s.section !== "main" && c({ section: "main" }),\n                            s',
   after:'                            a && o && s.section !== "main" && c({ section: "main" }),\n                            __claudexModelPresentation(ne, s, t)'},
  {file:'shared-100-CDJp2jvs.js',name:'remove-vendor-upgrade-pill',
   before:'    { activeOrganization: d } = ce(),\n    f = Ks(t),',
   after:'    { account: __hostAccount, activeOrganization: d } = ce(),\n    f = Ks(t) && !__claudexNoVendorSubscription(__hostAccount),'},
  {file:'shared-19-DSOWNXOA.js',name:'remove-vendor-upgrade-menu',
   before:'    j = !_ && !v,',after:'    j = !_ && !v && !__claudexNoVendorSubscription(u),'},
  {file:'shared-19-DSOWNXOA.js',name:'hide-host-plan-in-account-trigger',
   before:'    b = i ? void 0 : o ? (m === "raven" ? o.name : (o.plan_display_name ?? tM[m])) : void 0,',
   after:'    b = i || (m !== "raven" && __claudexNoVendorSubscription(a)) ? void 0 : o ? (m === "raven" ? o.name : (o.plan_display_name ?? tM[m])) : void 0,'},
  {file:'shared-46-BL5bnnMV.js',name:'leave-vendor-upgrade-route',
   before:'  qq = sB("UpgradeLayoutRoute"),',after:'  qq = __claudexSubscriptionRoute(sB("UpgradeLayoutRoute")),'},
  {file:'shared-46-BL5bnnMV.js',name:'leave-vendor-downgrade-route',
   before:'path: "downgrade", component: sB("DowngradeLayoutRoute")',
   after:'path: "downgrade", component: __claudexSubscriptionRoute(sB("DowngradeLayoutRoute"))'},
  {file:'shared-46-BL5bnnMV.js',name:'leave-vendor-pricing-route',
   before:'path: "pricing", component: sB("PricingRoute")',
   after:'path: "pricing", component: __claudexSubscriptionRoute(sB("PricingRoute"))'},
];
const sha = value => createHash('sha256').update(value).digest('hex');
export function deriveOfficialUiHostSubscriptionModule(file, source) {
  if(!Object.hasOwn(hostSubscriptionInputHashes,file)) return source;
  if(sha(source)!==hostSubscriptionInputHashes[file]) throw Error('Pinned host-subscription checksum mismatch: '+file);
  let result=source;
  for(const rule of hostSubscriptionRules.filter(rule=>rule.file===file)) {
    const at=result.indexOf(rule.before);
    if(at<0 || result.indexOf(rule.before,at+rule.before.length)>=0) throw Error('Pinned host-subscription anchor mismatch: '+rule.name);
    result=result.slice(0,at)+rule.after+result.slice(at+rule.before.length);
  }
  return noVendorSubscriptionSource+(file==='shared-46-BL5bnnMV.js'?subscriptionRouteSource:'')+(file==='shared-8-B9DjIUqu.js'?hostModelSubscriptionSource:'')+result;
}
export function applyOfficialUiHostSubscription(directory) {
  directory=fs.realpathSync(directory);
  if(directory.split(path.sep).includes('.restore')) throw Error('Recovered sources are immutable');
  const rows=Object.keys(hostSubscriptionInputHashes).map(file=>{
    const location=path.join(directory,file);
    if(fs.lstatSync(location).isSymbolicLink()) throw Error('Subscription output symlink rejected');
    const source=fs.readFileSync(location,'utf8');
    return {file,source,output:deriveOfficialUiHostSubscriptionModule(file,source)};
  });
  for(const row of rows) fs.writeFileSync(path.join(directory,row.file),row.output);
  return {revision:hostSubscriptionRevision,modules:rows.map(row=>({file:row.file,
    originalSha256:hostSubscriptionOriginalHashes[row.file],inputSha256:sha(row.source),outputSha256:sha(row.output),
    rules:hostSubscriptionRules.filter(rule=>rule.file===row.file).map(rule=>rule.name)}))};
}
