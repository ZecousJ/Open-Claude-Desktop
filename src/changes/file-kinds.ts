/**
 * Which section of the Changes panel a file belongs to: generated files
 * (lockfiles, generated folders and suffixes, minified and map files, build
 * output), build files (Bazel), test files, and the rest. The checks run in
 * that order, so a generated test helper is generated.
 */
export type FileKind = "source" | "test" | "build" | "generated";

/** The separated sections in the order they follow the source files. */
export const separatedKinds = ["test", "build", "generated"] as const;
export type SeparatedKind = (typeof separatedKinds)[number];

export const kindLabels: Record<SeparatedKind, string> = {
  test: "Test files",
  build: "Build files",
  generated: "Generated files",
};

const generated = new RegExp(
  [
    "(^|\\/)(package-lock\\.json|npm-shrinkwrap\\.json|yarn\\.lock|pnpm-lock\\.yaml|bun\\.lockb?|Cargo\\.lock|Gemfile\\.lock|Podfile\\.lock|composer\\.lock|poetry\\.lock|uv\\.lock|Pipfile\\.lock|go\\.sum|flake\\.lock|pubspec\\.lock|mix\\.lock|packages\\.lock\\.json)$",
    "(^|\\/)(__generated__|generated|gen)\\/",
    "[._]gen(erated)?\\.[^/]+$",
    "\\.pb\\.(go|h|cc|ts|js)$",
    "\\.pb\\.gw\\.go$",
    "_pb2(_grpc)?\\.pyi?$",
    "_pb\\.(d\\.ts|js|ts)$",
    "\\.g\\.dart$",
    "\\.[Dd]esigner\\.cs$",
    "\\.min\\.(js|css)$",
    "\\.(js|css)\\.map$",
    "(^|\\/)(\\.next|\\.nuxt|\\.svelte-kit|\\.parcel-cache|__pycache__)\\/",
    "\\.(pyc|tsbuildinfo)$",
    "^dist\\/",
  ].join("|"),
);
const build = new RegExp(
  [
    "(^|\\/)BUILD(\\.bazel)?$",
    "(^|\\/)WORKSPACE(\\.bazel|\\.bzlmod)?$",
    "(^|\\/)MODULE\\.bazel(\\.lock)?$",
    "\\.bzl$",
  ].join("|"),
);
const testFile = new RegExp(
  [
    "(^|\\/)__(tests|snapshots)__\\/",
    "[._](test|spec)\\.[^/]+$",
    "(^|\\/)test_[^/]*\\.py$",
    "\\.snap$",
    "\\.stories\\.[jt]sx?$",
    "(^|\\/)conftest\\.py$",
    "Tests?\\.(swift|kt|java)$",
    "_unittest\\.(cc|cpp)$",
    "(^|\\/|_)tests\\.rs$",
    "(^|\\/)(tests?|testdata|spec|__Snapshots__|e2e([-_]tests?)?)\\/",
    "(^|\\/)[^/]+[-_]tests\\/",
  ].join("|"),
);

/** A path relative to the repository's top, with "/" separators. */
export function fileKind(path: string): FileKind {
  if (generated.test(path)) return "generated";
  if (build.test(path)) return "build";
  if (testFile.test(path)) return "test";
  return "source";
}

/** Splits files by kind, keeping their order within each. */
export function filesByKind<T extends { path: string }>(files: readonly T[]) {
  const groups: Record<FileKind, T[]> = {
    source: [],
    test: [],
    build: [],
    generated: [],
  };
  for (const file of files) groups[fileKind(file.path)].push(file);
  return groups;
}

/** Diffs this big start folded (the original's large-diff rule). */
export const largeDiffLines = 10_000;
export const largeDiffFiles = 300;
export function isLargeDiff(
  files: readonly { additions: number; deletions: number }[],
) {
  let lines = 0;
  for (const file of files) lines += file.additions + file.deletions;
  return lines > largeDiffLines || files.length > largeDiffFiles;
}
