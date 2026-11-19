/** Host-owned static preview affordance. Does not replace interactive artifact rendering. */
import {Do as useState,vo as useEffect,Eo as useRef,qa as jsx,Ja as jsxs} from './vendor-frame-iz8L1jC9.js';
import {p as useIntl} from './vendor-intl-D9Num-b5.js';
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
export const staticPreviewTypes=new Set(['text/html','text/plain','text/markdown']);
export function staticPreviewSelection(props){
 if(!props||![props.organizationId,props.conversationId,props.artifactId,props.versionId].every(x=>typeof x==='string'&&uuid.test(x)))return null;
 return{conversationId:props.conversationId,artifactId:props.artifactId,versionId:props.versionId};
}
export function staticPreviewMessages(locale){
 return String(locale).toLowerCase().startsWith('zh')?{
 pending:'正在打开隔离的静态预览…',opening:'正在打开…',openedLabel:'静态预览已打开',button:'静态预览（隔离）',
 opened:'静态预览已在独立窗口打开。脚本、链接、表单、网络和工具均禁用。关闭窗口后，请重新选择此作品再打开预览。',
 unavailable:'当前运行环境不支持静态预览。',changed:'作品或账号已改变。请重新打开作品后再预览。',
 unknown:'无法确认静态预览是否已打开。重试前请先检查预览窗口。',
 unsupported:'此作品类型不支持静态预览。交互式预览为独立功能。',
 idle:'独立窗口中的只读预览；脚本、链接、表单、网络和工具均禁用。'
 }:{
 pending:'Opening isolated static preview…',opening:'Opening…',openedLabel:'Static preview opened',button:'Static preview (isolated)',
 opened:'Static preview opened in a separate window. Scripts, links, forms, network and tools are disabled. After closing it, reselect this artifact to open another preview.',
 unavailable:'Static preview is unavailable in this host.',changed:'This artifact or account changed. Reopen it before previewing.',
 unknown:'Static preview could not be confirmed. Check the preview window before retrying.',
 unsupported:'This artifact type is not supported by static preview. The interactive preview remains separate.',
 idle:'Read-only preview in a separate window; scripts, links, forms, network and tools are disabled.'
 };
}
export function StaticPreviewControl(props){
 const [state,setState]=useState({kind:'idle',message:''}),operation=useRef(null),intl=useIntl(),messages=staticPreviewMessages(intl.locale);
 const selection=staticPreviewSelection(props),key=JSON.stringify([props.organizationId,selection,props.type]);
 useEffect(()=>{setState({kind:'idle',message:''});return()=>{operation.current?.abort();operation.current=null;};},[key]);
 if(!selection)return null;
 const supported=staticPreviewTypes.has(props.type);
 const open=async()=>{
  if(operation.current||!supported)return;
  const abort=new AbortController();operation.current=abort;setState({kind:'pending',message:'pending'});
  try{
   const response=await fetch(`/api/organizations/${props.organizationId}/__claudex/static-artifact-preview`,{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify(selection),signal:abort.signal});
   const body=await response.json();
   if(abort.signal.aborted||operation.current!==abort)return;
   if(response.status!==202||body?.opened!==true||body.mode!=='static-isolated'||body.interactive!==false){
    setState({kind:'error',message:response.status===501?'unavailable':response.status===409?'changed':'unknown'});return;
   }
   setState({kind:'opened',message:'opened'});
  }catch{if(!abort.signal.aborted&&operation.current===abort)setState({kind:'error',message:'unknown'});}
  finally{if(operation.current===abort)operation.current=null;}
 };
 return jsxs('div',{className:'border-b border-border-300 px-3 py-2 text-caption',children:[jsx('button',{type:'button',className:'rounded border border-border-300 px-2 py-1 disabled:opacity-50',disabled:!supported||state.kind==='pending'||state.kind==='opened',onClick:open,children:state.kind==='pending'?messages.opening:state.kind==='opened'?messages.openedLabel:messages.button}),jsx('div',{role:state.kind==='error'?'alert':'status','aria-live':'polite',children:!supported?messages.unsupported:messages[state.message]||messages.idle})]});
}
export function withStaticPreview(props,children){return jsxs('div',{className:'flex h-full min-h-0 flex-col',children:[jsx(StaticPreviewControl,props,JSON.stringify([props.organizationId,props.conversationId,props.artifactId,props.versionId,props.type])),jsx('div',{className:'min-h-0 flex-1',children})]});}
