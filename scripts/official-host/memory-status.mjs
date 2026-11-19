import {qa as jsx,Ja as jsxs} from './vendor-frame-iz8L1jC9.js';
import {p as useIntl} from './vendor-intl-D9Num-b5.js';
import {ce as useAccount} from './shared-l-p-m-w-2-BMCa56Vr.js';
import {jg as useReadQuery} from './shared-l-p-m-w-1-O9prfPUL.js';
import {k0 as memorySettingsKey} from './shared-l-p-m-w-0-C_nAiu5o.js';
function useSettings(){
 const {activeOrganization}=useAccount(),org=activeOrganization?.uuid;
 return useReadQuery(`/api/organizations/${org??''}/memory/settings`,{queryKey:[memorySettingsKey,{orgUuid:org}],enabled:!!org,staleTime:43200000,gcTime:43200000,retry:false,refetchOnWindowFocus:false,refetchOnMount:false,meta:{noToast:true}});
}
export function memoryFacts(data){
 const m=data?.claudex_memory;
 if(!m||m.version!==1||typeof m.available!=='boolean'||!['read-only','native'].includes(m.surface)||![null,'policy','server','offline','unsupported'].includes(m.reason)||!m.allowed||!m.preferences||[m.allowed.generate,m.allowed.searchChats,m.preferences.generate,m.preferences.searchChats].some(x=>typeof x!=='boolean')||!['available','consent_and_budget_not_established'].includes(m.generation_action)||!['available','existing_native_policy','unavailable'].includes(m.generation_disable_action)||!['available','existing_native_policy','unavailable'].includes(m.search_action))return null;
 const s=m.snapshot;
 if(!s||!['not_provided','present'].includes(s.state))return null;
 if(s.state==='present'&&(typeof s.memory!=='string'||s.memory.length>2000000||!Array.isArray(s.controls)||s.controls.length>10000||s.controls.some(x=>typeof x!=='string')||typeof s.updated_at!=='string'||!Number.isFinite(Date.parse(s.updated_at))))return null;
 return m;
}
export function memoryActionState(data,kind,checked=false){
 const m=memoryFacts(data);
 if(!m)return {disabled:true,reason:'unknown'};
 if(kind==='search'&&m.allowed.searchChats&&m.search_action==='available')return {disabled:false,reason:null};
 if(!m.available)return {disabled:true,reason:m.reason||'unavailable'};
 if(kind==='generate'){
  const canEnable=m.generation_action==='available';
  const canPause=checked&&(
   m.generation_disable_action==='available'||
   m.reset_action==='available'&&m.allowed.generate&&m.preferences.generate
  );
  return canEnable||canPause?{disabled:false,reason:null}:{disabled:true,reason:'consent'};
 }
 if(kind!=='search')return {disabled:true,reason:'unknown'};
 return m.allowed.searchChats&&m.search_action==='existing_native_policy'
  ?{disabled:false,reason:null}
  :{disabled:true,reason:m.surface==='read-only'?'readonly':'policy'};
}
function text(locale){return String(locale).toLowerCase().startsWith('zh')?{
 title:'Claudex 记忆状态',unknown:'无法确认记忆服务状态。设置未更改。',unavailable:'记忆服务当前不可用；这不代表已有记忆已删除。',policy:'当前服务策略不允许此操作。',server:'当前服务不支持此记忆能力。',unsupported:'当前账号或服务未提供此记忆能力。',offline:'记忆服务暂时无法访问。',readonly:'当前 Web 界面不支持更改此设置。',consent:'此开关会启动自动记忆生成；当前界面尚未建立所需的持续调用授权和预算，不能启用或更改。',saved:'已读取的记忆快照（只读）',old:'最后已知的记忆快照；当前服务不可用，无法确认它是否仍为最新。',none:'本次状态未提供记忆正文；不能据此认定没有记忆。',empty:'此已读取快照的正文为空。',savedPrefs:'已保存偏好（不是调用授权）',generate:'自动生成',search:'历史搜索',on:'开',off:'关',prefs:'以下开关显示已生效状态，不代表保存的个人偏好或收费授权。'
 }:{title:'Claudex memory status',unknown:'Memory service status could not be verified. Settings are unchanged.',unavailable:'Memory is currently unavailable; this does not mean existing memories were deleted.',policy:'The current service policy does not allow this action.',server:'This service does not provide this memory capability.',unsupported:'This account or service does not provide this memory capability.',offline:'The memory service cannot currently be reached.',readonly:'This Web interface cannot change this setting.',consent:'This switch starts automatic memory generation. The required recurring-call authorization and budget have not been established in this interface, so it cannot be changed.',saved:'Read memory snapshot (read-only)',old:'Last-known memory snapshot; the service is unavailable and its freshness cannot be verified.',none:'This status did not include memory content; it does not establish that no memories exist.',empty:'The content of this read snapshot is empty.',savedPrefs:'Saved preferences (not authorization)',generate:'Automatic generation',search:'Chat search',on:'On',off:'Off',prefs:'The switches show effective state, not saved personal preferences or billing consent.'};}
export function formatMemoryTimestamp(value,locale){
 const date=new Date(value);
 if(!Number.isFinite(date.getTime()))return '—';
 const options={year:'numeric',month:'short',day:'numeric',hour:'2-digit',minute:'2-digit',timeZoneName:'short'};
 try{return new Intl.DateTimeFormat(locale,options).format(date);}
 catch{return new Intl.DateTimeFormat('en-US',options).format(date);}
}
export function HostMemorySwitch({control:Control,kind,...props}){
 const query=useSettings();
 const gate=memoryActionState(query.isError?undefined:query.data,kind,props.checked);
 const disabled=props.disabled||gate.disabled;
 const change=value=>{
  if(!disabled&&(kind!=='generate'||value===false||query.data?.claudex_memory?.generation_action==='available'))props.onCheckedChange?.(value);
 };
 return jsx(Control,{...props,disabled,onCheckedChange:change});
}
export function HostMemoryMode({control:Control,items,onChange,...props}){
 const query=useSettings();
 const facts=memoryFacts(query.isError?undefined:query.data);
 const active=props.value!=='off';
 const canSetMode=!!facts?.available&&facts.generation_action==='available';
 const canPause=!!facts?.available&&(
  facts.generation_disable_action==='available'||
  facts.reset_action==='available'&&facts.allowed.generate
 );
 const canSelect=value=>value===props.value||(value==='off'?active&&canPause:canSetMode);
 return jsx(Control,{
  ...props,
  items:items.map(item=>({...item,disabled:item.disabled||!canSelect(item.value)})),
  disabled:props.disabled||!(canSetMode||active&&canPause),
  onChange:value=>{if(value&&canSelect(value))onChange?.(value);},
 });
}
export function HostMemoryStatus(){
 const query=useSettings(),intl=useIntl(),m=text(intl.locale),facts=memoryFacts(query.data);
 if(query.isLoading)return null;
 const snapshot=facts?.snapshot;
 return jsxs('section',{style:{minWidth:0,maxWidth:'100%',whiteSpace:'normal',overflowWrap:'anywhere'},className:'rounded border border-border-300 p-3 my-2',children:[jsx('h3',{className:'font-medium',children:m.title}),jsx('p',{role:'status',children:query.isError||!facts?m.unknown:!facts.available?(m[facts.reason]||m.unavailable):m.prefs}),facts?jsx('p',{className:'text-sm text-secondary',children:`${m.savedPrefs}: ${m.generate} ${facts.preferences.generate?m.on:m.off}; ${m.search} ${facts.preferences.searchChats?m.on:m.off}`}):null,snapshot?.state==='present'?jsxs('div',{children:[jsx('p',{className:'text-sm text-secondary',children:!query.isError&&facts.available?m.saved:m.old}),jsx('time',{dateTime:snapshot.updated_at,title:snapshot.updated_at,children:formatMemoryTimestamp(snapshot.updated_at,intl.locale)}),jsx('pre',{style:{maxWidth:'100%',maxHeight:'20rem',overflow:'auto',whiteSpace:'pre-wrap',overflowWrap:'anywhere'},className:'whitespace-pre-wrap break-words text-sm',children:snapshot.memory||m.empty}),snapshot.controls.length?jsx('ul',{style:{maxWidth:'100%',maxHeight:'12rem',overflow:'auto',whiteSpace:'normal',overflowWrap:'anywhere'},children:snapshot.controls.map((value,index)=>jsx('li',{children:value},String(index)))}):null]}):jsx('p',{className:'text-sm text-secondary',children:m.none})]});
}
export function withMemoryStatus(Component,props){return jsxs('div',{children:[jsx(Component,props),jsx(HostMemoryStatus,{})]});}
