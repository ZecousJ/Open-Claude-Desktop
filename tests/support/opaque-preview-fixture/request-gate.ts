/** Inert fixture only. Host-injected one-use request tag; never a shell proof. */
import {randomBytes} from 'node:crypto';
export const fixtureOrigin='https://fixture.invalid';
export const tagHeader='x-claudex-inert-request-tag';
export interface TrustedRequest {id:number;url:string;method:string;webContentsId?:number;frame?:unknown;resourceType:string;requestHeaders:Record<string,string>}
export function createFixtureRequestGate(options:{webContentsId:number;frame:unknown;url:string;epoch:unknown;currentEpoch():unknown;current():boolean;now?:()=>number;lifetimeMs?:number}){
 const now=options.now??Date.now, deadline=now()+(options.lifetimeMs??30000);let live=true,issued=false,consumed=false,tag:string|undefined;
 const active=()=>{try{return live&&now()<deadline&&options.currentEpoch()===options.epoch&&options.current();}catch{return false;}};
 const strip=(headers:Record<string,string>)=>Object.fromEntries(Object.entries(headers).filter(([key])=>key.toLowerCase()!==tagHeader));
 return {
  authorize(details:TrustedRequest){
   const headers=strip(details.requestHeaders);
   if(!active()||issued||!Number.isSafeInteger(details.id)||details.id<0||details.webContentsId!==options.webContentsId||details.frame!==options.frame||details.resourceType!=='subFrame'||details.method!=='GET'||details.url!==options.url)return {cancel:true,requestHeaders:headers};
   issued=true;tag=randomBytes(32).toString('hex');return {cancel:false,requestHeaders:{...headers,[tagHeader]:tag}};
  },
  consume(method:string,url:string,headers:Headers){
   const supplied=headers.get(tagHeader);
   if(!active()||method!=='GET'||url!==options.url||!tag||supplied!==tag)return false;
   tag=undefined;consumed=true;return true;
  },
  get consumed(){return consumed;},
  retire(){live=false;tag=undefined;},
 };
}
