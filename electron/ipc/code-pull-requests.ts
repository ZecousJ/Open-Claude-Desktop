import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { validRepositoryName } from "../../shared/github-parse";
import { parsePullRequestUrl } from "../../shared/pull-request";
import type { AppContext, IpcHandle } from "../app/app-context";

const pullRequest = z.strictObject({
  repository: z.string().refine(validRepositoryName),
  number: z.number().int().positive(),
  url: z.string(),
  title: z.string().optional(),
  headRef: z.string().optional(),
  headRepository: z.string().refine(validRepositoryName).optional(),
  baseRef: z.string().optional(),
  own: z.boolean().optional(),
  openedBySession: z.boolean().optional(),
  createdAt: z.number().finite().nonnegative().optional(),
  state: z.enum(["open", "draft", "queued", "merged", "closed"]),
  checkedAt: z.number().finite().nonnegative(),
  dismissed: z.boolean().optional(),
  autoFix: z.strictObject({
    ci: z.boolean(),
    comments: z.boolean(),
    delivered: z.array(z.string()).max(400).optional(),
  }).optional(),
}).refine(row => {
  const ref = parsePullRequestUrl(row.url);
  return ref?.number === row.number && ref.repository.toLowerCase() === row.repository.toLowerCase();
});

const rows = z.array(pullRequest);
const intent = z.strictObject({
  arm: z.strictObject({
    branch: z.string().min(1).max(250),
    expiresAt: z.number().int().positive(),
  }).nullish(),
  own: z.boolean().optional(),
});

export function registerCodePullRequestHandlers(handle: IpcHandle, ctx: AppContext, generation: () => number) {
  const session = (id: unknown) => {
    const store = ctx.store;
    const account = ctx.activeAccount;
    const activation = generation();
    const conversation = typeof id === "string" ? store.conversation(id) : undefined;
    const current = () => !!account && !ctx.accountRetiring && account.id === ctx.activeAccount?.id &&
      generation() === activation && ctx.store === store && !!conversation && store.conversation(conversation.id) === conversation &&
      conversation.mode === "code" && !conversation.archived && !conversation.incognito && !conversation.cloudHosted &&
      !conversation.linkedToComputer && (!conversation.sessionAuthors ||
        conversation.sessionAuthors.ownerAccountUuid === account.id && conversation.sessionAuthors.viewerAccountUuid === account.id);
    if (!conversation || !current()) throw Error("The Code session is no longer available.");
    return { conversation, store, current };
  };

  handle("officialUpdateSessionPullRequests", async (id: unknown, raw: unknown) => {
    const { current: previous, next } = z.strictObject({ current: rows, next: rows }).parse(raw);
    const { conversation, store, current } = session(id);
    const unchanged = () => current() && isDeepStrictEqual(rows.parse(conversation.pullRequests ?? []), previous);
    if (!unchanged()) throw Error("The session's pull requests changed. Reopen the pull request menu.");
    if (isDeepStrictEqual(previous, next)) return previous;
    const arm = conversation.prAutoFixArm;
    const explicit = !!arm && next.some(row => row.headRef === arm.branch &&
      typeof row.autoFix?.ci === "boolean" && row.autoFix.ci !== previous.find(pr =>
        pr.number === row.number && pr.repository.toLowerCase() === row.repository.toLowerCase()
      )?.autoFix?.ci);
    await store.persistChatMetadata(conversation, {
      pullRequests: next,
      ...(explicit && { prAutoFixArm: undefined }),
    }, () => unchanged() && (!explicit || conversation.prAutoFixArm === arm));
    ctx.push({ type: "conversation", conversation: structuredClone(conversation) });
    return next;
  });

  handle("officialSetPrAutoFixIntent", async (id: unknown, raw: unknown) => {
    const { conversation, store, current } = session(id);
    const { arm, own } = intent.parse(raw);
    const patch = {
      ...(arm !== undefined && { prAutoFixArm: arm ?? undefined }),
      ...(own !== undefined && { prAutoFixOwnPrs: own }),
    };
    if (!Object.keys(patch).length) return;
    if (arm && (arm.expiresAt <= Date.now() || arm.expiresAt > Date.now() + 3_600_000))
      throw Error("The pull request request has expired.");
    await store.persistChatMetadata(conversation, patch, current);
    ctx.push({ type: "conversation", conversation: structuredClone(conversation) });
  });
}
