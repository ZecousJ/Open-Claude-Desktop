import { useEffect, useState } from "react";

type CliStatus = { installed: boolean; signedIn: boolean };

/**
 * The desktop's GitHub CLI: installed and signed in? Read when a menu needs
 * it, at most once every half minute (a sign-in in the terminal shows the
 * next time the menu opens). Undefined until known, and on the web.
 */
let known: { at: number; status: CliStatus } | undefined;
export function useGitHubCliStatus(wanted: boolean): CliStatus | undefined {
  const [status, setStatus] = useState(() => known?.status);
  useEffect(() => {
    if (!wanted || (known && Date.now() - known.at < 30_000)) return;
    let live = true;
    void Promise.resolve(window.desktop?.githubCliStatus?.())
      .then((result) => {
        if (!result) return;
        known = { at: Date.now(), status: result };
        if (live) setStatus(result);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [wanted]);
  return wanted ? status : undefined;
}
