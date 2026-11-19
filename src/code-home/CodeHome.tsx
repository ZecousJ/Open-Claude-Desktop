import { useState, type ReactNode } from "react";
import type { Conversation } from "../../shared/types";
import { useHost } from "../host/HostContext";
import { t } from "../i18n";
import { CodeHomeEnvironmentSlot } from "./CodeHomeEnvironmentSlot";
import { useCodeHomeGutters } from "./useCodeHomeGutters";
import { CodeHomeSuggestionsSlot } from "./CodeHomeSuggestionsSlot";
import { CodeLandingTexture } from "./CodeLandingTexture";

interface CodeHomeProps {
  name: string;
  conversations: Conversation[];
  composer: ReactNode;
  /** Legacy caller data; the default home no longer mounts a landing list. */
  landing?: ReactNode;
}

export function CodeHome(props: CodeHomeProps) {
  return useHost().kind === "web" ? (
    <WebCodeHome composer={props.composer} />
  ) : (
    <DesktopCodeHome {...props} />
  );
}

function DesktopCodeHome({ composer }: CodeHomeProps) {
  const [suggestionsSlot, setSuggestionsSlot] =
    useState<HTMLUListElement | null>(null);
  const [environmentSlot, setEnvironmentSlot] = useState<HTMLDivElement | null>(
    null,
  );
  return (
    <CodeHomeEnvironmentSlot.Provider value={environmentSlot}>
      <CodeHomeSuggestionsSlot.Provider value={suggestionsSlot}>
        <div className="code-home-draft native-code-home">
          <CodeLandingTexture />
          <div className="native-code-home-centre">
            <div
              className="native-code-home-environments"
              ref={setEnvironmentSlot}
            />
            <ul
              className="native-code-home-suggestions next-steps"
              aria-label={t("Next steps")}
              ref={setSuggestionsSlot}
            />
          </div>
          {composer}
        </div>
      </CodeHomeSuggestionsSlot.Provider>
    </CodeHomeEnvironmentSlot.Provider>
  );
}

/** Web new-session home: the environment stack in the centre and the prompt below. */
function WebCodeHome({ composer }: { composer: ReactNode }) {
  const home = useCodeHomeGutters();
  const [environmentSlot, setEnvironmentSlot] = useState<HTMLDivElement | null>(
    null,
  );
  return (
    <CodeHomeEnvironmentSlot.Provider value={environmentSlot}>
      <div className="code-home-draft" ref={home}>
        <CodeLandingTexture />
        <div className="code-home-environments" ref={setEnvironmentSlot} />
        {composer}
      </div>
    </CodeHomeEnvironmentSlot.Provider>
  );
}
