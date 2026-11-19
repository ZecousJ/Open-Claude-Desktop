import assert from "node:assert/strict";
import test from "node:test";
import JSZip from "jszip";
import { createGeneratedFileBatch } from "../../src-web/official/generated-file-batch";

const organization = "d5f1b421-017a-4562-87a3-c58857b1d20f";
const files = [
  { orgUuid: organization, fileUuid: "report", filepath: "/reports/summary.txt" },
  { orgUuid: organization, fileUuid: "archive", filepath: "C:\\archive\\summary.txt" },
];

test("a single generated-file ZIP keeps both same-named snapshots", async () => {
  const downloads: { name: string; data: Blob }[] = [];
  const requests: string[] = [];
  const batch = createGeneratedFileBatch({
    organization,
    current: () => true,
    fetch: async url => {
      requests.push(String(url));
      return new Response(requests.length === 1 ? "Report summary" : "Archived summary");
    },
    download: (name, data) => downloads.push({ name, data }),
  });
  await batch(files);
  assert.deepEqual(requests, files.map(file => `/api/organizations/${organization}/files/${file.fileUuid}/contents`));
  assert.equal(downloads.length, 1);
  assert.equal(downloads[0].name, "Claudex-files.zip");
  const zip = await JSZip.loadAsync(await downloads[0].data.arrayBuffer());
  assert.deepEqual(Object.keys(zip.files), ["summary.txt", "summary (2).txt"]);
  assert.equal(await zip.file("summary.txt")?.async("string"), "Report summary");
  assert.equal(await zip.file("summary (2).txt")?.async("string"), "Archived summary");
});

test("a failed or retired read does not start a partial ZIP download", async () => {
  let current = true, requests = 0;
  const batch = createGeneratedFileBatch({
    organization,
    current: () => current,
    fetch: async () => ++requests === 2 ? new Response(null, { status: 503 }) : new Response("file"),
    download: () => assert.fail("Unexpected download"),
  });
  await assert.rejects(batch(files), /could not be downloaded/);
  await assert.rejects(batch([files[0], { ...files[1], orgUuid: "another" }]), /current account/);
  assert.equal(requests, 2);
  current = false;
  await assert.rejects(batch(files), { name: "AbortError" });
  assert.equal(requests, 2);
});
