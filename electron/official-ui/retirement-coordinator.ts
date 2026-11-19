/** Visible recovery waits for real host completion signals and the response
 * handoff fence, never a renderer-provided cause or an assumed microtask order. */
export function createRetirementCoordinator(options: {
  pendingOperations(): number;
  hasActiveAccount(): boolean;
  recover(current: () => boolean): Promise<void>;
  diagnostic(): void;
  stalled?(current: () => boolean): void;
  mayReportStalled?(): boolean;
  timeoutMs?: number;
}) {
  type Record = { key: object; done: boolean; deactivated: boolean; signaled: boolean; responses: boolean; recovering: boolean; timer?: ReturnType<typeof setTimeout> };
  let latest: Record | undefined;
  const attempt = async (record: Record) => {
    if (record !== latest || record.done || record.recovering || !record.deactivated ||
        !record.signaled || !record.responses || options.pendingOperations() || options.hasActiveAccount()) return;
    record.recovering = true;
    const current = () => latest === record && !options.pendingOperations() && !options.hasActiveAccount();
    try { await options.recover(current); if (current()) { record.done = true; clearTimeout(record.timer); } }
    catch { if (current()) options.diagnostic(); }
    finally { record.recovering = false; }
  };
  return {
    retire(key: object, responses: Promise<unknown>) {
      const record: Record = {key,done:false,deactivated:false,signaled:false,responses:false,recovering:false};
      if (latest) clearTimeout(latest.timer);
      latest=record;
      if (options.stalled) {
        const current = () => latest === record && !record.done && (options.mayReportStalled?.() ?? !options.hasActiveAccount());
        record.timer = setTimeout(() => { if (current()) { try { options.stalled!(current); } catch {} } }, options.timeoutMs ?? 15000);
        record.timer.unref?.();
      }
      void responses.then(()=>{record.responses=true;void attempt(record);},()=>{record.responses=true;options.diagnostic();void attempt(record);});
    },
    deactivated(key: object) { if(latest?.key===key){latest.deactivated=true;void attempt(latest);} },
    settled(key: object) { if(latest?.key===key){latest.signaled=true;void attempt(latest);} },
    signedOut(key: object) { if(latest?.key===key){latest.signaled=true;void attempt(latest);} },
    poke() { if(latest)void attempt(latest); },
  };
}
