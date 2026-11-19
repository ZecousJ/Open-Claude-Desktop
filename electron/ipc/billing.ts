import { profileReadLease } from "../account/profile-read-lease";
import { assertAccountOperationCurrent } from "../account/operation-lease";
import { requestJson } from "../sub2api/http";
import {
  readSpendLimitSource,
  spendLimitAmount,
  writeSpendLimitSource,
} from "../account/spend-limit-read";
import { shell } from "electron";
import { z } from "zod";
import type { AppContext, IpcHandle } from "../app/app-context";
import { BillingSession } from "../account/billing";
import { billingError } from "../account/billing-payments";

const orderId = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const paymentRequest = z
  .object({
    method: z.string().regex(/^[a-z_]{1,40}$/),
    planId: orderId.optional(),
    amount: z.number().positive().max(1_000_000).optional(),
    mobile: z.boolean().optional(),
  })
  .strict()
  .refine(
    (value) => (value.planId === undefined) !== (value.amount === undefined),
    "Choose a plan or an amount.",
  );

/** Settings → Billing: the plan and balance, redeem codes and payments. */
export function registerBillingHandlers(handle: IpcHandle, ctx: AppContext) {
  const captureLease = profileReadLease(ctx);
  let active: { billing: BillingSession; current: () => boolean } | undefined;
  ctx.onAccountDeactivating(() => {
    active?.billing.close();
    active = undefined;
  });
  const session = () => {
    if (active?.current()) return active.billing;
    const { host, current } = captureLease();
    assertAccountOperationCurrent(current);
    if (!host) throw Error("This account has no Claudex plan.");
    active?.billing.close();
    const billing = new BillingSession(host, {
      openExternal: (url) => shell.openExternal(url),
      push: (event) => ctx.push(event),
      active: current,
    });
    active = { billing, current };
    return billing;
  };
  const translated =
    <A extends unknown[], T>(run: (...args: A) => Promise<T>) =>
    async (...args: A) => {
      try {
        return await run(...args);
      } catch (error) {
        throw billingError(error);
      }
    };
  handle("spendLimit", async () => {
    const lease = captureLease();
    if (!lease.current())
      throw Error("The account changed while reading its spend limit.");
    const host = lease.host;
    if (!host) return null;
    const backend = host.backend;
    const url = `${backend.accounts.baseUrl}/api/v1/claudex/spend-limit`;
    return readSpendLimitSource(
      (check) =>
        backend.session.authorized((token) => {
          check();
          return requestJson(fetch, url, { token });
        }),
      lease.current,
    );
  });
  handle(
    "setSpendLimit",
    translated(async (raw: unknown) => {
      const limitUsd = spendLimitAmount.parse(raw);
      const lease = captureLease();
      const { host } = lease;
      const check = () => {
        if (!lease.current())
          throw Error("The account changed while saving its spend limit.");
      };
      check();
      if (!host) throw Error("This account has no Claudex plan.");
      const backend = host.backend;
      const baseUrl = backend.accounts.baseUrl;
      const saved = await backend.session.authorized((token) => {
        check();
        return writeSpendLimitSource({ baseUrl, token, limitUsd });
      });
      check();
      return saved;
    }),
  );
  handle("billingInfo", () =>
    ctx.remote ? translated(() => session().info())() : null,
  );
  handle(
    "redeemCode",
    translated(async (raw: unknown) => {
      const code = z
        .string()
        .trim()
        .regex(/^[A-Za-z0-9_-]{4,128}$/, "Enter the code as you received it.")
        .parse(raw);
      return session().redeem(code);
    }),
  );
  handle("billingCheckout", () =>
    ctx.remote ? translated(() => session().checkout())() : null,
  );
  handle(
    "startPayment",
    translated((raw: unknown) => session().start(paymentRequest.parse(raw))),
  );
  handle(
    "reopenPayment",
    translated((raw: unknown) => session().reopen(orderId.parse(raw))),
  );
  handle(
    "billingOrders",
    translated((raw: unknown) =>
      session().orders(z.number().int().min(1).max(10_000).parse(raw)),
    ),
  );
  handle(
    "billingOrder",
    translated((raw: unknown) => session().order(orderId.parse(raw))),
  );
  handle(
    "cancelOrder",
    translated((raw: unknown) => session().cancel(orderId.parse(raw))),
  );
}
