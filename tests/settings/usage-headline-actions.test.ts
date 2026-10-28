import test from "node:test";
import assert from "node:assert/strict";
import { readSource } from "../support/read-source";

test("the usage headline's Upgrade plan and Buy more usage are the 40px, radius 10, 15px lg buttons", () => {
  const css = readSource("src/settings/usage.css", "utf8");
  const rule = css.match(
    /\.usage-headline-actions \.settings-button\.regular\s*\{([^}]*)\}/,
  );
  assert.ok(rule, "a rule for the headline's buttons");
  assert.match(rule[1], /height:\s*40px/);
  assert.match(rule[1], /border-radius:\s*10px/);
  assert.match(rule[1], /font-size:\s*15px/);
  // The global regular button stays the 32px one used elsewhere.
  assert.match(
    readSource("src/settings/settings.css", "utf8"),
    /\.settings-button\.regular\s*\{\s*height:\s*32px/,
  );
});

test("Escape on the checkout page leaves the Settings window open behind it", () => {
  const dialog = readSource("src/settings/SettingsDialog.tsx", "utf8");
  assert.match(
    dialog,
    /event\.key === "Escape" && !document\.querySelector\("\.checkout-page"\)/,
  );
  assert.match(
    readSource("src/settings/billing/CheckoutPage.tsx", "utf8"),
    /className="checkout-page"/,
  );
});

test("Turn off memory's options sit in one surface-0 panel as plain rows, not bordered cards", () => {
  const css = readSource("src/settings/tabs/turn-off-memory.css", "utf8");
  const panel = css.match(/\n\.turn-off-memory\s*\{([^}]*)\}/)![1];
  assert.match(panel, /padding:\s*16px/);
  assert.match(panel, /border-radius:\s*16px/);
  assert.match(panel, /background:\s*#0b0b0b/);
  assert.match(panel, /gap:\s*8px/);
  const row = css.match(/\n\.turn-off-memory > label\s*\{([^}]*)\}/)![1];
  assert.doesNotMatch(row, /border:|padding:/);
});
