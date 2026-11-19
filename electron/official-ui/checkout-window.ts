/**
 * The top-up window (shared/checkout-window.ts): Claudex's own checkout for
 * adding funds, laid out like Stripe Checkout, paid with WeChat Pay or
 * Alipay. The official interface's "Buy usage credits" opens it through the
 * page shim (page-shim.cjs → POST /api/__claudex/checkout), since the
 * official purchase panel only takes cards (owner, 2026-10-31).
 */
import { writeFileSync } from "node:fs";
import { BrowserWindow, dialog, ipcMain, nativeTheme } from "electron";
import type { IpcMainEvent, IpcMainInvokeEvent } from "electron";
import { z } from "zod";
import {
  checkoutWindowChannels,
  checkoutWindowMethods,
  type CheckoutWindowInfo,
  type CheckoutWindowView,
} from "../../shared/checkout-window";
import type { BillingCheckout } from "../../shared/billing-api";
import { extraPagePreferences, loadExtraPage } from "../extra-pages";
import { mainState } from "../app/main-state";
import { dirname, onAppEvent, routedCall } from "../main";
import type { OfficialActivationLease } from "./activation-lease";

/** The methods this window offers (owner, 2026-10-31: WeChat Pay and Alipay). */
const offeredMethods = ["wxpay", "alipay"];

interface OwnedCheckout {
  readonly window: BrowserWindow;
  readonly lease: OfficialActivationLease;
  readonly email: string;
  view: CheckoutWindowView;
}

let checkout: OwnedCheckout | undefined;
let registered = false;

function currentCheckout() {
  const active = checkout;
  if (active?.lease.current() && !active.window.isDestroyed()) return active;
}

function senderCheckout(event: IpcMainEvent | IpcMainInvokeEvent) {
  const active = currentCheckout();
  if (
    active &&
    event.sender === active.window.webContents &&
    event.senderFrame === event.sender.mainFrame
  )
    return active;
}

const darkNow = () => {
  const theme = mainState.store?.settings.theme;
  return (
    theme === "dark" || (theme !== "light" && nativeTheme.shouldUseDarkColors)
  );
};

function register() {
  if (registered) return;
  registered = true;
  ipcMain.handle(checkoutWindowChannels.info, (event): CheckoutWindowInfo => {
    const checkout = senderCheckout(event);
    if (!checkout) throw new Error("Untrusted IPC sender");
    return {
      view: checkout.view,
      email: checkout.email,
      theme: darkNow() ? "dark" : "light",
      methods: offeredMethods,
    };
  });
  ipcMain.handle(
    checkoutWindowChannels.call,
    async (event, method: unknown, ...args: unknown[]) => {
      const checkout = senderCheckout(event);
      if (!checkout) throw new Error("Untrusted IPC sender");
      if (
        typeof method !== "string" ||
        !checkoutWindowMethods.some((name) => name === method)
      )
        throw new Error("Unknown payment call");
      const value = await routedCall(method, ...args).finally(() => {
        if (currentCheckout() !== checkout)
          throw new Error("This checkout window is no longer available.");
      });
      if (method === "billingCheckout" && value) {
        const billing: BillingCheckout = value;
        return {
          ...billing,
          methods: billing.methods.filter((m) => offeredMethods.includes(m.id)),
        };
      }
      return value;
    },
  );
  ipcMain.on(checkoutWindowChannels.close, (event) => {
    senderCheckout(event)?.window.close();
  });
  ipcMain.handle(
    checkoutWindowChannels.saveInvoiceCsv,
    async (event, rawOrderId: unknown, rawCsv: unknown) => {
      const checkout = senderCheckout(event);
      if (!checkout || checkout.view !== "billing")
        throw new Error("Untrusted IPC sender");
      const orderId = z.int().positive().parse(rawOrderId);
      const csv = z.string().parse(rawCsv);
      const result = await dialog.showSaveDialog(checkout.window, {
        defaultPath: `invoice-${orderId}.csv`,
        filters: [{ name: "CSV", extensions: ["csv"] }],
      });
      if (result.canceled || !result.filePath) return;
      if (senderCheckout(event) !== checkout || checkout.view !== "billing")
        throw new Error("This checkout window is no longer available.");
      writeFileSync(result.filePath, csv, "utf8");
    },
  );
  // An order's progress (electron/account/billing.ts follows it).
  onAppEvent((event) => {
    if (event.type === "billing-order")
      currentCheckout()?.window.webContents.send(
        checkoutWindowChannels.order,
        event,
      );
  });
}

/** Opens the top-up window on a view, or brings the open one forward on it. */
export function openCheckoutWindow(options: {
  lease: OfficialActivationLease;
  hidden?: boolean;
  view?: CheckoutWindowView;
}) {
  const { lease, view = "topup", hidden = false } = options;
  const account = mainState.activeAccount;
  if (!account || !lease.current()) throw new Error("Sign in to continue.");
  register();
  const title = view === "billing" ? "Billing" : "Add funds";
  const active = currentCheckout();
  if (active?.lease === lease) {
    active.view = view;
    active.window.setTitle(title);
    active.window.webContents.send(checkoutWindowChannels.view, view);
    if (!hidden) active.window.focus();
    return active.window;
  }
  active?.window.destroy();
  const window = new BrowserWindow({
    show: false,
    ...(hidden
      ? { focusable: false, paintWhenInitiallyHidden: true, skipTaskbar: true }
      : {}),
    width: 1000,
    height: 720,
    minWidth: 420,
    minHeight: 560,
    title,
    backgroundColor: darkNow() ? "#151515" : "#ffffff",
    // The page's <title> must not replace the view's name.
    autoHideMenuBar: true,
    webPreferences: extraPagePreferences(dirname, "checkout-preload.cjs"),
  });
  const opened: OwnedCheckout = { window, lease, email: account.email, view };
  checkout = opened;
  const stop = lease.onRetire(() => window.destroy());
  window.on("page-title-updated", (event) => event.preventDefault());
  window.once("closed", () => {
    stop();
    if (checkout === opened) checkout = undefined;
  });
  if (hidden) {
    // e2e: shown (so nothing pauses) but transparent, click-through, unfocusable.
    window.setOpacity(0);
    window.setIgnoreMouseEvents(true);
    window.showInactive();
  } else
    window.once("ready-to-show", () => {
      if (currentCheckout() === opened) window.show();
    });
  void loadExtraPage(window.webContents, "checkout.html", dirname).catch(
    (error) => {
      if (currentCheckout() === opened)
        console.error(
          "Top-up window:",
          error instanceof Error ? error.message : String(error),
        );
    },
  );
  return window;
}

/** Development and e2e: the open top-up window's contents. */
export function checkoutContents(lease: OfficialActivationLease) {
  const active = currentCheckout();
  return active?.lease === lease ? active.window.webContents : undefined;
}

/** Development and e2e: runs JavaScript in the open top-up window. */
export function evalInCheckoutWindow(
  lease: OfficialActivationLease,
  script: string,
) {
  const contents = checkoutContents(lease);
  if (!contents) throw new Error("No top-up window");
  return contents.executeJavaScript(script, true);
}
