/** In-memory HTTP streams and image decoder stub only; no real account writes. */
import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type http from "node:http";
import { accountRoute } from "../electron/official-ui/api/account";
import { avatarUploadLimit, avatarPhotoLimit } from "../shared/avatar";
function fixture() {
  let identity = 1,
    status = 0,
    output = "",
    decodes = 0;
  let png = Buffer.from("inert decoded fixture");
  const writes: unknown[] = [];
  const settings: any = {};
  const ctx: any = {
    account: () => ({ id: "owner" }),
    sessionIdentity: () => identity,
    settings: () => settings,
    image: {
      thumbnail: () => {
        decodes++;
        return png;
      },
    },
    call: async (method: string, patch: unknown) => {
      assert.equal(method, "saveSettings");
      writes.push(patch);
      Object.assign(settings, patch);
    },
  };
  const req = Object.assign(new EventEmitter(), {
    method: "POST",
    headers: { "content-type": "multipart/form-data; boundary=bound" },
  }) as unknown as http.IncomingMessage;
  const res: any = {
    writeHead: (code: number) => {
      status = code;
    },
    end: (data: string) => {
      output = data;
    },
  };
  return {
    req,
    ctx,
    writes,
    get status() {
      return status;
    },
    get output() {
      return output;
    },
    get decodes() {
      return decodes;
    },
    change: () => {
      identity++;
    },
    oversizedPng: () => {
      png = Buffer.alloc(avatarPhotoLimit + 1);
    },
    run: () => accountRoute(req, res, "/api/account_avatar_image", ctx),
    body: (type = "image/png") => {
      req.emit(
        "data",
        Buffer.from(
          `--bound\r\nContent-Disposition: form-data; name="file"; filename="sample.png"\r\nContent-Type: ${type}\r\n\r\ninert fixture\r\n--bound--\r\n`,
        ),
      );
      req.emit("end");
    },
  };
}
test("declared oversized avatar rejects before decode or settings write", async () => {
  const f = fixture();
  f.req.headers["content-length"] = String(avatarUploadLimit + 65537);
  await f.run();
  assert.equal(f.status, 413);
  assert.equal(f.decodes, 0);
  assert.equal(f.writes.length, 0);
  f.req.emit("end");
});
test("avatar exact allowed types are preserved and unsupported image MIME is refused", async () => {
  const bad = fixture(),
    pending = bad.run();
  bad.body("image/svg+xml");
  await pending;
  assert.equal(bad.status, 400);
  assert.equal(bad.decodes, 0);
  assert.equal(bad.writes.length, 0);
  for (const type of ["image/png", "image/jpeg", "image/webp"]) {
    const f = fixture(),
      result = f.run();
    f.body(type);
    await result;
    assert.equal(f.status, 200);
    assert.equal(f.decodes, 1);
    assert.equal(f.writes.length, 1);
  }
});
test("oversized processed photo never persists and old-account body never decodes", async () => {
  const big = fixture();
  big.oversizedPng();
  const p = big.run();
  big.body();
  await p;
  assert.equal(big.status, 413);
  assert.equal(big.writes.length, 0);
  const stale = fixture(),
    done = stale.run();
  stale.change();
  stale.body();
  await done;
  assert.equal(stale.status, 400);
  assert.match(stale.output, /account changed/);
  assert.equal(stale.decodes, 0);
  assert.equal(stale.writes.length, 0);
});

test("readonly avatar operations reject before body/save; late delete never acknowledges success", async () => {
  for (const method of ["POST", "DELETE"]) {
    const f = fixture(); f.ctx.readOnly = true; f.req.method = method;
    await f.run(); assert.equal(f.status, 501); assert.equal(f.writes.length, 0); assert.equal(f.decodes, 0);
  }
  const f = fixture(); f.req.method = "DELETE";
  f.ctx.call = async () => { f.change(); };
  await f.run(); assert.equal(f.status, 400); assert.match(f.output, /account changed/);
});
