/** Internal, request-scoped stages for locale-only saves. No renderer API or account data. */
import {AsyncLocalStorage} from 'node:async_hooks';
import {types} from 'node:util';
const stages = [
 'request','catalog-validation','save-dispatch','readback','complete',
 'native-schema','native-policy','native-validation','integration-before','integration-after',
 'integration-keepawake','integration-tray','integration-shortcuts','integration-shortcuts-preserved','integration-monitor',
 'rollback-before','rollback-after','flush-before','flush-after','native-theme','native-notify',
 'device-refresh-before','device-refresh-after','native-engine-stop','native-engine-ensure','native-return',
] as const;
type Stage=typeof stages[number];
const allowed=new Set<string>(stages);
const scope=new AsyncLocalStorage<{stage:Stage;active:boolean;log:(...args:unknown[])=>void}>();
function emit(state:NonNullable<ReturnType<typeof scope.getStore>>,result:'enter'|'failed',kind='none'){
 try{state.log('[official-ui:locale-save]',`stage=${state.stage} result=${result} error=${kind}`);}catch{}
}
function kind(error:unknown){
 try{
  if(types.isProxy(error)||!types.isNativeError(error))return 'unknown';
  const descriptor=Object.getOwnPropertyDescriptor(error,'name');
  if(descriptor)return 'value' in descriptor&&['Error','TypeError','RangeError','AbortError','ZodError'].includes(descriptor.value)?descriptor.value:'unknown';
  const prototype=Object.getPrototypeOf(error);
  return prototype===TypeError.prototype?'TypeError':prototype===RangeError.prototype?'RangeError':prototype===Error.prototype?'Error':'unknown';
 }catch{return 'unknown';}
}
export function localeSaveStage(stage:Stage){const state=scope.getStore();if(!state||!state.active||!allowed.has(stage))return;state.stage=stage;emit(state,'enter');}
export function localeSaveFailure(error:unknown){const state=scope.getStore();if(state?.active)emit(state,'failed',kind(error));}
export async function withLocaleSaveDiagnostics<T>(log:(...args:unknown[])=>void,operation:()=>Promise<T>):Promise<T>{
 const state={stage:'request' as Stage,active:true,log};
 return scope.run(state,async()=>{emit(state,'enter');try{return await operation();}catch(error){emit(state,'failed',kind(error));throw error;}finally{state.active=false;}});
}
