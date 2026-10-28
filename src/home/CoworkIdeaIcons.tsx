import {
  CalendarCheck,
  FileText,
  FolderOpen,
  Inbox,
  SlidersHorizontal,
  type LucideIcon,
} from "lucide-react";

/** A Cowork idea's 28px glyph (Lucide). */
function idea(Icon: LucideIcon) {
  return function IdeaIcon() {
    return (
      <Icon
        className="cowork-idea-icon"
        size={28}
        strokeWidth={1.5}
        aria-hidden="true"
      />
    );
  };
}

export const BriefingIdeaIcon = idea(CalendarCheck);
export const InboxIdeaIcon = idea(Inbox);
export const CustomizeIdeaIcon = idea(SlidersHorizontal);
export const OrganizeIdeaIcon = idea(FolderOpen);
export const FileIdeaIcon = idea(FileText);
