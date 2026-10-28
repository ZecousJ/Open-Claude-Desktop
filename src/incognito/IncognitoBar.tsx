import { IncognitoSolidIcon } from "../ui/IncognitoIcon";
import { IconButton } from "../ui/Controls";
import { ExitIncognitoIcon } from "../ui/icons";

/**
 * Incognito chrome: current web uses the left header lockup; the native
 * window retains its centred lockup and OS drag region.
 */
export function IncognitoBar({ onExit }: { onExit: () => void }) {
  return (
    <header className="incognito-bar">
      <h1>
        <span className="incognito-bar-icon">
          <IncognitoSolidIcon />
        </span>
        <span>Incognito</span>
      </h1>
      <IconButton
        label="Exit incognito"
        shortcut={["shift", "mod", "I"]}
        placement="below-before"
        className="incognito-exit"
        onClick={onExit}
      >
        <ExitIncognitoIcon />
      </IconButton>
    </header>
  );
}
