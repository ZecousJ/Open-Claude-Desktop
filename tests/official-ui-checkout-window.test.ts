import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerHooks } from "node:module";
import test from "node:test";
import { checkoutWindowChannels as channels } from "../shared/checkout-window";
import { createOfficialActivationLease } from "../electron/official-ui/activation-lease";
import { AccountRetirement } from "../electron/account/account-retirement";
import { Listeners, type AppContext } from "../electron/app/app-context";

type Reply = (event: unknown, ...args: unknown[]) => unknown;
const handles = new Map<string, Reply>();
const events = new Set<(event: unknown) => void>();
let chooseInvoiceFile: () => Promise<{ canceled: boolean; filePath?: string }> = async () => ({ canceled: true });
let resolveBilling: (value: unknown) => void = () => {};
const state = { activeAccount: { email: "a@example.test" } };

function deferred() {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

class TestWindow extends EventEmitter {
  destroyed = false;
  focused = false;
  sent: unknown[][] = [];
  webContents = {
    mainFrame: {},
    send: (...message: unknown[]) => this.sent.push(message),
  };
  constructor(private options: { title: string }) {
    super();
  }
  isDestroyed() {
    return this.destroyed;
  }
  destroy() {
    this.destroyed = true;
    this.emit("closed");
  }
  close() {
    this.destroy();
  }
  title() {
    return this.options.title;
  }
  setTitle(title: string) {
    this.options.title = title;
  }
  focus() {
    this.focused = true;
  }
}

const mocks = {
  electron: {
    BrowserWindow: TestWindow,
    dialog: { showSaveDialog: () => chooseInvoiceFile() },
    shell: {},
    ipcMain: {
      handle: (channel: string, handler: Reply) =>
        handles.set(channel, handler),
      on: () => {},
    },
    nativeTheme: { shouldUseDarkColors: false },
  },
  "../main": {
    dirname: "/tmp",
    onAppEvent: (listener: (event: unknown) => void) => {
      events.add(listener);
      return () => events.delete(listener);
    },
    routedCall: () =>
      new Promise((resolve) => {
        resolveBilling = resolve;
      }),
  },
  "../app/main-state": { mainState: state },
  "../extra-pages": {
    extraPagePreferences: () => ({}),
    loadExtraPage: async () => {},
  },
};

const key = "__checkoutTestMocks";
const exports = new Map(
  Object.entries(mocks).map(([name, module]) => [name, Object.keys(module)]),
);
Object.assign(globalThis, { [key]: mocks });
const hook = registerHooks({
  resolve(specifier, context, next) {
    const names = exports.get(specifier);
    const parent = context.parentURL;
    if (
      names &&
      (parent?.endsWith("/electron/official-ui/checkout-window.ts") ||
        (specifier === "electron" &&
          parent?.endsWith("/electron/ipc/billing.ts")))
    ) {
      const source =
        `const mock = globalThis.${key}[${JSON.stringify(specifier)}];` +
        names.map((name) => `export const ${name} = mock.${name};`).join("");
      return {
        shortCircuit: true,
        url: `data:text/javascript,${encodeURIComponent(source)}`,
      };
    }
    return next(specifier, context);
  },
});
const { openCheckoutWindow, checkoutContents } =
  await import("../electron/official-ui/checkout-window");
const { registerBillingHandlers } = await import("../electron/ipc/billing");
hook.deregister();
Reflect.deleteProperty(globalThis, key);

function call(
  channel: string,
  window: { webContents: Electron.WebContents },
  ...args: unknown[]
) {
  const handler = handles.get(channel);
  assert.ok(handler);
  const sender = window.webContents;
  return handler({ sender, senderFrame: sender.mainFrame }, ...args);
}

test("checkout drops a retired account's window and pending replies before the next account opens", async () => {
  let identity = { owner: "a", store: {}, generation: 1, active: true };
  const lease = createOfficialActivationLease(identity, () => identity);
  const first = openCheckoutWindow({ view: "billing", lease });
  assert.ok(first instanceof TestWindow);
  assert.equal(first.title(), "Billing");
  assert.equal(openCheckoutWindow({ view: "topup", lease }), first);
  assert.equal(first.title(), "Add funds");
  assert.equal(first.focused, true);
  assert.equal(checkoutContents(lease), first.webContents);
  assert.deepEqual(call(channels.info, first), {
    view: "topup",
    email: "a@example.test",
    theme: "light",
    methods: ["wxpay", "alipay"],
  });
  const event = { type: "billing-order", orderId: 10, status: "PENDING" };
  for (const send of events) send(event);
  assert.deepEqual(first.sent, [
    [channels.view, "topup"],
    [channels.order, event],
  ]);

  const pending = call(channels.call, first, "billingInfo");
  const rejected = assert.rejects(
    Promise.resolve(pending),
    /no longer available/,
  );
  lease.retire();
  assert.equal(first.isDestroyed(), true);
  assert.equal(checkoutContents(lease), undefined);
  assert.throws(() => call(channels.info, first), /Untrusted IPC sender/);
  assert.throws(
    () => openCheckoutWindow({ view: "billing", lease }),
    /Sign in to continue/,
  );
  for (const send of events) send({ ...event, status: "COMPLETED" });
  assert.equal(first.sent.length, 2);

  identity = { owner: "b", store: {}, generation: 2, active: true };
  state.activeAccount = { email: "b@example.test" };
  const next = createOfficialActivationLease(identity, () => identity);
  const second = openCheckoutWindow({ view: "billing", lease: next });
  assert.notEqual(second, first);
  assert.equal(checkoutContents(lease), undefined);
  assert.equal(checkoutContents(next), second.webContents);
  assert.match(JSON.stringify(call(channels.info, second)), /b@example\.test/);
  resolveBilling({ balance: 12 });
  await rejected;
  next.retire();
});

test("retiring the billing account while Save is open prevents the CSV write", async (t) => {
  const folder = mkdtempSync(join(tmpdir(), "invoice-save-"));
  const filePath = join(folder, "invoice-6001.csv");
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const chosen = deferred();
  chooseInvoiceFile = async () => {
    await chosen.promise;
    return { canceled: false, filePath };
  };
  t.after(() => { chooseInvoiceFile = async () => ({ canceled: true }); });
  const identity = { owner: "b", store: {}, generation: 2, active: true };
  const lease = createOfficialActivationLease(identity, () => identity);
  const window = openCheckoutWindow({ view: "billing", lease });
  const saving = call(channels.saveInvoiceCsv, window, 6001, "Invoice,#6001");
  lease.retire();
  chosen.resolve();
  await assert.rejects(Promise.resolve(saving), /no longer available/);
  assert.equal(existsSync(filePath), false);
});

test("a delayed redeem never reads the next account's billing", async () => {
  const entered = deferred();
  const release = deferred();
  const reads: string[] = [];
  const host = (owner: string) => ({
    accounts: { baseUrl: "https://fixture.invalid" },
    bootstrap: {
      current: () => ({
        features: { payment: true, desktopCheckout: false, redeem: true },
      }),
    },
    backend: {
      session: { authorized: (run: (token: string) => unknown) => run(owner) },
      client: {
        redeem: async (token: string) => {
          assert.equal(token, owner);
          if (owner === "old") {
            entered.resolve();
            await release.promise;
          }
          return { type: "balance", value: 3 };
        },
        profile: async () => {
          reads.push(owner);
          return { balance: 9 };
        },
        subscriptions: async () => [],
      },
    },
    refreshPlan: async () => {},
  });
  const retirement = new AccountRetirement();
  const deactivating = new Listeners<void>();
  retirement.finishActivation(retirement.beginActivation());
  const ctx = {
    get accountActivationIdentity() {
      return retirement.accountActivationIdentity;
    },
    get accountRetiring() {
      return retirement.accountRetiring;
    },
    activeAccount: { id: "old" },
    store: {},
    remote: host("old"),
    onAccountActivated() {},
    onAccountDeactivating: (listener: () => void) => deactivating.add(listener),
  };
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  registerBillingHandlers(
    (name, handler) => handlers.set(name, handler),
    ctx as unknown as AppContext,
  );
  const redeem = handlers.get("redeemCode");
  assert.ok(redeem);
  const rejected = assert.rejects(
    Promise.resolve(redeem("TEST-CODE")),
    /account changed/,
  );
  await entered.promise;
  retirement.beginDeactivation();
  await deactivating.emitAsync();
  ctx.remote = host("next");
  ctx.store = {};
  ctx.activeAccount = { id: "next" };
  retirement.finishActivation(retirement.beginActivation());
  release.resolve();
  await rejected;
  assert.deepEqual(reads, []);
  assert.partialDeepStrictEqual(await redeem("TEST-CODE"), {
    billing: { balance: 9 },
  });
  assert.deepEqual(reads, ["next"]);
});
