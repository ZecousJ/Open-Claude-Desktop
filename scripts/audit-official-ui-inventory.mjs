/** Read-only inventory of the frozen official UI and Claudex adapters.
 * Usage: node scripts/audit-official-ui-inventory.mjs --out /tmp/inventory.json
 * This inventories evidence, never promotes static registration to runtime acceptance.
 */
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { collectProductSurface } from "./audit/collect-product-surface.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceRoot = process.env.CLAUDEX_RECOVERED_SOURCE ?? path.resolve(root, "../claude-frontend-4.4212.0");
const output = process.argv[process.argv.indexOf("--out") + 1];
if (!process.argv.includes("--out") || !output) throw Error("Supply --out /path/inventory.json");
const read = (p) => fs.readFileSync(path.resolve(root, p), "utf8");
const json = (p) => JSON.parse(read(p));
const hash = (v) => createHash("sha256").update(v).digest("hex");
const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]);
const location = (sf, node) => `${path.relative(root, sf.fileName)}:${sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1}`;
const compact = (s) => s.replace(/\s+/g, " ").trim();
const parse = (file) => ts.createSourceFile(file, fs.readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, file.endsWith(".ts") ? ts.ScriptKind.TS : ts.ScriptKind.JS);
const visit = (n, fn) => { fn(n); ts.forEachChild(n, c => visit(c, fn)); };
// The workbook renderer stores oversized cells in a lossless overflow sheet.
const short = (s) => s;
const usercontentRoot = path.join(root, "build/official-usercontent");
const usercontentFiles = fs.existsSync(usercontentRoot) ? walk(usercontentRoot) : [];
const files = [...walk(path.join(root, "build/official-ui")), ...usercontentFiles];
const contract = json("build/official-ui/data/native-ipc-contract.json");
const schema = json("work/official-native/schema.json");
const baseline = json("docs/official-ui-inventory-baseline.json");
const verificationRuns = json("docs/official-ui-verification-runs.json");
if (verificationRuns.version !== 1 || !Array.isArray(verificationRuns.runs))
  throw Error("Invalid current verification ledger");
if (new Set(verificationRuns.runs.map(run => run.id)).size !== verificationRuns.runs.length)
  throw Error("Duplicate verification run ID");
for (const run of verificationRuns.runs)
  for (const key of ["id", "area", "platform", "result", "scope", "observed", "evidence", "remaining"])
    if (typeof run[key] !== "string" || !run[key].trim()) throw Error(`Missing run evidence: ${run.id} ${key}`);
for (const run of verificationRuns.runs)
  if (run.completedAt && !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(run.completedAt)) throw Error(`Invalid verification completion timestamp: ${run.id}`);
if (verificationRuns.timestampRequiredFrom)
  for (const run of verificationRuns.runs)
    if (run.id >= verificationRuns.timestampRequiredFrom && !run.completedAt) throw Error(`Missing verification completion timestamp: ${run.id}`);
const installedKnownOld = new Set(baseline.installedKnownOld ?? []);
const registrations = new Map();
const findings = [];
let currentFile = "";
const stub = new Proxy(function () { return stub; }, { get(_t, k) { if(k === "then") return undefined; if(k === Symbol.iterator) return function*(){}; return stub; } });
const host = {
  ctx: { root: "/inventory", account: () => ({ id: "inventory" }), settings: () => ({ theme:"dark", providers:[], mcpServers:{} }),
    onEvent: () => () => {}, log() {}, defaultWorkspace: () => "/inventory/workspace" },
  on(op, fn) { registrations.set(op, { file: currentFile, handler: String(fn), kind: "注册处理器" }); return this; },
  answer(value, ...ops) { for(const op of ops) registrations.set(op, { file: currentFile, handler:JSON.stringify(value),kind:"常量应答" }); return this; },
  emit(){}, store(domain,name,initial){
    this.on(`${domain}.${name}_$store$_getState`,()=>initial);
    this.on(`${domain}.${name}_$store$_getStateSync`,()=>initial);
    return stub;
  },
};
// Follow the actual host entrypoint. A hand-maintained module list omitted
// newly connected domains and could falsely report their handlers as missing.
const nativeEntry = parse(path.join(root, "electron/official-ui/native/index.ts"));
const calledRegistrations = new Set();
visit(nativeEntry, n => {
  if(ts.isCallExpression(n) && ts.isIdentifier(n.expression)) calledRegistrations.add(n.expression.text);
});
const nativeRegistrations = [];
for(const statement of nativeEntry.statements) {
  if(!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
  const imports=statement.importClause?.namedBindings;
  if(!imports || !ts.isNamedImports(imports)) continue;
  for(const item of imports.elements) {
    if(!item.name.text.startsWith("register") || !calledRegistrations.has(item.name.text)) continue;
    const module=statement.moduleSpecifier.text;
    if(!module.startsWith("./")) throw Error(`Unexpected native registration source: ${module}`);
    nativeRegistrations.push({file:`electron/official-ui/native/${module.slice(2)}.ts`,name:item.propertyName?.text??item.name.text});
  }
}
if(!nativeRegistrations.length) throw Error("No native entrypoint registrations found");
// Only call registration functions, with inert dependencies. No handlers,
// dialogs, engine calls or real filesystem operations are invoked.
for(const {file,name} of nativeRegistrations) {
  currentFile = file;
  const exports = {};
  const require = (name) => {
    if(name === "node:crypto") return {createHash, randomUUID:()=>"00000000-0000-4000-8000-000000000000"};
    if(name === "node:os") return {hostname:()=>"inventory", homedir:()=>"/inventory"};
    if(name === "node:path") return path;
    if(name === "electron") return {app:{getPath:()=>"/inventory"}};
    if(name === "./host") return {NativeRefusal:class NativeRefusal extends Error{}};
    if(name === "../api/state") return {readState:()=>({}),writeState(){}};
    return stub;
  };
  const code = ts.transpileModule(read(currentFile), { compilerOptions:{module:ts.ModuleKind.CommonJS, target:ts.ScriptTarget.ES2022, esModuleInterop:true} }).outputText;
  vm.runInNewContext(code, {exports,require,process:{platform:"darwin"},Buffer,setInterval:()=>({unref(){}}),clearInterval(){},console:{log(){},warn(){}}}, {filename:currentFile,timeout:3000});
  const register = exports[name];
  if(typeof register!=="function") throw Error(`No ${name} registration in ${currentFile}`);
  register(host, {});
}
// Resolve exact literal registration locations, including multiline on() calls.
for(const file of new Set([...registrations.values()].map(r=>r.file))) {
  const sf=parse(path.join(root,file));
  visit(sf,n=>{
    if(!ts.isCallExpression(n)) return;
    for(const a of n.arguments) if(ts.isStringLiteral(a)){
      const name=a.text.includes(".")?a.text:file.endsWith("code-terminals.ts")?`LocalSessions.${a.text}`:"";
      const found=registrations.get(name); if(found?.file===file)found.location=location(sf,n);
    }
  });
}
const legacyFile = "electron/official-ui/native/legacy.ts";
const legacyAst=parse(path.join(root,legacyFile));
const legacy=[];
visit(legacyAst,n=>{if(ts.isIfStatement(n) && n.expression.getText(legacyAst).match(/has\(|includes\(|channel|\.test\(operation\)/))legacy.push(n);});
function fallback(op){
  const dot=op.indexOf(".");
  const channel=dot<0?op:`$eipc_message$_legacy_$_ns_$_${op.slice(0,dot)}_$_${op.slice(dot+1)}`;
  for(const n of legacy){
    const expr=n.expression.getText(legacyAst);
    let yes=false;
    try{yes=vm.runInNewContext(expr,{operation:op,channel,has:(...s)=>s.includes(op),includes:s=>channel.includes(s)},{timeout:50});}catch{}
    if(!yes)continue;
    const body=compact(n.thenStatement.getText(legacyAst));
    const real=/window\.|execFileSync|statfsSync|DesktopInfo_/.test(body)||op==="DesktopInfo.getSystemInfo"||op==="FileSystem.getSystemPath";
    return {implementation:real?"旧适配读取/操作（未验收）":"占位/无实际效果",location:location(legacyAst,n),detail:short(body)};
  }
  return {implementation:"未适配",location:`${legacyFile}:133`,detail:"无专用处理器；回退抛出 Native host adapter is not configured"};
}
const opMap=new Map();
for(const [kind, entries]of [["invoke",contract.invokes],["sync",contract.sync]]) for(const e of entries){
  const p=e.channel.split("_$_");const op=p.length>=4?`${p[2]}.${p.slice(3).join("_$_")}`:e.channel;
  const x=opMap.get(op)??{op,channels:[],kinds:new Set(),params:[],returns:"合同未给出",schema:false};
  x.channels.push(e.channel);x.kinds.add(kind);opMap.set(op,x);
}
const events=[];
for(const [domain,d]of Object.entries(schema.domains)){
  for(const [method,m]of Object.entries(d.methods??{})){
    const op=`${domain}.${method}`;const x=opMap.get(op)??{op,channels:[],kinds:new Set(),params:[],returns:null};
    x.schema=true;x.params=m.params??[];x.returns=m.returns;opMap.set(op,x);
  }
  for(const [event,args]of Object.entries(d.events??{}))events.push({domain,event,kind:"事件",schema:JSON.stringify(args),source:"work/official-native/schema.json",verification:"未独立核验",acceptance:"真实触发、订阅、取消订阅、多窗口与账号切换无丢失/重复/串号"});
  if(d.stores)events.push({domain,event:"stores 原始声明",kind:"状态声明（抽取不完整）",schema:String(d.stores),source:"work/official-native/schema.json",verification:"需展开全部状态；不能按首个字段算覆盖",acceptance:"枚举全部状态键、初始值、更新事件、持久化及注销；与 preload 对账"});
}
// Preload contains event/store channels absent from the signature extractor.
const preload=read("build/official-ui/host/official-preload.cjs");
const preloadAst=ts.createSourceFile("build/official-ui/host/official-preload.cjs",preload,ts.ScriptTarget.Latest,true,ts.ScriptKind.JS);
const eventKeys=new Set(events.map(e=>`${e.domain}.${e.event}`));
visit(preloadAst,n=>{
  if(!ts.isStringLiteral(n)||!n.text.includes("_$_"))return;
  const pieces=n.text.split("_$_");
  const domain=pieces[0],event=pieces.slice(1).join("_$_");
  if(!domain||!event||!schema.domains[domain])return;
  if(opMap.has(`${domain}.${event}`)||eventKeys.has(`${domain}.${event}`))return;
  eventKeys.add(`${domain}.${event}`);
  events.push({domain,event,kind:event.includes("$store$")?"状态通道":"preload 事件/辅助通道",schema:"见 preload 消费签名",source:location(preloadAst,n),verification:"未独立核验",acceptance:"核对主进程发出/应答方、参数、初值、取消订阅、账号切换和重启行为"});
});
const native=[...opMap.values()].sort((a,b)=>a.op.localeCompare(b.op)).map((x,i)=>{
  const r=registrations.get(x.op);const fb=fallback(x.op);
  let implementation=r?(r.kind==="常量应答"?"常量/能力应答":"已注册；语义待逐分支验收"):fb.implementation;
  if(r && /NativeRefusal|directory_unavailable|not_registered/.test(r.handler)) implementation="已注册；含拒绝分支，需核对可用范围";
  if(r && /=>\s*(?:void 0|undefined|null|false|true|\"ready\"|\[\]|\(\{\s*success: true\s*\}\))\s*$/.test(r.handler))implementation="常量/无实际效果；需核对语义";
  if(x.op.startsWith("WindowManager."))implementation="官方 window-manager 处理；未独立验收";
  const evidence=baseline.nativeEvidence[x.op];
  return {id:`N${String(i+1).padStart(4,"0")}`,domain:x.op.split(".")[0],operation:x.op,transport:[...x.kinds].join(" / ")||"仅官方签名",params:JSON.stringify(x.params),returns:x.returns??"void",implementation,
    verification:installedKnownOld.has(x.op)?"已知失败；源码补接后未核验":evidence?.verification??"未逐接口验收",
    evidence:evidence?.evidence??"仅静态清点；有处理器不代表功能正确",source:r?(r.location??r.file):fb.location,
    installed:installedKnownOld.has(x.op)?"安装版未包含当前补接":evidence?.installed??"当前安装版未逐接口复核",
    acceptance:evidence?.acceptance??"按官方参数及返回校验：正常、空值、非法输入、失败/取消/超时、持久化、重启、账号隔离、真实界面与目标平台；全部符合才完成",
    verifiedAt:evidence?.verifiedAt??"历史未记录/未核验",completedAt:evidence?.completedAt??"未完成",detail:short(r?.handler??fb.detail),channels:x.channels.join("\n")};
});
const http=new Map(),routes=[],components=[],modules=[],dynamic=[];
let parseErrors=0,scanNodes=0;
const addHttp=(value,source,kind,method="未知（待消费方确认）")=>{
  const key=`${kind}\0${value}`;const x=http.get(key)??{id:"",path:value,kind,method,implementation:"未逐路由映射",verification:"未核验",sources:[]};
  x.sources.push(source);http.set(key,x);
};
const uiJs=files.filter(f=>/\.(?:js|cjs|mjs)$/.test(f)&&(f.includes(`${path.sep}ui${path.sep}`)||usercontentFiles.includes(f)));
const adapterFiles=walk(path.join(root,"electron/official-ui")).filter(f=>f.endsWith(".ts"));
for(const file of [...uiJs,...adapterFiles]){
  const sf=parse(file),rel=path.relative(root,file),ui=uiJs.includes(file),exports=[];
  const factories=new Set();
  const parents=new Map();
  for(const st of sf.statements)if(ts.isImportDeclaration(st)&&st.moduleSpecifier.text?.includes("vendor-frame")){
    for(const spec of st.importClause?.namedBindings?.elements??[])if(["Ja","Ka"].includes(spec.propertyName?.text??spec.name.text))factories.add(spec.name.text);
  }
  // Route declarations with getParentRoute are joined within each module.
  visit(sf,n=>{if(ts.isVariableDeclaration(n)&&n.initializer&&ts.isCallExpression(n.initializer)){
    const obj=n.initializer.arguments.find(ts.isObjectLiteralExpression);
    if(!obj)return;const props=new Map(obj.properties.filter(ts.isPropertyAssignment).map(p=>[p.name.getText(sf).replace(/["']/g,""),p.initializer]));
    if(!props.has("getParentRoute"))return;
    const p=props.get("path"),par=props.get("getParentRoute");
    parents.set(n.name.getText(sf),{part:p&&(ts.isStringLiteral(p)||ts.isNoSubstitutionTemplateLiteral(p))?p.text:"",parent:par&&ts.isArrowFunction(par)&&ts.isIdentifier(par.body)?par.body.text:null,source:location(sf,n),component:props.get("component")?.getText(sf)??"重定向/布局"});
  }});
  function routePath(key,seen=new Set()) {if(seen.has(key))return "{循环}";seen.add(key);const r=parents.get(key);if(!r)return "";const base=r.parent?routePath(r.parent,seen):"";return `${base}/${r.part}`.replace(/\/+/g,"/");}
  for(const [key,r]of parents)if(r.part)routes.push({id:"",path:routePath(key),kind:"声明路由",component:r.component,source:r.source,verification:"未逐路由核验",acceptance:"正常入口/直达/刷新/返回/无效ID/无权限/断网/空态/加载失败/窗口布局，功能与官方一致"});
  visit(sf,n=>{
    scanNodes++;
    if(ts.isExportDeclaration(n)&&n.exportClause&&ts.isNamedExports(n.exportClause))for(const e of n.exportClause.elements)exports.push(e.name.text);
    if(ts.isStringLiteral(n)||ts.isNoSubstitutionTemplateLiteral(n)){
      const text=n.text;
      if(/^\/(?:api|edge-api|claudeai-rpc|v1)(?:\/|$)/.test(text)&&text.length<3000)addHttp(text,location(sf,n),ui?"官方静态路径":"适配层路径片段");
    }
    if(ui && ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.name.text==="split" && ts.isStringLiteral(n.expression.expression) && n.arguments[0]?.text==="."){
      const list=n.expression.expression.text;
      if(list.includes("admin-settings") || list.includes("cowork") && list.includes("settings"))
        for(const item of list.split("."))routes.push({id:"",path:item,kind:"压缩路由名称候选；非确认 URL",component:"待与声明路由及运行入口关联",source:location(sf,n),verification:"未逐路由核验",acceptance:"追溯路由名称到实际路径和功能 gate，记录隐藏/企业/平台条件；不能静默排除"});
    }
    if(ts.isTemplateExpression(n)){
      const text=n.getText(sf).slice(1,-1);
      if(/^\/(?:api|edge-api|claudeai-rpc|v1)(?:\/|$)/.test(text)&&text.length<3000)addHttp(text.replace(/\$\{[^}]*\}/g,"{动态参数}"),location(sf,n),ui?"官方模板路径":"适配层模板");
    }
    if(!ts.isCallExpression(n))return;
    const e=n.expression;
    if(ts.isPropertyAccessExpression(e)&&["test","exec"].includes(e.name.text)&&ts.isRegularExpressionLiteral(e.expression)&&!ui){
      const pattern=e.expression.getText(sf);
      if(/api|organizations|bootstrap|frame|settings|memory|skills|files|sharing|sessions/.test(pattern))addHttp(pattern,location(sf,n),"适配层匹配规则");
    }
    // Keep every React JSX/JSXS factory call's component target. These are
    // symbol-level candidates, not invented human component names.
    if(ui&&ts.isIdentifier(e)&&factories.has(e.text)&&n.arguments[0]){
      const target=n.arguments[0];
      if(!ts.isStringLiteral(target))components.push({id:"",module:rel,symbol:compact(target.getText(sf)),source:location(sf,n),verification:"组件逐状态未核验",acceptance:"定位真实入口并覆盖加载、空态、成功、失败、禁用、长内容、键盘、主题、窗口尺寸与中断；映射到功能验收记录"});
    }
    const expr=e.getText(sf);
    if(ui&&/^(?:fetch|[\w$]+\.(?:fetch|request|get|post|put|patch|delete))$/.test(expr)&&n.arguments.length){
      const a=n.arguments[0];if(!ts.isStringLiteral(a)&&!ts.isNoSubstitutionTemplateLiteral(a)&&!ts.isTemplateExpression(a)&&!ts.isObjectLiteralExpression(a))dynamic.push({id:"",kind:"动态网络调用候选",expression:short(compact(n.getText(sf))),source:location(sf,n),status:"待人工追踪；不能声称接口已全识别",acceptance:"追溯 URL 构造及方法，记录具体接口/权限/功能；运行时网络追踪交叉验证"});
    }
  });
  if(sf.parseDiagnostics.length){parseErrors+=sf.parseDiagnostics.length;findings.push({kind:"解析诊断",source:rel,detail:sf.parseDiagnostics.map(x=>ts.flattenDiagnosticMessageText(x.messageText," ")).join("; ")});}
  if(ui)modules.push({id:"",file:rel,bytes:fs.statSync(file).size,sha256:hash(fs.readFileSync(file)),exports:exports.join(", "),verification:"模块存在；不等于组件功能已验收",acceptance:"所有导出/内部交互映射到组件和功能；逐状态回放后才能更新核验状态"});
}
const adapters=[...http.values()].filter(x=>x.kind.startsWith("适配层"));
for(const x of http.values()){
  x.sources=[...new Set(x.sources)];
  if(x.kind.startsWith("适配层")){x.implementation=x.sources.some(s=>s.includes("/fixtures.ts:"))?"占位匹配；不是业务实现":"已声明路径/规则；方法与分支待逐项确认";}
  else{
    const matches=adapters.filter(a=>a.path===x.path);
    if(matches.length)x.implementation=matches.every(a=>a.sources.every(s=>s.includes("/fixtures.ts:")))?"仅同名占位候选":"发现同名适配候选；需核对方法/参数/分支";
    // A matching regex is deliberately not called 'implemented' automatically.
  }
  x.acceptance="明确 HTTP 方法、路径参数、请求/响应 schema、鉴权与业务语义；接口回归和官方页面 E2E；空数据/失败/超时/重试/断线/账号切换";
}
const rpc=[],protocol=[],protocolDefinitions=[];
for(const entry of json("build/official-ui/data/conversation-protocol.json")){
  const d=entry.descriptor;
  for(const s of d.service??[])for(const m of s.method??[]){
    const pathname=`/claudeai-rpc/${d.package}.${s.name}/${m.name}`;
    const adapted=["StreamTimeline","PerformAction","GetNewConversationDefaults"].includes(m.name)&&s.name==="ConversationService";
    rpc.push({id:"",operation:pathname,input:m.inputType??"",output:m.outputType??"",stream:!!m.serverStreaming,
      implementation:adapted?"有适配；子动作/消息类型仍有缺口":"未发现专用 RPC 适配",verification:adapted?"限定 Chat 流程有历史 E2E 记录；非全分支验收":"未核验",source:`build/official-ui/data/conversation-protocol.json -> ${d.name}`,acceptance:"对应请求/响应全部字段、流式结束/错误/取消、动作分支、幂等、断线恢复及账号隔离"});
  }
  const message=(m,prefix)=>{
    const name=`${prefix}.${m.name}`;
    protocolDefinitions.push({id:"",kind:"message",name,definition:JSON.stringify(m),source:d.name,verification:"全部字段/oneof/选项逐分支待核验"});
    for(const f of m.field??[])protocol.push({id:"",message:name,field:f.name,jsonName:f.jsonName??f.name,type:f.typeName??f.type,number:f.number,oneof:f.oneofIndex??"",source:d.name,verification:"字段逐分支未核验",acceptance:"建立字段来源、允许值和省略/空值语义，验证正反序列化及真实界面消费"});
    for(const e of m.enumType??[])protocolDefinitions.push({id:"",kind:"nested enum",name:`${name}.${e.name}`,definition:JSON.stringify(e),source:d.name,verification:"枚举全部值与未知值待核验"});
    for(const nested of m.nestedType??[])message(nested,name);
  };
  for(const m of d.messageType??[])message(m,d.package);
  for(const e of d.enumType??[])protocolDefinitions.push({id:"",kind:"enum",name:`${d.package}.${e.name}`,definition:JSON.stringify(e),source:d.name,verification:"枚举全部值与未知值待核验"});
  protocolDefinitions.push({id:"",kind:"file options/dependencies",name:d.name,definition:JSON.stringify(Object.fromEntries(Object.entries(d).filter(([key])=>!["messageType","enumType","service"].includes(key)))),source:d.name,verification:"协议版本/选项/依赖兼容待核验"});
}
const types=[...Object.entries(schema.zods).map(([name,definition])=>({name,definition,kind:"zod"})),...Object.entries(schema.validators).map(([name,definition])=>({name,definition,kind:"validator"}))].map(x=>({id:"",...x,definition:typeof x.definition==="string"?x.definition:JSON.stringify(x.definition),verification:"参数/返回类型逐字段未验收",source:"work/official-native/schema.json",acceptance:"展开嵌套对象/枚举/可选与nullable，覆盖调用参数和返回约束；与原版主进程行为核对"}));
const manifest=JSON.parse(fs.readFileSync(path.join(sourceRoot,"recovery/source-manifest.json"),"utf8"));
const assets=files.map(file=>({id:"",file:path.relative(root,file),kind:path.extname(file).slice(1)||"file",bytes:fs.statSync(file).size,sha256:hash(fs.readFileSync(file)),verification:"文件已纳入清点；运行/外观/资源状态未逐项核验"}));
// All extracted source-manifest files, including renderer/native parts that are
// not shipped in Claudex. Do not silently drop them as 'out of scope'.
const sourceFiles=manifest.files.map(x=>({id:"",file:x.file,reference:x.reference??"",sha256:x.outputSha256??"",present:fs.existsSync(path.join(sourceRoot,x.file)),scope:x.file.startsWith("src/cloud/")?"官方 Web/当前界面来源":x.file.startsWith("src/renderer/")?"官方桌面原有渲染器；需判定适用性":"官方宿主/其他源文件；需判定适用性",verification:"源码文件纳入基线；不是功能验收"}));
const cases=[];
for(const file of walk(path.join(root,"tests/official-ui-e2e")).filter(f=>/\.(?:mjs|mts)$/.test(f))){
  const sf=parse(file);let count=0;
  visit(sf,n=>{if(ts.isPropertyAssignment(n)&&n.name.getText(sf)==="name"&&ts.isStringLiteral(n.initializer)){
    cases.push({id:"",name:n.initializer.text,source:location(sf,n),run:"未在本次重跑",result:"测试存在不等于已通过；按功能总表的证据记录判断"});count++;
  }});
  if(!count&&(path.basename(file).match(/^(?:code-|cowork-|session-connectors)/)||/\bClient\.launch\(|\bassert\./.test(read(path.relative(root,file)))))cases.push({id:"",name:path.basename(file),source:path.relative(root,file),run:"未在本次重跑",result:"独立 E2E 脚本；详见功能总表的限定验证范围"});
}
for(const file of walk(path.join(root,"tests")).filter(f=>(/official.*\.test\.tsx?$/.test(f)||/[/\\]chat[/\\]memory-[^/\\]+\.test\.tsx?$/.test(f)))){
  const sf=parse(file);visit(sf,n=>{if(ts.isCallExpression(n)&&n.expression.getText(sf).match(/(?:^|\.)test$/)&&n.arguments[0]&&ts.isStringLiteral(n.arguments[0]))cases.push({id:"",name:n.arguments[0].text,source:location(sf,n),run:"未在本次重跑",result:"回归用例定义；不能代替 GUI E2E 或跨平台实机验收"});});
}
const numbered=(rows,prefix)=>rows.map((r,i)=>({...r,id:`${prefix}${String(i+1).padStart(5,"0")}`}));
// Include Claudex's original desktop/Web bridge, rather than assuming the
// official-facing contract is the entire product's interface surface.
const bridgeAst=parse(path.join(root,"shared/desktop-bridge.ts"));
const methodLists=new Map(),imports=new Map(),claudex=[];
for(const st of bridgeAst.statements)if(ts.isImportDeclaration(st)&&st.moduleSpecifier.text?.startsWith("."))
  for(const spec of st.importClause?.namedBindings?.elements??[])imports.set(spec.name.text,{file:path.resolve(root,"shared",`${st.moduleSpecifier.text}.ts`),name:spec.propertyName?.text??spec.name.text});
const unwrap=n=>{while(n&&(ts.isAsExpression(n)||ts.isSatisfiesExpression(n)||ts.isParenthesizedExpression(n)))n=n.expression;return n;};
const readList=(name)=>{
  if(methodLists.has(name))return methodLists.get(name);
  const imp=imports.get(name);const sf=imp?parse(imp.file):bridgeAst;const target=imp?.name??name;let result;
  visit(sf,n=>{if(!ts.isVariableDeclaration(n)||n.name.getText(sf)!==target)return;
    const init=unwrap(n.initializer);
    const obj=init&&ts.isCallExpression(init)?init.arguments.find(ts.isObjectLiteralExpression):undefined;
    if(obj)result=obj.properties.filter(ts.isPropertyAssignment).map(p=>({name:p.name.getText(sf).replace(/^["']|["']$/g,""),source:location(sf,p)}));
    else if(init&&ts.isArrayLiteralExpression(init))result=init.elements.filter(ts.isStringLiteral).map(p=>({name:p.text,source:location(sf,p)}));
  });
  if(!result)throw Error(`Cannot enumerate desktop bridge ${name}`);
  methodLists.set(name,result);return result;
};
const domainLists={};
visit(bridgeAst,n=>{if(ts.isVariableDeclaration(n)&&n.name.getText(bridgeAst)==="domainMethods"){
  const obj=unwrap(n.initializer);if(!ts.isObjectLiteralExpression(obj))throw Error("Nonliteral domainMethods");
  for(const p of obj.properties.filter(ts.isPropertyAssignment))domainLists[p.name.getText(bridgeAst).replace(/^["']|["']$/g,"")]=readList(p.initializer.getText(bridgeAst));
}});
const bridgeExports={};
vm.runInNewContext(ts.transpileModule(read("shared/web-bridge-methods.ts"),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{exports:bridgeExports,require:()=>({coreMethods:readList("coreMethods").map(m=>m.name),domainMethods:Object.fromEntries(Object.entries(domainLists).map(([k,v])=>[k,v.map(m=>m.name)]))})},{timeout:3000});
for(const [domain,entries]of [["core",readList("coreMethods")],...Object.entries(domainLists)])for(const m of entries)claudex.push({id:"",domain,method:m.name,webKind:bridgeExports.webMethodTable.get(m.name)??"未分类",note:bridgeExports.webMethodNotes[m.name]??"",source:m.source,implementation:"原Claudex合同；官方UI的调用映射待逐项追踪",verification:"本次未逐接口验收",acceptance:"桌面处理器、runner/browser/Go映射、官方消费入口、鉴权与正常/异常/取消/重启/跨账号按平台分别验收"});
const seenComponent=new Set();const uniqueComponents=components.filter(c=>{const k=`${c.module}:${c.symbol}`;if(seenComponent.has(k))return false;seenComponent.add(k);return true;});
const nativeCount=contract.invokes.length+contract.sync.length;
const localeManifest=json("build/official-ui/data/locale-recovery.json");
const onlineLocaleHtml=fs.readFileSync(path.join(sourceRoot,"src/cloud/index.html"),"utf8");
const declaredLocales=(/data-i18n-catalogs="([^"]+)"/.exec(onlineLocaleHtml)?.[1]??"").split(",").filter(Boolean);
const localeNames=["en-US",...declaredLocales.map(entry=>entry.split(":")[0])];
if(new Set(localeNames).size!==localeNames.length)throw Error("Duplicate declared official locale");
const localeCatalogs=localeNames.flatMap(locale=>["base","dynamic"].map(part=>{
  const recovered=localeManifest.catalogs.find(row=>row.locale===locale&&row.part===part);
  const file=`build/official-ui/ui/i18n/${part==="dynamic"?"dynamic/":""}${locale}.json`;
  const present=fs.existsSync(path.join(root,file));
  const onlineEnglish=json(`build/official-ui/ui/i18n/${part==="dynamic"?"dynamic/":""}en-US.json`);
  const messages=present?Object.keys(json(file)).length:0;
  const kind=recovered?.sourceKind??(recovered?"matched-desktop":null);
  const sourceKind=locale==="en-US"?"录制的在线英文":({"matched-desktop":"官方安装包译文，仅复用英文原文一致的ID","matched-online":"相邻官方在线版本译文，仅复用英文原文一致的ID","exact-online":"固定构建的官方在线语言包"})[kind]??"缺少对应官方在线语言包";
  const verification=kind==="matched-online"?"按固定构建英文原文和消息ID匹配":kind==="exact-online"?"原始目录与固定构建版本一致":locale==="en-US"||recovered?"Mac限定语言切换见RUN-20261102-35；非全量文案验收":"未适配/未核验";
  const gap=locale==="en-US"?"英文缺省；Windows/Web仍待真实验收":kind==="matched-online"?`${recovered.unmatchedOnlineMessages}条未匹配使用英文；不包含组织专属文案`:kind==="exact-online"?"动态目录不包含组织专属文案":recovered?"新增在线消息、9437条gated文案和其他状态未全验；不可记为完整翻译":"不得空包或假成功；须恢复匹配构建的官方包并完成实际界面验收";
  return {locale,part,sourceKind,messages,onlineMessages:Object.keys(onlineEnglish).length,unmatched:recovered?.unmatchedOnlineMessages??(present?0:Object.keys(onlineEnglish).length),file:present?file:"未恢复",source:recovered?.source??(locale==="en-US"?`src/cloud/i18n/${part==="dynamic"?"dynamic/":""}en-US.json`:"官方页面meta声明；未捕获内容"),sha256:recovered?.sha256??"",verification,gap};
}));
const checks=[
  {item:"实际原生入口注册模块",expected:nativeRegistrations.length,actual:new Set([...registrations.values()].map(row=>row.file)).size,scope:"从native/index.ts实际调用自动发现；不再手写固定模块名单"},
  {item:"官方声明语言及两类语言包",expected:localeNames.length*2,actual:localeCatalogs.length,scope:"包含未恢复的语言；每种语言base/dynamic分别保留，缺失不从分母删除"},
  {item:"preload invoke/sync 通道",expected:nativeCount,actual:native.reduce((n,r)=>n+(r.channels?r.channels.split("\n").filter(Boolean).length:0),0),scope:"合同全部通道纳入；按操作去重后仍保留各通道"},
  {item:"官方方法签名",expected:Object.values(schema.domains).reduce((n,d)=>n+Object.keys(d.methods??{}).length,0),actual:[...opMap.values()].filter(x=>x.schema).length,scope:"官方签名与 preload 合同取并集"},
  {item:"官方 schema 事件",expected:Object.values(schema.domains).reduce((n,d)=>n+Object.keys(d.events??{}).length,0),actual:events.filter(e=>e.kind==="事件").length,scope:"另外保留 preload 额外状态/事件"},
  {item:"官方类型定义（两类分别保留）",expected:Object.keys(schema.zods).length+Object.keys(schema.validators).length,actual:types.length,scope:"同名 validator/zod 也不覆盖"},
  {item:"装配包所有文件",expected:files.length,actual:assets.length,scope:"包含 CSS/字体/图片/WASM，非仅主页面"},
  {item:"装配包 UI JS 文件",expected:uiJs.length,actual:modules.length,scope:"全模块；组件工厂调用候选逐条单列"},
  {item:"复原工程来源清单",expected:manifest.files.length,actual:sourceFiles.length,scope:"保留不在当前装配包的官方文件，适用性待核对"},
  {item:"扫描的 TypeScript AST 解析诊断",expected:0,actual:parseErrors,scope:"非零项必须人工审查；不能按扫描成功掩盖"},
];
const fId=i=>`F${String(i+1).padStart(3,"0")}`;
const result={generatedAt:new Date().toISOString(),officialBuild:json("build/official-ui/data/build.json"),sourceManifestBuild:manifest.sourceBuild,
  basis:"静态全量基线+已有验证记录。仅声明/匹配候选不代表实现。动态构造、远端 gate、平台分支及组件语义仍需运行追踪，不能作绝对零漏项/全部可用承诺。",
  features:baseline.features.map((r,i)=>({verifiedAt:baseline.featureEvidence?.[fId(i)]?.verifiedAt??"历史未记录/未核验",completedAt:baseline.featureEvidence?.[fId(i)]?.completedAt??"未完成",id:`F${String(i+1).padStart(3,"0")}`,domain:r[0],feature:r[1],implementation:baseline.states[r[2]][0],verification:baseline.states[r[2]][1],evidence:r[3],gap:r[4],acceptance:r[5]||"官方真实界面：正常、空态、非法输入、取消、超时/断网、重试、重启、账号隔离、主题/尺寸/键盘与权限；有证据且对应平台通过才完成",priority:r[6]||"P2",mac:r[2]==="H"?"限定历史记录通过；待当前版复核":r[2]==="F"?"已知失败":"未完成验收",windows:"未完成 Windows 应用级实机验收",web:"按 Web 专项行验收；PC 结果不可复用",release:"源码/历史测试口径；不自动代表已安装或已部署",...(baseline.featureEvidence?.[fId(i)]??{})})),evidence:baseline.evidence,native,localeCatalogs,claudex:numbered(claudex,"CX"),events:numbered(events,"EV"),http:numbered([...http.values()],"H"),routes:numbered(routes,"R"),rpc:numbered(rpc,"RPC"),protocol:numbered(protocol,"PF"),protocolDefinitions:numbered(protocolDefinitions,"PD"),types:numbered(types,"T"),modules:numbered(modules,"M"),components:numbered(uniqueComponents,"C"),dynamic:numbered(dynamic,"D"),assets:numbered(assets,"A"),sourceFiles:numbered(sourceFiles,"S"),tests:numbered(cases,"TEST"),checks,findings,scanNodes,
  inputs:["build/official-ui/data/build.json","build/official-ui/data/native-ipc-contract.json","work/official-native/schema.json","build/official-ui/data/conversation-protocol.json","build/official-ui/manifest.json","docs/official-ui-coverage.md","docs/official-ui-inventory-baseline.json","scripts/audit-official-ui-inventory.mjs","shared/desktop-bridge.ts","shared/web-bridge-methods.ts",...adapterFiles.map(file=>path.relative(root,file))].map(file=>({file,sha256:hash(read(file))})),
};
const matchedFeatures = new Set();
for (const row of result.features) {
  const update = verificationRuns.featureUpdates.find(update => update.domain === row.domain && update.feature === row.feature);
  if (!update) continue;
  matchedFeatures.add(update);
  const { domain, feature, ...fields } = update;
  Object.assign(row, fields);
}
if (matchedFeatures.size !== verificationRuns.featureUpdates.length)
  throw Error("A verification update did not match a unique feature");
for (const [operation, update] of Object.entries(verificationRuns.nativeUpdates)) {
  const row = result.native.find(row => row.operation === operation);
  if (!row) throw Error(`Unknown verified native operation: ${operation}`);
  Object.assign(row, update);
}
result.runs = verificationRuns.runs;
const product = collectProductSurface();
const bridgeKeys = new Set(result.claudex.map(row=>`${row.domain}.${row.method}`));
if (product.methods.length !== bridgeKeys.size || product.methods.some(row=>!bridgeKeys.has(`${row.domain}.${row.name}`)))
  throw Error("Current product bridge key sets differ");
for(const [key,value] of Object.entries(product)) {
  if(["checks","methods","sourceSnapshot"].includes(key))continue;
  result[key]=value;
}
result.productSourceSnapshot=product.sourceSnapshot;
checks.push(...product.checks);
result.acceptance="incomplete";
result.acceptanceGaps=[
  {id:"A01",scope:"需求清单完整性",status:"未完成",gap:"全部审核原文已保留，但逐段需求到新版功能/接口/组件映射尚未清零",close:"每条需求有稳定映射、适用性与当前验证证据；未知项清零"},
  {id:"A02",scope:"运行时接口完整性",status:"未完成",gap:"动态调用、路由组、条件注册、远程gate与角色/平台分支仍待展开",close:"静态键集合与各配置运行时注册/网络轨迹双向对账"},
  {id:"A03",scope:"逐接口语义",status:"未完成",gap:"原生、桥、HTTP、RPC、协议字段中的未适配、占位、拒绝与未验收项仍存在",close:"每项正常/异常/权限/取消/超时/恢复/隔离全部有证据"},
  {id:"A04",scope:"停止、进程与草稿",status:"已知失败",gap:"真实Escape停止回合后测试子进程仍存活；安装版未含当前竞态修复",close:"回合与进程均结束，草稿保留、重开与后续真实回复通过"},
  {id:"A05",scope:"会话连接器",status:"已知失败",gap:"Code持久化与官方store为关闭，但重开菜单仍显示开启；Cowork未完成",close:"真实菜单、会话配置、账号隔离与实际工具调用一致"},
  {id:"A06",scope:"Cowork首页",status:"已知失败",gap:"/task/new完整创建流程仍未验收，必带systemPrompt适配缺口保留",close:"官方首页真实首发、审批、文件、追问、重开均通过"},
  {id:"A07",scope:"macOS完整应用验收",status:"未完成",gap:"当前仅部分真实流程通过；源码、测试构建和安装版不同",close:"当前交付包全部适用功能/状态的真实E2E与版本哈希一致"},
  {id:"A08",scope:"Windows完整应用验收",status:"未完成",gap:"没有新版Windows完整实机证据；原用户恢复超时仍需复验",close:"真实Windows交付包逐接口/界面/恢复/停止/路径/权限验收"},
  {id:"A09",scope:"Web完整验收",status:"未完成",gap:"实验功能及模型替身测试不能替代生产浏览器；生产Web未替换",close:"真实浏览器、认证、runner、网络异常及不支持入口逐项验收"},
  {id:"A10",scope:"全部UI状态与官方一致性",status:"未完成",gap:"组件候选与历史UI状态仍未逐入口映射，交互/动画/主题/尺寸/键盘未全验",close:"依据冻结官方源码和运行配置逐状态回放；不凭截图手改"},
  {id:"A11",scope:"交付与线上配置",status:"未完成",gap:"源码通过不代表已安装/发布；服务健康不代表所有接口正常",close:"交付二进制/资源/服务配置哈希与测试证据一致，安装后回归通过"},
  {id:"A12",scope:"Android/iOS",status:"按用户要求暂缓",gap:"当前PC/Web优先；保留移动端历史要求，不计为当前通过",close:"PC/Web全部完成后再开展独立适配与实机验收"},
];
for (const update of verificationRuns.acceptanceUpdates ?? []) {
  const row = result.acceptanceGaps.find(row => row.id === update.id);
  if (!row) throw Error(`Unknown acceptance gap ${update.id}`);
  Object.assign(row, update);
}
result.inputs.push(...["scripts/audit/collect-product-surface.mjs","scripts/audit/collect-interface-syntax.mjs","scripts/audit/extract-go-routes.go","scripts/audit/go.mod","scripts/audit/go.sum","scripts/render-official-ui-inventory.mjs","scripts/verify-official-ui-inventory.py","scripts/official-ui-locales.mjs","scripts/build-official-ui.mjs","build/official-ui/data/locale-recovery.json"].map(file=>({file,sha256:hash(read(file))})));
result.inputs.push({ file: "docs/official-ui-verification-runs.json", sha256: hash(read("docs/official-ui-verification-runs.json")) });
for(const check of checks)if(check.expected!==check.actual)throw Error(`Inventory mismatch: ${check.item} ${check.actual}/${check.expected}`);
fs.mkdirSync(path.dirname(path.resolve(output)),{recursive:true});fs.writeFileSync(output,JSON.stringify(result,null,2));
console.log(JSON.stringify(Object.fromEntries(Object.entries(result).filter(([,v])=>Array.isArray(v)).map(([k,v])=>[k,v.length]))));
