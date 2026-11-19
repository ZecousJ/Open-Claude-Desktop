/** Host-owned read error UI; never replaces failed knowledge with an empty success. */
import {Do as useState,vo as useEffect,Eo as useRef,qa as jsx,Ja as jsxs} from './vendor-frame-iz8L1jC9.js';
import {p as useIntl} from './vendor-intl-D9Num-b5.js';
import {EP as useDocs,IkJ as useFiles} from './shared-0-BgsOqC85.js';
import {h as useQueryClient} from './vendor-query-CdfkcLg6.js';
import {zG as syncQueryName} from './shared-l-p-m-w-0-C_nAiu5o.js';
import {G3 as Status} from './shared-2-CuvP2TaI.js';
export function ProjectKnowledgeError({projectUuid,organizationUuid,failed}) {
 const docs=useDocs(projectUuid,false),files=useFiles(projectUuid,false),client=useQueryClient(),intl=useIntl();
 const [busy,setBusy]=useState(false),operation=useRef(null),alive=useRef(true);
 useEffect(()=>{alive.current=true;return()=>{alive.current=false;operation.current=null;};},[projectUuid,organizationUuid]);
 // The parent owns the real query error. Disabled observers must not restart
 // a failed query merely because this error panel was mounted.
 if(!failed)return null;
 const retry=async()=>{
  if(!alive.current||operation.current)return;
  const token={};operation.current=token;setBusy(true);
  const attempt=read=>{try{return Promise.resolve(read());}catch(error){return Promise.reject(error);}};
  try{
   await Promise.allSettled([
    attempt(()=>docs.refetch({cancelRefetch:false})),attempt(()=>files.refetch({cancelRefetch:false})),
    attempt(()=>client.refetchQueries({queryKey:[syncQueryName,{orgUuid:organizationUuid,projectUuid,calculateSize:undefined}],exact:true,type:'active'},{cancelRefetch:false,throwOnError:true})),
   ]);
  }catch{/* Real query errors remain in the query cache; never claim success here. */}
  finally{if(alive.current&&operation.current===token){operation.current=null;setBusy(false);}}
 };
 return jsx(Status,{variant:'error',headline:intl.formatMessage({defaultMessage:'Something went wrong',id:'JqiqNj0Ooi'}),ctaLabel:intl.formatMessage({defaultMessage:'Try again',id:'FazwRldA7z'}),ctaBusy:busy,onCtaClick:retry});
}
export function withProjectKnowledgeError(failed,count,props,children){
 if(!failed)return children;
 return jsxs('div',{children:[jsx(ProjectKnowledgeError,{...props,failed},JSON.stringify([props.accountUuid,props.organizationUuid,props.projectUuid])),count>0?children:null]});
}
