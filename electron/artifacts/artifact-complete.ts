import { z } from "zod";
import { preference } from "../../shared/settings-extras";
import type { AppContext } from "../app/app-context";
import {
  CompletionUnavailableError,
  gatewayCompleter,
  type Completer,
} from "../memory/completion";

/** The longest prompt an artifact may send (characters). */
export const maxArtifactPromptLength = 200_000;
/** Calls one account may make per minute, so a looping artifact stops soon. */
export const artifactCallsPerMinute = 20;

const instructions =
  "You answer a request that an interactive artifact (a small app the user is running) sent with window.claude.complete. Reply with the answer only, in the format the request asks for, without greetings or commentary.";

export function artifactCompleter(ctx: AppContext): Completer {
  return gatewayCompleter(async () => {
    const settings = ctx.store.settings;
    const provider = settings.providers.find(
      (item) => item.id === settings.activeProviderId,
    );
    if (!provider) return undefined;
    if (!ctx.engine.gatewayEndpoint()) {
      try {
        await ctx.engine.ensure(provider, { interactive: false });
      } catch {
        return undefined;
      }
    }
    const endpoint = ctx.engine.gatewayEndpoint();
    return endpoint ? { ...endpoint, model: provider.model } : undefined;
  });
}

/**
 * Settings → Capabilities → AI-powered artifacts: `window.claude.complete`
 * inside an artifact's preview posts its prompt to the page, which calls
 * `artifactComplete`. The answer comes from the account's active model
 * through this engine's gateway, so the key, model list and limits apply as
 * to any chat. Off unless the person turned it on.
 */
export function artifactCompleteHandler(
  ctx: AppContext,
  complete: Completer = artifactCompleter(ctx),
  now: () => number = Date.now,
) {
  const recent: number[] = [];
  return async (raw: unknown) => {
    const prompt = z
      .string()
      .min(1, "The artifact sent an empty request.")
      .max(maxArtifactPromptLength, "The artifact's request is too long.")
      .parse(raw);
    if (!preference(ctx.store.settings, "aiArtifacts"))
      throw new Error(
        "AI-powered artifacts are off. Turn them on in Settings → Capabilities.",
      );
    const at = now();
    while (recent.length && at - recent[0] > 60_000) recent.shift();
    if (recent.length >= artifactCallsPerMinute)
      throw new Error(
        "This artifact is asking too often. Try again in a minute.",
      );
    recent.push(at);
    try {
      return await complete({ instructions, input: prompt });
    } catch (error) {
      if (error instanceof CompletionUnavailableError)
        throw new Error("No model is available to answer the artifact.");
      throw error;
    }
  };
}
