/** Minimal host-only activation checks; recovered official source stays immutable. */
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
export const hostWindowManagerRevision='claudex-window-activation-v1';
export const hostWindowManagerSource='claude-frontend-4.4212.0/electron/recovered/window-manager.cjs';
export const hostWindowManagerOriginalHash='53730fe3b8e2833997c83f5ded25afdb063f37d9d54b51420f5228676286b840';
export const hostWindowManagerOutputHash='501c4e079e89e9133cbcdbda0f64d77dc8e10c2b3befd0724045c91310380435';
const sha=x=>createHash('sha256').update(x).digest('hex');
export const hostWindowManagerRules=[
 ['preserve-host-only-config','allowedOrigins:e.allowedOrigins,maxPendingWindows:', 'allowedOrigins:e.allowedOrigins,claudexActivationBound:e.claudexActivationBound,allowWebContents:e.allowWebContents,maxPendingWindows:'],
 ['bind-default-session-to-real-caller','getDefaultWindowOptions(){return typeof this.config.defaultWindowOptions=="function"?this.config.defaultWindowOptions():this.config.defaultWindowOptions}', 'getDefaultWindowOptions(e){if(this.config.claudexActivationBound===!0){try{return typeof this.config.defaultWindowOptions=="function"?this.config.defaultWindowOptions(e):null}catch{return null}}return typeof this.config.defaultWindowOptions=="function"?this.config.defaultWindowOptions():this.config.defaultWindowOptions}'],
 ['recheck-host-lease-on-manager-ipc','validateOrigin(e){if(!this.config.allowedOrigins)', 'validateOrigin(e){if(this.config.claudexActivationBound===!0){try{if(typeof this.config.allowWebContents!=="function"||this.config.allowWebContents(e)!==!0)return!1}catch{return!1}}if(!this.config.allowedOrigins)'],
 ['recheck-host-lease-before-window-open','e.setWindowOpenHandler((t=>{let{frameName:r,url:i}=t', 'e.setWindowOpenHandler((t=>{if(this.config.claudexActivationBound===!0&&!this.validateOrigin(e))return{action:"deny"};let{frameName:r,url:i}=t'],
 ['pass-real-parent-and-refuse-missing-private-session','n=this.getDefaultWindowOptions();return{action:"allow",overrideBrowserWindowOptions:', 'n=this.getDefaultWindowOptions(e);if(this.config.claudexActivationBound===!0&&(!n||typeof n!=="object"||typeof n.then==="function"||!n.webPreferences?.session||typeof n.webPreferences.session!=="object"||typeof n.webPreferences.session.then==="function"))return{action:"deny"};return{action:"allow",overrideBrowserWindowOptions:'],
 ['retain-sandbox-in-activation-bound-popups','sandbox:n.webPreferences?.sandbox??!0', 'sandbox:this.config.claudexActivationBound===!0?!0:n.webPreferences?.sandbox??!0'],
 ['reject-child-created-after-parent-retirement','e.on("did-create-window",((n,{frameName:r})=>{let i=r,a=this.pendingWindows.get(i);', 'e.on("did-create-window",((n,{frameName:r})=>{if(this.config.claudexActivationBound===!0&&!this.validateOrigin(e)){try{n.destroy()}catch{p("Retired managed window cleanup was not confirmed.")}return}let i=r,a=this.pendingWindows.get(i);'],
];
export function deriveOfficialHostWindowManager(source){
 if(typeof source!=='string'||sha(source)!==hostWindowManagerOriginalHash)throw Error('Pinned window-manager source checksum mismatch.');
 let result=source;
 for(const [name,before,after]of hostWindowManagerRules){const at=result.indexOf(before);if(at<0||result.indexOf(before,at+before.length)!==-1)throw Error('Pinned window-manager anchor mismatch: '+name);result=result.slice(0,at)+after+result.slice(at+before.length);}
 if(sha(result)!==hostWindowManagerOutputHash)throw Error('Pinned window-manager output checksum mismatch.');
 return result;
}
/** Lightweight packaging check; full assembly also verifies immutable archive derivation. */
export function verifyPackagedHostWindowManager(root){
 const meta=JSON.parse(fs.readFileSync(path.join(root,'manifest.json'),'utf8'));
 const file=path.join(root,'host/window-manager.cjs');
 if(fs.lstatSync(file).isSymbolicLink())throw Error('Host window manager cannot be a symlink.');
 const expected=meta.hostWindowManager?hostWindowManagerOutputHash:hostWindowManagerOriginalHash;
 if(sha(fs.readFileSync(file))!==expected)throw Error('Packaged window-manager checksum mismatch.');
 if(!meta.hostWindowManager&&!['hostAuth','hostCapabilities','hostCompletion','hostUsage'].every(key=>meta[key]===null))throw Error('Activation-bound native host derivation is missing.');
 if(meta.hostWindowManager&&(meta.hostWindowManager.revision!==hostWindowManagerRevision||meta.hostWindowManager.originalSha256!==hostWindowManagerOriginalHash||meta.hostWindowManager.outputSha256!==hostWindowManagerOutputHash))throw Error('Packaged window-manager revision mismatch.');
 return expected;
}
export function applyOfficialHostWindowManager(hostDirectory){
 const directory=fs.realpathSync(hostDirectory);if(directory.split(path.sep).includes('.restore'))throw Error('Recovered official source is immutable.');
 const file=path.join(directory,'window-manager.cjs');if(fs.lstatSync(file).isSymbolicLink())throw Error('Host window manager cannot be a symlink.');
 const result=deriveOfficialHostWindowManager(fs.readFileSync(file,'utf8'));fs.writeFileSync(file,result);
 return {revision:hostWindowManagerRevision,source:hostWindowManagerSource,originalSha256:hostWindowManagerOriginalHash,outputSha256:sha(result),rules:hostWindowManagerRules.map(r=>r[0])};
}
