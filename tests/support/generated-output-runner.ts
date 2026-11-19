/** Isolated acceptance wiring: actual runner gate and registered artifact reader;
 * account/snapshot provider is the self-authored Store, never production services. */
import { registerArtifactHandlers } from "../../electron/ipc/artifacts";
import { officialUiRead } from "../../runner/src/official-ui-read";
import { encodeWireValue, decodeWireValue } from "../../shared/web-wire";
import type { createGeneratedOutputFixture } from "./generated-output-fixture";
export function generatedOutputRunner(
  f: Awaited<ReturnType<typeof createGeneratedOutputFixture>>,
) {
  const handlers = new Map<string, (...args: any[]) => unknown>();
  registerArtifactHandlers((name, fn) => handlers.set(name, fn), {
    root: f.profile,
    blobs: f.blobs,
  } as any);
  let reads = 0;
  const ctx: any = {
    userId: "f019-owner",
    activeAccount: f.ctx.account(),
    officialSessionIdentity: f.ctx.sessionIdentity,
    store: f.store,
    setAccessToken() {},
    appVersion: "fixture",
    log() {},
    onEvent: () => () => {},
    selectedAttachments: new Map(),
    signedOut: false,
    closedFlag: false,
  };
  const dispatcher: any = {
    options: { officialUiRoot: f.ctx.root, officialUiActions: false },
    guard: { modes: ["chat"] },
    contextFor: async () => ctx,
    context: () => ctx,
    now: Date.now,
    run: async (frame: any, expected: any) => {
      if (
        expected.context !== ctx ||
        expected.identity !== ctx.officialSessionIdentity()
      )
        throw Error("Retired fixture");
      const args = decodeWireValue(frame.args) as any[];
      if (frame.method === "snapshot") return f.ctx.snapshot();
      if (frame.method === "conversationTurns") {
        const c = await f.ctx.loadConversation(args[0]);
        return { turns: c?.turns ?? [], savedBranches: c?.savedBranches ?? [] };
      }
      if (frame.method === "readGeneratedFile") {
        reads++;
        return handlers.get(frame.method)!(...args);
      }
      if (frame.method === "modelCatalog") return f.ctx.modelCatalog();
      return f.ctx.call(frame.method, ...args);
    },
  };
  return {
    async read(request: any) {
      return officialUiRead(dispatcher, {
        method: "officialUiRead",
        args: encodeWireValue([request]),
        user: { id: "f019-owner", accessToken: "synthetic-fixture-only" },
      } as any);
    },
    get reads() {
      return reads;
    },
  };
}
