// Re-lists, for each lucide icon already in docs/icons-states-remaining.json,
// the source files that import it (after code moves between files). It never
// adds an icon: a new lucide import still needs its own documented reason.
import fs from "node:fs";
const file = "docs/icons-states-remaining.json";
const inventory = JSON.parse(fs.readFileSync(file, "utf8"));
const sources = fs
  .readdirSync("src", { recursive: true, withFileTypes: true })
  .filter((entry) => entry.isFile() && /\.tsx?$/.test(entry.name))
  .map((entry) => `${entry.parentPath}/${entry.name}`);
const users = new Map();
for (const path of sources)
  for (const match of fs
    .readFileSync(path, "utf8")
    .matchAll(/import\s*\{([^}]+)\}\s*from "lucide-react"/g))
    for (const name of match[1]
      .split(",")
      .map((part) => part.trim())
      .filter(Boolean))
      users.set(name, [...(users.get(name) ?? []), path]);
for (const [name, entry] of Object.entries(
  inventory.remaining.namedLucideImports,
))
  entry.files = [...new Set(users.get(name) ?? [])].sort();
fs.writeFileSync(file, `${JSON.stringify(inventory, null, 2)}\n`);
