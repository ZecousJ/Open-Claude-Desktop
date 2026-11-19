import fs from 'node:fs';import path from 'node:path';import {createHash} from 'node:crypto';
export const hostWorkspaceTrustRevision='claudex-workspace-trust-scope-v3';
export const hostWorkspaceTrustOriginalHashes={
  "ce2cf86ad-xBQnhcQf.js": "9d1f2f1744fa1880713d5b79e3e3576dd1e00dde56ca63143c566467db2e15a8",
  "c516e93ca-D70RQPy8.js": "2b1f965f77d59ea07e3d55671e35051cbb532fd59673a86b98c1161629aa63be",
  "c165c93f1-d-JWv0qg.js": "49a6bafe59de533e118c9fb1eee2f0378d96cd3d890eb0406efe393f5fcc4474",
  "cc43287c9-BDrqHHqn.js": "8c2d97cb1dc34e2ecb2e1c6918bac434b698dee3833e447527b445b38509c03f",
  "c6a2a31c4-Ctc4FG8F.js": "5e13d857dfdf2214034d4077f4e8334fd6b260d4ce2ac76a16ae2d126b182b7b"
};
export const hostWorkspaceTrustInputHashes={
  "ce2cf86ad-xBQnhcQf.js": "9d1f2f1744fa1880713d5b79e3e3576dd1e00dde56ca63143c566467db2e15a8",
  "c516e93ca-D70RQPy8.js": "1e665cff0c14c2bdd3a0ec3c4666021ddc9624c8033b7990120984a1054ef5aa",
  "c165c93f1-d-JWv0qg.js": "fd5e8ef55dc2496feb1be05b7636dad318f52f09dba617e6861b07a299008b45",
  "cc43287c9-BDrqHHqn.js": "37435742fba07f7db79e31d4ffc92b10074cd5e7dbbb6274593968a1cd914d08",
  "c6a2a31c4-Ctc4FG8F.js": "d364e54a07ab9bb8637470169f7aaa9364e515f50f83685a437cdb910c0615da"
};
export const hostWorkspaceTrustRules=[
  {
    file: 'cc43287c9-BDrqHHqn.js',
    name: 'picker-candidate-root-display',
    before: 'let n = await x(e, t.sources, i);',
    after: 'let n = await x(e, t.sources, i, { claudexTrustRoot: t.claudexTrustRoot });',
  },
  {
    file: 'ce2cf86ad-xBQnhcQf.js',
    name: 'ssh-trust-query-identity',
    before: 'return ["epitaxy", "workspace-trust", v(t), e];',
    after: 'return ["epitaxy", "workspace-trust", v(t), e, ...(t?.kind === "ssh" ? [t.sshIdentityFile ?? ""] : [])];',
  },
  {
    "file": "ce2cf86ad-xBQnhcQf.js",
    "name": "merge-root-display",
    "before": "                  sources: Array.from(new Set([...c.sources, ...r])),",
    "after": "                  sources: Array.from(new Set([...c.sources, ...r])),\n                  claudexTrustRoot: s?.claudexTrustRoot ?? c.claudexTrustRoot,"
  },
  {
    "file": "ce2cf86ad-xBQnhcQf.js",
    "name": "pending-root-display",
    "before": "                cwd: n,\n                sources: r,",
    "after": "                cwd: n,\n                claudexTrustRoot: s?.claudexTrustRoot,\n                sources: r,"
  },
  {
    "file": "ce2cf86ad-xBQnhcQf.js",
    "name": "checked-root-display",
    "before": "{ gateId: i?.gateId ?? n });",
    "after": "{ gateId: i?.gateId ?? n, claudexTrustRoot: a.claudexTrustRoot });"
  },
  {
    "file": "ce2cf86ad-xBQnhcQf.js",
    "name": "requested-root-display",
    "before": "{ requestedBy: r });",
    "after": "{ requestedBy: r, claudexTrustRoot: i.claudexTrustRoot });"
  },
  {
    "file": "ce2cf86ad-xBQnhcQf.js",
    "name": "prefetched-root-display",
    "before": ": n(r, c.sources, o);",
    "after": ": n(r, c.sources, o, { claudexTrustRoot: c.claudexTrustRoot });"
  },
  {
    "file": "c516e93ca-D70RQPy8.js",
    "name": "gate-root-prop",
    "before": "                workspace: N.cwd,",
    "after": "                workspace: N.cwd,\n                workspaceRoot: N.claudexTrustRoot,"
  },
  {
    "file": "c516e93ca-D70RQPy8.js",
    "name": "gate-root-memo-check",
    "before": "    J1($, 25, N.cwd) ||",
    "after": "    J1($, 25, N) ||"
  },
  {
    "file": "c516e93ca-D70RQPy8.js",
    "name": "gate-root-memo-store",
    "before": "            N.cwd,\n          ),",
    "after": "            N,\n          ),"
  },
  {
    "file": "c165c93f1-d-JWv0qg.js",
    "name": "dialog-root-prop",
    "before": "      workspace: i,",
    "after": "      workspace: i,\n      workspaceRoot: __claudexTrustRoot,"
  },
  {
    "file": "c165c93f1-d-JWv0qg.js",
    "name": "dialog-root-key",
    "before": "    h = d(),\n    g = T(a || !n ? null : i),",
    "after": "    h = d(),\n    __claudexRoot = typeof __claudexTrustRoot === \"string\" && __claudexTrustRoot.length > 0 && __claudexTrustRoot.length <= 4096 && !/[\\0\\r\\n]/.test(__claudexTrustRoot) ? __claudexTrustRoot : undefined,\n    __claudexRootKey = JSON.stringify([i, __claudexRoot, h.locale]),\n    g = T(a || !n ? null : i),"
  },
  {
    "file": "c165c93f1-d-JWv0qg.js",
    "name": "dialog-existing-scope-description",
    "before": "    E = J1($, 6, i)\n      ? K1($, 6, i, r(\"div\", { dir: \"ltr\", className: A, children: r(P, { value: i }) }))",
    "after": "    E = J1($, 6, __claudexRootKey)\n      ? K1($, 6, __claudexRootKey, __claudexRoot && __claudexRoot !== i ? t(\"div\", { children: [r(\"div\", { dir: \"ltr\", className: A, children: r(P, { value: i }) }), __claudexRoot && __claudexRoot !== i ? r(\"p\", { className: M, children: h.formatMessage({ defaultMessage: __claudexTrustMessages[h.locale] ?? \"Trusting applies to the whole repository at {root}.\", id: \"claudex.workspace-trust.repository-scope\" }, { root: __claudexRoot }) }) : null] }) : r(\"div\", { dir: \"ltr\", className: A, children: r(P, { value: i }) }))"
  },
  {
    "file": "cc43287c9-BDrqHHqn.js",
    "name": "branch-root-capture",
    "before": "ge({ cwd: t, sources: r.sources, targetBranch: e })",
    "after": "ge({ cwd: t, claudexTrustRoot: r.claudexTrustRoot, sources: r.sources, targetBranch: e })"
  },
  {
    "file": "cc43287c9-BDrqHHqn.js",
    "name": "branch-root-state",
    "before": "                cwd: he.cwd,\n                sources: he.sources,",
    "after": "                cwd: he.cwd,\n                claudexTrustRoot: he.claudexTrustRoot,\n                sources: he.sources,"
  },
  {
    "file": "cc43287c9-BDrqHHqn.js",
    "name": "branch-root-dialog",
    "before": "                workspace: N.cwd,\n                sources: N.sources,",
    "after": "                workspace: N.cwd,\n                workspaceRoot: N.claudexTrustRoot,\n                sources: N.sources,"
  },
  {
    "file": "c6a2a31c4-Ctc4FG8F.js",
    "name": "customize-root-capture",
    "before": "c({ cwd: e, sources: t.sources })",
    "after": "c({ cwd: e, claudexTrustRoot: t.claudexTrustRoot, sources: t.sources })"
  },
  {
    "file": "c6a2a31c4-Ctc4FG8F.js",
    "name": "customize-root-dialog",
    "before": "                workspace: s.cwd,\n                sources: s.sources,",
    "after": "                workspace: s.cwd,\n                workspaceRoot: s.claudexTrustRoot,\n                sources: s.sources,"
  }
];
export const hostWorkspaceTrustMessages={"de-DE": "Das Vertrauen gilt für das gesamte Repository unter {root}.", "es-419": "La confianza se aplica a todo el repositorio en {root}.", "es-ES": "La confianza se aplica a todo el repositorio en {root}.", "fr-FR": "La confiance s’applique à l’ensemble du dépôt situé dans {root}.", "hi-IN": "भरोसा {root} पर मौजूद पूरी रिपॉज़िटरी पर लागू होता है।", "id-ID": "Kepercayaan berlaku untuk seluruh repositori di {root}.", "it-IT": "L’attendibilità si applica all’intero repository in {root}.", "ja-JP": "信頼は {root} にあるリポジトリ全体に適用されます。", "ko-KR": "신뢰는 {root}에 있는 전체 저장소에 적용됩니다.", "pt-BR": "A confiança se aplica a todo o repositório em {root}.", "zh-CN": "信任将应用于位于 {root} 的整个仓库。"};
const sha=s=>createHash('sha256').update(s).digest('hex');
export function deriveOfficialUiHostWorkspaceTrustModule(file,source){
 if(!Object.hasOwn(hostWorkspaceTrustInputHashes,file))return source;
 if(sha(source)!==hostWorkspaceTrustInputHashes[file])throw Error('Pinned workspace trust input mismatch: '+file);
 let result=source;for(const rule of hostWorkspaceTrustRules.filter(r=>r.file===file)){
 const at=result.indexOf(rule.before);if(at<0||result.indexOf(rule.before,at+rule.before.length)>=0)throw Error('Pinned workspace trust anchor mismatch: '+rule.name);
 result=result.slice(0,at)+rule.after+result.slice(at+rule.before.length);
 }if(file==="c165c93f1-d-JWv0qg.js")result="const __claudexTrustMessages="+JSON.stringify(hostWorkspaceTrustMessages)+";\n"+result;return result;
}
export function applyOfficialUiHostWorkspaceTrust(directory){
 directory=fs.realpathSync(directory);if(directory.split(path.sep).includes('.restore'))throw Error('Recovered sources are immutable');
 const rows=Object.keys(hostWorkspaceTrustInputHashes).map(file=>{const location=path.join(directory,file);if(fs.lstatSync(location).isSymbolicLink())throw Error('Workspace trust output symlink rejected');const source=fs.readFileSync(location,'utf8');return{file,location,source,output:deriveOfficialUiHostWorkspaceTrustModule(file,source)}});
 for(const row of rows)fs.writeFileSync(row.location,row.output);
 return{revision:hostWorkspaceTrustRevision,modules:rows.map(r=>({file:r.file,originalSha256:hostWorkspaceTrustOriginalHashes[r.file],inputSha256:sha(r.source),outputSha256:sha(r.output),rules:hostWorkspaceTrustRules.filter(x=>x.file===r.file).map(x=>x.name)}))};
}
