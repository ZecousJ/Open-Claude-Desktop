import fs from 'node:fs/promises';
import path from 'node:path';
import { Workbook, SpreadsheetFile } from '@oai/artifact-tool';
const [inputPath,out,tmp]=process.argv.slice(2);
if (!inputPath || !out || !tmp) throw Error('Expected inventory JSON, output directory and preview directory');
await fs.mkdir(tmp,{recursive:true});
const data=JSON.parse(await fs.readFile(inputPath,'utf8'));
const beijing=value=>value&&Number.isFinite(Date.parse(value))?new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false}).format(new Date(value))+' +08:00':value;
for(const rows of [data.features,data.native,data.runs])for(const row of rows)for(const key of ['verifiedAt','completedAt'])if(row[key])row[key]=beijing(row[key]);
const wb=Workbook.create();
const navy='#26364D', ink='#17243A', muted='#56657B';
const expected=[];
const col=n=>{let s='';while(n>0){n--;s=String.fromCharCode(65+n%26)+s;n=Math.floor(n/26);}return s;};
const overflow=[];
const safe=(v,source)=>{if(v===undefined||v===null)return '';if(typeof v==='object')v=JSON.stringify(v);if(typeof v==='string'&&[...v].length>1000&&!source.startsWith('长单元格原文!')){const id=`LONG-${overflow.length+1}`,chars=[...v];for(let i=0;i<chars.length;i+=1000)overflow.push({id,source,part:`${Math.floor(i/1000)+1}/${Math.ceil(chars.length/1000)}`,original:chars.slice(i,i+1000).join('')});return `完整原文见“长单元格原文” ${id}（${chars.length} 字符）`;}if(typeof v==='string'&&v.startsWith('='))return "'"+v;return v;};
const spec=(key,title,width=28)=>({key,title,width});
const cover=wb.worksheets.add('进度与口径');
wb.worksheets.add('功能总表');
cover.showGridLines=false;
cover.getRange('A1:F60').format={font:{name:'Arial',size:10,color:ink},verticalAlignment:'center',rowHeight:25};
cover.getRange('A2').values=[['Claudex PC / Web 功能与接口核验清单']];
cover.getRange('A2').format.font={name:'Arial',size:15,bold:true,color:ink};
cover.getRange('A4:F4').values=[['范围','官方冻结版本','构建','整理日期','产品验收状态','本次产品测试']];
cover.getRange('A5:F5').values=[['PC + Web；手机暂缓','4.4212.0',data.officialBuild.buildId,'2026-11-02','尚未完成',`已记录 ${data.runs.length} 项本轮结果`]];
cover.getRange('A4:F4').format={fill:navy,font:{name:'Arial',size:10,bold:true,color:'#FFFFFF'},rowHeight:28};
cover.getRange('A7:C7').values=[['功能总表状态','数量','含义']];
cover.getRange('A7:C7').format={fill:navy,font:{name:'Arial',size:10,bold:true,color:'#FFFFFF'}};
const statuses=[['限定流程已适配','有历史 E2E 记录，需当前版及完整分支复核'],['部分适配','存在功能、状态或平台缺口'],['源码有实现','未完成真实界面验收'],['未适配或无专用实现证据','不得按占位/注册算完成'],['已知失败/缺失','必须修复并回归后才能关闭'],['源码已修；未交付安装版','不能当作用户当前安装版已修复'],['已部署限定修复','仅特定服务端故障修复']];
const end=data.features.length+5;
statuses.forEach(([s,n],i)=>{const r=i+8;cover.getRange(`A${r}:C${r}`).values=[[s,null,n]];cover.getRange(`B${r}`).formulas=[[`=COUNTIF('功能总表'!$E$6:$E$${end},A${r})`]];});
statuses.forEach(([s],i)=>{const r=i+8;cover.getRange(`B${r}`).values=[[data.features.filter(x=>x.implementation===s).length]];});
cover.getRange('A15:C15').values=[['功能验收项总数',null,'不是已完成数，也不是总体百分比']];
cover.getRange('B15').values=[[data.features.length]];
cover.getRange('A17:C17').values=[['静态清点分母','条数','阅读方法']];
cover.getRange('A17:C17').format={fill:navy,font:{name:'Arial',size:10,bold:true,color:'#FFFFFF'}};
const sources=[['官方原生操作','native','合同与签名并集；逐操作保留全部通道'],['Claudex 桌面/Web 桥','claudex','原有产品接口亦保留，官方UI映射待追踪'],['状态事件及声明','events','包括不完整store声明和preload额外通道'],['HTTP路径及匹配候选','http','按来源种类区分，静态路径不等于已实现接口'],['路由及名称候选','routes','声明URL与压缩名称列表分开'],['RPC方法','rpc','每方法单列，不把一个service算一个功能'],['协议字段','protocol','每字段单列；重复描述仍保留来源'],['原生类型定义','types','zod和validator不合并覆盖'],['UI模块','modules','全部JS模块逐文件哈希'],['组件符号候选','components','工厂target去重；不是语义组件已全识别'],['动态调用候选','dynamic','含数据访问误报，须追踪后才能定为网络接口'],['装配包文件','assets','JS/CSS/字体/图片/WASM/元数据全部纳入'],['复原源码来源文件','sourceFiles','包括未装配的桌面渲染器与宿主源文件'],['测试定义','tests','测试存在不等于本次执行或通过']];
for(let i=0;i<sources.length;i++){const [label,key,note]=sources[i],r=18+i;cover.getRange(`A${r}:C${r}`).values=[[label,data[key].length,note]];}
cover.getRange('A34:C34').values=[['仍需关闭的验收缺口','影响','关闭条件']];
cover.getRange('A34:C34').format={fill:'#8A2935',font:{name:'Arial',size:10,bold:true,color:'#FFFFFF'}};
cover.getRange('A35:C38').values=['A01','A03','A08','A09'].map(id=>{
 const gap=data.acceptanceGaps.find(row=>row.id===id);
 if(!gap)throw Error(`Missing cover gap ${id}`);
 return [gap.scope,gap.gap,gap.close];
});
cover.getRange('A35:C38').format={wrapText:true,rowHeight:55};
cover.getRange('A40').values=[['完成门槛：适配语义正确、对应平台真实E2E通过、交付构建一致，且全部未映射/未判定/占位/已知失败项清零。']];
cover.getRange('A41').values=[['静态分母对账通过仍不足以证明绝对零漏项；动态构造、功能gate和组件语义映射的剩余项已列为未完成。']];
cover.getRange('A42').values=[['本轮逐项核验表记录实际新结果；PC现有Mac记录不能代替Windows或Web，不把历史报告改写为新验收结果。']];
cover.getRange('A44:C44').values=[['原产品与历史需求补充','条数','阅读方法']];
cover.getRange('A44:C44').format={fill:navy,font:{name:'Arial',size:10,bold:true,color:'#FFFFFF'}};
const extraSources=[['历史差异全部checkbox','parityChecks','包含[s]、跳过及非标准格式；新版逐条映射待完成'],['历史UI逐状态','uiStates','基础状态与所有源附加状态，当前新版未全验'],['历史审核问题编号','historicalFindings','所有done/exempt/todo/review编号均保留'],['当前产品IPC候选','productIpc','Electron注册/调用/动态通道'],['后端路由及中间件','productRoutes','含Group/Use；最终路径和运行配置待核对'],['当前产品组件候选','productSymbols','包括Vue与原Claudex组件；语义适用性待核'],['当前产品HTTP候选','productHttp','原桌面/Web/runner/管理前端全部源码扫描'],['全部产品测试声明候选','productTests','含skip/todo/动态工厂；不是已执行测试数'],['当前产品源码文件','productFiles','逐文件SHA-256；不是独立功能数'],['全部审核源文档','sourceDocuments','docs/fidelity Markdown与JSON'],['审核原文片段','auditLines','原文顺序和长行分片完整保留']];
extraSources.forEach(([label,key,note],i)=>cover.getRange(`A${45+i}:C${45+i}`).values=[[label,data[key].length,note]]);
cover.getRange('A57').values=[['旧 pc-review-fixes 表仅代表旧实现；以本表主工程源码、官方冻结构建与本轮结果为当前基线。']];
for(const [c,w]of [['A',37],['B',23],['C',70],['D',18],['E',24],['F',22]])cover.getRange(`${c}1:${c}60`).format.columnWidth=w;
cover.getRange('B8:B31').setNumberFormat('0');
cover.getRange('B12').conditionalFormats.add('cellIs',{operator:'greaterThan',formula:0,format:{fill:'#FCE3E7',font:{color:'#9F1239',bold:true}}});
expected.push({name:'进度与口径',records:60,header:0,lastRow:60});

const sheets=[];
function table(name,key,columns,note,{rowHeight=36,first=5}={}){
 const rows=data[key],s=name==='功能总表'?wb.worksheets.getItem(name):wb.worksheets.add(name),last=first+rows.length,cols=columns.length;
 s.showGridLines=false;
 const all=s.getRange(`A${first}:${col(cols)}${last}`);
 all.format={font:{name:'Arial',size:10,color:ink},verticalAlignment:'top',wrapText:true,rowHeight};
 s.getRange('A2').values=[[name]];s.getRange('A2').format.font={name:'Arial',size:14,bold:true,color:ink};
 s.getRange('A3').values=[[note]];s.getRange('A3').format={font:{name:'Arial',size:10,color:muted},rowHeight:26};
 s.getRange(`A${first}:${col(cols)}${first}`).values=[columns.map(c=>c.title)];
 for(let offset=0;offset<rows.length;offset+=1200){
  const chunk=rows.slice(offset,offset+1200).map((r,i)=>columns.map((c,j)=>safe(r[c.key],`${name}!${col(j+1)}${first+offset+i+1}`)));
  s.getRangeByIndexes(first+offset,0,chunk.length,cols).values=chunk;
  // Size wrapped descriptions from their displayed text. Dense source cells
  // are split into the overflow table rather than clipped at Excel's limit.
  const heights=chunk.map(row=>Math.min(409,Math.max(rowHeight,...row.map((value,j)=>{
   const lines=String(value).split('\n').reduce((sum,line)=>sum+Math.max(1,Math.ceil([...line].reduce((n,c)=>n+(c.codePointAt(0)>255?2:1),0)/Math.max(8,columns[j].width-2))),0);
   return lines*14+10;
  }))));
  for(let i=0;i<heights.length;){let next=i+1;while(next<heights.length&&heights[next]===heights[i])next++;if(heights[i]>rowHeight)s.getRangeByIndexes(first+offset+i,0,next-i,cols).format.rowHeight=heights[i];i=next;}
 }
 if(rows.length)s.tables.add(`A${first}:${col(cols)}${last}`,true,`Inventory${sheets.length+1}`);
 s.getRange(`A${first}:${col(cols)}${first}`).format={fill:navy,font:{name:'Arial',size:10,bold:true,color:'#FFFFFF'},horizontalAlignment:'center',verticalAlignment:'center',rowHeight:30,wrapText:true};
 columns.forEach((c,i)=>{s.getRange(`${col(i+1)}${first}:${col(i+1)}${last}`).format.columnWidth=c.width;});
 s.freezePanes.freezeRows(first);s.freezePanes.freezeColumns(name==='功能总表'?4:Math.min(2,cols));
 for(let j=0;j<columns.length;j++)if(rows.length<2000&&['verification','implementation','priority'].includes(columns[j].key)){
  const r=s.getRange(`${col(j+1)}${first+1}:${col(j+1)}${last}`);
  for(const t of ['已知失败','P0','占位','未适配'])r.conditionalFormats.add('containsText',{text:t,format:{fill:'#FCE3E7',font:{color:'#9F1239'}}});
  for(const t of ['未验','未核验','部分','待逐','候选','未完成'])r.conditionalFormats.add('containsText',{text:t,format:{fill:'#FFF1D6',font:{color:'#805200'}}});
 }
 expected.push({name,key,records:rows.length,header:first,lastRow:last,columns:columns.map(c=>c.key)});sheets.push(name);console.log(JSON.stringify({sheet:name,rows:rows.length}));return s;
}
table('功能总表','features',[spec('id','编号',10),spec('priority','优先级',10),spec('domain','区域',15),spec('feature','功能/交互',37),spec('implementation','适配状态',29),spec('verification','核验状态',35),spec('gap','缺口/验证边界',65),spec('acceptance','验收条件',85),spec('mac','macOS',36),spec('windows','Windows',40),spec('web','Web',43),spec('evidence','证据编号',18),spec('release','安装/部署口径',49),spec('verifiedAt','最近核验结束时间（北京时间）',30),spec('completedAt','全项验收完成时间（北京时间）',30)],`${data.features.length}个验收项。历史通过、本次源码、当前安装版分别记录。完整性待追踪项也在表内。`,{rowHeight:66});
table('本轮逐项核验','runs',[spec('id','记录编号',28),spec('area','功能/接口范围',36),spec('platform','实际平台/构建',40),spec('result','本次结果',44),spec('scope','实际测试范围',82),spec('observed','观察/断言结果',98),spec('evidence','证据位置',105),spec('remaining','尚未证明的范围',100),spec('completedAt','本次测试结束时间（北京时间）',30)],'每项实际测试完成后追加记录与北京时间；历史无时间证据保留空白。功能总表的全项完成时间只在全范围验收通过时填写，失败与限定通过不算整项完成。',{rowHeight:95});
table('全量验收缺口','acceptanceGaps',[spec('id','编号',12),spec('scope','范围',35),spec('status','状态',25),spec('gap','当前缺口',95),spec('close','关闭条件',110)],'任何未完成、已知失败或未知映射仍存在时，整体状态保持未完成。',{rowHeight:70});
table('官方原生接口','native',[spec('id','编号',11),spec('domain','域',28),spec('operation','操作',55),spec('implementation','源码适配判定',40),spec('verification','核验状态',42),spec('evidence','验证依据',52),spec('installed','安装版状态',42),spec('transport','调用类型',24),spec('params','官方参数',65),spec('returns','官方返回',65),spec('acceptance','验收条件',90),spec('source','适配来源',65),spec('detail','处理器/回退原文',90),spec('channels','全部合同通道',100),spec('verifiedAt','最近核验结束时间（北京时间）',30),spec('completedAt','全接口验收完成时间（北京时间）',30)],'preload合同与主进程签名取并集。注册/常量/拒绝/占位/未适配分开；每个方法均需独立验收。');
table('Claudex桥接口','claudex',[spec('id','编号',11),spec('domain','域',25),spec('method','方法',48),spec('webKind','Web运行位置',22),spec('verification','核验状态',35),spec('implementation','官方UI映射',65),spec('note','既有Web契约说明',90),spec('source','来源',65),spec('acceptance','验收条件',90)],'原Claudex桌面/Web全部方法；合同中的absent是原Web设计，不自动代表新官方UI已正确隐藏入口。');
table('状态与事件','events',[spec('id','编号',11),spec('domain','域',30),spec('event','事件/状态键',55),spec('kind','类型',32),spec('verification','核验状态',45),spec('schema','签名/原始声明',85),spec('source','来源',70),spec('acceptance','验收条件',90)],'包括schema事件、preload附加通道及不完整store声明；不把不完整声明当作完整字段枚举。');
table('HTTP路径候选','http',[spec('id','编号',11),spec('kind','来源类型',25),spec('path','路径/模板/规则',85),spec('method','HTTP方法',35),spec('implementation','适配匹配状态',55),spec('verification','核验状态',22),spec('sources','来源',90),spec('acceptance','验收条件',90)],'保留官方字面量/模板与适配层规则；同名只是匹配候选，尚须逐方法、参数和业务分支映射。');
table('路由与入口','routes',[spec('id','编号',11),spec('kind','路由类型',36),spec('path','路径/名称',70),spec('component','组件符号/声明',55),spec('verification','核验状态',25),spec('source','来源',80),spec('acceptance','验收条件',90)],'声明路由与压缩路由名称均保留；名称候选不是已经确认可访问的URL。');
table('RPC方法','rpc',[spec('id','编号',12),spec('operation','完整RPC路径',100),spec('implementation','适配状态',48),spec('verification','核验状态',62),spec('input','请求类型',70),spec('output','返回类型',70),spec('stream','服务端流式',16),spec('source','来源',80),spec('acceptance','验收条件',90)],'所有descriptor service method。ConversationService的3个方法有适配也不代表全部动作/消息类型完成。');
table('协议字段','protocol',[spec('id','编号',12),spec('message','消息类型',80),spec('field','字段',40),spec('jsonName','JSON名',40),spec('type','类型',75),spec('number','字段号',12),spec('oneof','oneof索引',14),spec('verification','核验状态',34),spec('source','描述来源',65),spec('acceptance','验收条件',90)],'每个protobuf字段均保留，含嵌套消息；oneof的0是有效索引，不为空值。');
table('协议定义与枚举','protocolDefinitions',[spec('id','编号',12),spec('kind','定义类型',30),spec('name','全名',95),spec('verification','核验状态',50),spec('definition','原始定义/枚举全部值',125),spec('source','描述来源',75)],'除逐字段表外，还保留message完整定义、oneof声明、顶层/嵌套枚举、协议选项及依赖。');
table('原生类型','types',[spec('id','编号',12),spec('kind','定义类别',18),spec('name','类型符号',35),spec('verification','核验状态',40),spec('definition','完整抽取定义',120),spec('source','来源',60),spec('acceptance','验收条件',90)],'zod和validator分别保留；定义中含全部抽取属性，偏好等大对象仍需逐键语义映射。');
table('组件候选','components',[spec('id','编号',12),spec('symbol','组件target符号',45),spec('module','模块',95),spec('verification','核验状态',40),spec('source','调用位置',100),spec('acceptance','逐状态验收条件',95)],'React工厂非原生target按模块+符号去重。包裹组件、动态工厂和非React入口的语义映射尚未完成。');
table('动态待追踪','dynamic',[spec('id','编号',12),spec('kind','候选类型',33),spec('status','追踪状态',60),spec('expression','原始调用表达式',120),spec('source','来源',100),spec('acceptance','关闭条件',95)],'宽范围保留动态fetch/request/get/post等调用。包含Map/数据访问误报，数量不能当作真实网络接口数。');
table('UI模块','modules',[spec('id','编号',12),spec('file','模块文件',100),spec('bytes','字节数',15),spec('sha256','SHA-256',68),spec('exports','导出符号',90),spec('verification','核验状态',60),spec('acceptance','关闭条件',95)],'全部装配UI JS模块逐文件清点与哈希；模块存在和完整加载不代表功能验收。');
table('装配包文件','assets',[spec('id','编号',12),spec('file','文件',110),spec('kind','扩展名',15),spec('bytes','字节数',18),spec('sha256','SHA-256',68),spec('verification','核验状态',80)],'全部装配包文件，包含字体、样式、图像、WASM、worker与宿主元数据。');
table('复原源码','sourceFiles',[spec('id','编号',12),spec('file','复原文件',110),spec('reference','引用来源',80),spec('sha256','输出SHA-256',68),spec('present','文件存在',16),spec('scope','来源范围/适用性',65),spec('verification','核验状态',70)],'source-manifest全量清单，未装配的renderer/宿主代码保留为待判定；不直接排除。');
table('测试定义','tests',[spec('id','编号',14),spec('name','测试/脚本',105),spec('run','本次执行状态',28),spec('result','证据边界',90),spec('source','来源',100)],'自动枚举现有相关回归与官方UI E2E定义；没有运行记录就不写本次通过。');
table('历史差异逐条','parityChecks',[spec('id','原编号',38),spec('marker','原标记',12),spec('verification','核验状态',55),spec('mapping','新版映射状态',65),spec('original','源行完整原文',125),spec('source','来源',70),spec('mac','macOS',36),spec('windows','Windows',36),spec('web','Web',40)],'来自当前主工程全部checkbox源行，包含[s]、豁免和未知格式；旧标记不是新版通过。',{rowHeight:60});
table('历史UI逐状态','uiStates',[spec('id','状态编号',70),spec('component','案例',50),spec('state','状态',20),spec('historical','历史记录',30),spec('verification','当前核验状态',75),spec('gap','差异',95),spec('reference','参考',90),spec('implementation','实现',90),spec('source','来源',55)],'保留所有案例的九种基础状态及源文件附加状态；须重新映射至新版官方界面。');
table('历史审核问题','historicalFindings',[spec('id','原编号',30),spec('domain','区域',20),spec('historical','历史状态',20),spec('verification','当前核验状态',75),spec('mapping','新版映射',65),spec('original','原问题',130),spec('source','来源',90)],'全部历史live问题编号连续性对账；完成或豁免也保留，不作为当前新版签收。',{rowHeight:60});
table('产品IPC候选','productIpc',[spec('id','编号',12),spec('kind','注册或调用类型',28),spec('channel','通道或表达式',85),spec('file','源码',90),spec('line','行',12),spec('verification','核验状态',75)],'当前主工程Electron注册、调用、事件和动态表达式；不以静态出现证明运行行为。');
table('后端路由与中间件','productRoutes',[spec('id','编号',12),spec('method','方法或Group-Use',25),spec('receiver','接收者',55),spec('expression','相对路径或表达式',95),spec('file','源码',90),spec('line','行',12),spec('verification','核验状态',80)],'Go语法与类型联合扫描，全部路由组/中间件保留；最终前缀、鉴权链和条件注册待运行对账。');
table('产品组件定义候选','productSymbols',[spec('id','编号',12),spec('symbol','名称',60),spec('kind','定义类型',25),spec('file','源码',100),spec('line','行',12),spec('verification','核验状态',75)],'包括React/TS定义及管理前端Vue SFC；工具类可能为候选，须追踪后判定适用性。');
table('产品HTTP调用候选','productHttp',[spec('id','编号',12),spec('callee','调用',50),spec('expression','地址或表达式',105),spec('file','源码',100),spec('line','行',12),spec('verification','核验状态',75)],'原Claudex桌面、Web、runner、管理前端的HTTP候选；动态地址尚需运行追踪。');
table('全部产品测试定义','productTests',[spec('id','唯一位置',105),spec('name','用例或套件',100),spec('kind','测试声明或条件',55),spec('source','来源',100),spec('verification','执行证据状态',80)],'完整保留测试定义和skip/todo/条件声明；套件不按独立产品功能累计，定义不等于本次通过。');
table('当前产品源码文件','productFiles',[spec('file','文件',115),spec('kind','类型',15),spec('bytes','字节数',18),spec('sha256','SHA-256',68),spec('verification','状态',90)],'当前主工程Git跟踪及未忽略产品文件逐文件哈希；与旧工作树分别记录，不借用旧实现测试结果。');
table('全部审核源文档','sourceDocuments',[spec('file','文档',115),spec('bytes','字节数',18),spec('sha256','SHA-256',68),spec('verification','需求映射状态',90)],'全部docs/fidelity Markdown与JSON；留存源快照，避免只选取部分报告。');
table('审核原文逐行','auditLines',[spec('id','源行与片段',115),spec('source','来源',110),spec('part','片段顺序',18),spec('original','完整片段原文',140),spec('verification','核验状态',85)],'审核/官方UI/差异报告所有非空行按顺序保留；每段1000字符防止单元格截断；原文为证据数据。',{rowHeight:70});
table('证据来源','evidence',[spec('id','证据编号',12),spec('kind','证据类型',40),spec('scope','已验证范围/事实',100),spec('limit','限制',105),spec('source','来源',120)],'E编号可在功能表与接口表检索。历史报告、静态实现、真实失败和部署记录分别标识。',{rowHeight:66});
table('语言包与缺失文案','localeCatalogs',[spec('locale','语言',18),spec('part','类型',15),spec('sourceKind','恢复来源',60),spec('messages','已恢复条数',18),spec('onlineMessages','在线英文分母',18),spec('unmatched','未匹配文案',18),spec('verification','核验范围',85),spec('gap','剩余缺口',100),spec('file','装配文件',100),spec('source','官方来源',100),spec('sha256','来源SHA-256',68)],'保留官方页面声明的全部语言及base/dynamic包；安装包译文只复用英文原文相同的ID，不冒充新版在线包。9437条gated文案的翻译仍未完整恢复。',{rowHeight:66});
const checks=data.checks.map(r=>({...r,result:r.expected===r.actual?'分母对账一致':'不一致'}));
data.checks=checks;
table('分母对账','checks',[spec('item','对账对象',45),spec('expected','源记录数',18),spec('actual','纳入记录数',18),spec('result','对账结果',22),spec('scope','分母说明',110)],'仅证明所列冻结文件集合纳入完整。动态语义、运行状态和未映射项仍需继续验证。');
data.inputs=data.inputs.map(x=>({...x,note:'生成时文件哈希；原文件变更后应重新生成'}));
table('输入版本','inputs',[spec('file','输入文件',105),spec('sha256','SHA-256',68),spec('note','说明',70)],'确保后续更新能区分官方构建、适配源码与证据变化。');
data.rules=[
 {item:'范围',rule:'PC与Web优先。安卓/iOS独立客户端暂缓，不把PC中的模拟器能力混为移动端验收。'},
 {item:'完成定义',rule:'接口语义、参数/返回、权限/隔离、全部UI状态、真实E2E、目标平台、安装部署版本全部有证据。任一缺失不能关闭。'},
 {item:'本次验证',rule:'本轮逐项核验表记录实际执行的客户端和自动化测试，保留失败、平台与构建边界；未重跑项目仍按历史状态。'},
 {item:'异常矩阵',rule:'正常/空态/加载/失败、非法输入、取消、超时、断网、重试、重启、并发、账号切换、权限拒绝、主题、窗口大小、长内容、键盘和焦点。'},
 {item:'接口对账',rule:'原生通道和签名取并集；RPC逐方法，协议逐字段；HTTP候选需补方法和动态构造，不以正则命中判定实现。'},
 {item:'组件对账',rule:'模块和资源全量纳入，组件符号仅静态候选。动态工厂、包裹导出、隐藏菜单、远端gate和平台分支仍须追踪。'},
 {item:'不适用项',rule:'企业、营销、硬件、官方特有服务等未正式判定前保留。需写明产品决策及官方入口处理，不能用未实现冒充不适用。'},
 {item:'Windows',rule:'传输级/路径单测不能代替真实Windows安装包E2E；受影响用户故障仍待现场复验。'},
 {item:'Web',rule:'实验开关和模型服务替身测试必须单列；生产Web未替换。PC通过记录不能用于Web签收。'},
 {item:'版本一致性',rule:'当前Mac安装0.0.39；最新interrupt/scratch相关源码未打包安装，不能因版本号相同假定包含修复。'},
 {item:'剩余完整性任务',rule:'完成动态URL和组件语义映射、HTTP方法/分支、原生属性/设置键、各角色/平台功能gate的运行追踪；未知项清零前不宣称绝对无漏项。'},
 {item:'更新方法',rule:'修改基线证据及状态后运行 scripts/audit-official-ui-inventory.mjs --out <JSON路径>；冻结来源变更需先核对版本和分母。'}
];
table('验收规则','rules',[spec('item','项目',30),spec('rule','规则/当前边界',140)],'状态更新必须可追溯到测试记录和实际交付版本。',{rowHeight:56});
data.overflow=overflow;
table('长单元格原文','overflow',[spec('id','原文编号',25),spec('source','原单元格',55),spec('part','片段顺序',18),spec('original','完整原文片段',140)],'超长内容完整分片；原位置保留索引，不因Excel单元格长度限制删除原文。',{rowHeight:70});
wb.recalculate();
console.log((await wb.inspect({kind:'region',sheetId:'进度与口径',range:'A7:C15',maxChars:3000,tableMaxRows:10,tableMaxCols:3})).ndjson);
await fs.mkdir(out,{recursive:true});
await fs.writeFile(path.join(tmp,'expected.json'),JSON.stringify(expected,null,2));
await fs.writeFile(path.join(tmp,'render-data.json'),JSON.stringify(data));
// Render a representative range on every sheet, including the output and
// source tables, so both human labels and dense source layouts are checked.
for(let i=0;i<expected.length;i++){
 const e=expected[i],range=e.header?`A2:${col(Math.min(4,e.columns.length))}${Math.min(e.lastRow,e.header+3)}`:'A2:C15';
 const png=await wb.render({sheetName:e.name,range,scale:1,format:'png'});
 await fs.writeFile(path.join(tmp,`preview-${String(i).padStart(2,'0')}.png`),new Uint8Array(await png.arrayBuffer()));
}
// Inspect the changed status columns and latest evidence, not just the first
// rows of each existing source table.
const featureRow=(domain,feature)=>{
 const index=data.features.findIndex(row=>row.domain===domain&&row.feature===feature);
 if(index<0)throw Error(`Missing preview feature ${domain}/${feature}`);
 return index+6;
};
const codeConnectorRow=featureRow('连接器','Code会话重开工具菜单');
const coworkConnectorRow=featureRow('连接器','Cowork会话重开工具菜单');
const coworkHomeRow=featureRow('Cowork','真正/task/new首页创建');
const mcpRow=featureRow('连接器','真实MCP工具一次审批、拒绝与结果回放');
const initialConnectorRow=featureRow('连接器','首页首发连接器快照校验与初始化');
const memoryControlsRow=featureRow('记忆','controls编辑与冲突保护');
const memorySynthesisRow=featureRow('记忆','重新生成与melange');
const coworkMemoryRow=featureRow('记忆','Cowork账户文件记忆列表、读取、保存、删除与重置');
const localeRow=featureRow('设置','界面语言切换');
const gitRow=featureRow('Code','Git状态与变更列表');
const sidebarRow=featureRow('Code','Scratch任务归类与历史分组');
const appearanceRow=featureRow('设置','外观主题与聊天字体');
const filesRow=featureRow('Code','文件浏览、搜索、提及与改动面板');
const previewRow=featureRow('Code','内置预览浏览器Launch与导航状态');
const recoveryRow=featureRow('Code','流式故障有界重连、工具去重与停止取消');
const landingTerminalRow=featureRow('Code','无会话草稿终端');
const openedRow=featureRow('Code','会话已打开通知与已读更新');
const shellRow=featureRow('外壳','菜单、窗口控制与前进后退');
const localMcpRow=featureRow('连接器','本机MCP生命周期与故障恢复');
const stopRow=featureRow('Code','停止正在运行的命令/回合');
for (const [name,sheetName,range] of [
 ['current-local-mcp','功能总表',`D${localMcpRow}:G${localMcpRow}`],
 ['current-native-stop','功能总表',`D${stopRow}:G${stopRow}`],
 ['current-core-times','功能总表',`M${stopRow}:O${stopRow}`],
 ['current-shell-exit','功能总表',`D${shellRow}:G${shellRow}`],
 ['current-shell-exit-times','功能总表',`M${shellRow}:O${shellRow}`],
 ['current-landing-terminal','功能总表',`D${landingTerminalRow}:G${landingTerminalRow+1}`],
 ['current-landing-terminal-times','功能总表',`M${landingTerminalRow}:O${landingTerminalRow+1}`],
 ['current-history-open','功能总表',`D${openedRow}:G${openedRow}`],
 ['current-stream-recovery','功能总表',`D${recoveryRow}:G${recoveryRow}`],
 ['current-stream-recovery-times','功能总表',`M${recoveryRow}:O${recoveryRow}`],
 ['current-file-preview','功能总表',`D${filesRow}:G${previewRow}`],
 ['current-file-preview-times','功能总表',`M${filesRow}:O${previewRow}`],
 ['current-sidebar','功能总表',`D${sidebarRow}:G${sidebarRow}`],
 ['current-appearance','功能总表',`D${appearanceRow}:G${appearanceRow}`],
 ['current-appearance-times','功能总表',`M${appearanceRow}:O${appearanceRow}`],
 ['current-git','功能总表',`D${gitRow}:G${gitRow}`],
 ['current-git-times','功能总表',`M${gitRow}:O${gitRow}`],
 ['current-run-times','本轮逐项核验',`G${data.runs.length+5}:I${data.runs.length+5}`],
 ['current-gates','进度与口径','A34:C42'],
 ['current-connectors','功能总表',`D${codeConnectorRow}:G${coworkConnectorRow}`],
 ['current-cowork','功能总表',`D${coworkHomeRow}:G${coworkHomeRow}`],
 ['current-mcp','功能总表',`D${mcpRow}:G${initialConnectorRow}`],
 ['current-memory','功能总表',`D${memoryControlsRow}:G${memorySynthesisRow}`],
 ['current-cowork-memory','功能总表',`C${coworkMemoryRow}:G${coworkMemoryRow}`],
 ['current-locales','功能总表',`C${localeRow}:G${localeRow}`],
 ['current-runs','本轮逐项核验',`A${Math.max(6,data.runs.length+2)}:F${data.runs.length+5}`],
 ['current-acceptance','全量验收缺口','A8:E11'],
]) {
 const png=await wb.render({sheetName,range,scale:1,format:'png'});
 await fs.writeFile(path.join(tmp,`preview-${name}.png`),new Uint8Array(await png.arrayBuffer()));
}
const target=path.join(out,'Claudex-PC-Web-全量适配与核验清单-20261102.xlsx');
await (await SpreadsheetFile.exportXlsx(wb)).save(target);
if(path.resolve(inputPath)!==path.resolve(out,'inventory-20261102.json'))await fs.copyFile(inputPath,path.join(out,'inventory-20261102.json'));
await fs.rename(`${target}.inspect.ndjson`,path.join(tmp,'export-inspect.ndjson')).catch(error=>{if(error.code!=='ENOENT')throw error;});
console.log(JSON.stringify({output:target,sheets:expected.length,records:expected.reduce((s,e)=>s+e.records,0)}));
