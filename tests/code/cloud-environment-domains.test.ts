import test from "node:test";
import assert from "node:assert/strict";
import { act, createElement } from "react";
import { parseHTML } from "linkedom";
import {
  domainsRequiredMessage,
  invalidDomainMessage,
  validAllowedDomain,
} from "../../shared/allowed-domain";
import { cloudEnvironmentInput } from "../../shared/cloud-environments-input";
import { initialCloudEnvironment } from "../../shared/cloud-environments-api";

test("an allowed domain is a name with two labels, a wildcard form, localhost or an address", () => {
  for (const good of [
    "example.com",
    "*.example.com",
    "api.example.co.uk",
    "xn--bcher-kva.example",
    "localhost",
    "127.0.0.1",
    "  example.com  ",
  ])
    assert.ok(validAllowedDomain(good), good);
  for (const bad of [
    "",
    "example",
    "https://example.com",
    "example.com/path",
    "example..com",
    "-example.com",
    "example-.com",
    "*example.com",
    "*.localhost",
    "*.127.0.0.1",
    "256.1.1.1",
    "exa mple.com",
    "example.123",
  ])
    assert.ok(!validAllowedDomain(bad), bad);
});

test("the saved environment refuses a malformed domain with the live message", () => {
  const { id, updatedAt, ...base } = initialCloudEnvironment;
  const result = cloudEnvironmentInput.safeParse({
    ...base,
    network: "custom",
    allowedDomains: ["example"],
  });
  assert.equal(result.success, false);
  assert.equal(result.error?.issues[0].message, invalidDomainMessage);
  assert.ok(
    cloudEnvironmentInput.safeParse({
      ...base,
      network: "custom",
      allowedDomains: ["*.example.com", "localhost"],
    }).success,
  );
});

test("custom access with no domain cannot be saved and says why; a domain list is checked", async () => {
  const previous = {
    window: globalThis.window,
    document: globalThis.document,
    IS_REACT_ACT_ENVIRONMENT: (
      globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
    ).IS_REACT_ACT_ENVIRONMENT,
  };
  const { window, document } = parseHTML(
    '<html><body><main id="root"></main></body></html>',
  );
  window.desktop = {} as unknown as Window["desktop"];
  Object.assign(globalThis, {
    window,
    document,
    IS_REACT_ACT_ENVIRONMENT: true,
  });
  const { createRoot } = await import("react-dom/client");
  const { CloudEnvironmentDialog } =
    await import("../../src/composer/CloudEnvironmentDialog");
  const root = createRoot(document.getElementById("root")!);
  const saveButton = () =>
    [...document.querySelectorAll("button.primary")].at(-1) as
      HTMLButtonElement | undefined;
  try {
    await act(async () => {
      root.render(
        createElement(CloudEnvironmentDialog, {
          environment: {
            ...initialCloudEnvironment,
            id: "11111111-1111-1111-1111-111111111111",
            name: "CI",
            network: "custom",
            allowedDomains: [],
            includeDefaultDomains: false,
            updatedAt: 1,
          },
          onError() {},
        }),
      );
    });
    const area = document.querySelector(
      "textarea[placeholder*='example.com']",
    )!;
    // Nothing is said until the list has been left; the button is off at once.
    assert.equal(document.querySelector("[role=alert]"), null);
    assert.equal(saveButton()?.disabled, true);
    await act(async () => {
      area.dispatchEvent(new window.Event("focusout", { bubbles: true }));
      area.dispatchEvent(new window.Event("blur"));
    });
    assert.equal(
      document.querySelector("[role=alert]")?.textContent,
      domainsRequiredMessage,
    );
  } finally {
    await act(async () => root.unmount());
    Object.assign(globalThis, previous);
  }
});
