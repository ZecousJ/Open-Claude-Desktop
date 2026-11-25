import { reconcileQueue, nextQueued } from './src/composer/queue.ts';
import { writeFileSync } from 'node:fs';
const base={id:'synthetic-a',title:'SYNTHETIC',mode:'code',providerId:'p',model:'m',pinned:false,archived:false,createdAt:1,updatedAt:1};
const entry=(text:string,patch:any={})=>({id:text,text,attachments:[],state:'queued',mode:'code',providerId:'p',model:'m',webSearch:false,...patch});
const conversation=(running:boolean,items:any[]=[])=>({...base,turns:[{id:'t',prompt:'SYNTHETIC',attachments:[],items,status:running?'inProgress':'completed',createdAt:1}]});
const steered=entry('one',{state:'steered',messageId:'m1'});
const delivered={id:'i',type:'userMessage',steered:true,clientId:'m1',text:'one',attachments:[]};
const cases=[
 ['steered waits',conversation(true),[steered]],
 ['steered delivered',conversation(true,[delivered]),[steered]],
 ['unread steer requeued',conversation(false),[steered]],
 ['definite null waits',conversation(true),[entry('one')]],
 ['idle queue sends first',conversation(false),[entry('one'),entry('two')]],
 ['failure blocks later',conversation(false),[entry('one',{error:'SYNTHETIC failure'}),entry('two')]],
 ['accepted steer blocks queue',conversation(true),[steered,entry('two')]],
 ['wrong item type cannot deliver',conversation(true,[{...delivered,type:'agentMessage'}]),[steered]],
 ['wrong client cannot deliver',conversation(true,[{...delivered,clientId:'other'}]),[steered]],
 ['missing steer flag cannot deliver',conversation(true,[{...delivered,steered:false}]),[steered]],
];
const normalized=(e:any)=>({text:e.text,state:e.state,messageId:e.messageId??null,error:e.error??null});
const vectors=cases.map(([name,c,entries]:any)=>{const next=reconcileQueue(entries,c);return {name,conversation:c,entries,expected:next.map(normalized),next:nextQueued(next,c)?.text??null};});
writeFileSync(process.argv[2],JSON.stringify(vectors,null,2)+'\n');
