/** Existing official feedback forms, text-only. */
import { randomUUID } from "node:crypto";
import os from "node:os";
import { z } from "zod";
import type { AdapterContext } from "../api/context";
import type { NativeHost } from "./host";
import {
  isLocalCodeSession,
  isWslCodeSession,
} from "../api/code-session-ownership";
import {
  createProductFeedbackSubmitter,
  productFeedbackDeliverySchema,
  productFeedbackText,
  type ProductFeedbackAnswer,
} from "../../../shared/product-feedback";

const retired = { failureReason: "auth_error", statusCode: 409 };
const unavailable = { failureReason: "unavailable", statusCode: 403 };

function captureActivation(ctx: AdapterContext) {
  const owner = ctx.account()?.id;
  const identity = ctx.sessionIdentity?.();
  return {
    owner,
    identity,
    current: () => {
      try {
        return (
          !!owner &&
          identity != null &&
          identity !== "" &&
          ctx.account()?.id === owner &&
          ctx.sessionIdentity?.() === identity &&
          ctx.isCurrent?.() === true
        );
      } catch {
        return false;
      }
    },
  };
}

function createTextFeedbackSubmitter(ctx: AdapterContext) {
  let active:
    | (ReturnType<typeof captureActivation> & {
        submit: ReturnType<typeof createProductFeedbackSubmitter>;
      })
    | undefined;
  const retire = () => {
    active = undefined;
  };
  const unsubscribe = ctx.onAccountDeactivating?.(retire);
  const submit = async (
    text: string,
    activation: ReturnType<typeof captureActivation>,
  ): Promise<ProductFeedbackAnswer> => {
    const localCall = ctx.localCall;
    if (ctx.readOnly || !localCall) return unavailable;
    if (!activation.current()) return retired;
    if (
      !active ||
      active.owner !== activation.owner ||
      active.identity !== activation.identity
    ) {
      active = {
        ...activation,
        submit: createProductFeedbackSubmitter({
          appVersion: ctx.appVersion,
          uuid: randomUUID,
          current: activation.current,
          async send(request) {
            const result = await localCall("submitProductFeedback", request);
            const parsed = productFeedbackDeliverySchema.safeParse(result);
            return parsed.success ? parsed.data : { kind: "unknown" };
          },
        }),
      };
    }
    return active.submit(text);
  };
  return {
    submit,
    dispose: () => {
      unsubscribe?.();
      retire();
    },
  };
}

const codeTextFeedbackSchema = z
  .object({
    claudexTextOnlyFeedback: z.literal(true),
    description: z.string().min(1).max(4096).trim().min(1),
  })
  .strict();

function createCodeFeedbackHandler(
  ctx: AdapterContext,
  submit: ReturnType<typeof createTextFeedbackSubmitter>["submit"],
) {
  return async (...args: unknown[]): Promise<ProductFeedbackAnswer> => {
    const payload = codeTextFeedbackSchema.safeParse(args[1]);
    if (
      args.length !== 2 ||
      typeof args[0] !== "string" ||
      !/^local_[A-Za-z0-9_-]{1,256}$/.test(args[0]) ||
      !payload.success
    )
      return { failureReason: "invalid_request", statusCode: 400 };
    if (ctx.readOnly || !ctx.localCall || !ctx.localListConversations)
      return unavailable;
    const activation = captureActivation(ctx);
    if (!activation.current()) return retired;
    try {
      // Use the local index. Loading a session can resume it or migrate its history.
      const rows = await ctx.localListConversations();
      if (!activation.current()) return retired;
      const id = args[0].slice("local_".length);
      const matches = rows.filter((row) => row.id === id);
      const session = matches.length === 1 ? matches[0] : undefined;
      if (
        !session ||
        (session.sessionAuthors &&
          session.sessionAuthors.ownerAccountUuid !== activation.owner)
      )
        return { failureReason: "not_found", statusCode: 404 };
      const ownedSsh =
        session.mode === "code" &&
        !session.incognito &&
        !session.cloudHosted &&
        !session.cloudEnvironmentId &&
        session.environment?.kind === "ssh" &&
        !!session.cwd &&
        !!ctx.sshCodeEnvironment?.(session);
      if (!(
        isLocalCodeSession(session) ||
        isWslCodeSession(session) ||
        ownedSsh
      ))
        return { failureReason: "not_found", statusCode: 404 };
      return submit(payload.data.description, activation);
    } catch {
      return activation.current()
        ? { failureReason: "unavailable", statusCode: 503 }
        : retired;
    }
  };
}

export function registerProductFeedback(host: NativeHost) {
  const { ctx } = host;
  const { submit, dispose } = createTextFeedbackSubmitter(ctx);
  host.on(
    "LocalSessions.submitFeedback",
    createCodeFeedbackHandler(ctx, submit),
  );
  host.on(
    "CoworkFeedback.submitFeedback",
    async (raw: unknown): Promise<ProductFeedbackAnswer> => {
      const text = productFeedbackText(raw);
      return typeof text === "string"
        ? submit(text, captureActivation(ctx))
        : text;
    },
  );
  host.on("CoworkFeedback.getSystemInfo", () => ({
    appVersion: ctx.appVersion,
    platform: process.platform,
    osRelease: os.release(),
  }));
  return dispose;
}
