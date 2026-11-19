import http from "node:http";
import { Readable, Writable } from "node:stream";
import { randomUUID } from "node:crypto";
import { officialSideQuestionPath,officialSideQuestionBatchPath,officialSideQuestionStopPath } from "../../../shared/official-side-question";
import { reply, type AdapterContext } from "./context";
import { nativeSideQuestionRoute } from "./native-side-question";
import { readBoundedBytes, RequestBodyError } from "./request-body";
import { ScopedMap } from "./scope";

type Event={event:string;data:Record<string,unknown>};
type Operation={id:string;base:string;owner:string;identity:unknown;events:Event[];bytes:number;done:boolean;response:Capture;timer:NodeJS.Timeout};
class Capture extends Writable {
  status=0;headers:Record<string,string>={};chunks:Buffer[]=[];ready!:()=>void; readyPromise=new Promise<void>(resolve=>{this.ready=resolve});
  operation?:Operation;
  writeHead(status:number,headers:Record<string,string>={}) {this.status=status;this.headers=headers;this.ready();return this;}
  override _write(chunk:Buffer,_encoding:BufferEncoding,done:(error?:Error|null)=>void) {
    const buffer=Buffer.from(chunk);
    if(this.status!==200){this.chunks.push(buffer);done();return;}
    const match=/^event: ([a-z_]+)\ndata: ([^\n]+)\n\n$/.exec(buffer.toString("utf8"));
    try {
      if(!match || !["content_block_delta","message_stop","error"].includes(match[1])) throw Error("Invalid side stream event.");
      const data=JSON.parse(match[2]);
      const op=this.operation;
      if(!op || op.done || op.events.length>=8192 || op.bytes+buffer.length>2*1024*1024)throw Error("Side stream limit exceeded.");
      op.events.push({event:match[1],data});op.bytes+=buffer.length;
      if(match[1]==="message_stop" || match[1]==="error")op.done=true;
      done();
    } catch(error) {done(error as Error);}
  }
}
export function createWebSideQuestionRoute(ctx:AdapterContext) {
 const operations=new ScopedMap<string,Operation>("side-question-operations");
 const scoped=new Proxy(ctx,{get(target,key,receiver){return key === "readOnly" ? false : Reflect.get(target,key,receiver)}});
 return async(req:http.IncomingMessage,res:http.ServerResponse,p:string,url:URL):Promise<boolean>=>{
  const isStart=officialSideQuestionPath.test(p),batch=officialSideQuestionBatchPath.exec(p),stop=officialSideQuestionStopPath.exec(p);
  if(!isStart&&!batch&&!stop)return false;
  const fail=(status:number,message:string)=>reply(res,{error:{message}},status);
  if(!ctx.sideQuestionGateway)return fail(501,"Side questions are unavailable on this host.");
  const owner=ctx.account()?.id,identity=ctx.sessionIdentity?.();
  if(!owner||identity==null||ctx.isCurrent?.()!==true)return fail(409,"The account activation changed.");
  if(isStart){
    if(req.method!=="POST"||url.search)return fail(400,"Invalid side-question request.");
    if(operations.size>=32)return fail(429,"Too many side questions are open.");
    let bytes:Buffer;
    try{bytes=await readBoundedBytes(req,2*1024*1024);}catch(error){return fail(error instanceof RequestBodyError?error.status:400,"Invalid side-question request.");}
    const inner=Readable.from([bytes]) as http.IncomingMessage;inner.method="POST";inner.url=p;inner.headers=req.headers;
    const capture=new Capture();capture.on("error",()=>{});
    const operation:Operation={id:randomUUID(),base:p.slice(0,-"/side_question".length),owner,identity,events:[],bytes:0,done:false,response:capture,timer:setTimeout(()=>{},0)};
    clearTimeout(operation.timer);capture.operation=operation;
    capture.once("close",()=>{
      if(!capture.status)capture.ready();
      if(!operation.done){operation.events.push({event:"error",data:{type:"error",error:{type:"api_error",message:"The side question could not be completed."}}});operation.done=true;}
    });
    operation.timer=setTimeout(()=>{capture.destroy();operations.delete(operation.id);},3*60_000);operation.timer.unref();
    operations.set(operation.id,operation);
    void nativeSideQuestionRoute(inner,capture as unknown as http.ServerResponse,p,scoped).catch(()=>capture.destroy());
    await capture.readyPromise;
    if(!capture.status){clearTimeout(operation.timer);operations.delete(operation.id);return fail(503,"The side question could not be started.");}
    if(capture.status!==200){
      await new Promise<void>(resolve=>capture.writableFinished?resolve():capture.once("finish",resolve));
      clearTimeout(operation.timer);operations.delete(operation.id);
      res.writeHead(capture.status,capture.headers);res.end(Buffer.concat(capture.chunks));return true;
    }
    return reply(res,{operation_id:operation.id,cursor:0,events:[],done:false});
  }
  const match=batch??stop!;const operation=operations.get(match[1]);
  if(!operation||operation.owner!==owner||operation.identity!==identity||!p.startsWith(operation.base+"/claudex_side_question/"))return fail(404,"Side question is unavailable.");
  if(stop){
    if(req.method!=="POST"||url.search)return fail(400,"Invalid side-question stop.");
    operation.response.destroy();clearTimeout(operation.timer);operations.delete(operation.id);return reply(res,{stopped:true});
  }
  if(req.method!=="GET"||!/^\?cursor=(0|[1-9][0-9]{0,6})$/.test(url.search))return fail(400,"Invalid side-question cursor.");
  const cursor=Number(url.search.slice(8));if(cursor>operation.events.length)return fail(400,"Invalid side-question cursor.");
  const events:Event[]=[];let bytes=0;
  for(const event of operation.events.slice(cursor,cursor+64)){
    const size=Buffer.byteLength(JSON.stringify(event));if(bytes+size>220*1024)break;
    events.push(event);bytes+=size;
  }
  const next=cursor+events.length,done=operation.done&&next===operation.events.length;
  return reply(res,{operation_id:operation.id,cursor:next,events,done});
 };
}
