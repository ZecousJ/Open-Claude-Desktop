/** The frozen CoworkMemory contract maps to the account-owned file memory
 * handlers, not the classic synthesized memory HTTP endpoints. */
import { z } from "zod";
import type { NativeHost } from "./host";
import { sessionAccountScope } from "./session-account-scope";
import { coworkInstructionsLimit } from "../../../shared/settings-extras";

export function registerCoworkMemory(host: NativeHost) {
  const { ctx } = host;
  let mutation: symbol | undefined;
  const account = sessionAccountScope(ctx, () => { mutation = undefined; });
  const name = z.string().min(1).max(255).refine(value =>
    !/[\\/\0\r\n]/.test(value) && value.endsWith(".md") &&
    value.toLowerCase() !== "memory.md" && value !== ".md",
    "Use the exact editable memory filename, not a path alias.");
  const contents = z.string().max(262144).refine(value => Buffer.byteLength(value) <= 262144,
    "Memory content exceeds the file byte limit.");
  const row = z.object({ path: name, content: contents.optional(), updatedAt: z.string().refine(value => Number.isFinite(Date.parse(value))) });
  const validate = (method: string, result: unknown, args: unknown[]) => {
    if (method === "readGlobalMemory") return z.string().max(coworkInstructionsLimit).nullable().parse(result);
    if (method === "listAccountMemories") {
      const rows = z.array(row).max(2000).parse(result);
      if (new Set(rows.map(r => r.path)).size !== rows.length || Buffer.byteLength(JSON.stringify(rows)) > 4 * 1024 * 1024)
        throw Error("Invalid or oversized account memory inventory.");
      if (args[0] !== false && rows.some(r => r.content === undefined))
        throw Error("Account memory content was not returned.");
      return rows;
    }
    if (method === "readAccountMemory") {
      const file = row.nullable().parse(result);
      if (file && (file.path !== args[0] || file.content === undefined)) throw Error("The requested account memory was not returned.");
      return file;
    }
    return z.boolean().parse(result);
  };
  const call = (method: string, args: unknown[]) => {
    if (ctx.isCurrent?.() === false) throw new Error("The memory adapter was retired.");
    if (!ctx.account?.()) throw new Error("Sign in to use memory.");
    if (ctx.readOnly || !ctx.localCall)
      throw new Error("File memory is not available on this host.");
    return account.run(async () => {
      const writes = /^(write|delete|reset)/.test(method);
      if (writes && mutation) throw Error("Another memory change is pending. Retry after it finishes.");
      const lease = writes ? Symbol(method) : undefined;
      if (lease) mutation = lease;
      try {
        const strictRead = ["listAccountMemories", "readAccountMemory", "resetMemories"].includes(method);
        const result = await account.guard(() => ctx.localCall!(method, ...args, ...(strictRead ? [{ strict: true }] : [])));
        if (ctx.isCurrent?.() === false) throw Error("The memory adapter was retired.");
        return validate(method, result, args);
      } finally { if (lease && mutation === lease) mutation = undefined; }
    });
  };
  host.on("CoworkMemory.readGlobalMemory", () => call("readGlobalMemory", []));
  host.on("CoworkMemory.writeGlobalMemory", (content: unknown) =>
    call("writeGlobalMemory", [
      z.string().max(coworkInstructionsLimit).parse(content),
    ]),
  );
  host.on("CoworkMemory.listAccountMemories", (includeContent: unknown) =>
    call("listAccountMemories", [z.boolean().optional().parse(includeContent)]),
  );
  host.on("CoworkMemory.readAccountMemory", (path: unknown) =>
    call("readAccountMemory", [name.parse(path)]),
  );
  host.on(
    "CoworkMemory.writeAccountMemory",
    (path: unknown, content: unknown) =>
      call("writeAccountMemory", [
        name.parse(path),
        contents.parse(content),
      ]),
  );
  host.on("CoworkMemory.deleteAccountMemory", (path: unknown) =>
    call("deleteAccountMemory", [name.parse(path)]),
  );
  host.on("CoworkMemory.resetMemories", () => call("resetMemories", []));
}
