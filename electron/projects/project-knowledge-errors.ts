import type {
  KnowledgeSourceFailure,
  KnowledgeSourceState,
} from "../../shared/collections-api";

/** Only explicit provider status/codes establish access loss. Unknown failures
 * remain retryable; provider prose is never used as a permission decision. */
export class KnowledgeSourceError extends Error {
  constructor(
    public failure: KnowledgeSourceFailure,
    message: string,
  ) {
    super(message);
  }
}

export function knowledgeSourceFailure(error: unknown): KnowledgeSourceFailure {
  if (error instanceof KnowledgeSourceError) return error.failure;
  if (!error || typeof error !== "object") return "temporary";
  const raw = error as Record<string, unknown>;
  const status = raw.status ?? raw.statusCode ?? raw.httpStatus;
  const code = raw.code;
  if (status === 401 || code === "invalid_token" || code === "unauthorized")
    return "reconnect";
  if (status === 403 || code === "access_denied" || code === "forbidden")
    return "forbidden";
  if (
    status === 404 ||
    status === 410 ||
    code === "not_found" ||
    code === "RESOURCE_NOT_FOUND"
  )
    return "not-found";
  if (code === "URL_NOT_SUPPORTED" || code === "RESOLUTION_FAILED")
    return "resolution";
  if (raw.error && raw.error !== error)
    return knowledgeSourceFailure(raw.error);
  return "temporary";
}

export function knowledgeFailureState(
  error: unknown,
): Pick<KnowledgeSourceState, "status" | "failure"> {
  const failure = knowledgeSourceFailure(error);
  return {
    status: failure === "temporary" ? "failed" : "inaccessible",
    failure,
  };
}

/** gh reports HTTP failures as '(HTTP NNN)' on stderr; its exit code is not HTTP. */
export function knowledgeGithubFailure(result: { stderr: string }) {
  const match = /\(HTTP (401|403|404|410)\)/.exec(result.stderr);
  return new KnowledgeSourceError(
    knowledgeSourceFailure({ status: match ? Number(match[1]) : undefined }),
    "Something went wrong. You can try again.",
  );
}

/** Preserve HTTP outcomes before the shared MCP transport flattens failures. */
export async function withKnowledgeProviderErrors<T>(
  request: typeof fetch,
  run: (request: typeof fetch) => Promise<T>,
): Promise<T> {
  let failure: KnowledgeSourceError | undefined;
  const observed: typeof fetch = async (...args) => {
    const response = await request(...args);
    if (!response.ok && !failure)
      failure = new KnowledgeSourceError(
        knowledgeSourceFailure({ status: response.status }),
        "The source could not be synced.",
      );
    return response;
  };
  try {
    return await run(observed);
  } catch (error) {
    throw failure ?? error;
  }
}
