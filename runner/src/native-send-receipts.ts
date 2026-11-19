import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { type WebRpcError } from "../../shared/web-protocol";
import { callError } from "./dispatcher-support";
import { writeOfficialStateFile, syncOfficialStateDirectory } from "./official-ui-receipts";
import type { WebAppContext } from "./web-app-context";

export const nativeSendInput = z.object({
  clientRequestId: z.string().uuid().transform(id => id.toLowerCase()),
  conversationId: z.string().optional(),
  incognito: z.boolean().optional(),
}).passthrough();

const receiptSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("pending") }),
  z.object({ status: z.literal("accepted"), conversationId: z.string() }),
  z.object({ status: z.literal("refused"), error: z.object({
    message: z.string(), code: z.string().optional(), details: z.unknown().optional(),
  }) }),
]);
type Receipt = z.infer<typeof receiptSchema>;
const responseId = z.object({ id: z.string() });
const inFlight = new WeakMap<WebAppContext, Map<string, Promise<unknown>>>();
const incognitoReceipts = new WeakMap<WebAppContext, Map<string, Receipt>>();

const unknownOutcome = () => Object.assign(
  new Error("The previous send could not be confirmed. Check the conversation before sending again."),
  { code: "CLAUDEX_SEND_OUTCOME_UNKNOWN" },
);

function refuse({ message, code, details }: WebRpcError): never {
  throw Object.assign(new Error(message), { code, details });
}

export async function sendWithNativeReceipt(
  ctx: WebAppContext,
  input: z.infer<typeof nativeSendInput>,
  send: (input: unknown[]) => Promise<unknown>,
) {
  const { clientRequestId, ...args } = input;
  const store = ctx.store;
  const existing = store.conversations.find(row => row.id === input.conversationId);
  const incognito = existing?.incognito ?? input.incognito ?? false;
  const directory = path.join(store.root, "native-send-receipts");
  const file = path.join(directory, `${clientRequestId}.json`);
  const current = ctx.officialSessionIdentity();
  const checkAccount = () => {
    if (ctx.accountRetiring || ctx.officialSessionIdentity() !== current) throw unknownOutcome();
  };
  checkAccount();
  const operations = inFlight.get(ctx) ?? new Map<string, Promise<unknown>>();
  const active = operations.get(clientRequestId);
  if (active) {
    const answer = await active;
    checkAccount();
    return answer;
  }

  let privateReceipts = incognitoReceipts.get(ctx);
  let receipt = privateReceipts?.get(clientRequestId);
  if (!receipt) {
    try {
      receipt = receiptSchema.parse(JSON.parse(fs.readFileSync(file, "utf8")));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw unknownOutcome();
    }
  }
  if (receipt?.status === "refused") refuse(receipt.error);
  if (receipt?.status === "accepted") {
    const conversation = store.conversations.find(row => row.id === receipt.conversationId);
    if (!conversation) throw unknownOutcome();
    return structuredClone(conversation);
  }
  if (receipt) throw unknownOutcome();

  const pending: Receipt = { status: "pending" };
  const save = (value: Receipt) => {
    if (incognito) {
      if (!privateReceipts) {
        privateReceipts = new Map();
        incognitoReceipts.set(ctx, privateReceipts);
      }
      privateReceipts.set(clientRequestId, value);
    } else {
      writeOfficialStateFile(file, value);
    }
  };
  if (!incognito) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    syncOfficialStateDirectory(store.root);
  }
  save(pending);

  const operation = Promise.resolve().then(async () => {
    checkAccount();
    let result: unknown;
    try {
      result = await send([{ ...args, ...(!args.conversationId && { newConversationId: clientRequestId }) }]);
    } catch (error) {
      save({ status: "refused", error: callError(error) });
      throw error;
    }
    const { id } = responseId.parse(result);
    save({ status: "accepted", conversationId: id });
    return result;
  });
  operations.set(clientRequestId, operation);
  inFlight.set(ctx, operations);
  try {
    const answer = await operation;
    checkAccount();
    return answer;
  } finally {
    operations.delete(clientRequestId);
  }
}
