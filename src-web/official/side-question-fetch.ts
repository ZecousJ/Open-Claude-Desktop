import type { OfficialUiReadRequest,OfficialUiReadResponse } from "../../shared/official-ui-web";
type Bridge=(request:OfficialUiReadRequest)=>Promise<OfficialUiReadResponse>;
type Batch={operation_id:string;cursor:number;events:{event:string;data:Record<string,unknown>}[];done:boolean};
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const encoder=new TextEncoder();
function parse(result:OfficialUiReadResponse,previous?:Batch):Batch {
 if(result.status!==200||result.body.byteLength>256*1024||!/^application\/json(?:;|$)/i.test(result.contentType))throw Error("Invalid side-question response.");
 const value=JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(result.body)) as Batch;
 if(!value||!uuid.test(value.operation_id)||!Number.isSafeInteger(value.cursor)||value.cursor<0||typeof value.done!=="boolean"||!Array.isArray(value.events)||value.events.length>64)throw Error("Invalid side-question batch.");
 if(previous && (value.operation_id!==previous.operation_id || value.cursor!==previous.cursor+value.events.length) || !previous && (value.cursor!==0||value.events.length||value.done))throw Error("Side-question cursor changed.");
 if(value.events.some(entry=>!entry||!["content_block_delta","message_stop","error"].includes(entry.event)||!entry.data||entry.data.type!==entry.event))throw Error("Invalid side-question event.");
 const terminal=value.events.findIndex(entry=>entry.event==="message_stop"||entry.event==="error");
 if((terminal>=0 && (terminal!==value.events.length-1||!value.done)) || (value.done && terminal<0))throw Error("Invalid side-question termination.");
 return value;
}
export async function openOfficialSideQuestion(request:OfficialUiReadRequest,signal:AbortSignal,read:Bridge,action:Bridge):Promise<Response> {
 if(signal.aborted)throw new DOMException("The request was aborted.","AbortError");
 const answer=await action(request);
 if(answer.status!==200)return new Response(answer.body as BodyInit,{status:answer.status,headers:{"Content-Type":answer.contentType}});
 let batch:Batch;
 try{batch=parse(answer);}catch{return Response.json({error:"Invalid side-question response."},{status:502});}
 const base=request.path.slice(0,-"/side_question".length)+`/claudex_side_question/${batch.operation_id}`;
 let closed=false,stopped=false,streamController:ReadableStreamDefaultController<Uint8Array>|undefined;
 const stop=()=>{if(stopped)return;stopped=true;void action({method:"POST",path:base+"/stop",contentType:"application/json",body:encoder.encode("{}")}).catch(()=>{});};
 if(signal.aborted){stop();throw new DOMException("The request was aborted.","AbortError");}
 const abort=()=>{closed=true;stop();try{streamController?.error(new DOMException("The request was aborted.","AbortError"));}catch{}};signal.addEventListener("abort",abort,{once:true});
 const stream=new ReadableStream<Uint8Array>({
  start(controller){streamController=controller;},
  async pull(controller){
   try{
    while(!closed){
     const result=await read({method:"GET",path:base+`?cursor=${batch.cursor}`});
     if(closed)return;
     const next=parse(result,batch);batch=next;
     if(next.events.length){controller.enqueue(encoder.encode(next.events.map(event=>`event: ${event.event}\ndata: ${JSON.stringify(event.data)}\n\n`).join("")));}
     if(next.done){closed=true;signal.removeEventListener("abort",abort);controller.close();return;}
     if(next.events.length)return;
     await new Promise(resolve=>setTimeout(resolve,150));
    }
   }catch{
    if(!closed){closed=true;stop();signal.removeEventListener("abort",abort);controller.enqueue(encoder.encode('event: error\ndata: {"type":"error","error":{"type":"api_error","message":"The side question could not be completed."}}\n\n'));controller.close();}
   }
  },
  cancel(){closed=true;signal.removeEventListener("abort",abort);stop();},
 });
 return new Response(stream,{status:200,headers:{"Content-Type":"text/event-stream; charset=utf-8","Cache-Control":"no-store"}});
}
