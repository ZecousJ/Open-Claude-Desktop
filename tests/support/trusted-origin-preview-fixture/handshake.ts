import {probeMode,type ProbeMode} from './cases';
/** Host-owned fixture handshake. Nonces bind documents; origin/native lease supply authority. */
const nonce=(x:unknown):x is string=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x);
export function createHandshake(options:{hostNonce:string;mode?:ProbeMode;current():boolean;send(value:unknown):void;close():void}){
 if(!nonce(options.hostNonce)||!probeMode(options.mode??'plain'))throw Error('Invalid nonce');
 let state:'new'|'binding'|'ready'|'retired'='new',docNonce:string|undefined;
 const retire=()=>{if(state==='retired')return;state='retired';options.close();};
 const active=()=>{if(state==='retired')return false;let live=false;try{live=options.current();}catch{}if(!live)retire();return live;};
 const shape=(v:unknown,keys:string[]):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v)&&Object.keys(v).length===keys.length&&keys.every(k=>Object.hasOwn(v,k));
 return {get state(){return state;},retire,
  ready(value:unknown){if(!active())return;if(state!=='new'||!shape(value,['type','docNonce'])||value.type!=='ready'||!nonce(value.docNonce)){retire();return;}docNonce=value.docNonce;state='binding';return {type:'bind',docNonce,hostNonce:options.hostNonce};},
  receive(value:unknown){if(!active())return false;if(!shape(value,['type','docNonce','hostNonce'])||value.docNonce!==docNonce||value.hostNonce!==options.hostNonce){retire();return false;}if(value.type==='ack'&&state==='binding'){state='ready';if(!active())return false;try{options.send({type:'inert',docNonce,hostNonce:options.hostNonce,sequence:1,mode:options.mode??'plain'});return true;}catch{retire();return false;}}if(value.type==='loaded'&&state==='ready')return true;retire();return false;},
 };
}

export function readyForMount(value:unknown,mount:string):unknown|undefined{
 if(!nonce(mount)||!value||typeof value!=='object'||Array.isArray(value))return;
 const v=value as Record<string,unknown>;
 if(Object.keys(v).length!==2||!Object.hasOwn(v,'message')||v.mount!==mount)return;
 return v.message;
}
