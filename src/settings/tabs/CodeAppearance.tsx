import { useEffect, useRef, useState, type CSSProperties } from "react";
import type {
  CodeDarkTheme,
  CodeLightTheme,
} from "../../../shared/settings-extras";
import {
  codeThemeForMode,
  codeThemePreviewVariables,
  type CodeThemeId,
  type CodeThemeMode,
} from "../code-theme-palettes";
import { CodeThemeSelect } from "../CodeThemeSelect";
import type { TabProps } from "../context";

/**
 * Claude Code → Code appearance, the original's two theme pickers with a diff
 * preview under each. The installed highlight.js GitHub assets provide the two
 * additional supported palettes; the original renderer palettes remain the
 * Claudex defaults.
 */
export function CodeThemePickers({
  settings,
  save,
  onError,
}: Pick<TabProps, "settings" | "save" | "onError">) {
  const [pending, setPending] = useState({ light: false, dark: false });
  const busy = useRef(new Set<CodeThemeMode>());
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
  const commit = async (mode: CodeThemeMode, value: CodeThemeId) => {
    if (busy.current.has(mode)) return;
    busy.current.add(mode);
    setPending((current) => ({ ...current, [mode]: true }));
    try {
      await save(
        mode === "light"
          ? { codeLightTheme: value as CodeLightTheme }
          : { codeDarkTheme: value as CodeDarkTheme },
        "Couldn’t save your change. Try again.",
      );
    } catch (error) {
      if (live.current) onError(error);
    } finally {
      busy.current.delete(mode);
      if (live.current)
        setPending((current) => ({ ...current, [mode]: false }));
    }
  };
  return (
    <div className="code-themes">
      {(["light", "dark"] as const).map((theme) => (
        <div key={theme} className="code-theme">
          <CodeThemeSelect<CodeThemeId>
            label={theme === "light" ? "Light code theme" : "Dark code theme"}
            value={codeThemeForMode(
              theme,
              settings.codeLightTheme,
              settings.codeDarkTheme,
            )}
            options={[
              {
                value: theme === "light" ? "claudex-light" : "claudex-dark",
                label: theme === "light" ? "Claudex Light" : "Claudex Dark",
              },
              {
                value: theme === "light" ? "github-light" : "github-dark",
                label: theme === "light" ? "GitHub Light" : "GitHub Dark",
              },
            ]}
            disabled={pending[theme]}
            onChange={(value) => void commit(theme, value)}
          />
          <CodePreview
            theme={theme}
            value={codeThemeForMode(
              theme,
              settings.codeLightTheme,
              settings.codeDarkTheme,
            )}
          />
        </div>
      ))}
    </div>
  );
}

function CodePreview({
  theme,
  value,
}: {
  theme: CodeThemeMode;
  value: CodeThemeId;
}) {
  return (
    <pre
      className={`code-theme-preview ${theme}`}
      style={codeThemePreviewVariables(value) as CSSProperties}
      aria-hidden="true"
      data-no-translate
    >
      <span className="line">
        <i>1</i>
        <b> </b>
        <span className="k">function</span> <span className="f">greet</span>(
        <span className="p">name</span>: <span className="t">string</span>){" "}
        {"{"}
      </span>
      <span className="line removed">
        <i>2</i>
        <b>-</b>
        {"  "}
        <span className="k">return</span> <span className="s">"Hello, "</span> +{" "}
        <span className="p">name</span>;
      </span>
      <span className="line added">
        <i>2</i>
        <b>+</b>
        {"  "}
        <span className="k">return</span>{" "}
        <span className="s">{"`Hello, ${name}!`"}</span>;
      </span>
      <span className="line">
        <i>3</i>
        <b> </b>
        {"}"}
      </span>
    </pre>
  );
}
