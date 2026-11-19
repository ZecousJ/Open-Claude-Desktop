import assert from "node:assert/strict";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { createOfficialEventSource } from "../../src-web/official/event-source";
import {
  officialUiReadMaxBytes,
  type OfficialUiReadResponse,
} from "../../shared/official-ui-web";

const origin = "https://example.test";
const path =
  "/api/organizations/11111111-1111-4111-8111-111111111111/mcp/v2/bootstrap";
const event = (name: string, data: unknown) =>
  `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
const stream =
  event("server_list", { servers: [{ uuid: "owned", name: "Owned server" }] }) +
  event("server_base", { uuid: "owned", connected: true }) +
  event("tools", {
    server_uuid: "owned",
    tools: [{ name: "search", enabled_key: "real-key" }],
  }) +
  event("resources", { server_uuid: "owned", resources: [], complete: true }) +
  event("skills", {
    server_uuid: "owned",
    skills: [
      {
        frontmatter: { name: "audit", description: "Run an audit" },
        url: "skill://audit/SKILL.md",
      },
    ],
  }) +
  event("first_pass_complete", {}) +
  event("completed", {});
const answer = (text = stream): OfficialUiReadResponse => ({
  status: 200,
  contentType: "text/event-stream; charset=utf-8",
  body: new TextEncoder().encode(text),
});
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
function setup(
  read: (request: any) => Promise<OfficialUiReadResponse> = async () =>
    answer(),
  timeoutMs = 500,
) {
  const nativeCalls: unknown[][] = [];
  class Native extends EventTarget {
    readonly native = true;
    constructor(...args: unknown[]) {
      super();
      nativeCalls.push(args);
    }
  }
  let listener: (event: any) => void = () => {};
  let subscriptions = 0;
  const Source = createOfficialEventSource(
    origin,
    read,
    Native as unknown as typeof EventSource,
    (fn) => {
      listener = fn;
      subscriptions++;
      return () => {
        subscriptions--;
      };
    },
    { timeoutMs },
  );
  return {
    Source,
    nativeCalls,
    get subscriptions() {
      return subscriptions;
    },
    emit: (event: any) => listener(event),
  };
}

test("finite official EventSource delivers actual SSE events and closes without reconnecting", async () => {
  const requests: any[] = [];
  const f = setup(async (request) => {
    requests.push(request);
    return answer();
  });
  const source = new f.Source(path, { withCredentials: true });
  assert.equal(source.readyState, f.Source.CONNECTING);
  assert.equal(source.withCredentials, true);
  assert.equal(source.url, origin + path);
  let opens = 0,
    errors = 0;
  const received: [string, any][] = [];
  source.onopen = () => {
    opens++;
    assert.equal(source.readyState, f.Source.OPEN);
  };
  source.onerror = () => {
    errors++;
  };
  for (const name of [
    "server_list",
    "server_base",
    "tools",
    "resources",
    "skills",
    "first_pass_complete",
    "completed",
  ])
    source.addEventListener(name, (event) => {
      const message = event as MessageEvent;
      assert.equal(message.origin, origin);
      received.push([name, JSON.parse(message.data)]);
    });
  await tick();
  assert.deepEqual(requests, [{ method: "GET", path }]);
  assert.equal(opens, 1);
  assert.equal(errors, 0);
  assert.equal(received.length, 7);
  assert.equal(received[2][1].tools[0].enabled_key, "real-key");
  assert.equal(received[4][1].skills[0].frontmatter.name, "audit");
  assert.equal(source.readyState, f.Source.CLOSED);
  assert.equal(f.subscriptions, 0);
  await tick();
  assert.equal(requests.length, 1);
});

test("the official iframe delivers MCP tools from the parent window's byte array", async () => {
  const response = answer();
  response.body = runInNewContext("Uint8Array.from(bytes)", { bytes: response.body });
  assert.equal(response.body instanceof Uint8Array, false);
  const f = setup(async () => response);
  const source = new f.Source(path);
  const tools: unknown[] = [];
  source.addEventListener("tools", (event) => {
    tools.push(JSON.parse((event as MessageEvent).data));
  });
  await tick();
  assert.deepEqual(tools, [
    { server_uuid: "owned", tools: [{ name: "search", enabled_key: "real-key" }] },
  ]);
  assert.equal(source.readyState, f.Source.CLOSED);
  assert.equal(f.subscriptions, 0);
});

test("EventSource delegates foreign origins, other paths and query variants to native unchanged", async () => {
  let reads = 0;
  const f = setup(async () => {
    reads++;
    return answer();
  });
  for (const input of [
    "https://api.anthropic.com" + path,
    "/api/v1/events",
    path + "?server_id=one",
    path + "#fragment",
    path.replace("11111111", "not-uuid"),
    "/elsewhere",
  ]) {
    const init = { withCredentials: true };
    const source = new f.Source(input, init);
    assert.equal((source as any).native, true);
    assert.deepEqual(f.nativeCalls.at(-1), [input, init]);
  }
  await tick();
  assert.equal(reads, 0);
  assert.equal(f.subscriptions, 0);
});

test("EventSource close before opening performs no authenticated request", async () => {
  let reads = 0;
  const f = setup(async () => {
    reads++;
    return answer();
  });
  const source = new f.Source(path);
  source.close();
  source.close();
  await tick();
  assert.equal(reads, 0);
  assert.equal(source.readyState, f.Source.CLOSED);
  assert.equal(f.subscriptions, 0);
});

for (const mode of ["close", "signed-out"] as const) {
  test(`EventSource ${mode} discards an in-flight answer and removes account listener`, async () => {
    let release!: (value: OfficialUiReadResponse) => void;
    const f = setup(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const source = new f.Source(path);
    let delivered = 0;
    source.onopen = source.onerror = () => {
      delivered++;
    };
    source.addEventListener("server_list", () => {
      delivered++;
    });
    await tick();
    assert.equal(f.subscriptions, 1);
    if (mode === "close") source.close();
    else f.emit({ type: "signed-out" });
    release(answer());
    await tick();
    assert.equal(delivered, 0);
    assert.equal(source.readyState, f.Source.CLOSED);
    assert.equal(f.subscriptions, 0);
  });
}

test("EventSource close during dispatch prevents all subsequent events", async () => {
  const f = setup();
  const source = new f.Source(path);
  let seen = 0;
  source.addEventListener("server_list", () => {
    seen++;
    source.close();
  });
  source.addEventListener("tools", () => {
    seen++;
  });
  source.addEventListener("completed", () => {
    seen++;
  });
  await tick();
  assert.equal(seen, 1);
  assert.equal(f.subscriptions, 0);
});

test("EventSource supports multiline data, CRLF, comments, message handler and listener removal", async () => {
  const data =
    event("server_list", { servers: [] }) +
    ': comment\n\nid: real-id\ndata: {"text":\ndata: "hello"}\n\n' +
    event("first_pass_complete", {}) +
    event("completed", {});
  const f = setup(async () => answer(data.replaceAll("\n", "\r\n")));
  const source = new f.Source(path);
  let messages = 0,
    removed = 0;
  const listener = () => {
    removed++;
  };
  source.addEventListener("message", listener);
  source.removeEventListener("message", listener);
  source.onmessage = (event) => {
    messages++;
    assert.deepEqual(JSON.parse(event.data), { text: "hello" });
    assert.equal(event.lastEventId, "real-id");
  };
  await tick();
  assert.equal(messages, 1);
  assert.equal(removed, 0);
});

test("invalid, truncated, oversized and non-SSE replies emit error, not partial success", async () => {
  const bad: OfficialUiReadResponse[] = [
    { ...answer(), status: 500 },
    { ...answer(), contentType: "application/json" },
    answer(""),
    answer(event("server_list", { servers: [] })),
    answer(stream.replace("data: {}", "data: not-json")),
    answer(stream.replace("event: completed", "event: error")),
    answer(stream.replace('"server_uuid":"owned","skills"', '"skills"')),
    answer(
      stream.replace(
        'data: {"servers":[{"uuid":"owned","name":"Owned server"}]}',
        "data: {}",
      ),
    ),
    answer(stream.trimEnd()),
    { ...answer(), body: new Uint8Array(officialUiReadMaxBytes + 1) },
    { ...answer(), body: new Uint8Array([0xff]) },
  ];
  for (const response of bad) {
    const f = setup(async () => response);
    const source = new f.Source(path);
    let errors = 0,
      opened = 0,
      inventory = 0;
    source.onerror = () => {
      errors++;
      assert.equal(source.readyState, f.Source.CLOSED);
    };
    source.onopen = () => {
      opened++;
    };
    source.addEventListener("server_list", () => {
      inventory++;
    });
    await tick();
    assert.equal(errors, 1);
    assert.equal(opened, 0);
    assert.equal(inventory, 0);
    assert.equal(f.subscriptions, 0);
  }
});

test("EventSource transport rejection and timeout fail once without automatic retries", async () => {
  for (const pending of [false, true]) {
    let reads = 0;
    const f = setup(async () => {
      reads++;
      if (pending) return new Promise(() => {});
      throw Error("disconnected");
    }, 5);
    const source = new f.Source(path);
    const failed = new Promise<void>((resolve) => {
      source.onerror = () => resolve();
    });
    await failed;
    assert.equal(source.readyState, f.Source.CLOSED);
    assert.equal(f.subscriptions, 0);
    assert.equal(reads, 1);
  }
});

test("already-ended account subscription prevents any read", async () => {
  let reads = 0,
    unsubscribed = 0;
  const Source = createOfficialEventSource(
    origin,
    async () => {
      reads++;
      return answer();
    },
    class {} as any,
    (listener) => {
      listener({
        type: "signed-out",
        reason: "session-expired",
        message: "Account changed",
      });
      return () => {
        unsubscribed++;
      };
    },
  );
  const source = new Source(path);
  await tick();
  assert.equal(reads, 0);
  assert.equal(unsubscribed, 1);
  assert.equal(source.readyState, Source.CLOSED);
});

test("EventSource consumes actual runner connector bootstrap, not a replacement empty inventory", async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const paths = await import("node:path");
  const { createRunnerOfficialAdapter } =
    await import("../../runner/src/official-ui-adapter");
  const { organizationUuid } =
    await import("../../electron/official-ui/api/context");
  const root = fs.mkdtempSync(paths.join(os.tmpdir(), "claudex-mcp-stream-"));
  const calls: string[] = [];
  try {
    const run = createRunnerOfficialAdapter(
      {
        account: () => ({
          id: "owner",
          email: "owner@example.invalid",
          name: "Owner",
        }),
        settings: () => ({}),
        sessionIdentity: () => 1,
        stateDirectory: () => root,
        onEvent: () => () => {},
        appVersion: "test",
        log() {},
      } as never,
      async (method) => {
        calls.push(method);
        assert.equal(method, "mcpServers");
        return {
          servers: [
            {
              name: "real-remote",
              url: "https://example.invalid/mcp",
              state: "ready",
              toolList: [
                { name: "lookup", description: "Find a note", enabled: true },
              ],
            },
            {
              name: "local-native",
              command: "stdio-server",
              state: "ready",
              toolList: [],
            },
          ],
        };
      },
      root,
      { modes: ["chat"] },
    );
    const f = setup(run);
    const source = new f.Source(
      `/api/organizations/${organizationUuid("owner")}/mcp/v2/bootstrap`,
    );
    let inventory: any, tools: any;
    const complete = new Promise<void>((resolve, reject) => {
      source.onerror = () => reject(Error("Actual adapter SSE failed"));
      source.addEventListener("server_list", (event) => {
        inventory = JSON.parse((event as MessageEvent).data);
      });
      source.addEventListener("tools", (event) => {
        tools = JSON.parse((event as MessageEvent).data);
      });
      source.addEventListener("completed", () => resolve());
    });
    await complete;
    assert.deepEqual(calls, ["mcpServers"]);
    assert.equal(inventory.servers.length, 1);
    assert.equal(inventory.servers[0].name, "real-remote");
    assert.equal(tools.server_uuid, inventory.servers[0].uuid);
    assert.equal(tools.tools[0].name, "lookup");
    assert.equal(typeof tools.tools[0].enabled_key, "string");
    assert.equal(source.readyState, f.Source.CLOSED);
    assert.equal(f.subscriptions, 0);
  } finally {
    // The real runner adapter queues state persistence for 500 ms; deleting
    // its fixture first creates a false save failure after this test ends.
    await new Promise((resolve) => setTimeout(resolve, 550));
    fs.rmSync(root, { recursive: true, force: true });
  }
});
