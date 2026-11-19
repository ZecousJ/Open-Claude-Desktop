/**
 * Settings: the sections the official page opens over Claudex's own settings.
 * Usage and Billing show a balance-billed account (owner, 2026-10-12: Claudex
 * has no subscriptions, only the balance).
 */
import { expect } from "../harness.mjs";

/** Opens a settings section and returns the dialog's text. */
const section = (name) => `(async () => {
  location.hash = '#settings/${name}';
  await __e2e.waitFor(() => __e2e.all('[role=dialog]').some(__e2e.visible), 15000);
  await __e2e.sleep(2500);
  return __e2e.all('[role=dialog]').filter(__e2e.visible).map((d) => d.innerText).join('\\n');
})()`;

export const cases = [
  {
    name: "usage chart follows the active theme and keyboard focus",
    async run(client) {
      await client.goto("/new");
      await client.eval(section("usage"));
      const chart = await client.eval(`(async () => {
        const chart = await __e2e.waitFor(() => document.querySelector('.clx-usage-chart'));
        const bars = [...chart.querySelectorAll('button')];
        const event = key => new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
        if (!bars.length) throw Error('The usage range needs recorded requests.');
        const previous = document.documentElement.dataset.mode;
        const colors = [];
        try {
          for (const mode of ['light', 'dark']) {
            document.documentElement.dataset.mode = mode;
            const segments = [...chart.querySelectorAll('button span')].filter(segment => segment.getBoundingClientRect().height > 0);
            colors.push(segments.map(segment => getComputedStyle(segment).backgroundColor));
          }
          bars[0].focus();
          if (document.activeElement !== bars[0]) throw Error('The chart cannot take focus.');
          bars[0].dispatchEvent(event('End'));
          if (document.activeElement !== bars.at(-1)) throw Error('End did not focus the last bucket.');
          bars.at(-1).dispatchEvent(event('Home'));
          if (document.activeElement !== bars[0]) throw Error('Home did not focus the first bucket.');
          return { colors, label: bars[0].getAttribute('aria-label') };
        } finally {
          if (previous === undefined) delete document.documentElement.dataset.mode;
          else document.documentElement.dataset.mode = previous;
        }
      })()`);
      expect(chart.colors.every((colors) => colors.some((color) => color !== "rgba(0, 0, 0, 0)" && color !== "transparent")), "usage bars must have visible color in both themes");
      expect(chart.label.includes("Input") && chart.label.includes("Output") && chart.label.includes("Cache"), "the focused bucket must label each token count");
    },
  },
  {
    name: "usage shows the balance and no plan limits",
    async run(client) {
      await client.goto("/new");
      const credits = await client.api("/api/organizations/x/prepaid/credits");
      expect(credits.status === 200 && typeof credits.body.amount === "number", `credits answered ${credits.status}`);
      const text = await client.eval(section("usage"));
      expect(!/Unable to load usage limits/.test(text), "the page could not load the usage limits");
      expect(/Usage credits/.test(text), `no usage credits section: ${text.slice(0, 400)}`);
      const dollars = `$${(credits.body.amount / 100).toFixed(2)}`;
      expect(text.includes(dollars), `the balance ${dollars} is not shown: ${text.slice(0, 600)}`);
    },
  },
  {
    name: "buy usage credits opens the Claudex top-up window",
    async run(client) {
      await client.goto("/new");
      await client.eval(section("usage"));
      // The page's own button: the shim sends it to the top-up window, never the card panel.
      await client.eval(`(async () => {
        const buy = await __e2e.waitFor(() => __e2e.all('[role=dialog] button').find((b) => __e2e.visible(b) && /^Buy usage credits/.test(b.innerText.trim())));
        buy.click();
      })()`);
      const topUp = client.client.page("checkout");
      await topUp.waitFor("!!document.querySelector('.checkout-page .checkout-merchant') && !!document.querySelector('.checkout-method')", 30000);
      const methods = await topUp.eval("[...document.querySelectorAll('.checkout-method-label')].map((m) => m.innerText.trim())");
      expect(methods.length > 0 && methods.every((m) => /WeChat|Alipay|微信|支付宝/.test(m)), `methods: ${JSON.stringify(methods)}`);
      // An amount gives a quote on the left (Stripe-like summary), without placing an order.
      await topUp.eval(`(() => {
        const input = document.querySelector('.checkout-money-input input');
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, '20');
        input.dispatchEvent(new Event('input', { bubbles: true }));
        return true;
      })()`);
      await topUp.waitFor("!!document.querySelector('.checkout-total') && /[1-9]/.test(document.querySelector('.checkout-amount').innerText)", 10000);
      const panel = await client.eval("/Need more usage\\?|Pay now/.test(document.body.innerText)");
      expect(!panel, "the official card checkout opened too");
      await topUp.eval("window.checkoutWindow.close(), true").catch(() => {});
    },
  },
  {
    name: "settings billing opens the Claudex billing page",
    async run(client) {
      await client.goto("/new");
      await client.eval(section("usage"));
      await client.eval(`(async () => {
        const nav = await __e2e.waitFor(() => __e2e.all('[role=dialog] button').find((b) => __e2e.visible(b) && b.innerText.replace(/[\\uE000-\\uF8FF]/g, '').trim() === 'Billing'));
        nav.click();
      })()`);
      const billing = client.client.page("checkout");
      await billing.waitFor("!!document.querySelector('.billing-window') && !!document.querySelector('.billing-plan')", 30000);
      const text = await billing.eval("document.querySelector('.billing-window').innerText");
      expect(/\$\s?\d/.test(text), `no balance on the Billing page: ${text.slice(0, 300)}`);
      // The official subscription page never opened (Usage stays behind it).
      const official = await client.eval("/Cancel plan|Adjust plan|No payment method/.test(document.body.innerText)");
      expect(!official, "the official billing page opened");
      // Its address leads to the same page.
      await billing.eval("window.checkoutWindow.close(), true").catch(() => {});
      await client.eval("(location.hash = '#settings/billing', true)");
      await billing.waitFor("!!document.querySelector('.billing-window')", 30000);
      await client.waitFor("location.hash === '#settings/usage'", 10000);
      await billing.eval("window.checkoutWindow.close(), true").catch(() => {});
    },
  },
];
