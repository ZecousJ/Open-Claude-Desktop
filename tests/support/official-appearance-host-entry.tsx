/** Inert loopback harness: real product Surface/frame, synthetic bridge only. */
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { OfficialWebSurface } from '../../src-web/official/OfficialWebSurface';
import type { WebBridge } from '../../src-web/bridge';
import type { OfficialUiReadRequest, OfficialUiReadResponse } from '../../shared/official-ui-web';
import '../../src-web/official/host.css';
const accountId = 'appearance-local-fixture';
const activation = {};
const call = async (kind: 'read' | 'action', request: OfficialUiReadRequest): Promise<OfficialUiReadResponse> => {
  const answer = await fetch('/__appearance/bridge', {
    method: 'POST', headers: {'content-type':'application/json','x-appearance-fixture':'1'},
    body: JSON.stringify({kind, request:{...request, body:request.body ? Array.from(request.body) : undefined}}),
  });
  const result = await answer.json();
  if (!answer.ok) throw Error(result.error ?? 'Local fixture transport failed.');
  return {...result, body:new Uint8Array(result.body)};
};
const bridge = {
  auth: { current:{account:{id:accountId}}, activationIdentity:activation, onChange:()=>()=>{} },
  officialUiRead:(request:OfficialUiReadRequest)=>call('read',request),
  officialUiAction:(request:OfficialUiReadRequest)=>call('action',request),
  officialUiEvents:()=>()=>{},
} as unknown as WebBridge;
function Harness() {
  const [failure,setFailure] = useState(false), [error,setError] = useState('');
  return <>
    <aside style={{background:'#fff2b2',color:'#302200',font:'13px system-ui',padding:'6px 10px'}}>
      <strong>INERT F068 PRODUCT HARNESS — synthetic identity, no real account, no models or network services.</strong>{' '}
      <label><input type="checkbox" checked={failure} onChange={async e=>{
        const value=e.currentTarget.checked;
        try {const result=await fetch('/__appearance/failure',{method:'POST',headers:{'content-type':'application/json','x-appearance-fixture':'1'},body:JSON.stringify({enabled:value})});if(!result.ok)throw Error();setFailure(value);setError('');}
        catch {setError('Could not change local failure simulation.');}
      }}/>Simulate appearance save failure</label>
      {error&&<span role="alert">{error}</span>}
    </aside>
    <OfficialWebSurface {...({accountId,bridge,appearanceSettingsOptIn:true,onSignOut:async()=>{throw Error('This synthetic harness has no real sign-out operation.');}} as any)}/>
  </>;
}
createRoot(document.getElementById('root')!).render(<Harness/>);
