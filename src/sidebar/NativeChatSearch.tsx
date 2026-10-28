import { useContext } from "react";
import { useT } from "../i18n";
import { AppIcon } from "../ui/app-icon";
import { keyName, ShortcutPlatform } from "../ui/Tooltip";

/**
 * The current native unified frame has a Search row above New, including
 * Chat/Cowork. Source: O16/shared-21-DI_JOKFI.js:6816–6896. The caller owns
 * the existing command-palette action; opening Search does not start a chat.
 */
export function NativeChatSearch({ onSearch }: { onSearch: () => void }) {
  const t = useT();
  const platform = useContext(ShortcutPlatform);
  return (
    <div className="native-chat-search-wrap">
      <button
        type="button"
        className="native-chat-search"
        aria-keyshortcuts={platform === "darwin" ? "Meta+K" : "Control+K"}
        onMouseDown={(event) => event.preventDefault()}
        onClick={onSearch}
      >
        <span className="native-chat-search-leading" aria-hidden="true">
          <AppIcon name="Search" size={16} />
        </span>
        <span className="native-chat-search-label">{t("Search")}</span>
        <kbd aria-hidden="true">{keyName(platform, "mod")} K</kbd>
      </button>
    </div>
  );
}
