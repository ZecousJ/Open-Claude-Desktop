// (live claude.ai bundle, 2026-10-14, frame-shell-chrome-B45f-YAC.js): tool-approval-set and artifact Permissions.
(() => {
  const frame = document.querySelector('.full-frame');
  const dialog = document.querySelector('[data-artifact-tools]');
  const permissions = document.querySelector('[data-artifact-permissions]');
  if (!frame || !dialog || !permissions) return;
  const messages = JSON.parse(document.querySelector('[data-install-messages]').textContent);
  const locale = navigator.languages?.find((language) => messages[language]) || navigator.language;
  const text = (value, values = {}) => (messages[locale]?.[value] || value).replace(/\{(\w+)\}/g, (match, name) => Object.hasOwn(values, name) ? String(values[name]) : match);
  const identity = 'published:' + location.pathname;
  const tab = crypto.randomUUID();
  const queue = [];
  const inFlight = new Set();
  const pending = new Set();
  let credential, restoring, decision, busy = false;
  let disarm = () => {};
  const node = (tag, value, className) => {
    const element = document.createElement(tag);
    if (value !== undefined) element.textContent = value;
    if (className) element.className = className;
    return element;
  };
  const escape = (value) => String(value).replace(/[\p{Cc}\p{Cf}\p{Co}\p{Default_Ignorable_Code_Point}\u2028\u2029]/gu, (character) => `\\u${character.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}`);
  const quote = (value) => {
    const points = [...escape(value.replace(/[\uD800-\uDFFF]/gu, '�'))];
    return `“⁨${points.length > 128 ? points.slice(0, 127).join('') + '…' : points.join('')}⁩”`;
  };
  async function session() {
    if (credential && credential.until > Date.now()) return credential.token;
    if (!restoring) restoring = (async () => {
      let account;
      try { account = sessionStorage.getItem('claudex-web-account') || localStorage.getItem('claudex-web-last-account'); } catch {}
      if (account === '-') throw Object.assign(new Error(text('The request failed.')), { signIn: true });
      const response = await fetch('/api/v1/claudex/web/auth/refresh', {
        method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', 'X-Claudex-Web': '1', 'X-Claudex-Client': 'web' },
        body: JSON.stringify(account ? { account } : {}),
      });
      const body = await response.json();
      if (!response.ok || typeof body.data?.access_token !== 'string') throw Object.assign(new Error(text('The request failed.')), { signIn: response.status === 401 });
      credential = { token: body.data.access_token, until: Date.now() + Math.max(0, body.data.expires_in * 1000 - 30000) };
      return credential.token;
    })().finally(() => { restoring = undefined; });
    return restoring;
  }
  async function rpc(method, ...args) {
    const token = await session();
    const response = await fetch('/api/v1/claudex/web/rpc/' + method, {
      method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token, 'X-Claudex-Client': 'web', 'X-Claudex-Web-Tab': tab },
      body: JSON.stringify({ args }),
    });
    const body = await response.json();
    if (!response.ok || body.ok !== true) {
      if (response.status === 401) credential = undefined;
      throw Object.assign(new Error(text('The request failed.')), { signIn: response.status === 401 });
    }
    return body.value;
  }
  const button = (label, action, primary = false) => {
    const element = node('button', text(label), primary ? 'button primary' : 'button');
    element.addEventListener('click', action);
    return element;
  };
  function close() { disarm(); dialog.close(); decision = undefined; showNext(); }
  function arm(controls) {
    let ready = false;
    const pointers = new Set();
    const update = (value) => { ready = value; for (const control of controls) control.disabled = !value; };
    const check = () => {
      if (pointers.size || document.activeElement?.tagName === 'IFRAME') { timer = setTimeout(check, 500); return; }
      update(true);
    };
    let timer = setTimeout(check, 500);
    const reset = () => { update(false); clearTimeout(timer); timer = setTimeout(check, 500); };
    const event = (event) => {
      if (event.type === 'pointerdown') pointers.add(event.pointerId);
      else if (event.type === 'pointerup' || event.type === 'pointercancel') { if (!pointers.delete(event.pointerId)) { reset(); return; } }
      else if (event.type === 'pointermove' && event.buttons === 0) { pointers.delete(event.pointerId); return; }
      if (!ready) reset();
    };
    const controller = new AbortController();
    for (const name of ['pointerdown', 'pointerup', 'pointercancel', 'pointermove', 'keydown', 'wheel']) document.addEventListener(name, event, { capture: true, passive: name === 'wheel' || name === 'pointermove', signal: controller.signal });
    document.addEventListener('visibilitychange', () => { if (!document.hidden) reset(); }, { signal: controller.signal });
    update(false);
    disarm = () => { clearTimeout(timer); controller.abort(); };
  }
  function layout(title, description, server) {
    dialog.replaceChildren();
    const header = node('div', undefined, 'tool-header');
    const heading = node('h2', title);
    heading.id = 'artifact-tool-title';
    const dismiss = button('Close', () => { if (!busy) decision ? decision(false) : close(); });
    dismiss.className = 'tool-close';
    dismiss.setAttribute('aria-label', text('Close'));
    dismiss.textContent = '×';
    if (server) {
      const label = node('div', undefined, 'tool-title');
      const icon = node('span', [...escape(server)][0]?.toUpperCase() || '?', 'tool-connector');
      icon.setAttribute('aria-hidden', 'true');
      label.append(icon, heading); header.append(label, dismiss);
    } else header.append(heading, dismiss);
    dialog.append(header);
    if (description) dialog.append(node('p', description, 'tool-description'));
  }
  function signIn() {
    if (decision) return;
    layout(text('This artifact uses connectors'), text('If you trust this artifact, you can grant it access to communicate with outside services.'));
    const link = node('a', text('Sign in'), 'button primary');
    link.href = '/'; link.target = '_blank'; link.rel = 'noopener noreferrer';
    dialog.append(link, button('Done', close));
    if (!dialog.open) dialog.showModal();
  }
  function showNext() {
    if (dialog.open || !queue.length) return;
    const { request, answer } = queue.shift();
    const count = request.groups.reduce((total, group) => total + group.tools.length, 0);
    layout(count === 1 ? text('Let this artifact run these 1 tool?') : text('Let this artifact run these {count} tools?', { count }), request.groups.length === 1
      ? text('These tools are from {connector}. Claudex may decide when this artifact runs them. After you allow them, this artifact can run them without asking.', { connector: quote(request.groups[0].server) })
      : text('Claudex may decide when this artifact runs these tools. After you allow them, this artifact can run them without asking.'), request.server);
    const body = node('div', undefined, 'tool-body');
    const list = node('div', undefined, 'tool-list');
    list.setAttribute('role', 'region'); list.setAttribute('aria-label', text('Tools to allow')); list.tabIndex = 0;
    for (const group of request.groups) {
      const section = node('div', undefined, 'tool-group');
      if (request.groups.length > 1) section.append(node('div', text('From {connector}', { connector: quote(group.server) })));
      const tools = node('ul');
      for (const tool of group.tools) { const item = node('li', escape(tool)); item.dir = 'ltr'; tools.append(item); }
      section.append(tools); list.append(section);
    }
    const input = JSON.stringify(request.input, null, 2).replace(/[\p{Cc}\p{Cf}\p{Co}\p{Default_Ignorable_Code_Point}\u2028\u2029]/gu, (character) => character === '\n' ? character : escape(character));
    const shortened = input.length > 20000;
    const argumentsLabel = text('This time it will run {tool} and send', { tool: quote(request.tool) });
    const args = node('div', undefined, 'tool-input');
    args.append(node('div', argumentsLabel));
    if (shortened) args.append(node('p', text('Only the start is shown. All of it will be sent.')));
    if (!Object.keys(request.input).length) args.append(node('p', text('Nothing — this call has no arguments.')));
    else {
      const cutoff = /[\uD800-\uDBFF]/.test(input[1999] || '') ? 1999 : 2000;
      const preview = node('div', undefined, 'tool-args');
      preview.dir = 'ltr'; preview.tabIndex = 0; preview.setAttribute('role', 'region'); preview.setAttribute('aria-label', argumentsLabel);
      const entries = Object.entries(request.input);
      const identities = new Set();
      let readable = !shortened && entries.length <= 64;
      const rows = entries.map(([key, value]) => {
        const words = key.replace(/([a-z0-9])([A-Z])/g, '$1 $2').split('_').join(' ').toLowerCase();
        const label = words.charAt(0).toUpperCase() + words.slice(1);
        const identity = label.toLowerCase().replace(/ /g, '').replace(/0/g, 'o').replace(/[1i]/g, 'l').replace(/cl/g, 'd').replace(/rn/g, 'm').replace(/vv/g, 'w');
        if (!/^[a-z][a-z0-9]*(?:(?:_[a-z0-9]+)*|(?:[A-Z][a-z0-9]+)*)$/.test(key) || label.length > 32 || label.split(' ').length > 4 || identities.has(identity)) readable = false;
        identities.add(identity);
        const serialized = JSON.stringify(value, null, 2).replace(/[\p{Cc}\p{Cf}\p{Co}\p{Default_Ignorable_Code_Point}\u2028\u2029]/gu, (character) => character === '\n' ? character : escape(character));
        return { label, text: serialized, stacked: serialized.includes('\n') || serialized.length > 45 || label.length > 18 };
      });
      if (readable) {
        const description = node('dl');
        for (const row of rows) { const item = node('div', undefined, row.stacked ? 'stacked' : ''); item.append(node('dt', row.label), node('dd', row.text)); description.append(item); }
        preview.append(description);
      } else preview.append(node('pre', shortened ? input.slice(0, cutoff) : input));
      args.append(preview);
    }
    body.append(list, args); dialog.append(body);
    const footer = node('div', undefined, 'tool-footer');
    let decided = false;
    const decide = async (allow) => {
      if (busy || decided) return;
      decided = true;
      busy = true;
      for (const control of dialog.querySelectorAll('button')) control.disabled = true;
      pending.delete(request.id);
      busy = false;
      close();
      try { answer({ result: await rpc('respondArtifactTool', request.id, allow) }); }
      catch { answer({ error: text('The request failed.') }); }
    };
    decision = decide;
    const cancel = button('Cancel', () => decide(false));
    const allow = button('Allow', () => decide(true), true);
    footer.append(cancel, allow); dialog.append(footer); dialog.showModal(); dialog.focus();
    arm([cancel, allow]);
  }
  dialog.addEventListener('cancel', (event) => { event.preventDefault(); if (!busy) decision ? decision(false) : close(); });
  permissions.textContent = text('Permissions');
  permissions.addEventListener('click', async () => {
    if (dialog.open) return;
    layout(text('Permissions'));
    dialog.showModal();
    try {
      const groups = await rpc('artifactToolPermissions', identity);
      if (!dialog.open || decision) return;
      dialog.append(node('h3', text('Connectors')));
      for (const group of groups) {
        const row = node('div', undefined, 'tool-permission-row');
        row.append(node('span', escape(group.server)), button('Remove', async () => {
          try { await rpc('revokeArtifactTools', identity, group.server); row.remove(); } catch { row.append(node('p', text('The request failed.'))); }
        }));
        dialog.append(row);
      }
      dialog.append(button('Done', close, true));
    } catch (error) { if (error.signIn) signIn(); else if (dialog.open && !decision) dialog.append(node('p', text('The request failed.')), button('Done', close, true)); }
  });
  addEventListener('message', async (event) => {
    const data = event.data;
    if (event.source !== frame.contentWindow || data?.type !== 'claudex-artifact-tool' || !Number.isSafeInteger(data.id) || !Array.isArray(data.args) || inFlight.has(data.id) || inFlight.size >= 16) return;
    inFlight.add(data.id);
    const target = frame.contentWindow;
    const answer = (value) => {
      inFlight.delete(data.id);
      if (target === frame.contentWindow) target.postMessage({ type: 'claudex-artifact-tool-result', id: data.id, ...value }, '*');
    };
    try {
      if (['listTools', 'serverTools', 'describeTool'].includes(data.method)) {
        const groups = await rpc('artifactTools');
        const server = groups.find((group) => group.server === data.args[0]);
        answer({ result: data.method === 'listTools' ? { servers: groups.map((group) => ({ ...group, authStatus: 'connected' })) } : data.method === 'serverTools' ? server : server?.tools.find((tool) => tool.name === data.args[1]) });
      } else if (data.method === 'callTool') {
        const [server, tool, input, options] = data.args;
        const request = await rpc('requestArtifactTool', identity, { server, tool, input, ...(Array.isArray(options?.groups) ? { groups: options.groups } : {}) });
        if (request.permitted) answer({ result: await rpc('respondArtifactTool', request.id, true) });
        else { pending.add(request.id); queue.push({ request, answer }); showNext(); }
      } else throw new Error();
    } catch (error) { answer({ error: text('The request failed.') }); if (error.signIn) signIn(); }
  });
  addEventListener('pagehide', () => { for (const id of pending) void rpc('respondArtifactTool', id, false).catch(() => {}); });
})();
