/** Synthetic file bytes and conditional writes, held in memory. No disk/network. */
import type { ProjectFile, ProjectEntry } from "../../../shared/project-files";
import type { FixtureDomain } from "./index";

export const filesFixture: FixtureDomain = {
  params: {
    files: "some|readonly|conflict|error: explicit synthetic editor states",
  },
  bridge: ({ params, state, origin }) => {
    const scenario = params.get("files");
    if (!scenario) return {};
    const files = new Map<string, string>([
      [
        "reference-one.md",
        "# File editor reference\n\nSynthetic local acceptance content.\n",
      ],
      [
        "reference-two.ts",
        "export function greet(name: string) {\n    return `Hello ${name}`;\n}\n",
      ],
      [
        "nested/config.json",
        '{\n    "preview": true,\n    "source": "synthetic"\n}\n',
      ],
      ["crlf.txt", "First line\r\nSecond line\r\n"],
    ]);
    const revisions = new Map([...files.keys()].map((path) => [path, 0]));
    const revision = (path: string) =>
      (revisions.get(path) ?? 0).toString(16).padStart(64, "0");
    const read = (path: string): ProjectFile => {
      const content = files.get(path);
      if (content === undefined) throw new Error("Synthetic file is missing");
      return {
        path,
        content,
        bytes: new TextEncoder().encode(content).length,
        revision: revision(path),
        writable: scenario !== "readonly",
      };
    };
    state.conversations.unshift({
      id: "synthetic-files",
      title: "File editor acceptance",
      mode: "code",
      pinned: false,
      archived: false,
      cwd: "/synthetic/files-workspace",
      environment: { kind: "local" },
      providerId: "fixture",
      model: "Opus 5.5",
      createdAt: origin,
      updatedAt: origin,
      turns: [],
    });
    return {
      listProjectFolder: async (_id, folder) => {
        const entries = new Map<string, ProjectEntry>();
        for (const path of files.keys()) {
          const prefix = folder ? `${folder}/` : "";
          if (!path.startsWith(prefix)) continue;
          const rest = path.slice(prefix.length),
            name = rest.split("/")[0];
          entries.set(name, {
            name,
            path: prefix + name,
            kind: rest.includes("/") ? "folder" : "file",
          });
        }
        return { entries: [...entries.values()], truncated: false };
      },
      readProjectFile: async (_id, path) => read(path),
      writeProjectFile: async (_id, path, text, expected) => {
        if (scenario === "error") throw new Error("Synthetic disk failure");
        if (scenario === "readonly")
          return { status: "denied", reason: "read-only" };
        if (scenario === "conflict" || revision(path) !== expected)
          return { status: "conflict", currentRevision: revision(path) };
        if (!files.has(path)) return { status: "missing" };
        files.set(path, text);
        revisions.set(path, (revisions.get(path) ?? 0) + 1);
        return { status: "saved", file: read(path) };
      },
      mentionFiles: async (_scope, query) =>
        [...files.keys()]
          .filter((path) => path.includes(query))
          .map((path) => ({ path, kind: "file" as const })),
      searchProjectFiles: async (_id, query) => ({
        matches: [...files].flatMap(([path, content]) =>
          content
            .split(/\r?\n/)
            .flatMap((preview, index) =>
              preview.toLowerCase().includes(query.toLowerCase())
                ? [{ path, line: index + 1, preview }]
                : [],
            ),
        ),
        truncated: false,
      }),
    };
  },
};
