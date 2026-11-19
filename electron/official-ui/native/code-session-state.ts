/** Durable, account-owned Code input. Acknowledged queue writes are atomic. */
import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { AdapterContext } from "../api/context";
import type { Attachment } from "../../../shared/types";
import { skillReferencesSchema, type SkillReference } from "../../../shared/skill-references";

export interface QueuedCodeMessage {
  uuid: string;
  message: string;
  /** Original message stays display text; sendText is a once-expanded durable command snapshot. */
  sendText?: string;
  requestHash?: string;
  command?: { name: string; source: "prompt" | "skill" };
  skillReferences?: SkillReference[];
  state: "queued" | "steered" | "submitting";
  createdAt: number;
  messageId?: string;
  before?: string[];
  delivery?: "steer";
  beforeItems?: string[];
  steeringGates?: Record<string, boolean>;
  requiresConfirmation?: boolean;
  attachments?: Attachment[];
}
export interface CommandReceipt {
  inputHash: string;
  payloadHash: string;
  requestHash?: string;
}
export interface CodeSessionState {
  version: 1;
  queues: [string, QueuedCodeMessage[]][];
  messageIds: [string, [string, string][]][];
  commandReceipts?: [string, [string, CommandReceipt][]][];
}
const empty = (): CodeSessionState => ({
  version: 1,
  queues: [],
  messageIds: [],
});
const object = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === "object" && !Array.isArray(v);
const id = (v: unknown): v is string =>
  typeof v === "string" && v.length > 0 && v.length <= 500;
const entry = (v: unknown): v is QueuedCodeMessage =>
  object(v) &&
  id(v.uuid) &&
  typeof v.message === "string" &&
  v.message.length <= 200_000 &&
  (v.skillReferences === undefined || skillReferencesSchema.safeParse(v.skillReferences).success) &&
  (v.requestHash === undefined ||
    (typeof v.requestHash === "string" &&
      /^[0-9a-f]{64}$/.test(v.requestHash))) &&
  ((v.command === undefined && v.sendText === undefined) ||
    (object(v.command) &&
      typeof v.command.name === "string" &&
      /^[A-Za-z0-9_][A-Za-z0-9._:-]{0,63}$/.test(v.command.name) &&
      ["prompt", "skill"].includes(String(v.command.source)) &&
      typeof v.sendText === "string" &&
      v.sendText.length > 0 &&
      v.sendText.length <= 200_000)) &&
  ["queued", "steered", "submitting"].includes(String(v.state)) &&
  typeof v.createdAt === "number" &&
  Number.isFinite(v.createdAt) &&
  (v.attachments === undefined ||
    (Array.isArray(v.attachments) &&
      v.attachments.length <= 12 &&
      v.attachments.every(
        (a) =>
          object(a) &&
          id(a.id) &&
          typeof a.name === "string" &&
          typeof a.path === "string" &&
          ["image", "text", "document"].includes(String(a.kind)) &&
          typeof a.size === "number",
      ))) &&
  (v.requiresConfirmation === undefined ||
    typeof v.requiresConfirmation === "boolean") &&
  (v.messageId === undefined || id(v.messageId)) &&
  (v.before === undefined || (Array.isArray(v.before) && v.before.every(id))) &&
  (v.state !== "submitting" || Array.isArray(v.before)) &&
  (v.delivery === undefined ||
    (v.delivery === "steer" &&
      Array.isArray(v.beforeItems) &&
      v.beforeItems.every(id))) &&
  (v.state !== "steered" || id(v.messageId)) &&
  (v.steeringGates === undefined ||
    (object(v.steeringGates) &&
      Object.values(v.steeringGates).every((v) => typeof v === "boolean")));

export function codeSessionState(ctx: AdapterContext) {
  const file = () => {
    const root = ctx.stateDirectory?.(),
      owner = ctx.account?.()?.id;
    if (!root || !owner) return undefined;
    return path.join(
      root,
      "official-ui",
      "native-accounts",
      createHash("sha256").update(owner).digest("hex"),
      "code-input.json",
    );
  };
  return {
    read(): CodeSessionState {
      const target = file();
      if (!target) return empty();
      let v: unknown;
      try {
        v = JSON.parse(fs.readFileSync(target, "utf8"));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return empty();
        throw Error(
          "Saved Code input could not be read; it has been preserved.",
        );
      }
      if (
        !object(v) ||
        v.version !== 1 ||
        !Array.isArray(v.queues) ||
        !Array.isArray(v.messageIds) ||
        (v.commandReceipts !== undefined &&
          (!Array.isArray(v.commandReceipts) ||
            v.commandReceipts.reduce(
              (n, row) =>
                n +
                (Array.isArray(row) && Array.isArray(row[1])
                  ? row[1].length
                  : 2001),
              0,
            ) > 2000 ||
            !v.commandReceipts.every(
              (row) =>
                Array.isArray(row) &&
                row.length === 2 &&
                id(row[0]) &&
                Array.isArray(row[1]) &&
                row[1].every(
                  (pair) =>
                    Array.isArray(pair) &&
                    pair.length === 2 &&
                    id(pair[0]) &&
                    object(pair[1]) &&
                    typeof pair[1].inputHash === "string" &&
                    /^[0-9a-f]{64}$/.test(pair[1].inputHash) &&
                    (pair[1].requestHash === undefined ||
                      (typeof pair[1].requestHash === "string" &&
                        /^[0-9a-f]{64}$/.test(pair[1].requestHash))) &&
                    typeof pair[1].payloadHash === "string" &&
                    /^[0-9a-f]{64}$/.test(pair[1].payloadHash),
                ),
            ))) ||
        !v.queues.every(
          (row) =>
            Array.isArray(row) &&
            row.length === 2 &&
            id(row[0]) &&
            Array.isArray(row[1]) &&
            row[1].every(entry),
        ) ||
        !v.messageIds.every(
          (row) =>
            Array.isArray(row) &&
            row.length === 2 &&
            id(row[0]) &&
            Array.isArray(row[1]) &&
            row[1].every(
              (pair) =>
                Array.isArray(pair) && pair.length === 2 && pair.every(id),
            ),
        )
      )
        throw Error("Saved Code input is invalid; it has been preserved.");
      return v as unknown as CodeSessionState;
    },
    write(value: CodeSessionState) {
      const target = file();
      if (!target) return; // In-memory test hosts have no persistent profile.
      fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
      const temporary = `${target}.${randomUUID()}.tmp`;
      try {
        const fd = fs.openSync(temporary, "wx", 0o600);
        try {
          fs.writeFileSync(fd, JSON.stringify(value));
          fs.fsyncSync(fd);
        } finally {
          fs.closeSync(fd);
        }
        fs.renameSync(temporary, target);
      } finally {
        fs.rmSync(temporary, { force: true });
      }
    },
  };
}
