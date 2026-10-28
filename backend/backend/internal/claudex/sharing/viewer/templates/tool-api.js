// (live claude.ai bundle, 2026-10-14, frame-shell-broker-RIN4pYaE.js): MCP list, describe and call APIs.
(() => {
  let sequence = 0;
  const pending = new Map();
  addEventListener('message', (event) => {
    const data = event.data;
    if (event.source !== parent || data?.type !== 'claudex-artifact-tool-result' || !pending.has(data.id)) return;
    const task = pending.get(data.id);
    pending.delete(data.id);
    clearTimeout(task.timer);
    typeof data.error === 'string' ? task.reject(new Error(data.error)) : task.resolve(data.result);
  });
  const request = (method, args) => new Promise((resolve, reject) => {
    if (pending.size >= 16) return reject(new Error('The request failed.'));
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('The request failed.')); }, 300000);
    pending.set(id, { resolve, reject, timer });
    parent.postMessage({ type: 'claudex-artifact-tool', id, method, args }, '*');
  });
  const mcp = {
    listTools: () => request('listTools', []),
    serverTools: (server) => request('serverTools', [server]),
    describeTool: (server, tool) => request('describeTool', [server, tool]),
    callTool: (server, tool, input = {}, options = {}) => request('callTool', [server, tool, input, options]),
  };
  window.claude = Object.assign(window.claude || {}, { mcp });
  window.mcp = mcp;
})();
