/** Bind the HTTP entry to the committed native account window, never a renderer-selected window. */
import type {BrowserWindow} from 'electron';
import type {AdapterContext} from '../api/context';
import {readStaticArtifact,type StaticArtifactSelection} from './static-content';
import type {StaticPreviewOptions} from './static-session';
export function createStaticArtifactPreviewHost(ctx:AdapterContext,host:{current():boolean;committedWindow():BrowserWindow|undefined;onRetire(listener:()=>void):()=>void;preloadPath:string;open(options:StaticPreviewOptions):Promise<{opened:true}>}){
 return async(selection:StaticArtifactSelection):Promise<{opened:true}>=>{
  const ownerWindow=host.committedWindow();
  const current=()=>host.current()&&!!ownerWindow&&!ownerWindow.isDestroyed()&&host.committedWindow()===ownerWindow;
  if(!current())throw Error('Static preview requires the current account window.');
  const source=await readStaticArtifact(ctx,selection);
  if(!current()||!source.current())throw Error('Static preview account window changed.');
  const result = await host.open({document:source.document,current:()=>current()&&source.current(),ownerWindow:ownerWindow!,preloadPath:host.preloadPath,onRetire:host.onRetire,log:()=>ctx.log('Static preview cleanup could not be confirmed.')});
  if(!current()||!source.current())throw Error('Static preview account window changed.');
  return result;
 };
}
