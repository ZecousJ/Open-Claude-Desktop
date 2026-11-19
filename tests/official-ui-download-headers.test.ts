import test from "node:test";
import assert from "node:assert/strict";
import { createOfficialReadFetch } from "../src-web/official/read-fetch";
const file =
  "/api/organizations/11111111-1111-4111-8111-111111111111/files/22222222-2222-4222-8222-222222222222/contents";
test("original download-required attachment header survives runner response and length comes from actual bytes", async () => {
  const disposition =
    "attachment; filename=\"file\"; filename*=UTF-8''%E8%AF%B4%E6%98%8E.txt";
  const read = createOfficialReadFetch(
    "http://local.invalid",
    async () => ({
      status: 200,
      contentType: "text/plain",
      body: new TextEncoder().encode("hello"),
      contentDisposition: disposition,
    }),
    async () => {
      throw Error("fallback forbidden");
    },
  );
  const response = await read(file);
  assert.equal(response.headers.get("Content-Disposition"), disposition);
  assert.equal(response.headers.get("Content-Length"), "5");
  assert.equal(response.headers.get("X-Content-Type-Options"), "nosniff");
  assert.equal(await response.text(), "hello");
});
