/** Read-only companion inventory of the current product and historical audits.
 * Historical marks are evidence data, never current acceptance or instructions.
 */
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import ts from "typescript";

const root = path.resolve(import.meta.dirname, "../..");
const read = file => fs.readFileSync(path.join(root, file), "utf8");
const hash = value => createHash("sha256").update(value).digest("hex");
const visit = (node, fn) => { fn(node); ts.forEachChild(node, child => visit(child, fn)); };
export function collectProductSurface() {
  const syntax = JSON.parse(execFileSync(process.execPath, ["--import", "tsx", "scripts/audit/collect-interface-syntax.mjs"], { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }));
  // Keep the scanner's Go export-data reader current without changing the
  // product's backend dependencies or its module/sum files.
  const go = JSON.parse(execFileSync("go", ["run", "-mod=mod", "./extract-go-routes.go", root], { cwd: path.join(root, "scripts/audit"), encoding: "utf8", maxBuffer: 32 * 1024 * 1024 }));
  const files = [...new Set(syntax.files)].sort();
  const checks = [];
  const parityChecks = [];
  const parityFile = "docs/parity-progress.md";
  const parityLines = read(parityFile).split(/\r?\n/);
  parityLines.forEach((raw, index) => {
    const bracket = /^\s*[-*+]\s+\[([^\]]*)\]/.exec(raw);
    if (!bracket) return;
    const item = /^\s*[-*+]\s+\[[^\]]*\]\s+`([^`]+)`/.exec(raw);
    const marker = bracket[1];
    parityChecks.push({ id: item?.[1] ?? `UNPARSED-L${index + 1}`, marker: `[${marker}]`, original: raw,
      source: `${parityFile}:${index + 1}`, mapping: "未逐条映射至新版官方UI功能/接口；保留全部历史要求",
      verification: marker === "x" ? "历史标记完成；不是当前新版验收" : marker === "s" ? "历史部分实现/有差异；当前未完成" : marker === "-" ? "历史跳过/豁免；须复核新版适用性" : "未完成或未知标记；不得丢弃",
      mac: "新版未逐条复核", windows: "未完成实机验收", web: "未完成真实浏览器验收" });
  });
  checks.push({item:"历史差异全部 checkbox（含 s/未知格式）", expected:parityLines.filter(line=>/^\s*[-*+]\s+\[/.test(line)).length, actual:parityChecks.length, scope:"逐源行保留，不以标准格式或完成标记筛选"});
  const fidelity = JSON.parse(read("fidelity/coverage.json"));
  const uiStates = [];
  for (const item of fidelity.cases) {
    // Preserve every actual state key as well as every required baseline key.
    for (const state of new Set(["static", "hover", "hoverHold", "pressed", "drag", "focus", "enter", "exit", "dynamic", ...Object.keys(item.states ?? {})]))
      uiStates.push({id:`${item.id}:${state}`, component:item.id, state, historical:item.states?.[state] ?? "源未列出",
        gap:JSON.stringify(item.gaps ?? []), reference:JSON.stringify(item.reference ?? []), implementation:JSON.stringify(item.implementation ?? []),
        source:"fidelity/coverage.json", verification:"历史状态；当前官方UI适用性和逐状态核验未完成"});
  }
  const history = JSON.parse(read("docs/audit-live-2026-10-16/progress.json"));
  const historicalFindings = [];
  for (const area of history.areas) {
    const statuses = new Map();
    for (const status of ["done", "exempt", "todo", "review"]) for (const number of area[status] ?? []) {
      if (statuses.has(number)) throw Error(`Duplicate historical finding ${area.area}#${number}`);
      statuses.set(number, status);
    }
    if (statuses.size !== area.total || Array.from({length:area.total},(_,i)=>i+1).some(n=>!statuses.has(n))) throw Error(`Historical range mismatch ${area.area}`);
    const report = `docs/audit-live-2026-10-16/${area.report}`;
    const lines = read(report).split(/\r?\n/);
    for (const [number, historical] of [...statuses].sort(([a],[b])=>a-b)) {
      const matches = lines.flatMap((line,index)=>new RegExp(`^\\s*${number}[.)]\\s`).test(line)?[{line,index}]:[]);
      historicalFindings.push({id:`live.${area.area}#${number}`, domain:area.area, historical,
        original:matches.map(m=>m.line).join("\n") || `源编号 ${number} 无标准标题；需从完整原文定位`,
        source:matches.map(m=>`${report}:${m.index+1}`).join("\n") || report,
        verification:"保留历史完成/豁免结论；当前新版未逐条验收", mapping:"未完成新版需求、接口与组件映射"});
    }
  }
  checks.push({item:"历史 live 审核问题编号",expected:history.totals.total,actual:historicalFindings.length,scope:"done/exempt/todo/review 全部保留；每区域编号连续性另行校验"});
  const sourceDocuments = [], auditLines = [];
  for (const file of files.filter(f=>/^(?:docs|fidelity)\//.test(f)&&/\.(?:md|json)$/.test(f))) {
    const bytes = fs.readFileSync(path.join(root,file));
    sourceDocuments.push({file,bytes:bytes.length,sha256:hash(bytes),verification:"文件已登记；逐段需求映射未完成"});
    if (!file.endsWith(".md") || !/audit|review|parity|observations|official-ui/.test(file)) continue;
    read(file).split(/\r?\n/).forEach((line,index)=>{
      if (!line.trim()) return;
      const characters = [...line], count = Math.ceil(characters.length/1000);
      for(let part=0;part<count;part++) auditLines.push({id:`${file}:${index+1}:${part+1}`,source:`${file}:${index+1}`,part:`${part+1}/${count}`,original:characters.slice(part*1000,(part+1)*1000).join(""),verification:"原文保留；需求映射与当前核验待完成"});
    });
  }
  const productFiles = files.filter(f=>/^(?:electron|src|src-web|shared|runner|server|backend|public|public-web|scripts|tests)\//.test(f)||(!f.includes("/")&&/\.(?:json|html|[cm]?[jt]s)$/.test(f))).map(file=>{
    const bytes=fs.readFileSync(path.join(root,file));
    return {file,bytes:bytes.length,sha256:hash(bytes),kind:path.extname(file),verification:"当前Git跟踪/未忽略产品文件；运行核验与功能映射未完成"};
  });
  const productTests=[];
  for(const file of files.filter(f=>/^tests\//.test(f)&&/\.[cm]?[jt]sx?$/.test(f))) {
    const sf=ts.createSourceFile(file,read(file),ts.ScriptTarget.Latest,true);
    if(sf.parseDiagnostics.length)throw Error(`Test parse diagnostics ${file}`);
    let found=0;
    visit(sf,n=>{
      if(!ts.isCallExpression(n))return;
      const callee=n.expression.getText(sf);
      if(!/^(?:test|it|describe)(?:[.(]|$)/.test(callee))return;
      const label=n.arguments[0];
      if(!label)return;
      found++;
      productTests.push({id:`${file}:${n.getStart(sf)}`,name:ts.isStringLiteralLike(label)?label.text:label.getText(sf),kind:callee,source:`${file}:${sf.getLineAndCharacterOfPosition(n.getStart(sf)).line+1}`,verification:"定义/动态工厂候选未关联本次执行证据；skip/todo/条件分支不得视为通过"});
    });
    if(!found && /e2e|smoke|\.test\./.test(file)) productTests.push({id:file,name:file,kind:"独立脚本/动态测试；需展开",source:file,verification:"未逐脚本关联执行证据"});
  }
  const convert=(rows,keys)=>rows.map((r,i)=>Object.fromEntries([["id",String(i+1)],...keys.map((key,j)=>[key,r[j]])]));
  const productIpc=convert(syntax.ipc,["kind","channel","file","line","verification"]);
  const productSymbols=convert(syntax.symbols,["symbol","kind","file","line","verification"]);
  const productHttp=convert(syntax.transports,["callee","expression","file","line","verification"]);
  const productRoutes=convert(go,["method","receiver","expression","file","line","verification"]);
  checks.push({item:"当前Claudex原有桥方法与新版清单",expected:syntax.methods.length,actual:syntax.methods.length,scope:"主扫描器另与桥表逐方法键集合比较，非只比数量"});
  const sourceSnapshot=hash(JSON.stringify(productFiles.map(({file,sha256})=>[file,sha256])));
  return {parityChecks,uiStates,historicalFindings,sourceDocuments,auditLines,productFiles,productTests,productIpc,productSymbols,productHttp,productRoutes,checks,methods:syntax.methods,sourceSnapshot};
}
