import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import type { Conversation } from "../../shared/types";
import {
  maxRolloutBytes,
  rolloutNamePattern,
  type ConversationImport,
} from "../../shared/cloud-sync-api";

// Link refusals and native-thread handoff.
export function assertLinkableTask(conversation: Conversation) {
  if (conversation.mode !== "cowork")
    throw new Error("This kind of task can’t be linked to a computer.");
  if (conversation.scheduledTaskId)
    throw new Error(
      "A scheduled task uses this task, so it can’t be linked to a computer.",
    );
  if (conversation.repository)
    throw new Error(
      "This task already has a repository, so it can’t be linked to a computer. To use this computer’s files and apps, start a new task here, then ask Claudex to add the repository.",
    );
  if (conversation.turns.some((turn) => turn.status === "inProgress"))
    throw new Error(
      "This task is in the middle of a step. Wait for it to finish (or stop it), then link again.",
    );
}

export function exportCoworkTask(
  conversation: Conversation,
  root: string,
  blobRoot = root,
): ConversationImport {
  assertLinkableTask(conversation);
  const payload: ConversationImport = {
    conversation: new TextEncoder().encode(JSON.stringify(conversation)),
    rollouts: [],
    files: [],
  };
  let total = payload.conversation.byteLength;
  const threads = new Set(
    [
      conversation.threadId,
      ...(conversation.savedBranches ?? []).map((branch) => branch.threadId),
    ].filter(Boolean),
  );
  const walk = (folder: string, base: string, history: boolean, depth = 0) => {
    if (depth > 20 || !fs.existsSync(folder)) return;
    for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const file = path.join(folder, entry.name);
      if (entry.isDirectory()) walk(file, base, history, depth + 1);
      else if (entry.isFile()) {
        if (
          history &&
          (!rolloutNamePattern.test(entry.name) ||
            ![...threads].some((thread) => entry.name.includes(thread!)))
        )
          continue;
        total += fs.statSync(file).size;
        if (total > maxRolloutBytes || payload.files!.length >= 2000)
          throw new Error(
            "This task is too long to link to a computer. To use this computer’s files and apps, start a new task here.",
          );
        const row = {
          name: history ? entry.name : path.relative(base, file),
          data: new Uint8Array(fs.readFileSync(file)),
        };
        (history ? payload.rollouts : payload.files!).push(row);
      }
    }
  };
  walk(path.join(root, "codex-home", "sessions"), root, true);
  if (conversation.threadId && !payload.rollouts.length)
    throw new Error(
      "Something earlier in this task can’t be carried over to a computer. To use this computer’s files and apps, start a new task here.",
    );
  if (conversation.cwd) walk(conversation.cwd, conversation.cwd, false);
  const attachments = new Map(
    [
      ...conversation.turns,
      ...(conversation.savedBranches ?? []).flatMap((branch) => branch.turns),
    ].flatMap((turn) =>
      (turn.attachments ?? []).map(
        (attachment) => [attachment.id, attachment] as const,
      ),
    ),
  );
  for (const attachment of attachments.values()) {
    const file = attachment.path;
    const base = path.join(blobRoot, "attachments") + path.sep;
    if (
      !/^[A-Za-z0-9_-]{1,80}$/.test(attachment.id) ||
      !fs.existsSync(base) ||
      !fs.existsSync(file) ||
      !fs.realpathSync(file).startsWith(fs.realpathSync(base) + path.sep) ||
      !fs.statSync(file).isFile()
    )
      throw new Error(
        "Something earlier in this task can’t be carried over to a computer. To use this computer’s files and apps, start a new task here.",
      );
    total += fs.statSync(file).size;
    if (total > maxRolloutBytes || payload.files!.length >= 2000)
      throw new Error(
        "This task is too long to link to a computer. To use this computer’s files and apps, start a new task here.",
      );
    payload.files!.push({
      name: `.claudex-attachments/${attachment.id}/${path.basename(file)}`,
      data: new Uint8Array(fs.readFileSync(file)),
    });
  }
  const digests = new Set<string>();
  JSON.stringify(conversation, (key, value) => {
    if (
      key === "digest" &&
      typeof value === "string" &&
      /^[0-9a-f]{64}$/.test(value)
    )
      digests.add(value);
    return value;
  });
  payload.blobs = [];
  for (const digest of digests) {
    const file = path.join(blobRoot, "generated-files", digest);
    if (!fs.existsSync(file) || !fs.lstatSync(file).isFile()) continue;
    total += fs.statSync(file).size;
    if (total > maxRolloutBytes)
      throw new Error(
        "This task is too long to link to a computer. To use this computer’s files and apps, start a new task here.",
      );
    payload.blobs.push({
      name: digest,
      data: new Uint8Array(fs.readFileSync(file)),
    });
  }
  return payload;
}

export function importCoworkTask(
  payload: ConversationImport,
  root: string,
): Conversation {
  const source = JSON.parse(
    Buffer.from(payload.conversation).toString("utf8"),
  ) as Conversation;
  assertLinkableTask(source);
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(source.id))
    throw new Error("Couldn’t link this task to this computer.");
  const workspace = path.join(root, "workspace", "linked", source.id);
  if (
    (payload.files?.length ?? 0) > 2000 ||
    (payload.blobs?.length ?? 0) > 2000 ||
    payload.rollouts.length > 200 ||
    [
      ...payload.rollouts,
      ...(payload.files ?? []),
      ...(payload.blobs ?? []),
    ].reduce(
      (total, row) => total + row.data.byteLength,
      payload.conversation.byteLength,
    ) > maxRolloutBytes
  )
    throw new Error("Couldn’t link this task to this computer.");
  if (
    source.threadId &&
    !payload.rollouts.some((row) => row.name.includes(source.threadId!))
  )
    throw new Error(
      "Something earlier in this task can’t be carried over to a computer. To use this computer’s files and apps, start a new task here.",
    );
  const attachments = [
    source.turns,
    ...(source.savedBranches ?? []).map((branch) => branch.turns),
  ]
    .flat()
    .flatMap((turn) => turn.attachments ?? []);
  const attachmentPaths = new Map(
    attachments.map((attachment) => {
      const name = `.claudex-attachments/${attachment.id}/${path.basename(attachment.path)}`;
      if (
        !/^[A-Za-z0-9_-]{1,80}$/.test(attachment.id) ||
        !payload.files?.some((row) => row.name === name)
      )
        throw new Error(
          "Something earlier in this task can’t be carried over to a computer. To use this computer’s files and apps, start a new task here.",
        );
      return [attachment.path, path.join(workspace, name)];
    }),
  );
  const relocate = (value: string) => {
    if (attachmentPaths.has(value)) return attachmentPaths.get(value)!;
    const prefix = [source.cwd, "/workspace"].find(
      (folder) =>
        folder && (value === folder || value.startsWith(folder + "/")),
    );
    return prefix ? workspace + value.slice(prefix.length) : value;
  };
  const writes = [
    ...payload.rollouts.map((row) => {
      const match = row.name.match(rolloutNamePattern);
      if (!match) throw new Error("Couldn’t link this task to this computer.");
      const data = Buffer.from(row.data)
        .toString("utf8")
        .split("\n")
        .map((line) => {
          if (!line.trim()) return line;
          return JSON.stringify(JSON.parse(line), (key, value) =>
            (key === "cwd" || attachmentPaths.has(value)) &&
            typeof value === "string"
              ? relocate(value)
              : value,
          );
        })
        .join("\n");
      return {
        file: path.join(
          root,
          "codex-home",
          "sessions",
          match[1],
          match[2],
          match[3],
          row.name,
        ),
        data: Buffer.from(data),
      };
    }),
    ...(payload.files ?? []).map((row) => {
      const file = path.resolve(workspace, row.name);
      if (!file.startsWith(workspace + path.sep) || row.name.includes("\\"))
        throw new Error("Couldn’t link this task to this computer.");
      return { file, data: row.data };
    }),
    ...(payload.blobs ?? []).map((row) => {
      if (
        !/^[0-9a-f]{64}$/.test(row.name) ||
        createHash("sha256").update(row.data).digest("hex") !== row.name
      )
        throw new Error("Couldn’t link this task to this computer.");
      return {
        file: path.join(root, "generated-files", row.name),
        data: row.data,
      };
    }),
  ];
  for (const { file } of writes) {
    let parent = file;
    while (parent !== root && parent !== path.dirname(parent)) {
      if (fs.existsSync(parent) && fs.lstatSync(parent).isSymbolicLink())
        throw new Error("Couldn’t link this task to this computer.");
      parent = path.dirname(parent);
    }
  }
  for (const { file, data } of writes) {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, data, { mode: 0o600 });
  }
  fs.mkdirSync(workspace, { recursive: true, mode: 0o700 });
  for (const attachment of attachments)
    attachment.path = relocate(attachment.path);
  for (const turn of [
    ...source.turns,
    ...(source.savedBranches ?? []).flatMap((branch) => branch.turns),
  ])
    for (const file of turn.items.flatMap(
      (item) => item.generatedFiles ?? [],
    )) {
      file.path = relocate(file.path);
      if (file.previousPath) file.previousPath = relocate(file.previousPath);
    }
  return {
    ...source,
    environment: { kind: "local" },
    cwd: workspace,
    linkedToComputer: true,
    projectId: undefined,
    slim: undefined,
    updatedAt: Date.now(),
  };
}
