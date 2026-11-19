import assert from "node:assert/strict";
import { test } from "node:test";
import { toolPermission } from "../electron/official-ui/native/command-permission";
import { registerExperimentalCodeSessions } from "../electron/official-ui/native/code-sessions";
import { registerExperimentalCoworkSessions } from "../electron/official-ui/native/cowork-sessions";
import { officialCodeApprovalControls, officialCodeApprovalResult } from "../electron/official-ui/api/cloud-code-approval";
import type { Approval, Conversation } from "../shared/types";

for (const mode of ["code", "cowork"] as const) {
  test(`${mode} reopens a real MCP approval and resolves only its original arguments`, async () => {
    const serverName = "Field-Notes";
    const toolName = "fixture_widget-v2";
    const mcpServers = {
      [serverName]: {
        display_name: "Field Notes",
        url: "https://example.com/mcp",
        claudex_directory_id: "a2545dc6-cc30-4f5b-8482-96108b4c5142",
      },
    };
    const c = {
      id: "local-mcp",
      mode,
      threadId: "thread",
      cwd: process.cwd(),
      title: "MCP",
      providerId: "p",
      model: "m",
      pinned: false,
      archived: false,
      createdAt: 1,
      updatedAt: 1,
      turns: [
        {
          id: "turn",
          prompt: "Use lookup",
          status: "inProgress",
          createdAt: 1,
          attachments: [],
          items: [
            {
              id: "tool",
              type: "mcpToolCall",
              server: serverName,
              tool: toolName,
              mcpAppResourceUri: "ui://fixture/widget.html",
              status: "inProgress",
              arguments: { repository: "morluto/rea" },
            },
          ],
        },
      ],
    } as Conversation;
    const approval: Approval = {
      id: 72,
      conversationId: c.id,
      method: "mcpServer/elicitation/request",
      params: {
        threadId: "thread",
        turnId: "turn",
        serverName,
        mode: "form",
        message: 'Allow tool "lookup"?',
        requestedSchema: { type: "object", properties: {} },
        _meta: {
          codex_approval_kind: "mcp_tool_call",
          tool_name: toolName,
          tool_params: { repository: "morluto/rea" },
          persist: ["session", "always"],
        },
      },
    };
    let pending = [approval];
    const calls: unknown[][] = [],
      events: any[] = [],
      handlers = new Map<string, (...args: any[]) => any>();
    let listener!: (event: any) => void;
    const host = {
      ctx: {
        account: () => ({ id: "fixture-owner" }),
        settings: () => ({ mcpServers }),
        localLoadConversation: async (id: string) =>
          id === c.id ? c : undefined,
        onEvent(fn: (event: any) => void) {
          listener = fn;
          return () => {};
        },
        log() {},
        async localCall(name: string, ...args: unknown[]) {
          if (name === "snapshot") return { approvals: pending };
          if (name === "coworkFolderAccess") return { state: "granted", folder: c.cwd };
          calls.push([name, ...args]);
          if (name === "approve") {
            pending = [];
            listener({ type: "approval-resolved", id: approval.id });
          }
        },
      },
      on(name: string, handler: (...args: any[]) => any) {
        handlers.set(name, handler);
      },
      emit(_domain: string, _channel: string, event: any) {
        events.push(event);
      },
    };
    (mode === "code"
      ? registerExperimentalCodeSessions
      : registerExperimentalCoworkSessions)(host as never);
    const domain = mode === "code" ? "LocalSessions" : "LocalAgentModeSessions";
    const run = (method: string, ...args: unknown[]) =>
      handlers.get(`${domain}.${method}`)!(...args);
    const request = (await run("getSession", `local_${c.id}`))
      .pendingToolPermissions[0];
    assert.equal(request.toolName, mode === "code"
      ? "mcp__3d7dbae0-89f2-4b6b-85c5-392460c543f9__fixture_widget-v2"
      : "mcp__Field-Notes__fixture_widget-v2");
    assert.equal(request.cliToolUseId, "turn:tool:tool");
    assert.deepEqual(request.input, approval.params._meta.tool_params);
    assert.equal(request.suppressAlwaysAllowRule, true);
    if (mode === "code") {
      const [control] = officialCodeApprovalControls(c, [approval], mcpServers);
      assert.equal(control.request.subtype, "can_use_tool");
      if (control.request.subtype !== "can_use_tool") assert.fail();
      assert.equal(control.request.tool_name, request.toolName);
      assert.deepEqual(officialCodeApprovalResult(c, [approval], {
        subtype: "success",
        request_id: control.request_id,
        response: {
          behavior: "allow",
          toolUseID: request.cliToolUseId,
          tool_name: request.toolName,
          updatedInput: request.input,
        },
      }, mcpServers), {
        kind: "ready",
        id: approval.id,
        response: { action: "accept", content: null, _meta: null },
      });
    }
    listener({ type: "approval", approval });
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(
      events.some(
        (e) =>
          e.type === "tool_permission_request" && e.request.requestId === "72",
      ),
    );
    await assert.rejects(
      run("respondToToolPermission", "72", "always"),
      /Only allow once or deny/,
    );
    await assert.rejects(
      run("respondToToolPermission", "72", "once", {
        repository: "another/repo",
      }),
      /Edited approval input/,
    );
    assert.deepEqual(calls, []);
    await run("respondToToolPermission", "72", "once", request.input);
    assert.deepEqual(calls, [
      ["approve", 72, { action: "accept", content: null, _meta: null }],
    ]);
    assert.ok(events.some((e) => e.type === "tool_permission_resolved"));
    await assert.rejects(
      run("respondToToolPermission", "72", "once"),
      /no longer available/,
    );
    pending = [approval];
    calls.length = 0;
    await run("respondToToolPermission", "72", "deny");
    assert.deepEqual(calls, [
      ["approve", 72, { action: "decline", content: null, _meta: null }],
    ]);
    assert.equal(
      toolPermission({ ...approval, conversationId: "another" }, c),
      undefined,
    );
    assert.equal(
      toolPermission(
        { ...approval, params: { ...approval.params, mode: "url" } },
        c,
      ),
      undefined,
    );
    assert.equal(
      toolPermission(
        { ...approval, params: { ...approval.params, _meta: {} } },
        c,
      ),
      undefined,
    );
    assert.equal(
      toolPermission(
        {
          ...approval,
          params: {
            ...approval.params,
            _meta: { ...approval.params._meta, tool_params: [] },
          },
        },
        c,
      ),
      undefined,
    );
  });
}
