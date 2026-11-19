/** In-memory official route with inert source data only; no host files/accounts. */
import test from "node:test";
import assert from "node:assert/strict";
import {
  projectsRoute,
  knowledgeId,
} from "../electron/official-ui/api/projects";
import { organizationUuid } from "../electron/official-ui/api/context";
function fixture(name = "note.txt") {
  let activation = 1,
    status = 0,
    headers: any,
    body: any;
  let preview: any = {
    kind: "text",
    text: "你好\n",
    name,
    bytes: 7,
  };
  let fail = false,
    retire = false;
  const ctx: any = {
    account: () => ({ id: "owner", email: "owner@example.invalid" }),
    sessionIdentity: () => activation,
    snapshot: async () => ({
      projects: [{ id: "p", kind: "chat", name: "P", createdAt: 1 }],
    }),
    call: async (method: string) => {
      if (method === "listProjectKnowledge")
        return {
          files: [{ name, bytes: 7, addedAt: 1 }],
          bytes: 7,
          limit: 100,
        };
      assert.equal(method, "readProjectKnowledge");
      if (fail) throw Error("private path /not/exposed");
      if (retire) activation++;
      return preview;
    },
  };
  const base = `/api/organizations/${organizationUuid("owner")}/projects/p`;
  return {
    ctx,
    set: (x: any) => {
      preview = x;
    },
    fail: () => {
      fail = true;
    },
    retire: () => {
      retire = true;
    },
    async run(rest = "knowledge/" + knowledgeId("p", name)) {
      const req: any = { method: "GET" };
      const res: any = {
        writeHead: (s: number, h: any) => {
          status = s;
          headers = h;
        },
        end: (b: any) => {
          body = b;
        },
      };
      const p = base + "/" + rest;
      await projectsRoute(req, res, p, new URL(p, "http://localhost"), ctx);
      return {
        status,
        headers,
        body: Buffer.isBuffer(body) ? body.toString() : String(body),
      };
    },
  };
}
test("project knowledge text preview and docs preserve actual UTF8 contents", async () => {
  const f = fixture();
  const r = await f.run();
  assert.equal(r.status, 200);
  assert.equal(r.body, "你好\n");
  const d = await f.run("docs");
  assert.equal(d.status, 200);
  assert.equal(JSON.parse(d.body)[0].content, "你好\n");
});
test("unsupported source preview is explicit unavailable, never empty successful document", async () => {
  for (const rest of [undefined, "docs"]) {
    const f = fixture();
    f.set({ kind: "unsupported", reason: "encoding" });
    const r = await f.run(rest);
    assert.equal(r.status, 501);
    assert.match(r.body, /supported preview/);
  }
});
test("native knowledge source failures are sanitized errors rather than blank docs", async () => {
  const f = fixture();
  f.fail();
  const r = await f.run("docs");
  assert.equal(r.status, 503);
  assert.doesNotMatch(r.body, /private path/);
});
test("preview reactivation and malformed source cannot return successful contents", async () => {
  const f = fixture();
  f.retire();
  assert.equal((await f.run()).status, 409);
  const g = fixture();
  g.set({ kind: "text", text: null });
  assert.equal((await g.run()).status, 503);
});
test("actual PDF source bytes and media type remain supported", async () => {
  const f = fixture("note.pdf");
  f.set({
    kind: "pdf",
    name: "note.pdf",
    bytes: 10,
    base64: Buffer.from("%PDF-inert").toString("base64"),
  });
  const r = await f.run();
  assert.equal(r.status, 200);
  assert.equal(r.body, "%PDF-inert");
  assert.equal(r.headers["Content-Type"], "application/pdf");
});
test("malformed or oversized PDF and mismatched metadata cannot return empty success", async () => {
  for (const patch of [
    { base64: "!!!" },
    { base64: "", bytes: 0 },
    { bytes: 9 },
    { name: "foreign.pdf" },
    { bytes: 10_000_001 },
  ]) {
    const f = fixture("note.pdf");
    f.set({
      kind: "pdf",
      name: "note.pdf",
      bytes: 10,
      base64: Buffer.from("%PDF-inert").toString("base64"),
      ...patch,
    });
    assert.equal((await f.run()).status, 503);
  }
});
test("project routes reject foreign organization and readonly mutations before services", async () => {
  for (const mode of ["foreign", "readonly"] as const) {
    let calls = 0,
      status = 0;
    const ctx: any = {
      account: () => ({ id: "owner" }),
      readOnly: mode === "readonly",
      snapshot: async () => {
        calls++;
        throw Error("must not read");
      },
      call: async () => {
        calls++;
        throw Error("must not write");
      },
    };
    const p = `/api/organizations/${organizationUuid(mode === "foreign" ? "other" : "owner")}/projects`;
    await projectsRoute(
      { method: mode === "foreign" ? "GET" : "POST" } as any,
      {
        writeHead: (s: number) => {
          status = s;
        },
        end() {},
      } as any,
      p,
      new URL(p, "http://local"),
      ctx,
    );
    assert.equal(status, mode === "foreign" ? 404 : 501);
    assert.equal(calls, 0);
  }
});
test("GET cannot invoke batch knowledge deletion even through readonly route", async () => {
  let calls = 0,
    status = 0;
  const ctx: any = {
    account: () => ({ id: "owner" }),
    readOnly: true,
    snapshot: async () => {
      calls++;
    },
    call: async () => {
      calls++;
    },
  };
  const p = `/api/organizations/${organizationUuid("owner")}/projects/p/docs/delete_many`;
  await projectsRoute(
    { method: "GET" } as any,
    {
      writeHead: (s: number) => {
        status = s;
      },
      end() {},
    } as any,
    p,
    new URL(p, "http://local"),
    ctx,
  );
  assert.equal(status, 405);
  assert.equal(calls, 0);
});
test("malformed project create JSON cannot create an untitled project", async () => {
  const { Readable } = await import("node:stream");
  let status = 0,
    writes = 0;
  const req: any = Readable.from([Buffer.from("{broken")]);
  req.method = "POST";
  req.headers = {};
  const ctx: any = {
    account: () => ({ id: "owner" }),
    sessionIdentity: () => 1,
    call: async () => {
      writes++;
    },
    snapshot: async () => ({ projects: [] }),
  };
  const p = `/api/organizations/${organizationUuid("owner")}/projects`;
  await projectsRoute(
    req,
    {
      writeHead: (s: number) => {
        status = s;
      },
      end() {},
    } as any,
    p,
    new URL(p, "http://local"),
    ctx,
  );
  assert.equal(status, 400);
  assert.equal(writes, 0);
});
test("project JSON body retirement cannot dispatch a write", async () => {
  const { Readable } = await import("node:stream");
  let status = 0,
    writes = 0,
    identity = 1;
  const req: any = Readable.from(
    (function* () {
      yield Buffer.from('{"name":"P"}');
      identity++;
    })(),
  );
  req.method = "POST";
  req.headers = { "content-type": "application/json" };
  const ctx: any = {
    account: () => ({ id: "owner" }),
    sessionIdentity: () => identity,
    call: async () => {
      writes++;
    },
    snapshot: async () => ({ projects: [] }),
  };
  const p = `/api/organizations/${organizationUuid("owner")}/projects`;
  await projectsRoute(
    req,
    {
      writeHead: (s: number) => {
        status = s;
      },
      end() {},
    } as any,
    p,
    new URL(p, "http://local"),
    ctx,
  );
  assert.equal(status, 409);
  assert.equal(writes, 0);
});
