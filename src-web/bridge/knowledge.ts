/**
 * The knowledge bases the service offers, on the web: a plain request with
 * the session's token (shared/knowledge-api.ts).
 */
import {
  knowledgeBasesFrom,
  knowledgePath,
  type KnowledgeAPI,
} from "../../shared/knowledge-api";
import type { WebTransport } from "../../shared/web-client/transport";

type Method = (...args: any[]) => Promise<unknown>;

export function createKnowledgeMethods(transport: Pick<WebTransport, "json">): {
  [K in keyof KnowledgeAPI]: Method;
} {
  return {
    knowledgeBases: async () =>
      knowledgeBasesFrom(await transport.json(`/api/v1${knowledgePath}`)),
  };
}
