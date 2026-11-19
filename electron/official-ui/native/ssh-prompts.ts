import { z } from "zod";
import type { SshPrompt } from "../../../shared/ssh-api";
import type { NativeHost } from "./host";
import { sessionAccountScope } from "./session-account-scope";

const kinds = z.enum(["password", "passphrase", "hostkey", "other"]);
const pendingPrompt = z.object({
  id: z.string().uuid(), hostId: z.string(), kind: kinds, text: z.string(),
  fingerprint: z.string().optional(), confirm: z.boolean().optional(), notice: z.boolean().optional(),
});

export function registerSshPrompts(host: NativeHost) {
  const { ctx } = host;
  const scope = sessionAccountScope(ctx, () => {});
  const prompts = async () => {
    if (ctx.readOnly || ctx.isCurrent?.() === false || !ctx.account() || !ctx.localCall) return [];
    return z.array(pendingPrompt).parse(await scope.guard(() => ctx.localCall!("officialPendingSshPrompts")));
  };
  const project = (prompt: SshPrompt, queuedBehind: number) => ({
    requestId: prompt.id,
    host: prompt.hostId || "SSH",
    prompt: prompt.text,
    kind: prompt.kind,
    action: "settings",
    queuedBehind,
    ...(prompt.kind === "hostkey" && prompt.fingerprint ? {
      hostKey: {
        name: prompt.text.match(/The authenticity of host '([^']+)'/)?.[1] ?? (prompt.hostId || "SSH"),
        keyType: prompt.text.match(/(\S+) key fingerprint is/)?.[1] ?? "SSH",
        fingerprint: prompt.fingerprint,
        otherNames: [],
        otherNamesTruncated: false,
        target: true,
      },
    } : {}),
  });
  const first = (all: SshPrompt[]) => all.length ? [project(all[0], all.length - 1)] : [];
  host.on("LocalSessions.getPendingSSHPasswordRequests", () => scope.run(async () => first(await prompts())));
  host.on("LocalSessions.respondToSSHPassword", (id: unknown, raw: unknown) => scope.run(async () => {
    const request = z.string().uuid().parse(id);
    const answer = z.string().max(4096).nullish().parse(raw) ?? null;
    const prompt = (await prompts()).find((value) => value.id === request);
    if (!prompt) return;
    if (answer !== null && prompt.kind === "hostkey" && prompt.fingerprint !== answer)
      throw Error("The SSH host key changed. Retry the connection.");
    await scope.guard(() => ctx.localCall!("sshAnswerPrompt", request, answer));
  }));
  const present = () => scope.run(async () => {
    const [prompt] = first(await prompts());
    if (prompt) host.emit("LocalSessions", "onSSHPasswordRequired", prompt);
  });
  return ctx.onEvent((event) => {
    if (event.type === "ssh-prompt-closed")
      host.emit("LocalSessions", "onSSHPasswordRequestWithdrawn", { requestId: event.id, reason: "resolved" });
    else if (event.type !== "ssh-prompt") return;
    void present().catch((error) => ctx.log("SSH prompt update failed", String(error)));
  });
}
