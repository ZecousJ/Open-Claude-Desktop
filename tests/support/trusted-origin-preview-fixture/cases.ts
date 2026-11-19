/** Fixed self-authored probes only. No caller-supplied HTML or destination. */
export const probeModes=['plain','link','refresh','custom-scheme','image','form','iframe','script-marker'] as const;
export type ProbeMode=typeof probeModes[number];
export function probeMode(value:unknown):value is ProbeMode{return typeof value==='string'&&(probeModes as readonly string[]).includes(value);}
export function fixedCases(shellOrigin:string){
 const u=new URL(shellOrigin);if(u.origin!==shellOrigin||u.protocol!=='http:'||u.hostname!=='localhost')throw Error('Invalid local probe origin');
 const target=shellOrigin+'/probe';
 const head='<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'none\'; connect-src \'none\'; frame-src \'none\'; form-action \'none\'; base-uri \'none\'">';
 return {
  plain:head+'<h1>Fixed inert preview</h1><p>No accounts, models, scripts, files, tools or network.</p>',
  link:head+'<h1>Fixed navigation probe</h1><a href="'+target+'">Try blocked local link</a>',
  refresh:head+'<meta http-equiv="refresh" content="0;url='+target+'"><h1>Fixed meta refresh probe</h1>',
  'custom-scheme':head+'<h1>Fixed custom scheme probe</h1><a href="claudex-inert-probe:blocked">Try blocked unregistered scheme</a>',
  image:head+'<h1>Fixed image probe</h1><img alt="Expected blocked local probe" src="'+target+'">',
  form:head+'<h1>Fixed form probe</h1><form action="'+target+'" method="get"><button>Try blocked local form</button></form>',
  iframe:head+'<h1>Fixed nested iframe probe</h1><iframe title="Expected blocked nested probe" src="'+target+'"></iframe>',
  'script-marker':head+'<h1>Fixed script marker probe</h1><p>The marker must never execute.</p><script>console.log("FIXED_INERT_SCRIPT_EXECUTED")</script>',
 } satisfies Record<ProbeMode,string>;
}

export function isExecutedMarker(value:unknown){return value==='FIXED_INERT_SCRIPT_EXECUTED';}
export function createProbeFailureLatch(onFailure:()=>void){
 let failed=false;const fail=()=>{if(failed)return;failed=true;onFailure();};
 return {get failed(){return failed;},listenerReached:fail,consoleMessage(value:unknown){if(isExecutedMarker(value))fail();}};
}
