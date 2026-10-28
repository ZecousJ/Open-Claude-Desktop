import { z } from "zod";
import { validRepositoryName } from "../../shared/github-parse";
import {
  knowledgeExtensions,
  knowledgeFileLimit,
  type KnowledgeRepositoryFile,
} from "../../shared/collections-api";
import { runGh, type GhRunner } from "../git/github-cli";
import {
  KnowledgeSourceError,
  knowledgeFailureState,
  knowledgeGithubFailure,
} from "./project-knowledge-errors";
import {
  knowledgeProjectLimit,
  ProjectKnowledgeStore,
} from "./project-knowledge";

const repositoryName = z.string().max(140).refine(validRepositoryName);
const failure = "Something went wrong. You can try again.";

// GitHub file selection.
export async function knowledgeRepositories(
  run: GhRunner = runGh,
): Promise<string[]> {
  const auth = await run(["auth", "status"]);
  if (auth.code !== 0) return [];
  const result = await run([
    "api",
    "--paginate",
    "--slurp",
    "user/repos?per_page=100&sort=updated",
  ]);
  if (result.code !== 0) throw knowledgeGithubFailure(result);
  const pages = z
    .array(z.array(z.object({ full_name: repositoryName })))
    .parse(JSON.parse(result.stdout));
  return pages.flat().map((repo) => repo.full_name);
}

export async function knowledgeRepositoryFiles(
  repository: string,
  branch: string,
  run: GhRunner = runGh,
): Promise<KnowledgeRepositoryFile[]> {
  repositoryName.parse(repository);
  z.string().min(1).max(200).parse(branch);
  const result = await run([
    "api",
    `repos/${repository}/git/trees/${encodeURIComponent(branch)}?recursive=1`,
  ]);
  if (result.code !== 0) throw knowledgeGithubFailure(result);
  const tree = z
    .object({
      truncated: z.boolean().optional(),
      tree: z.array(
        z.object({
          path: z.string(),
          type: z.string(),
          mode: z.string(),
          sha: z.string().regex(/^[a-f0-9]{40,64}$/),
          size: z.number().optional(),
        }),
      ),
    })
    .parse(JSON.parse(result.stdout));
  if (tree.truncated) throw new Error(failure);
  return tree.tree
    .filter(
      (file) =>
        file.type === "blob" &&
        file.mode !== "120000" &&
        // Project files keep no hidden names (electron/project-knowledge.ts).
        !file.path.split("/").some((part) => part.startsWith(".")) &&
        knowledgeExtensions.includes(
          file.path.split(".").pop()?.toLowerCase() ?? "",
        ) &&
        (file.size ?? 0) <= knowledgeFileLimit,
    )
    .map((file) => ({ name: file.path, sha: file.sha, bytes: file.size ?? 0 }));
}

export async function readKnowledgeRepositoryFiles(
  repository: string,
  files: KnowledgeRepositoryFile[],
  run: GhRunner = runGh,
) {
  repositoryName.parse(repository);
  z.array(
    z.object({
      name: z.string().min(1).max(4096),
      sha: z.string().regex(/^[a-f0-9]{40,64}$/),
      bytes: z.number().min(0).max(knowledgeFileLimit),
    }),
  )
    .min(1)
    .max(200)
    .parse(files);
  const read = [];
  let bytes = 0;
  for (const file of files) {
    const result = await run(
      ["api", `repos/${repository}/git/blobs/${file.sha}`],
      Math.ceil((knowledgeFileLimit * 4) / 3) + 65_536,
    );
    if (result.code !== 0) throw knowledgeGithubFailure(result);
    const blob = z
      .object({
        encoding: z.literal("base64"),
        content: z.string(),
        size: z.number().max(knowledgeFileLimit),
      })
      .parse(JSON.parse(result.stdout));
    const data = Buffer.from(blob.content, "base64");
    bytes += data.length;
    if (bytes > knowledgeProjectLimit) throw new Error(failure);
    if (data.length > knowledgeFileLimit || data.length !== blob.size)
      throw new Error(failure);
    read.push({ name: `${repository}/${file.name}`, data });
  }
  return read;
}

// Source refresh preserves the last good copy on failure.
const syncing = new Set<string>();

export async function syncKnowledgeRepositoryFile(
  store: ProjectKnowledgeStore,
  projectId: string,
  name: string,
  run: GhRunner = runGh,
) {
  const key = `${store.folder(projectId)}/${name}`;
  if (syncing.has(key)) throw new Error(failure);
  const source = store
    .list(projectId)
    .files.find((file) => file.name === name)?.source;
  if (!source || source.provider !== "github") throw new Error(failure);
  syncing.add(key);
  try {
    const files = await knowledgeRepositoryFiles(
      source.repository,
      source.branch,
      run,
    );
    const file = files.find((file) => file.name === source.path);
    if (!file) throw new KnowledgeSourceError("not-found", failure);
    const loaded = await readKnowledgeRepositoryFiles(
      source.repository,
      [file],
      run,
    );
    const current = store
      .list(projectId)
      .files.find((file) => file.name === name)?.source;
    if (!current || JSON.stringify(current) !== JSON.stringify(source))
      return store.list(projectId);
    store.add(projectId, loaded);
    return store.setSource(projectId, name, {
      ...source,
      status: "idle",
      failure: undefined,
      lastSyncedAt: Date.now(),
    });
  } catch (error) {
    const current = store
      .list(projectId)
      .files.find((file) => file.name === name)?.source;
    if (current && JSON.stringify(current) === JSON.stringify(source))
      return store.setSource(projectId, name, {
        ...source,
        ...knowledgeFailureState(error),
      });
    return store.list(projectId);
  } finally {
    syncing.delete(key);
  }
}
