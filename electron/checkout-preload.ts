/**
 * The top-up window's preload (shared/checkout-window.ts). It exposes only
 * the payment calls, as the part of `window.desktop` the checkout uses, and
 * the window's own info and close.
 */
import { contextBridge, ipcRenderer } from "electron";
import {
  checkoutWindowChannels,
  type CheckoutDesktopBridge,
  type CheckoutWindowBridge,
  type CheckoutWindowView,
} from "../shared/checkout-window";

const call = (method: string, ...args: unknown[]) =>
  ipcRenderer.invoke(checkoutWindowChannels.call, method, ...args);

const desktop: CheckoutDesktopBridge = {
  billingInfo: () => call("billingInfo"),
  billingOrders: (page) => call("billingOrders", page),
  redeemCode: (code) => call("redeemCode", code),
  spendLimit: () => call("spendLimit"),
  setSpendLimit: (limitUsd) => call("setSpendLimit", limitUsd),
  billingCheckout: () => call("billingCheckout"),
  startPayment: (request) => call("startPayment", request),
  reopenPayment: (orderId) => call("reopenPayment", orderId),
  billingOrder: (orderId) => call("billingOrder", orderId),
  cancelOrder: (orderId) => call("cancelOrder", orderId),
  onEvent: (callback) => {
    const listener = (_event: unknown, value: Parameters<typeof callback>[0]) =>
      callback(value);
    ipcRenderer.on(checkoutWindowChannels.order, listener);
    return () =>
      void ipcRenderer.removeListener(checkoutWindowChannels.order, listener);
  },
};
const checkoutWindow: CheckoutWindowBridge = {
  info: () => ipcRenderer.invoke(checkoutWindowChannels.info),
  saveInvoiceCsv: (orderId, csv) =>
    ipcRenderer.invoke(checkoutWindowChannels.saveInvoiceCsv, orderId, csv),
  close: () => ipcRenderer.send(checkoutWindowChannels.close),
  onView: (callback) => {
    const listener = (_event: unknown, view: CheckoutWindowView) =>
      callback(view);
    ipcRenderer.on(checkoutWindowChannels.view, listener);
    return () =>
      void ipcRenderer.removeListener(checkoutWindowChannels.view, listener);
  },
};
contextBridge.exposeInMainWorld("desktop", desktop);
contextBridge.exposeInMainWorld("checkoutWindow", checkoutWindow);
