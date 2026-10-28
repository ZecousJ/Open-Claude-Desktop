import type { DeepLink } from "../../shared/deep-links";
import { sshLinkErrors } from "../../shared/ssh-links";
import { hasSshDialog, openSshDialog } from "./dialogs";

export function openSshLink(
  link: Extract<DeepLink, { kind: "ssh" | "ssh-error" }>,
  notify: (message: string) => void,
  translate: (message: string) => string,
) {
  if (link.kind === "ssh-error")
    return notify(translate(sshLinkErrors[link.error]));
  if (hasSshDialog() || document.querySelector('[role="dialog"]'))
    return notify(
      translate(
        "Couldn’t open link. Close the dialog, then open the link again.",
      ),
    );
  openSshDialog({ kind: "link", target: link.target });
}
