/**
 * Extracts the official desktop main process's native IPC schema (the `_o(ns,
 * "Domain", …, { methods, events })` tables) with each return type's validator
 * source, from an official desktop package, into a JSON reference used to
 * implement and test electron/official-ui/native.
 *   node scripts/extract-native-schema.mjs <desktop .vite/build dir> <out.json>
 */
import fs from "node:fs";
import path from "node:path";
const [dir, out] = process.argv.slice(2);
const files = fs.readdirSync(dir).filter((f) => f.endsWith(".js")).map((f) => path.join(dir, f));
const sources = files.map((f) => fs.readFileSync(f, "utf8"));
const all = sources.join("\n");
/** Reads a balanced bracket expression starting at s[i] ("[" or "{" or "("). */
function balanced(s, i) {
  const open = s[i], close = { "[": "]", "{": "}", "(": ")" }[open];
  let depth = 0, inStr = null;
  for (let j = i; j < s.length; j++) {
    const c = s[j];
    if (inStr) { if (c === "\\") j++; else if (c === inStr) inStr = null; continue; }
    if (c === '"' || c === "'" || c === "`") { inStr = c; continue; }
    if (c === "[" || c === "{" || c === "(") depth++;
    else if (c === "]" || c === "}" || c === ")") { depth--; if (depth === 0) return s.slice(i, j + 1); }
  }
  return s.slice(i);
}
/** Splits a top-level comma list inside brackets. */
function items(list) {
  const inner = list.slice(1, -1); const parts = []; let depth = 0, start = 0, inStr = null;
  for (let j = 0; j < inner.length; j++) {
    const c = inner[j];
    if (inStr) { if (c === "\\") j++; else if (c === inStr) inStr = null; continue; }
    if (c === '"' || c === "'" || c === "`") { inStr = c; continue; }
    if ("[{(".includes(c)) depth++; else if ("]})".includes(c)) depth--;
    else if (c === "," && depth === 0) { parts.push(inner.slice(start, j)); start = j + 1; }
  }
  if (inner.slice(start).trim()) parts.push(inner.slice(start));
  return parts.map((p) => p.trim());
}
const unquote = (s) => s.replace(/^"|"$/g, "");
const validators = new Map();
function validator(name) {
  if (!/^[\w$]+$/.test(name)) return name;
  if (validators.has(name)) return name;
  validators.set(name, null);
  const re = new RegExp(`function ${name.replace(/\$/g, "\\$")}\\(`);
  for (const s of sources) {
    const m = re.exec(s);
    if (m) { const body = balanced(s, s.indexOf("{", m.index)); validators.set(name, `function ${name}${s.slice(m.index + 9 + name.length, s.indexOf("{", m.index))}${body}`.slice(0, 4000)); break; }
  }
  return name;
}
const schema = {};
const re = /_o\(([\w$]+),"(\w+)",([\w$]+),\{/g;
let m;
while ((m = re.exec(all))) {
  const domain = m[2];
  const body = balanced(all, m.index + m[0].length - 1);
  const entry = { methods: {}, events: {} };
  for (const kind of ["methods", "events"]) {
    const at = body.indexOf(`${kind}:[`);
    if (at < 0) continue;
    for (const item of items(balanced(body, at + kind.length + 1))) {
      const parts = items(item);
      const name = unquote(parts[0]);
      const params = parts[1] ? items(parts[1]).map((p) => { const q = items(p); return { name: unquote(q[0]), type: q[1] }; }) : [];
      if (kind === "methods") entry.methods[name] = { params, returns: parts[2] ? validator(parts[2].replace(/^R\((.*)\)$/, "$1").replace(/^z\((.*)\)$/, "$1")) && parts[2] : null };
      else entry.events[name] = params;
    }
  }
  const stores = body.match(/stores:\[[^\]]*\]/);
  if (stores) entry.stores = stores[0];
  schema[domain] = schema[domain] ? { ...schema[domain], methods: { ...schema[domain].methods, ...entry.methods }, events: { ...schema[domain].events, ...entry.events } } : entry;
  for (const meth of Object.values(entry.methods)) for (const p of meth.params) validator(p.type.replace(/^R\((.*)\)$/, "$1").replace(/^z\((.*)\)$/, "$1"));
}
// zod-backed validators (`X.safeParse(e).success`): keep the schema's own text too.
const zods = {};
for (const [name, body] of validators) {
  const z = body && /return ([\w$]+)\.safeParse/.exec(body);
  if (!z) continue;
  const id = z[1];
  const def = new RegExp(`[,;\\s]${id.replace(/\$/g, "\\$")}=`);
  for (const src of sources) {
    const d = def.exec(src);
    if (!d) continue;
    let j = d.index + d[0].length, text = "";
    // The definition runs to the next top-level comma or semicolon.
    let depth = 0, inStr = null;
    for (; j < src.length && j - d.index < 6000; j++) {
      const c = src[j];
      if (inStr) { if (c === "\\") j++; else if (c === inStr) inStr = null; continue; }
      if (c === '"' || c === "'" || c === "`") { inStr = c; continue; }
      if ("[{(".includes(c)) depth++; else if ("]})".includes(c)) depth--;
      else if ((c === "," || c === ";") && depth === 0) break;
    }
    text = src.slice(d.index + d[0].length, j);
    zods[id] = text;
    break;
  }
}
fs.writeFileSync(out, JSON.stringify({ zods, domains: schema, validators: Object.fromEntries([...validators].filter(([, v]) => v)) }, null, 1));
console.log(`${Object.keys(schema).length} domains, ${Object.values(schema).reduce((n, d) => n + Object.keys(d.methods).length, 0)} methods, ${validators.size} types`);
