import assert from "node:assert/strict";
import test from "node:test";
import { organizationUuid } from "../../electron/official-ui/api/context";
import { officialCoworkDeviceId } from "../../electron/official-ui/api/cowork-device-id";
import { Sub2ApiClient } from "../../electron/sub2api/client";
import { officialUiRead } from "../../runner/src/official-ui-read";
import { WebSession } from "../../runner/src/web-remote-host";
import {
  isOfficialUiAction,
  isOfficialUiQuery,
  officialCoworkDeviceRenameMaxBytes,
  officialCoworkDevices,
  type OfficialUiReadRequest,
} from "../../shared/official-ui-web";
import type { ChatDeviceDirectory } from "../../shared/chat-devices-api";
import type { DeviceInfo } from "../../shared/remote-devices";
import { encodeWireValue } from "../../shared/web-wire";
import { negotiatedOfficialAction } from "../../src-web/official/negotiated-action";
import { createOfficialReadFetch } from "../../src-web/official/read-fetch";
import {
  findOfficialCoworkDevice,
  readOfficialCoworkDevices,
} from "../../runner/src/official-cowork-devices";

const owner = "7";
const base = `/api/organizations/${organizationUuid(owner)}/cowork`;
const readRoute = (path: string) => {
  const route = officialCoworkDevices("GET", path);
  assert.ok(route);
  return route;
};
const when = "2026-11-14T03:00:00.123456789Z";
const desktop: DeviceInfo = {
  id: "pc-fixture-desktop",
  name: "Desktop",
  platform: "darwin",
  version: "1",
  connectedAt: when,
  addedAt: when,
  lastSeenAt: when,
  online: true,
  computerAccess: true,
  chatBindingVersion: 1,
  chatModes: ["cowork"],
  chatPermissionModes: ["default", "auto"],
};
const directory = (devices: DeviceInfo[]): ChatDeviceDirectory => ({
  version: 1,
  accountScope: owner,
  organizationId: null,
  devices,
});

test("the original Cowork picker and presence routes allow only exact GETs", () => {
  for (const route of [`${base}/remote_devices`, `${base}/devices`]) {
    assert.equal(isOfficialUiQuery("GET", route), true);
    assert.equal(isOfficialUiQuery("GET", route, "?extra=true"), false);
    assert.equal(isOfficialUiQuery("GET", `${route}/some-device`), false);
    for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
      assert.equal(isOfficialUiQuery(method, route), false);
      assert.equal(isOfficialUiAction(method, route), false);
    }
  }
});

test("the picker lists reachable Cowork relay devices and the same UUID reads as connected", async () => {
  const relay = async () =>
    directory([
      desktop,
      { ...desktop, id: "pc-offline", online: false },
      { ...desktop, id: "pc-no-access", computerAccess: false },
      { ...desktop, id: "pc-chat-only", chatModes: ["chat"] },
      { ...desktop, id: "pc-obsolete", chatBindingVersion: undefined },
    ]);
  const id = officialCoworkDeviceId(owner, desktop.id);
  const inventory = await readOfficialCoworkDevices(
    readRoute(`${base}/remote_devices`),
    owner,
    relay,
    () => true,
  );
  const presence = await readOfficialCoworkDevices(
    readRoute(`${base}/devices`),
    owner,
    relay,
    () => true,
  );
  assert.match(
    id,
    /^[a-f0-9]{8}-[a-f0-9]{4}-8[a-f0-9]{3}-8[a-f0-9]{3}-[a-f0-9]{12}$/,
  );
  assert.equal(inventory.status, 200);
  assert.deepEqual(JSON.parse(Buffer.from(inventory.body).toString()), {
    devices: [
      { id, display_name: "Desktop", created_at: when, last_seen_at: when },
    ],
  });
  assert.deepEqual(JSON.parse(Buffer.from(presence.body).toString()), {
    devices: [{ device_id: id, name: "Desktop" }],
  });
  assert.equal(
    findOfficialCoworkDevice((await relay()).devices, owner, id)?.id,
    desktop.id,
  );
  assert.equal(
    findOfficialCoworkDevice((await relay()).devices, "8", id),
    undefined,
  );
  assert.equal(
    findOfficialCoworkDevice(
      (await relay()).devices,
      owner,
      officialCoworkDeviceId(owner, "pc-offline"),
    ),
    undefined,
  );
});

test("the directory rejects another organization and drops a result after account activation changes", async () => {
  let calls = 0;
  let active = true;
  const relay = async () => {
    calls++;
    active = false;
    return directory([desktop]);
  };
  const foreign = readRoute(
    `/api/organizations/${organizationUuid("8")}/cowork/remote_devices`,
  );
  assert.equal(
    (await readOfficialCoworkDevices(foreign, owner, relay, () => active))
      .status,
    404,
  );
  assert.equal(calls, 0);
  const route = readRoute(`${base}/remote_devices`);
  const result = await readOfficialCoworkDevices(
    route,
    owner,
    relay,
    () => active,
  );
  assert.equal(result.status, 409);
  assert.doesNotMatch(Buffer.from(result.body).toString(), /Desktop|devices/);
  assert.equal(calls, 1);
  assert.equal(
    (
      await readOfficialCoworkDevices(
        route,
        owner,
        async () => {
          throw Error();
        },
        () => true,
      )
    ).status,
    503,
  );
});

test("Web Settings manages offline signing devices through the current runner account", async () => {
  const origin = "https://fixture.test";
  const service = "/api/v1/claudex/signing-devices";
  const list = `${base}/remote_devices?for_removal=true`;
  const device = {
    id: "11111111-1111-4111-8111-111111111111",
    device_id: "22222222-2222-4222-8222-222222222222",
    display_name: "Offline Mac",
    platform: "darwin",
    public_key: null,
    is_hardware_backed: false,
    created_at: when,
    updated_at: when,
  };
  const item = `${base}/remote_devices/${device.id}`;
  let activation = {};
  let switchDuringRead = false;
  let removed = false;
  const requests: Array<[string | undefined, string]> = [];
  const nativeFetch: typeof fetch = async (target, init) => {
    const url = new URL(String(target));
    const path = url.pathname + url.search;
    assert.equal(url.origin, origin);
    assert.equal(new Headers(init?.headers).get("authorization"), "Bearer signed-in-account");
    requests.push([init?.method, path]);
    if (path === `${service}?for_removal=true`) {
      if (switchDuringRead) activation = {};
      return Response.json({ code: 0, data: { devices: removed ? [] : [device] } });
    }
    assert.equal(path, `${service}/${device.id}`);
    if (removed) return Response.json({ reason: "cowork_remote_device_not_found" }, { status: 404 });
    if (init?.method === "PATCH") {
      const body = JSON.parse(String(init.body));
      assert.deepEqual(body, { display_name: "Renamed Mac" });
      device.display_name = body.display_name;
      return Response.json({ code: 0, data: device });
    }
    assert.equal(init?.method, "DELETE");
    assert.equal(init.body, undefined);
    removed = true;
    return Response.json({ code: 0, data: null });
  };
  const client = new Sub2ApiClient(origin, nativeFetch);
  const session = new WebSession(client, "/unused", { baseUrl: origin, userId: 7, email: "fixture@example.test" });
  const ctx = {
    userId: 7, activeAccount: { id: owner }, accountRetiring: false,
    closedFlag: false, signedOut: false, officialSessionIdentity: () => activation,
    setAccessToken: (token: string) => session.setAccessToken(token),
    remote: { backend: { client } }, session,
    store: { root: "/unused" },
    chatDeviceController: { directory: async () => directory([]) },
  };
  const dispatcher = {
    options: { officialUiRoot: "/unused", officialUiActions: true }, guard: { modes: ["chat", "cowork"] },
    contextFor: async () => ctx, context: () => ctx, now: () => 1,
  };
  const call = (method: string) => (request: OfficialUiReadRequest) => officialUiRead(
    dispatcher as never, { method, args: encodeWireValue([request]), user: { id: 7, accessToken: "signed-in-account" } } as never,
  );
  const read = call("officialUiRead");
  const action = call("officialUiAction");
  const fetch = createOfficialReadFetch(origin, read, async () => assert.fail("unexpected native fetch"), undefined,
    negotiatedOfficialAction({ mode: "engine-chat", accountId: owner, read, action, isCurrent: () => true }));
  const rename = (body: object) => ({ method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  assert.deepEqual(await (await fetch(`${base}/remote_devices`)).json(), { devices: [] });
  assert.deepEqual(await (await fetch(list)).json(), { devices: [device] });
  assert.equal((await fetch(list + "&extra=yes")).status, 501);
  assert.equal((await fetch(list.replace(organizationUuid(owner), organizationUuid("other")))).status, 404);
  assert.equal((await fetch(item.replace(organizationUuid(owner), organizationUuid("other")), rename({ display_name: "Other" }))).status, 404);
  assert.equal((await fetch(item, rename({ display_name: "x", device_id: device.device_id }))).status, 400);
  assert.equal((await fetch(item, rename({ display_name: "x".repeat(officialCoworkDeviceRenameMaxBytes) }))).status, 413);
  assert.equal((await action({ method: "PATCH", path: item, contentType: "application/json", body: Buffer.alloc(officialCoworkDeviceRenameMaxBytes + 1) })).status, 413);
  assert.equal((await fetch(item, { method: "DELETE", body: "false" })).status, 413);
  assert.deepEqual(requests, [["GET", `${service}?for_removal=true`]]);
  const renamed = await fetch(item, rename({ display_name: "Renamed Mac" }));
  assert.equal(renamed.status, 200);
  assert.deepEqual(await renamed.json(), device);
  assert.equal((await fetch(item, { method: "DELETE", headers: { "Content-Type": "application/json" } })).status, 200);
  assert.deepEqual(await (await fetch(list)).json(), { devices: [] });
  const missing = await fetch(item, rename({ display_name: "Renamed Mac" }));
  assert.equal(missing.status, 404);
  const { error } = await missing.json();
  assert.equal(error.type, "not_found_error");
  assert.equal(error.details.error_code, "cowork_remote_device_not_found");
  switchDuringRead = true;
  assert.equal((await fetch(list)).status, 409);
});
