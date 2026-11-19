import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import {
  diffTotals,
  fileChangeDiff,
  parseUnifiedDiff,
} from "../../shared/diff-model";

function repository(
  run: (repo: {
    git: (...args: string[]) => string;
    put: (path: string, content: string) => void;
    root: string;
  }) => void,
) {
  const root = mkdtempSync(join(tmpdir(), "claudex-diff-"));
  const hooks = join(root, "empty-hooks");
  mkdirSync(hooks);
  const git = (...args: string[]) =>
    execFileSync(
      "git",
      [
        "-c",
        "core.quotePath=true",
        "-c",
        "core.autocrlf=false",
        "-c",
        "core.filemode=true",
        "-c",
        "commit.gpgsign=false",
        "-c",
        `core.hooksPath=${hooks}`,
        "-c",
        "user.name=Diff Test",
        "-c",
        "user.email=diff@example.invalid",
        ...args,
      ],
      { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
  const put = (path: string, content: string) => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  };
  try {
    git("init", "-q");
    git("commit", "--allow-empty", "-qm", "baseline");
    run({ git, put, root });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
const diffArgs = [
  "diff",
  "--no-ext-diff",
  "--no-textconv",
  "--no-color",
  "--src-prefix=a/",
  "--dst-prefix=b/",
];
const posixPaths = {
  skip:
    process.platform === "win32"
      ? "Fixture uses filenames unsupported by Windows"
      : false,
};
const names = [
  "ordinary.txt",
  "space name.txt",
  "x b/y b/z.txt",
  "tab\tname",
  'quote"name',
  "back\\slash",
  "line\nname",
  "目录/波奇😀.txt",
  "trailing ",
];
for (const quote of [true, false])
  for (const path of names) {
    test(
      `Git modified identity ${JSON.stringify(path)}, quotePath=${quote}`,
      {
        skip:
          process.platform === "win32" && /["\\\t\n]| $/.test(path)
            ? "Filename unsupported by Windows"
            : false,
      },
      () =>
        repository(({ git, put }) => {
          put(path, "same\nconst old = 1;\nlast\n");
          git("add", ".");
          git("commit", "-qm", "file");
          put(path, "same\nconst new = 1;\nlast\n");
          const files = parseUnifiedDiff(
            git("-c", `core.quotePath=${quote}`, ...diffArgs),
          );
          assert.equal(files.length, 1);
          const file = files[0];
          assert.equal(file.path, path);
          assert.equal(file.oldPath, undefined);
          assert.equal(file.status, "modified");
          assert.deepEqual(diffTotals(files), {
            files: 1,
            additions: 1,
            deletions: 1,
          });
          assert.deepEqual(
            file.hunks[0].lines.map(({ kind, oldNo, newNo }) => ({
              kind,
              oldNo,
              newNo,
            })),
            [
              { kind: "context", oldNo: 1, newNo: 1 },
              { kind: "del", oldNo: 2, newNo: undefined },
              { kind: "add", oldNo: undefined, newNo: 2 },
              { kind: "context", oldNo: 3, newNo: 3 },
            ],
          );
          assert.deepEqual(file.hunks[0].lines[1].changed, [[6, 9]]);
        }),
    );
  }
for (const empty of [false, true])
  for (const operation of ["add", "delete"] as const) {
    test(`Git ${empty ? "empty" : "text"} ${operation}`, posixPaths, () =>
      repository(({ git, put, root }) => {
        const path = "目录/x b/y\t.txt";
        put(path, empty ? "" : "old\n");
        git("add", ".");
        if (operation === "delete") {
          git("commit", "-qm", "file");
          rmSync(join(root, path));
          git("add", "-A");
        }
        const patch = git(...diffArgs, "--cached");
        const [file] = parseUnifiedDiff(patch);
        assert.equal(file?.path, path);
        assert.equal(file.status, operation === "add" ? "added" : "deleted");
        assert.equal(file.additions, operation === "add" && !empty ? 1 : 0);
        assert.equal(file.deletions, operation === "delete" && !empty ? 1 : 0);
        if (!empty && operation === "delete") {
          const bare = patch.slice(patch.indexOf("--- "));
          assert.equal(parseUnifiedDiff(bare)[0].path, path);
        }
      }),
    );
  }
for (const edited of [false, true])
  for (const [from, to] of [
    ["a/plain b/name", 'b/目录\t"name'],
    ['a/目录\t"name', "b/plain b/name"],
  ]) {
    test(
      `Git ${edited ? "edited" : "pure"} rename ${JSON.stringify(from)}`,
      posixPaths,
      () =>
        repository(({ git, put, root }) => {
          const body = Array.from({ length: 20 }, (_, n) => `line ${n}\n`).join(
            "",
          );
          put(from, body);
          git("add", ".");
          git("commit", "-qm", "file");
          mkdirSync(dirname(join(root, to)), { recursive: true });
          git("mv", from, to);
          if (edited) put(to, body + "extra\n");
          git("add", "-A");
          const [file] = parseUnifiedDiff(git(...diffArgs, "--cached", "-M"));
          assert.equal(file?.path, to);
          assert.equal(file.oldPath, from);
          assert.equal(file.status, "renamed");
          assert.equal(file.additions, edited ? 1 : 0);
        }),
    );
  }
test("Git copy metadata preserves actual a and b directories", posixPaths, () =>
  repository(({ git, put }) => {
    const from = "a/目录\tfile",
      to = "b/copy name";
    put(from, "same\n");
    git("add", ".");
    git("commit", "-qm", "file");
    put(to, "same\n");
    git("add", ".");
    const [file] = parseUnifiedDiff(
      git(...diffArgs, "--cached", "-C", "--find-copies-harder"),
    );
    assert.equal(file.path, to);
    assert.equal(file.oldPath, from);
  }),
);
for (const binaryPatch of [false, true])
  for (const operation of ["add", "delete", "modify"] as const) {
    test(`Git binary ${operation} patch=${binaryPatch}`, posixPaths, () =>
      repository(({ git, put, root }) => {
        const path = "目录/binary b/file\t";
        put(path, "old\0data");
        git("add", ".");
        if (operation !== "add") {
          git("commit", "-qm", "file");
          if (operation === "delete") rmSync(join(root, path));
          else put(path, "new\0data");
          git("add", "-A");
        }
        const [file] = parseUnifiedDiff(
          git(...diffArgs, "--cached", ...(binaryPatch ? ["--binary"] : [])),
        );
        assert.equal(file?.path, path);
        assert.equal(file.binary, true);
        assert.deepEqual(file.hunks, []);
        assert.equal(
          file.status,
          operation === "modify"
            ? "modified"
            : operation === "add"
              ? "added"
              : "deleted",
        );
      }),
    );
  }
test(
  "Git mode-only names with ambiguous spaces and quoted bytes",
  {
    skip:
      process.platform === "win32"
        ? "Windows does not provide POSIX executable bits or fixture names"
        : false,
  },
  () =>
    repository(({ git, put, root }) => {
      for (const path of ["x b/y b/z", "目录/tab\t"]) put(path, "same\n");
      git("add", ".");
      git("commit", "-qm", "file");
      for (const path of ["x b/y b/z", "目录/tab\t"])
        chmodSync(join(root, path), 0o755);
      const files = parseUnifiedDiff(git(...diffArgs));
      assert.deepEqual(
        files.map((f) => f.path).sort(),
        ["x b/y b/z", "目录/tab\t"].sort(),
      );
      for (const file of files) {
        assert.equal(file.executable, true);
        assert.deepEqual(file.hunks, []);
      }
    }),
);
test(
  "Git adjacent special and ordinary files keep their own hunks",
  posixPaths,
  () =>
    repository(({ git, put }) => {
      for (const path of names) put(path, "old\n");
      git("add", ".");
      git("commit", "-qm", "files");
      for (const path of names) put(path, "new\n");
      const files = parseUnifiedDiff(git(...diffArgs));
      assert.deepEqual(files.map((f) => f.path).sort(), [...names].sort());
      for (const file of files) {
        assert.equal(file.additions, 1);
        assert.equal(file.deletions, 1);
      }
    }),
);
test("adjacent header-only unified records remain separate", () => {
  const files = parseUnifiedDiff(
    "--- a/one\n+++ b/one\n--- a/two\n+++ /dev/null\n",
  );
  assert.equal(files.length, 2);
  assert.equal(files[0].path, "one");
  assert.equal(files[1].path, "two");
  assert.equal(files[1].status, "deleted");
});
test("malformed Git records preserve boundaries and avoid guessed identities", () => {
  for (const header of [
    '"a/bad\\q" "b/bad\\q"',
    '"a/unterminated b/name',
    "a/first b/second b/third",
  ]) {
    const files = parseUnifiedDiff(
      `diff --git ${header}\nGIT binary patch\n@@ -1 +1 @@\n-x\n+y\ndiff --git a/good b/good\n--- a/good\n+++ b/good\n@@ -1 +1 @@\n-old\n+new\n`,
      "fallback",
    );
    assert.equal(files.length, 2);
    assert.equal(files[0].path, "fallback");
    assert.equal(files[0].binary, true);
    assert.deepEqual(files[0].hunks, []);
    assert.equal(files[1].path, "good");
    assert.equal(files[1].additions, 1);
  }
});
test("bare hunks, no-newline markers and event paths retain their contract", () => {
  const patch =
    "@@ -1 +1 @@\n-old\n\\ No newline at end of file\n+new\n\\ No newline at end of file\n";
  const [file] = parseUnifiedDiff(patch, "fallback");
  assert.equal(file.path, "fallback");
  assert.equal(file.additions, 1);
  assert.equal(file.deletions, 1);
  const moved = fileChangeDiff({
    path: "a/actual\\name",
    kind: { type: "update", move_path: "b/new\tname" },
    diff: patch,
  });
  assert.equal(moved.path, "b/new\tname");
  assert.equal(moved.oldPath, "a/actual\\name");
  assert.equal(moved.status, "renamed");
  for (const kind of ["add", "delete"]) {
    const content = "--- a/content\n+++ b/content\n";
    const whole = fileChangeDiff({ path: "literal", kind, diff: content });
    assert.equal(whole.hunks[0].lines.length, 2);
    assert.equal(whole.hunks[0].lines[0].text, "--- a/content");
  }
});

for (const edited of [false, true])
  test(`Git binary rename edited=${edited}`, posixPaths, () =>
    repository(({ git, put, root }) => {
      const from = "a/目录\told",
        to = "b/binary b/new";
      const body = Array.from(
        { length: 100 },
        (_, n) => `${n}\0payload\n`,
      ).join("");
      put(from, body);
      git("add", ".");
      git("commit", "-qm", "file");
      mkdirSync(dirname(join(root, to)), { recursive: true });
      git("mv", from, to);
      if (edited) put(to, body + "extra\0payload\n");
      git("add", "-A");
      const patch = git(...diffArgs, "--cached", "-M", "--binary");
      assert.match(patch, /rename from /);
      const [file] = parseUnifiedDiff(patch);
      assert.equal(file.path, to);
      assert.equal(file.oldPath, from);
      assert.equal(file.status, "renamed");
      assert.deepEqual(file.hunks, []);
      if (edited) assert.equal(file.binary, true);
    }),
  );

test("portable quoted paths decode every Git escape and UTF-8 without normalization", () => {
  const encoded = String.raw`\357\273\277目录\a\b\t\n\v\f\r\\\"\346\263\242\345\245\207`;
  const path = '\uFEFF目录\x07\b\t\n\v\f\r\\"波奇';
  const [file] = parseUnifiedDiff(
    `diff --git "a/${encoded}" "b/${encoded}"\nrename from "${encoded}"\nrename to "b/${encoded}"\n`,
  );
  assert.equal(file.oldPath, path);
  assert.equal(file.path, `b/${path}`);
  const [marker] = parseUnifiedDiff(
    `--- "a/${encoded}"\told timestamp\n+++ /dev/null\n`,
  );
  assert.equal(marker.path, path);
  assert.equal(marker.status, "deleted");
});

test("real Git marker pairs remain distinct with and without their hunks", () =>
  repository(({ git, put, root }) => {
    put("one", "old\n");
    put("two", "old\n");
    git("add", ".");
    git("commit", "-qm", "files");
    rmSync(join(root, "one"));
    rmSync(join(root, "two"));
    const patches = ["one", "two"].map((path) => {
      const patch = git(...diffArgs, "--", path);
      return patch.slice(patch.indexOf("--- "));
    });
    for (const hunks of [true, false]) {
      const files = parseUnifiedDiff(
        patches
          .map((patch) => (hunks ? patch : patch.slice(0, patch.indexOf("@@"))))
          .join(""),
      );
      assert.deepEqual(
        files.map((file) => [file.path, file.status, file.deletions]),
        [
          ["one", "deleted", hunks ? 1 : 0],
          ["two", "deleted", hunks ? 1 : 0],
        ],
      );
    }
  }));

test("explicit path metadata overrides Git header guesses", () => {
  const [file] = parseUnifiedDiff(
    "diff --git a/guess b/guess\nrename from a/real old\nrename to b/real new\n--- a/stale\n+++ b/stale\n",
  );
  assert.equal(file.path, "b/real new");
  assert.equal(file.oldPath, "a/real old");
  const [marker] = parseUnifiedDiff(
    "diff --git a/guess b/guess\n--- a/actual \tstamp\n+++ /dev/null\n",
  );
  assert.equal(marker.path, "actual ");
  assert.equal(marker.oldPath, undefined);
  for (const invalid of [
    String.raw`\377`,
    String.raw`\400`,
    String.raw`\12`,
    String.raw`\q`,
  ]) {
    const files = parseUnifiedDiff(
      `diff --git "a/${invalid}" "b/${invalid}"\ndiff --git a/valid b/valid\n`,
      "fallback",
    );
    assert.deepEqual(
      files.map((file) => file.path),
      ["fallback", "valid"],
    );
  }
});

test("Codex event paths override identities in a real Git patch", () =>
  repository(({ git, put }) => {
    put("generated", "old\n");
    git("add", ".");
    git("commit", "-qm", "file");
    put("generated", "new\n");
    const patch = git(...diffArgs);
    const file = fileChangeDiff({
      path: "literal\\old",
      kind: { type: "update", move_path: 'b/literal"new' },
      diff: patch,
    });
    assert.equal(file.path, 'b/literal"new');
    assert.equal(file.oldPath, "literal\\old");
    assert.equal(file.additions, 1);
    assert.equal(file.deletions, 1);
  }));
