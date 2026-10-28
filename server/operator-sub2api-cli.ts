import path from "node:path";
import { loadSub2ApiConfig, saveSub2ApiConfig } from "./sub2api-config";

const usage = [
  "Usage: operator-sub2api --data-dir DIR (--url URL | --show)",
  "  --url URL   sign in, plans, models and quota come from this Claudex service",
  "  --show      print the service in use",
  "Takes effect at the next app start. CLAUDEX_SUB2API_URL is used when no file is set,",
  "else the default Claudex service. There are no local accounts.",
].join("\n");

function option(name: string) {
  const index = process.argv.indexOf(name);
  return index < 0 ? undefined : process.argv[index + 1];
}

const dataDir = option("--data-dir");
if (!dataDir) {
  console.error(usage);
  process.exit(2);
}
const root = path.resolve(dataDir);
try {
  const url = option("--url");
  if (url) {
    const saved = saveSub2ApiConfig(root, url);
    console.log(`Sub2API backend set to ${saved.baseUrl}.`);
  } else if (process.argv.includes("--show")) {
    console.log(`Claudex service: ${loadSub2ApiConfig(root).baseUrl}`);
  } else {
    console.error(usage);
    process.exit(2);
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
