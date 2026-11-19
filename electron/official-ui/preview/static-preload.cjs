// Dedicated isolated top-frame preload. No contextBridge, renderer API or application shim.
const { ipcRenderer } = require('electron');
const shell = process.argv.find(value => value.startsWith('--claudex-static-preview-shell='))?.slice('--claudex-static-preview-shell='.length);
if (process.isMainFrame && typeof shell === 'string' && /^http:\/\/127\.0\.0\.1:[0-9]+\/$/.test(shell) && location.href === shell) {
  let live = true, port, frame;
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const nonce = Array.from(bytes, x => x.toString(16).padStart(2, '0')).join('');
  const retire = () => {
    if (!live) return;
    live = false;
    if (port) { port.onmessage = null; port.close(); }
    if (frame) frame.remove();
    const status = document.getElementById('status');
    if (status) status.textContent = 'Static preview is no longer available. Close this window and open a new preview.';
  };
  ipcRenderer.on('claudex-static-preview-retire', retire);
  ipcRenderer.on('claudex-static-preview-bind', (event, value) => {
    const offered = event.ports || [];
    if (!live || port || !value || Object.keys(value).length !== 1 || value.nonce !== nonce || offered.length !== 1) {
      for (const p of offered) p.close();
      retire(); return;
    }
    port = offered[0];
    port.onmessage = event => {
      const value = event.data;
      if (!live || frame || !value || Object.keys(value).length !== 3 || value.type !== 'render' || value.nonce !== nonce || typeof value.document !== 'string' || new TextEncoder().encode(value.document).length > 1100000) { retire(); return; }
      const target = document.getElementById('preview');
      if (!target) { retire(); return; }
      frame = document.createElement('iframe');
      frame.setAttribute('sandbox', '');
      frame.setAttribute('referrerpolicy', 'no-referrer');
      frame.setAttribute('title', 'Static artifact');
      frame.width = '100%'; frame.height = '600';
      frame.srcdoc = value.document;
      target.append(frame);
    };
    port.start();
    port.postMessage({type:'ack', nonce});
  });
  addEventListener('pagehide', retire, {once:true});
  addEventListener('hashchange', retire, {once:true});
  addEventListener('popstate', retire, {once:true});
  addEventListener('DOMContentLoaded', () => { if (live) ipcRenderer.send('claudex-static-preview-ready', {nonce}); }, {once:true});
}
