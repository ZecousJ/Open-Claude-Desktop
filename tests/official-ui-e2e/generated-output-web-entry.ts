import { createOfficialReadFetch } from "../../src-web/official/read-fetch";
import { createGeneratedFileBatch } from "../../src-web/official/generated-file-batch";
import { browserEnv } from "../../src-web/bridge/browser-env";
import { encodeWireValue, decodeWireValue } from "../../shared/web-wire";
import { officialUserContentOrigin } from "../../shared/official-usercontent-origin";
const native = window.fetch.bind(window);
const read = async (request: any) => {
  const response = await native("/__f019/official-read", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(encodeWireValue(request)),
  });
  if (!response.ok) throw Error("Fixture runner unavailable");
  return decodeWireValue(await response.json()) as any;
};
window.fetch = createOfficialReadFetch(
  location.origin,
  read,
  native,
  () => () => {},
);
const configured = document
  .querySelector('meta[name="f019-preview-origin"]')
  ?.getAttribute("content");
Object.defineProperty(window, "__claudexOfficialUserContentOrigin", {
  value:
    officialUserContentOrigin(configured, location.origin) ??
    new URL("/official-preview-unavailable.html", location.origin).href,
  writable: false,
});
const response = await window.fetch("/api/account");
const account = await response.json();
const organization = account.memberships[0].organization.uuid;
const lifetime = new AbortController();
window.addEventListener("pagehide", () => lifetime.abort(), { once: true });
Object.defineProperty(window, "__claudexGeneratedFileBatch", {
  value: createGeneratedFileBatch({
    organization,
    fetch: window.fetch,
    download: browserEnv().download,
    current: () => !lifetime.signal.aborted,
    signal: lifetime.signal,
  }),
});
const entry: string = "/assets/v1/index-BJJTYFi2.js";
void import(/* @vite-ignore */ entry);
