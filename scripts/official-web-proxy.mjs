/** Reuse Node's already configured environment-aware Agent for the existing dev proxy. */
export function officialWebProxy(server, env, agents, policy) {
  if (env.NODE_USE_ENV_PROXY !== '1') return server;
  const proxy = Object.fromEntries(Object.entries(server?.proxy ?? {}).map(([key, value]) => {
    if (!value || typeof value !== 'object' || typeof value.target !== 'string') return [key,value];
    const target = new URL(value.target);
    if (!['http:','https:'].includes(target.protocol)) throw Error('Unsupported dev API target.');
    if (value.secure === false) throw Error('Development API certificate verification must remain enabled.');
    const configured = {...value,agent:target.protocol==='https:'?agents.https:agents.http};
    if (key === '/api' && policy) configured.configure = earlyApiHeaders(value.target, policy);
    return [key, configured];
  }));
  return {...server,proxy};
}

/** Same existing loopback policy, applied before HTTP request construction.
 * Node's environment Agent can flush headers before http-proxy's socket event.
 * Never use that late proxyReq event to mutate headers. */
export function earlyApiHeaders(target, {devApiOrigin, devRequestCookies, devResponseCookie}) {
  return (proxy) => {
    const trusted = new WeakSet();
    const originFor = request => devApiOrigin(target, request.headers.origin,
      request.headers.host, request.headers['sec-fetch-site']);
    proxy.on('start', (request) => {
      const origin = originFor(request);
      if (!origin) return;
      trusted.add(request);
      request.headers.origin = origin;
      if (request.headers.cookie) request.headers.cookie = devRequestCookies(request.headers.cookie);
    });
    // Vite emits this synchronously after construction, before ending the upgrade.
    proxy.on('proxyReqWs', (upstream, request) => {
      const origin = originFor(request);
      if (!origin) return;
      if (upstream.headersSent) { upstream.destroy(new Error('Dev WebSocket headers already sent.')); return; }
      upstream.setHeader('Origin', origin);
      if (request.headers.cookie) upstream.setHeader('Cookie', devRequestCookies(request.headers.cookie));
    });
    proxy.on('proxyRes', (response, request) => {
      if (!trusted.has(request)) return;
      trusted.delete(request);
      const cookies = response.headers['set-cookie'];
      if (cookies) response.headers['set-cookie'] = cookies.map(devResponseCookie);
    });
  };
}
