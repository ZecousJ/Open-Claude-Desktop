import { requestJson } from "../sub2api/http";
import type { SpendLimit } from "../../shared/billing-api";
import { shell } from "electron";
import { z } from "zod";
import type { AppContext, IpcHandle } from "../app/app-context";
import { BillingSession, redeemMessage } from "../account/billing";
import { billingError } from "../account/billing-payments";
import type { RemoteHost } from "../remote/host";

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
  const sessions = new WeakMap<RemoteHost, BillingSession>();
  let last: BillingSession | undefined;
  const remote = () => {
    if (!ctx.remote) throw Error("This account has no Claudex plan.");
    return ctx.remote;
  };
  const session = () => {
    const host = remote();
    let found = sessions.get(host);
    if (!found) {
      // Orders of an account that signed out are no longer followed.
      last?.close();
      found = new BillingSession(host, {
        openExternal: (url) => shell.openExternal(url),
        push: (event) => ctx.push(event),
        active: () => ctx.remote === host,
      });
      sessions.set(host, found);
      last = found;
    }
    return found;
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
  // Settings → Billing → Monthly spend limit (backend usage/spend.go).
  const spendUrl = () =>
    `${remote().backend.accounts.baseUrl}/api/v1/claudex/spend-limit`;
  const spendFrom = (body: unknown): SpendLimit => {
    const value = (body ?? {}) as Record<string, unknown>;
    return {
      limitUsd: typeof value.limit_usd === "number" ? value.limit_usd : null,
      usedUsd: typeof value.used_usd === "number" ? value.used_usd : 0,
      resetsAt: typeof value.resets_at === "string" ? value.resets_at : "",
    };
  };
  handle("spendLimit", async () => {
    if (!ctx.remote) return null;
    const backend = remote().backend;
    try {
      return spendFrom(
        await backend.session.authorized((token) =>
          requestJson(fetch, spendUrl(), { token }),
        ),
      );
    } catch {
      // An older service has no spend limits: the block is not shown.
      return null;
    }
  });
  handle(
    "setSpendLimit",
    translated(async (raw: unknown) => {
      const limit = z.number().min(0).max(100_000).nullable().parse(raw);
      const backend = remote().backend;
      return spendFrom(
        await backend.session.authorized((token) =>
          requestJson(fetch, spendUrl(), {
            method: "PUT",
            token,
            body: { limit_usd: limit },
          }),
        ),
      );
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
      const host = remote();
      const backend = host.backend;
      const redeemed = await backend.session.authorized((token) =>
        backend.client.redeem(token, code),
      );
      // A new plan or balance can change the models this device may use.
      await host.refreshPlan().catch(() => {});
      return {
        message: redeemMessage(redeemed),
        billing: await session().info(),
      };
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
