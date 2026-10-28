import type { RefObject } from "react";
import { Menu, type MenuPosition } from "../ui/Menu";
import {
  webCodeEnvironmentEntries,
  type WebCodeEnvironmentOptions,
} from "./web-code-environments";
import "./web-code-environment-menu.css";

export function WebCodeEnvironmentMenu({
  options,
  position,
  anchors,
  onClose,
}: {
  options: WebCodeEnvironmentOptions;
  position: MenuPosition;
  anchors: RefObject<HTMLElement | null>[];
  onClose: () => void;
}) {
  const entries = webCodeEnvironmentEntries(options);
  return (
    <Menu
      label="Environment"
      className="web-code-environment-menu"
      bodyClassName="web-code-environment-body"
      width={260}
      position={position}
      anchors={anchors}
      searchable="Search environments…"
      {...entries}
      onClose={onClose}
    />
  );
}
