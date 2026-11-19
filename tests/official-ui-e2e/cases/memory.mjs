/** Real memory preferences, with the test account's choices restored. */
import { expect } from "../harness.mjs";
const settingsPath = "/api/organizations/x/memory/settings";
const searchSwitch = `__e2e.all('[role=switch]').find(e => __e2e.visible(e) && (e.getAttribute('aria-label') === 'Search and reference chats' || (e.getAttribute('aria-labelledby') || '').split(/\\s+/).some(id => document.getElementById(id)?.textContent.trim() === 'Search and reference chats')))`;
const openMemory = async (client) => {
  await client.goto("/new");
  // /new can restore the last Code surface; open settings after that redirect.
  await client.eval("(location.hash = '#settings/memory', true)");
  await client.waitFor(`!!${searchSwitch}`);
};

export const cases = [
  {
    name: "memory settings reflect the engine's preferences",
    group: "memory preferences",
    setup: true,
    async run(client, state) {
      const result = await client.api(settingsPath);
      expect(
        result.status === 200,
        `memory settings answered ${result.status}`,
      );
      state.original = result.body;
      await openMemory(client);
      const value = await client.eval(
        `(${searchSwitch}).getAttribute('aria-checked') === 'true'`,
      );
      expect(
        value === state.original.enabled_saffron_search,
        "search switch differs from the engine's preference",
      );
    },
  },
  {
    name: "change chat search through its switch and reopen settings",
    group: "memory preferences",
    async run(client, state) {
      await client.eval(`(${searchSwitch}).click()`);
      const expected = !state.original.enabled_saffron_search;
      await client.waitFor(
        `fetch(${JSON.stringify(settingsPath)}).then(r=>r.json()).then(s=>s.enabled_saffron_search === ${expected})`,
        30000,
      );
      await openMemory(client);
      await client.waitFor(
        `(${searchSwitch})?.getAttribute('aria-checked') === ${JSON.stringify(String(expected))}`,
      );
    },
  },
  {
    name: "restore chat search through its switch",
    group: "memory preferences",
    async run(client, state) {
      await client.eval(`(${searchSwitch}).click()`);
      await client.waitFor(
        `fetch(${JSON.stringify(settingsPath)}).then(r=>r.json()).then(s=>s.enabled_saffron_search === ${state.original.enabled_saffron_search})`,
        30000,
      );
    },
  },
];

export async function cleanup(client, state) {
  if (state.original) {
    const result = await client.api(settingsPath, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        enabled_saffron_search: state.original.enabled_saffron_search,
      }),
    });
    expect(
      result.status === 200,
      "could not restore the test account's chat search choice",
    );
  }
}
