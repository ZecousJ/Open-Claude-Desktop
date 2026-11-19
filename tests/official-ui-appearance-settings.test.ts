/** Inert exact-route/owner contracts; no live account, model or system settings. */
import test from "node:test";
import assert from "node:assert/strict";
import { Readable, PassThrough } from "node:stream";
import { connectorsRoute } from "../electron/official-ui/api/connectors";
import {
  saveOfficialChatFont,
  officialChatFont,
} from "../electron/official-ui/api/appearance";
import { accountOf } from "../electron/official-ui/api/bootstrap";
import {
  inAdapterScope,
  newAdapterScope,
} from "../electron/official-ui/api/scope";

function fixture() {
  let owner: string | undefined = "appearance-a",
    identity: unknown = {},
    live = true,
    readOnly = false;
  let authorize: (() => Promise<void>) | undefined;
  const settings = new Map<string, any>([
    [
      "appearance-a",
      {
        theme: "system",
        chatFont: "serif",
        providers: [],
        unrelated: "retained",
      },
    ],
    ["appearance-b", { theme: "dark", chatFont: "dyslexia", providers: [] }],
  ]);
  const calls: any[] = [];
  let save = async (value: any) => {
    settings.set(owner!, value);
  };
  const ctx: any = {
    account: () =>
      owner ? { id: owner, email: "fixture@example.invalid" } : undefined,
    sessionIdentity: () => identity,
    isCurrent: () => live,
    settings: () => settings.get(owner!),
    get readOnly() {
      return readOnly;
    },
    get authorizeAppearanceSettings() {
      return authorize;
    },
    saveAppearanceFont: async (font: string) => {
      calls.push({ owner, name: "saveAppearanceFont", args: [font] });
      await save({ ...settings.get(owner!), chatFont: font });
    },
    call: async (name: string, ...args: any[]) => {
      calls.push({ owner, name, args });
      assert.equal(name, "saveSettings");
      await save(args[0]);
    },
    root: "build/official-ui",
    log() {},
  };
  const scope = newAdapterScope("appearance-a");
  const route = async (
    body: unknown,
    method = "PATCH",
    customRequest?: any,
  ) => {
    const req =
      customRequest ??
      Object.assign(Readable.from([Buffer.from(JSON.stringify(body))]), {
        method,
        headers: { "content-type": "application/json" },
      });
    let status = 0,
      text = "";
    const res: any = {
      writeHead: (n: number) => {
        status = n;
      },
      end: (s = "") => {
        text += s;
      },
    };
    const handled = await inAdapterScope(scope, () =>
      connectorsRoute(req, res, "/api/account/settings", ctx),
    );
    return { handled, status, body: JSON.parse(text) };
  };
  return {
    ctx,
    calls,
    settings,
    route,
    setSave: (f: typeof save) => {
      save = f;
    },
    readonly: () => {
      readOnly = true;
    },
    authorize: (f: () => Promise<void>) => {
      authorize = f;
    },
    retire: () => {
      identity = {};
    },
    switch: () => {
      owner = "appearance-b";
      identity = {};
    },
    noIdentity: (value?: unknown) => {
      identity = value;
    },
    logout: () => {
      owner = undefined;
    },
    disable: () => {
      live = false;
    },
    read: () => inAdapterScope(scope, () => accountOf(ctx)),
  };
}
test("actual settings route saves each existing supported response font and bootstrap reads the owned value", async () => {
  const f = fixture();
  for (const value of ["sans", "system", "dyslexia", "serif"]) {
    const r = await f.route({ chat_font: value });
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { chat_font: value });
    assert.equal(f.read()!.settings.chat_font, value);
    assert.equal(f.settings.get("appearance-a").unrelated, "retained");
  }
  assert.equal(f.calls.length, 4);
  assert.equal(
    f.calls.every((c) => c.name === "saveAppearanceFont"),
    true,
  );
  f.switch();
  assert.equal(f.read()!.settings.chat_font, "dyslexia");
  assert.equal(f.settings.get("appearance-a").chatFont, "serif");
});
test("font schema refuses unknown, nonstring, platform default, unsupported face and mixed settings without writes", async () => {
  const f = fixture();
  for (const value of [null, {}, true, 12, "", "Sans", " sans", "unknown"]) {
    assert.equal((await f.route({ chat_font: value })).status, 400);
  }
  for (const value of ["default", "atkinson"]) {
    const r = await f.route({ chat_font: value });
    assert.equal(r.status, 501);
    assert.match(r.body.error.message, /not supported/);
  }
  for (const body of [
    { chat_font: "sans", theme: "dark" },
    { chat_font: "sans", enabled_mcp_tools: {} },
    { chat_font: "sans", providers: [] },
  ])
    assert.equal((await f.route(body)).status, 400);
  assert.equal(f.calls.length, 0);
  assert.equal(officialChatFont("atkinson"), undefined);
  f.settings.get("appearance-a").chatFont = "invalid";
  assert.equal(Object.hasOwn(f.read()!.settings, "chat_font"), false);
});
test("read-only remains closed unless exact per-request hook grants response font; other settings never ride the grant", async () => {
  const f = fixture();
  f.readonly();
  assert.equal((await f.route({ chat_font: "sans" })).status, 403);
  let grants = 0;
  f.authorize(async () => {
    grants++;
  });
  assert.equal((await f.route({ chat_font: "sans" })).status, 200);
  assert.equal((await f.route({ enabled_mcp_tools: {} })).status, 403);
  assert.equal(
    (await f.route({ chat_font: "sans", enabled_mcp_tools: {} })).status,
    400,
  );
  assert.equal(grants, 1);
  assert.equal(f.calls.length, 1);
  f.authorize(async () => {
    throw Error("private detail");
  });
  const r = await f.route({ chat_font: "system" });
  assert.equal(r.status, 403);
  assert.doesNotMatch(JSON.stringify(r), /private detail/);
  assert.equal(f.calls.length, 1);
});
test("reactivation during authorization, missing identity and sign-out cannot save", async () => {
  for (const alter of [
    (f: any) => f.retire(),
    (f: any) => f.switch(),
    (f: any) => f.logout(),
    (f: any) => f.disable(),
  ]) {
    const f = fixture();
    f.authorize(async () => {
      alter(f);
    });
    assert.equal((await f.route({ chat_font: "sans" })).status, 409);
    assert.equal(f.calls.length, 0);
  }
  for (const missing of [undefined, null, ""]) {
    const f = fixture();
    f.noIdentity(missing);
    assert.equal((await f.route({ chat_font: "sans" })).status, 409);
    assert.equal(f.calls.length, 0);
  }
});
test("body arriving after account activation retirement never reaches the write", async () => {
  const f = fixture();
  const req = Object.assign(new PassThrough(), {
    method: "PATCH",
    headers: { "content-type": "application/json" },
  });
  const pending = f.route(null, "PATCH", req);
  f.retire();
  req.end(JSON.stringify({ chat_font: "sans" }));
  assert.equal((await pending).status, 409);
  assert.equal(f.calls.length, 0);
});
test("save failure or retirement after dispatch is explicit and never automatically retried", async () => {
  const f = fixture();
  f.setSave(async () => {
    throw Error("secret backend detail");
  });
  let r = await f.route({ chat_font: "sans" });
  assert.equal(r.status, 503);
  assert.doesNotMatch(JSON.stringify(r), /secret backend detail/);
  assert.equal(f.calls.length, 1);
  const g = fixture();
  g.setSave(async (value) => {
    g.settings.set("appearance-a", value);
    g.retire();
  });
  r = await g.route({ chat_font: "sans" });
  assert.equal(r.status, 409);
  assert.equal(g.calls.length, 1);
  assert.equal(g.settings.get("appearance-a").chatFont, "sans");
  assert.match(r.body.error.message, /confirm|changed/);
});
test("helper exact shape rejects arrays and unrelated payloads even without HTTP decoding", async () => {
  const f = fixture();
  for (const body of [null, [], {}, "sans", { theme: "dark" }])
    assert.equal((await saveOfficialChatFont(f.ctx, body)).status, 400);
  assert.equal(f.calls.length, 0);
});

test("native fallback uses existing saveSettings while readonly permission without atomic writer stays closed", async () => {
  const f = fixture();
  delete f.ctx.saveAppearanceFont;
  assert.equal((await f.route({ chat_font: "system" })).status, 200);
  assert.equal(f.calls[0].name, "saveSettings");
  assert.equal(f.calls[0].args[0].unrelated, "retained");
  f.readonly();
  let grants = 0;
  f.authorize(async () => {
    grants++;
  });
  assert.equal((await f.route({ chat_font: "sans" })).status, 403);
  assert.equal(grants, 0);
  assert.equal(f.calls.length, 1);
});
