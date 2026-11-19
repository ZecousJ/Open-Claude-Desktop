/** Opt-in, public-settings transport diagnostics only. No URLs, headers, bodies, identities or messages. */
export function acceptanceTransportRecord(input: { stage: 'begin'|'response'|'failure'; globalFetch: boolean; expectedService: boolean; envProxy: boolean; hasProxy: boolean; hasExtraCa: boolean; dispatcher: unknown; status?: number; error?: unknown }) {
  const e=input.error as {name?:unknown;cause?:{code?:unknown}}|undefined;
  const allowedNames=['Error','TypeError','AbortError','TimeoutError','AggregateError'];
  const code=typeof e?.cause?.code==='string'&&/^[A-Z0-9_]{1,64}$/.test(e.cause.code)?e.cause.code:undefined;
  return {stage:input.stage,transport:input.globalFetch?'node-global-fetch':'injected-fetch',expectedService:input.expectedService,envProxy:input.envProxy,hasProxy:input.hasProxy,hasExtraCa:input.hasExtraCa,dispatcher:['Agent','EnvHttpProxyAgent','ProxyAgent'].includes(String(input.dispatcher))?input.dispatcher:'unknown',...(Number.isInteger(input.status)?{status:input.status}:{}),...(e?{errorType:allowedNames.includes(String(e.name))?e.name:'unknown',...(code?{causeCode:code}:{})}:{})};
}
