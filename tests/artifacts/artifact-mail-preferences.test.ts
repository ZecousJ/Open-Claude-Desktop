import test from "node:test";
import assert from "node:assert/strict";
import { ClaudexSharing } from "../../electron/sub2api/claudex-sharing";
import type { Fetch } from "../../electron/sub2api/http";

test("the account's artifact e-mails are read and changed on the service", async () => {
  const calls: { url: string; method?: string; body?: unknown }[] = [];
  const prefs = { mentions: true, comments: true, shares: true };
  const fetchImpl: Fetch = async (url, init) => {
    calls.push({ url: String(url), method: init?.method, body: init?.body });
    if (init?.method === "PATCH")
      Object.assign(prefs, JSON.parse(String(init.body)));
    return Response.json({ code: 0, data: prefs });
  };
  const service = new ClaudexSharing("https://claudex.test", fetchImpl);
  assert.deepEqual(await service.mailPreferences("signed-in"), prefs);
  assert.deepEqual(
    await service.setMailPreferences("signed-in", { shares: false }),
    { mentions: true, comments: true, shares: false },
  );
  assert.deepEqual(
    calls.map(({ url, method, body }) => [url, method ?? "GET", body]),
    [
      [
        "https://claudex.test/api/v1/claudex/sharing/mail-preferences",
        "GET",
        undefined,
      ],
      [
        "https://claudex.test/api/v1/claudex/sharing/mail-preferences",
        "PATCH",
        '{"shares":false}',
      ],
    ],
  );
  const odd = new ClaudexSharing("https://claudex.test", async () =>
    Response.json({ code: 0, data: { mentions: "yes" } }),
  );
  await assert.rejects(odd.mailPreferences("signed-in"), /unexpected response/);
});
