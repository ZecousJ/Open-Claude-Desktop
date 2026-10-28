import test from "node:test";
import assert from "node:assert/strict";
import { marketplaceAddError } from "../../src/plugins/plugin-model";

test("adding a marketplace that fails says why in the original's sentences, not the runtime's", () => {
  const cases: [string, string][] = [
    [
      "fatal: unable to access 'https://x.test/a.git/': Could not resolve host: x.test",
      "Could not connect to the marketplace host. Check the URL and your network connection.",
    ],
    [
      "Error invoking remote method 'addMarketplace': Error: operation timed out",
      "The operation timed out. You can try again.",
    ],
    [
      "fatal: repository 'https://github.com/a/b.git/' not found",
      "Repository not found or not accessible.",
    ],
    [
      "fatal: Authentication failed for 'https://github.com/a/b.git/'",
      "This marketplace could not be accessed. Private repositories are only supported using the GitHub owner/repo format.",
    ],
    [
      "spawn git ENOENT",
      "Git is required to add marketplaces. Install Git, then restart the app.",
    ],
  ];
  for (const [raw, expected] of cases)
    assert.equal(marketplaceAddError(new Error(raw)), expected, raw);
  assert.equal(
    marketplaceAddError(new Error("Marketplace unavailable")),
    "Marketplace unavailable",
  );
  assert.equal(
    marketplaceAddError(new Error("")),
    "Failed to add marketplace.",
  );
});
