/** Only mocked account context; no engine or external service. */
import test from "node:test";
import assert from "node:assert/strict";
import { createApiAdapter } from "../electron/official-ui/api/index";
import { completionProtocolDescriptor } from "../electron/official-ui/api/completion-protocol";
import { organizationUuid } from "../electron/official-ui/api/context";
function context() {
  let owner: string | undefined = "owner";
  const ctx: any = {
    root: "/unused-mock",
    account: () =>
      owner ? { id: owner, email: "test@example.invalid" } : undefined,
    settings: () => ({}),
    isCurrent: () => true,
    sessionIdentity: () => owner,
    completionProtocol: "text-chat-v1",
    call: async (name: string) => {
      assert.equal(name, "memoryStatus");
      return undefined;
    },
    log: () => {},
  };
  return { ctx, setOwner: (value: string | undefined) => (owner = value) };
}
test("only actual installed REST Chat transport emits the descriptor; external context claims do not enable", async () => {
  const f = context();
  for (const wiring of [undefined, false, true, "native"] as const) {
    const adapter = createApiAdapter(f.ctx, {
      scoped: false,
      restCompletion: wiring,
    });
    let body: any;
    const response: any = {
      writeHead: () => {},
      end: (s: string) => (body = JSON.parse(s)),
    };
    await adapter({ url: "/api/account", method: "GET" } as any, response);
    if (wiring === true || wiring === "native")
      assert.deepEqual(body.claudex_frontend_completion_protocol, {
        version: 1,
        account_uuid: "owner",
        organization_uuid: organizationUuid("owner"),
        protocol: "text-chat-v1",
        surface: "chat",
        completion_path: "/chat_conversations/:id/completion",
        automatic_client_tools: "unsupported",
      });
    else assert.equal(body.claudex_frontend_completion_protocol, undefined);
  }
});
test("descriptor follows active owned account, absent when signed out or retired; settings unchanged", () => {
  const f = context(),
    first = completionProtocolDescriptor(f.ctx);
  f.setOwner("second");
  const second = completionProtocolDescriptor(f.ctx)!;
  assert.notEqual(first!.account_uuid, second.account_uuid);
  assert.equal(second.organization_uuid, organizationUuid("second"));
  f.setOwner(undefined);
  assert.equal(completionProtocolDescriptor(f.ctx), undefined);
  f.setOwner("owner");
  f.ctx.isCurrent = () => false;
  assert.equal(completionProtocolDescriptor(f.ctx), undefined);
  assert.deepEqual(f.ctx.settings(), {});
});
