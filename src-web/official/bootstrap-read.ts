import { bootstrapCatalog, expandBootstrap, isBootstrapRead, type BootstrapCatalog } from "../../shared/official-bootstrap-catalog";
import type { OfficialUiReadRequest, OfficialUiReadResponse } from "../../shared/official-ui-web";

type Read = (request: OfficialUiReadRequest) => Promise<OfficialUiReadResponse>;

export function preloadBootstrapCatalog(document: Document, fetch: typeof globalThis.fetch) {
  const url = document.querySelector<HTMLLinkElement>('link[data-bootstrap-catalog]')?.href;
  return url ? fetch(url).then(async response => {
    if (!response.ok) throw Error("The bootstrap catalog is unavailable.");
    return bootstrapCatalog.parse(await response.json());
  }).catch(() => undefined) : Promise.resolve(undefined);
}

export function bootstrapRead(read: Read, catalog: Promise<BootstrapCatalog | undefined>): Read {
  return async request => {
    if (!isBootstrapRead(request.method, request.path)) return read(request);
    const known = await catalog;
    if (!known) return read(request);
    const answer = await read({ ...request, bootstrapCatalogRevision: known.revision }).catch(error => {
      if (error instanceof Error && error.message === "Invalid official Web request.") return read(request);
      throw error;
    });
    // Runners predating catalog negotiation reject unknown request fields.
    if (answer.status === 400) return read(request);
    if (answer.status !== 200) return answer;
    const value: unknown = JSON.parse(new TextDecoder().decode(answer.body));
    return { ...answer, body: new TextEncoder().encode(JSON.stringify(expandBootstrap(value, known))) };
  };
}
