/** Real Node HTTP response serialization into an inert memory Duplex, no socket. */
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import {Duplex} from "node:stream";
import {withResponseLease} from "../electron/official-ui/response-lease";
function fixture(){
  const chunks:Buffer[]=[];
  const memory=new Duplex({read(){},write(chunk,_encoding,done){chunks.push(Buffer.from(chunk));done();}});
  const req=new http.IncomingMessage(memory as any);req.method="GET";
  const res=new http.ServerResponse(req);res.assignSocket(memory as any);res.on("error",()=>{});
  let current=true;withResponseLease({current:()=>current},res,()=>{});
  return{res,memory,retire:()=>{current=false;},text:()=>Buffer.concat(chunks).toString()};
}
test("real ServerResponse informational/flush/trailer outputs cannot bypass retired lease",()=>{
  const attempts=[
    (res:http.ServerResponse)=>res.writeEarlyHints({link:"</private>; rel=preload"}),
    (res:http.ServerResponse)=>res.writeContinue(),
    (res:http.ServerResponse)=>res.writeProcessing(),
    (res:http.ServerResponse)=>res.flushHeaders(),
    (res:http.ServerResponse)=>res.addTrailers({"X-Private":"secret"}),
  ];
  for(const attempt of attempts){const f=fixture();f.res.setHeader("X-Private","secret");f.retire();attempt(f.res);
    assert.match(f.text(),/410/);assert.doesNotMatch(f.text(),/secret|private|100 Continue|102 Processing|103 Early Hints/i);f.memory.destroy();}
});
test("preconstructed but unsent headers are destroyed rather than flushed after retirement",()=>{
  const f=fixture();f.res.writeHead(200,{"X-Private":"secret"});f.retire();f.res.flushHeaders();
  assert.equal(f.memory.destroyed,true);assert.equal(f.text(),"");
});
test("current real response retains informational and normal output semantics",()=>{
  const f=fixture();f.res.writeContinue();f.res.writeProcessing();f.res.writeEarlyHints({link:"</inert>; rel=preload"});f.res.writeHead(200);f.res.end("owned");
  assert.match(f.text(),/100 Continue/);assert.match(f.text(),/102 Processing/);assert.match(f.text(),/103 Early Hints/);assert.match(f.text(),/owned/);f.memory.destroy();
});
