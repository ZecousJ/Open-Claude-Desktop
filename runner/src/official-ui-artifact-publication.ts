import { HostedShares } from '../../electron/artifacts/hosted-shares';
import { ClaudexSharing } from '../../electron/sub2api/claudex-sharing';
import type { WebAppContext } from './web-app-context';

/** One publication cache per authenticated runner activation. */
export function webArtifactPublication(ctx: WebAppContext) {
  const api = new ClaudexSharing(ctx.runtime.serviceUrl, ctx.runtime.fetch);
  const { session, store } = ctx;
  const identity = ctx.officialSessionIdentity();
  const current = () => !ctx.closedFlag && !ctx.signedOut &&
    ctx.officialSessionIdentity() === identity && ctx.store === store && ctx.session === session;
  const call = <T>(fn: (token: string) => Promise<T>) => session.authorized(async token => {
    if (!current()) throw Error('The account activation changed.');
    const result = await fn(token);
    if (!current()) throw Error('The account activation changed.');
    return result;
  });
  const host = new HostedShares({
    root: store.root,
    conversation: id => store.conversations.find(c => c.id === id),
    changed: () => { if (current()) ctx.push({type: 'resync'}); },
    service: {
      status: () => call(token => api.status(token)),
      list: kind => call(token => api.list(token, kind)),
      create: body => call(token => api.create(token, body)),
      revoke: id => call(token => api.revoke(token, id)),
      setAccess: (id, access) => call(token => api.setAccess(token, id, access)),
      invite: (id, email, options) => call(token => api.invite(token, id, email, options)),
      uninvite: (id, email) => call(token => api.uninvite(token, id, email)),
      sharedWithMe: () => call(token => api.sharedWithMe(token)),
      readShared: id => call(token => api.readShared(token, id)),
      reportShared: (id, report) => call(token => api.reportShared(token, id, report)),
    },
  });
  ctx.onAccountDeactivating(() => host.close());
  return host;
}
