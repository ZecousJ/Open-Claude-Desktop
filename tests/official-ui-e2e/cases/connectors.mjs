/**
 * Customize › Connectors: add a public, sign-in-free MCP server as a custom
 * connector, see its tools, turn one off, remove it. The server is DeepWiki's
 * public MCP endpoint (no account, read-only); test connectors are removed
 * afterwards.
 */
import { expect } from "../harness.mjs";

const serverUrl = "https://mcp.deepwiki.com/mcp";
const remoteServers = (client) =>
  client.eval(
    "fetch('/api/organizations/x/mcp/remote_servers_with_connection').then((r) => r.json())",
  );

export const cases = [
  {
    name: "add a custom connector",
    group: "one connector",
    setup: true,
    async run(client, state) {
      state.name = `e2e-deepwiki-${Date.now().toString(36)}`;
      await client.goto("/customize/connectors");
      await client.eval(`(async () => {
        await __e2e.openMenu(() => __e2e.all('button').find((b) => __e2e.visible(b) && b.getAttribute('aria-label') === 'Add connector'));
        await __e2e.clickMenu('Add custom connector');
      })()`);
      await client.waitFor("!!document.querySelector('[role=dialog] input')");
      await client.eval(`(async () => {
        const dialog = document.querySelector('[role=dialog]');
        const field = (label) => [...dialog.querySelectorAll('input')].find((i) => (i.getAttribute('placeholder') || i.getAttribute('aria-label')) === label);
        const set = (el, v) => { el.focus(); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true })); };
        set(field('Name'), ${JSON.stringify(state.name)});
        set(field('MCP server URL'), ${JSON.stringify(serverUrl)});
        await __e2e.sleep(300);
      })()`);
      for (let i = 0; i < 8; i++) {
        const next = await client.waitFor(
          `(() => {
          if (!document.querySelector('[role=dialog]')) return 'closed';
          const b=[...document.querySelectorAll('[role=dialog] button')].find(b=>__e2e.visible(b)&&!b.disabled&&/^(Continue|Continue anyway|Add|Add connector|Connect|Done|Save)$/.test(b.innerText.trim()));
          if(!b)return false;b.dataset.e2eConnectorContinue='1';return 'ready';
        })()`,
          60000,
          500,
        );
        if (next === "closed") break;
        await client.click('[data-e2e-connector-continue="1"]');
        await client.eval("__e2e.sleep(1200)");
      }
      await client.waitFor(
        `fetch('/api/organizations/x/mcp/remote_servers').then((r) => r.json()).then((l) => l.some((s) => s.name === ${JSON.stringify(state.name)}))`,
        30000,
      );
    },
  },
  {
    name: "the connector connects and lists its tools",
    group: "one connector",
    async run(client, state) {
      await client.waitFor(
        `fetch('/api/organizations/x/mcp/remote_servers_with_connection').then((r) => r.json()).then((l) => l.some((s) => s.name === ${JSON.stringify(state.name)} && s.connected && s.tools.length > 0))`,
        60000,
        2000,
      );
      const server = (await remoteServers(client)).find(
        (s) => s.name === state.name,
      );
      state.uuid = server.uuid;
      state.tool = server.tools[0].name;
      await client.goto("/customize/connectors");
      await client.eval(
        "(async () => { const y = await __e2e.waitFor(() => __e2e.all('[role=radio]').find((b) => b.innerText.trim() === 'Yours')); __e2e.press(y); })()",
      );
      await client.waitFor(
        `__e2e.mainText().includes(${JSON.stringify(state.name)}) && /Connected/.test(__e2e.mainText())`,
        20000,
      );
    },
  },
  {
    name: "turn one of its tools off",
    group: "one connector",
    async run(client, state) {
      await client.goto(`/customize/connectors/yours/id/${state.uuid}`);
      const choose = (label) =>
        client.click(
          `[role=radiogroup][aria-label=${JSON.stringify(state.tool)}] [role=radio][aria-label=${JSON.stringify(label)}]`,
        );
      const policy = (value) =>
        `fetch('/api/organizations/x/mcp/remote_servers/${state.uuid}/tool_policies').then(r=>r.json()).then(r=>r.policies.some(t=>t.tool_name===${JSON.stringify(state.tool)}&&t.policy===${JSON.stringify(value)}))`;
      await choose("Blocked");
      await client.waitFor(policy("disabled"), 60000, 1000);
      await client.goto(`/customize/connectors/yours/id/${state.uuid}`);
      await client.waitFor(
        `__e2e.all('[role=radiogroup]').find(e=>e.getAttribute('aria-label')===${JSON.stringify(state.tool)})?.querySelector('[role=radio][aria-label=Blocked]')?.getAttribute('aria-checked')==='true'`,
      );
      await choose("Needs approval");
      await client.waitFor(policy("needs_approval"), 60000, 1000);
    },
  },
  {
    name: "remove the connector",
    group: "one connector",
    async run(client, state) {
      await client.goto(`/customize/connectors/yours/id/${state.uuid}`);
      await client.eval(
        `(async () => { await __e2e.menuOf(${JSON.stringify(`More options for ${state.name}`)}); await __e2e.clickMenu('Remove'); })()`,
      );
      await client.eval(
        "__e2e.clickText('Remove', '[data-cds=ConfirmationDialog] button')",
      );
      await client.waitFor(
        `fetch('/api/organizations/x/mcp/remote_servers').then(r=>r.json()).then(l=>!l.some(s=>s.name===${JSON.stringify(state.name)}))`,
        60000,
        1000,
      );
    },
  },
];

export async function cleanup(client, state) {
  if (!state.name) return;
  // Read this host's connector route, without waiting for the unrelated cloud
  // conversation catalogue. DELETE reconciles the committed config on restart.
  const removed = await client.eval(`(async()=>{
    const read=async()=>{const r=await fetch('/api/organizations/x/mcp/remote_servers');if(!r.ok)throw Error('Connector cleanup read failed: '+r.status);return r.json()};
    const name=${JSON.stringify(state.name)};const before=await read();const row=before.find(s=>s.name===name);
    if(row){const r=await fetch('/api/organizations/x/mcp/remote_servers/'+row.uuid,{method:'DELETE'});if(!r.ok)throw Error('Connector cleanup removal failed: '+r.status)}
    return !(await read()).some(s=>s.name===name);
  })()`);
  expect(removed, "could not remove the test connector from its account");
}
