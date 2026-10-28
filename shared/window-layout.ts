export interface PopoutBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface SessionPopout {
  sessionId: string;
  sessionType: string;
  isSsh?: boolean;
  title?: string;
  alwaysOnTop?: boolean;
  bounds?: PopoutBounds;
}

export interface PanePopout extends SessionPopout {
  paneTileId: string;
  view?: string;
}

export interface ProjectPopout {
  projectId: string;
  title?: string;
  alwaysOnTop?: boolean;
  bounds?: PopoutBounds;
}

export interface OpenLayout {
  popouts: SessionPopout[];
  panes: PanePopout[];
  projects?: ProjectPopout[];
  handledPanes?: { sessionId: string; paneTileId: string }[];
  handledProjects?: string[];
}

export type LayoutCommandKind =
  | "get_layout"
  | "open_in_split"
  | "open_in_window"
  | "focus"
  | "close_split"
  | "set_sidebar_collapsed";

export interface LayoutCommand {
  requestId: string;
  kind: LayoutCommandKind;
  deadline: number;
  mainWindowHidden: boolean;
  callerSessionId: string;
  targetSessionId?: string;
  targetIsSsh?: boolean;
  targetTitle?: string;
  collapsed?: boolean;
}

export interface LayoutCommandResult {
  requestId: string;
  outcome: "done" | "noop" | "refused" | "failed";
  reason?: string;
  paneIndex?: number;
  layout?: {
    mode: string;
    sidebarCollapsed: boolean;
    primarySessionId?: string;
    primaryFocused: boolean;
    panes: {
      index: number;
      col: number;
      row: number;
      kind: string;
      sessionId?: string;
      focused: boolean;
    }[];
    popoutSessionIds: string[];
    otherPopoutCount: number;
    caller: { primary: boolean; paneIndex?: number; popout: boolean };
  };
}
