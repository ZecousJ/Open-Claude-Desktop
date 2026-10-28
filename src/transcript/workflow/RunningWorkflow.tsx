import { useEffect, useState } from "react";

/**
 * Cowork's row while a dynamic workflow runs: three coral dots, "Running
 * workflow…", a dot and the time as "1m 3s". The workflow's own progress lives
 * in the side panel, so this row is all the transcript shows.
 */
export function RunningWorkflow({ startedAt }: { startedAt: number }) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  const seconds = Math.max(0, Math.floor((now - startedAt) / 1000));
  return (
    <div className="running-workflow" role="status">
      <span className="running-workflow-mark" aria-hidden="true">
        <i />
        <i />
        <i />
      </span>
      <span>Running workflow…</span>
      <span className="running-workflow-sep" aria-hidden="true">
        ·
      </span>
      <span aria-hidden="true">
        {seconds < 60
          ? `${seconds}s`
          : `${Math.floor(seconds / 60)}m ${seconds % 60}s`}
      </span>
    </div>
  );
}
