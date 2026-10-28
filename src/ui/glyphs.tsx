import { forwardRef } from "react";
import {
  type LucideIcon,
  type LucideProps,
  Archive as LucideArchive,
  ArrowDown as LucideArrowDown,
  ArrowLeft as LucideArrowLeft,
  ArrowRight as LucideArrowRight,
  ArrowUp as LucideArrowUp,
  ArrowUpDown as LucideArrowUpDown,
  ArrowUpRight as LucideArrowUpRight,
  BadgeCheck as LucideBadgeCheck,
  Ban as LucideBan,
  Beaker as LucideBeaker,
  Binoculars as LucideBinoculars,
  Blocks as LucideBlocks,
  BookOpen as LucideBookOpen,
  Brain as LucideBrain,
  Calendar as LucideCalendar,
  Camera as LucideCamera,
  ChartColumn as LucideChartColumn,
  ChartLine as LucideChartLine,
  Check as LucideCheck,
  ChevronDown as LucideChevronDown,
  ChevronLeft as LucideChevronLeft,
  ChevronRight as LucideChevronRight,
  ChevronUp as LucideChevronUp,
  Circle as LucideCircle,
  CircleAlert as LucideCircleAlert,
  CircleCheck as LucideCircleCheck,
  CircleDot as LucideCircleDot,
  CircleFadingPlus as LucideCircleFadingPlus,
  CircleHelp as LucideCircleHelp,
  CircleUserRound as LucideCircleUserRound,
  CircleX as LucideCircleX,
  Clock as LucideClock,
  Cloud as LucideCloud,
  CloudOff as LucideCloudOff,
  Code as LucideCode,
  Copy as LucideCopy,
  CornerDownLeft as LucideCornerDownLeft,
  Database as LucideDatabase,
  Diff as LucideDiff,
  Dna as LucideDna,
  Download as LucideDownload,
  Ellipsis as LucideEllipsis,
  EllipsisVertical as LucideEllipsisVertical,
  Expand as LucideExpand,
  ExternalLink as LucideExternalLink,
  Eye as LucideEye,
  EyeOff as LucideEyeOff,
  File as LucideFile,
  FileCode2 as LucideFileCode2,
  FileDiff as LucideFileDiff,
  FileSpreadsheet as LucideFileSpreadsheet,
  Files as LucideFiles,
  Filter as LucideFilter,
  Flag as LucideFlag,
  Folder as LucideFolder,
  FolderOpen as LucideFolderOpen,
  FolderPlus as LucideFolderPlus,
  Gavel as LucideGavel,
  GitBranch as LucideGitBranch,
  GitCommitVertical as LucideGitCommitVertical,
  GitPullRequest as LucideGitPullRequest,
  Github as LucideGithub,
  Globe as LucideGlobe,
  GraduationCap as LucideGraduationCap,
  Hand as LucideHand,
  History as LucideHistory,
  House as LucideHouse,
  Image as LucideImage,
  Info as LucideInfo,
  Landmark as LucideLandmark,
  Laptop as LucideLaptop,
  LayoutGrid as LucideLayoutGrid,
  Library as LucideLibrary,
  Lightbulb as LucideLightbulb,
  Link as LucideLink,
  Link2 as LucideLink2,
  List as LucideList,
  ListChecks as LucideListChecks,
  ListTodo as LucideListTodo,
  ListTree as LucideListTree,
  Lock as LucideLock,
  Mailbox as LucideMailbox,
  Megaphone as LucideMegaphone,
  MessageCircle as LucideMessageCircle,
  MessageSquare as LucideMessageSquare,
  MessageSquarePlus as LucideMessageSquarePlus,
  MessagesSquare as LucideMessagesSquare,
  Mic as LucideMic,
  Minimize2 as LucideMinimize2,
  Minus as LucideMinus,
  Monitor as LucideMonitor,
  MoonStar as LucideMoonStar,
  MousePointer as LucideMousePointer,
  Palette as LucidePalette,
  PanelRight as LucidePanelRight,
  Paperclip as LucidePaperclip,
  Pause as LucidePause,
  Pencil as LucidePencil,
  Pin as LucidePin,
  PinOff as LucidePinOff,
  Play as LucidePlay,
  PlayCircle as LucidePlayCircle,
  Plus as LucidePlus,
  Presentation as LucidePresentation,
  Redo2 as LucideRedo2,
  RefreshCw as LucideRefreshCw,
  Reply as LucideReply,
  RotateCcw as LucideRotateCcw,
  ScanEye as LucideScanEye,
  ScrollText as LucideScrollText,
  Search as LucideSearch,
  Send as LucideSend,
  Settings as LucideSettings,
  Shapes as LucideShapes,
  Share as LucideShare,
  ShieldCheck as LucideShieldCheck,
  Shuffle as LucideShuffle,
  SlidersHorizontal as LucideSlidersHorizontal,
  Smartphone as LucideSmartphone,
  Split as LucideSplit,
  Square as LucideSquare,
  SquareActivity as LucideSquareActivity,
  SquareTerminal as LucideSquareTerminal,
  Star as LucideStar,
  Sunrise as LucideSunrise,
  Table2 as LucideTable2,
  TextCursorInput as LucideTextCursorInput,
  Timer as LucideTimer,
  Trash2 as LucideTrash2,
  TriangleAlert as LucideTriangleAlert,
  Unlink as LucideUnlink,
  Upload as LucideUpload,
  User as LucideUser,
  Users as LucideUsers,
  Volume1 as LucideVolume1,
  Wrench as LucideWrench,
  X as LucideX,
  Zap as LucideZap,
  ZoomIn as LucideZoomIn,
  ZoomOut as LucideZoomOut,
} from "lucide-react";

/**
 * The interface's glyphs, by their Lucide names (Lucide, ISC licence),
 * drawn at 20px with a 1.75 stroke unless a caller sets otherwise. The
 * filled variants draw the outline glyph filled.
 */
function glyph(Icon: LucideIcon, fill?: boolean, name?: string) {
  return forwardRef<SVGSVGElement, LucideProps>(function Glyph(props, ref) {
    return (
      <Icon
        ref={ref}
        data-icon={name}
        size={20}
        strokeWidth={1.75}
        aria-hidden="true"
        focusable="false"
        {...(fill ? { fill: "currentColor" } : {})}
        {...props}
        className={`app-icon${props.className ? ` ${props.className}` : ""}`}
      />
    );
  });
}

export const Archive = /* @__PURE__ */ glyph(
  LucideArchive,
  undefined,
  "Archive",
);
export const ArrowDown = /* @__PURE__ */ glyph(
  LucideArrowDown,
  undefined,
  "ArrowDown",
);
export const ArrowLeft = /* @__PURE__ */ glyph(
  LucideArrowLeft,
  undefined,
  "ArrowLeft",
);
export const ArrowRight = /* @__PURE__ */ glyph(
  LucideArrowRight,
  undefined,
  "ArrowRight",
);
export const ArrowUp = /* @__PURE__ */ glyph(
  LucideArrowUp,
  undefined,
  "ArrowUp",
);
export const ArrowUpDown = /* @__PURE__ */ glyph(
  LucideArrowUpDown,
  undefined,
  "Sort",
);
export const ArrowUpRight = /* @__PURE__ */ glyph(
  LucideArrowUpRight,
  undefined,
  "ArrowUpRight",
);
export const BadgeCheck = /* @__PURE__ */ glyph(
  LucideBadgeCheck,
  undefined,
  "Verified",
);
export const Ban = /* @__PURE__ */ glyph(LucideBan, undefined, "Prohibit");
export const Beaker = /* @__PURE__ */ glyph(LucideBeaker, undefined, "Beaker");
export const Binoculars = /* @__PURE__ */ glyph(
  LucideBinoculars,
  undefined,
  "Binoculars",
);
export const Blocks = /* @__PURE__ */ glyph(
  LucideBlocks,
  undefined,
  "Connectors",
);
export const BookOpen = /* @__PURE__ */ glyph(
  LucideBookOpen,
  undefined,
  "Book",
);
export const Brain = /* @__PURE__ */ glyph(
  LucideBrain,
  undefined,
  "ExtendedThinking",
);
export const Calendar = /* @__PURE__ */ glyph(
  LucideCalendar,
  undefined,
  "Calendar",
);
export const Camera = /* @__PURE__ */ glyph(LucideCamera, undefined, "Camera");
export const ChartColumn = /* @__PURE__ */ glyph(
  LucideChartColumn,
  undefined,
  "Chart",
);
export const ChartLine = /* @__PURE__ */ glyph(
  LucideChartLine,
  undefined,
  "ChartLine",
);
export const Check = /* @__PURE__ */ glyph(LucideCheck, undefined, "Check");
export const ChevronDown = /* @__PURE__ */ glyph(
  LucideChevronDown,
  undefined,
  "CaretDown",
);
export const ChevronLeft = /* @__PURE__ */ glyph(
  LucideChevronLeft,
  undefined,
  "CaretLeft",
);
export const ChevronRight = /* @__PURE__ */ glyph(
  LucideChevronRight,
  undefined,
  "CaretRight",
);
export const ChevronUp = /* @__PURE__ */ glyph(
  LucideChevronUp,
  undefined,
  "CaretUp",
);
export const Circle = /* @__PURE__ */ glyph(LucideCircle, undefined, "Circle");
export const CircleAlert = /* @__PURE__ */ glyph(
  LucideCircleAlert,
  undefined,
  "WarningCircle",
);
export const CircleCheck = /* @__PURE__ */ glyph(
  LucideCircleCheck,
  undefined,
  "CheckCircle",
);
export const CircleDot = /* @__PURE__ */ glyph(
  LucideCircleDot,
  undefined,
  "Recording",
);
export const CircleFadingPlus = /* @__PURE__ */ glyph(
  LucideCircleFadingPlus,
  undefined,
  "CirclesAdd",
);
export const CircleHelp = /* @__PURE__ */ glyph(
  LucideCircleHelp,
  undefined,
  "Help",
);
export const CircleUserRound = /* @__PURE__ */ glyph(
  LucideCircleUserRound,
  undefined,
  "UserCircle",
);
export const CircleX = /* @__PURE__ */ glyph(
  LucideCircleX,
  undefined,
  "XCircle",
);
export const Clock = /* @__PURE__ */ glyph(LucideClock, undefined, "Clock");
export const Cloud = /* @__PURE__ */ glyph(LucideCloud, undefined, "Cloud");
export const CloudOff = /* @__PURE__ */ glyph(
  LucideCloudOff,
  undefined,
  "CloudSlash",
);
export const Code = /* @__PURE__ */ glyph(LucideCode, undefined, "Code");
export const Copy = /* @__PURE__ */ glyph(LucideCopy, undefined, "Copy");
export const CornerDownLeft = /* @__PURE__ */ glyph(
  LucideCornerDownLeft,
  undefined,
  "ArrowReturn",
);
export const Database = /* @__PURE__ */ glyph(
  LucideDatabase,
  undefined,
  "Database",
);
export const Diff = /* @__PURE__ */ glyph(
  LucideDiff,
  undefined,
  "ChangesPlusMinus",
);
export const Dna = /* @__PURE__ */ glyph(LucideDna, undefined, "DNA");
export const Download = /* @__PURE__ */ glyph(
  LucideDownload,
  undefined,
  "Download",
);
export const Ellipsis = /* @__PURE__ */ glyph(
  LucideEllipsis,
  undefined,
  "DotsHorizontal",
);
export const EllipsisVertical = /* @__PURE__ */ glyph(
  LucideEllipsisVertical,
  undefined,
  "DotsVertical",
);
export const Expand = /* @__PURE__ */ glyph(LucideExpand, undefined, "Expand");
export const ExternalLink = /* @__PURE__ */ glyph(
  LucideExternalLink,
  undefined,
  "ArrowOutSquare",
);
export const Eye = /* @__PURE__ */ glyph(LucideEye, undefined, "Eye");
export const EyeOff = /* @__PURE__ */ glyph(
  LucideEyeOff,
  undefined,
  "EyeSlash",
);
export const File = /* @__PURE__ */ glyph(LucideFile, undefined, "File");
export const FileCode2 = /* @__PURE__ */ glyph(
  LucideFileCode2,
  undefined,
  "CodeBlock",
);
export const FileDiff = /* @__PURE__ */ glyph(
  LucideFileDiff,
  undefined,
  "GitDiff",
);
export const FileSpreadsheet = /* @__PURE__ */ glyph(
  LucideFileSpreadsheet,
  undefined,
  "Spreadsheet",
);
export const Files = /* @__PURE__ */ glyph(LucideFiles, undefined, "Files");
export const Filter = /* @__PURE__ */ glyph(LucideFilter, undefined, "Filter");
export const Flag = /* @__PURE__ */ glyph(LucideFlag, undefined, "Flag");
export const Folder = /* @__PURE__ */ glyph(LucideFolder, undefined, "Folder");
export const FolderOpen = /* @__PURE__ */ glyph(
  LucideFolderOpen,
  undefined,
  "FolderOpen",
);
export const FolderPlus = /* @__PURE__ */ glyph(
  LucideFolderPlus,
  undefined,
  "FolderPlus",
);
export const Gavel = /* @__PURE__ */ glyph(LucideGavel, undefined, "Hammer");
export const GitBranch = /* @__PURE__ */ glyph(
  LucideGitBranch,
  undefined,
  "GitBranch",
);
export const GitCommitVertical = /* @__PURE__ */ glyph(
  LucideGitCommitVertical,
  undefined,
  "GitCommit",
);
export const GitPullRequest = /* @__PURE__ */ glyph(
  LucideGitPullRequest,
  undefined,
  "GitPullRequest",
);
export const Github = /* @__PURE__ */ glyph(LucideGithub, undefined, "Github");
export const Globe = /* @__PURE__ */ glyph(LucideGlobe, undefined, "Globe");
export const GraduationCap = /* @__PURE__ */ glyph(
  LucideGraduationCap,
  undefined,
  "GraduationCap",
);
export const Hand = /* @__PURE__ */ glyph(LucideHand, undefined, "Hand");
export const History = /* @__PURE__ */ glyph(
  LucideHistory,
  undefined,
  "History",
);
export const House = /* @__PURE__ */ glyph(LucideHouse, undefined, "Home");
export const Image = /* @__PURE__ */ glyph(LucideImage, undefined, "Image");
export const Info = /* @__PURE__ */ glyph(LucideInfo, undefined, "Info");
export const Landmark = /* @__PURE__ */ glyph(
  LucideLandmark,
  undefined,
  "Bank",
);
export const Laptop = /* @__PURE__ */ glyph(LucideLaptop, undefined, "Laptop");
export const LayoutGrid = /* @__PURE__ */ glyph(
  LucideLayoutGrid,
  undefined,
  "Grid",
);
export const Library = /* @__PURE__ */ glyph(
  LucideLibrary,
  undefined,
  "Library",
);
export const Lightbulb = /* @__PURE__ */ glyph(
  LucideLightbulb,
  undefined,
  "Lightbulb",
);
export const Link = /* @__PURE__ */ glyph(LucideLink, undefined, "Link");
export const Link2 = /* @__PURE__ */ glyph(
  LucideLink2,
  undefined,
  "LinkSimple",
);
export const List = /* @__PURE__ */ glyph(LucideList, undefined, "ListBullet");
export const ListChecks = /* @__PURE__ */ glyph(
  LucideListChecks,
  undefined,
  "Checklist",
);
export const ListTodo = /* @__PURE__ */ glyph(
  LucideListTodo,
  undefined,
  "Tasks",
);
export const ListTree = /* @__PURE__ */ glyph(
  LucideListTree,
  undefined,
  "Diagram",
);
export const Lock = /* @__PURE__ */ glyph(LucideLock, undefined, "Lock");
export const Mailbox = /* @__PURE__ */ glyph(
  LucideMailbox,
  undefined,
  "Mailbox",
);
export const Megaphone = /* @__PURE__ */ glyph(
  LucideMegaphone,
  undefined,
  "Bullhorn",
);
export const MessageCircle = /* @__PURE__ */ glyph(
  LucideMessageCircle,
  undefined,
  "ChatSimple",
);
export const MessageSquare = /* @__PURE__ */ glyph(
  LucideMessageSquare,
  undefined,
  "Chat",
);
export const MessageSquarePlus = /* @__PURE__ */ glyph(
  LucideMessageSquarePlus,
  undefined,
  "ChatAdd",
);
export const MessagesSquare = /* @__PURE__ */ glyph(
  LucideMessagesSquare,
  undefined,
  "Chats",
);
export const Mic = /* @__PURE__ */ glyph(LucideMic, undefined, "Microphone");
export const Minimize2 = /* @__PURE__ */ glyph(
  LucideMinimize2,
  undefined,
  "Collapse",
);
export const Minus = /* @__PURE__ */ glyph(LucideMinus, undefined, "Minus");
export const Monitor = /* @__PURE__ */ glyph(
  LucideMonitor,
  undefined,
  "Computer",
);
export const MoonStar = /* @__PURE__ */ glyph(
  LucideMoonStar,
  undefined,
  "MoonStars",
);
export const MousePointer = /* @__PURE__ */ glyph(
  LucideMousePointer,
  undefined,
  "Cursor",
);
export const Palette = /* @__PURE__ */ glyph(
  LucidePalette,
  undefined,
  "Palette",
);
export const PanelRight = /* @__PURE__ */ glyph(
  LucidePanelRight,
  undefined,
  "SidebarRight",
);
export const Paperclip = /* @__PURE__ */ glyph(
  LucidePaperclip,
  undefined,
  "Attachment",
);
export const Pause = /* @__PURE__ */ glyph(LucidePause, undefined, "Pause");
export const Pencil = /* @__PURE__ */ glyph(LucidePencil, undefined, "Edit");
export const Pin = /* @__PURE__ */ glyph(LucidePin, undefined, "Pin");
export const PinOff = /* @__PURE__ */ glyph(
  LucidePinOff,
  undefined,
  "PinSlash",
);
export const Play = /* @__PURE__ */ glyph(LucidePlay, undefined, "Play");
export const PlayCircle = /* @__PURE__ */ glyph(
  LucidePlayCircle,
  undefined,
  "PlayCircle",
);
export const Plus = /* @__PURE__ */ glyph(LucidePlus, undefined, "Add");
export const Presentation = /* @__PURE__ */ glyph(
  LucidePresentation,
  undefined,
  "Slides",
);
export const Redo2 = /* @__PURE__ */ glyph(
  LucideRedo2,
  undefined,
  "ArrowBendUpRight",
);
export const RefreshCw = /* @__PURE__ */ glyph(
  LucideRefreshCw,
  undefined,
  "ArrowClockwise",
);
export const Reply = /* @__PURE__ */ glyph(
  LucideReply,
  undefined,
  "ArrowBendUpLeft",
);
export const RotateCcw = /* @__PURE__ */ glyph(
  LucideRotateCcw,
  undefined,
  "ArrowCounterClockwise",
);
export const ScanEye = /* @__PURE__ */ glyph(
  LucideScanEye,
  undefined,
  "EyeFrame",
);
export const ScrollText = /* @__PURE__ */ glyph(
  LucideScrollText,
  undefined,
  "Scroll",
);
export const Search = /* @__PURE__ */ glyph(LucideSearch, undefined, "Search");
export const Send = /* @__PURE__ */ glyph(LucideSend, undefined, "PaperPlane");
export const Settings = /* @__PURE__ */ glyph(
  LucideSettings,
  undefined,
  "Settings",
);
export const Shapes = /* @__PURE__ */ glyph(LucideShapes, undefined, "Shapes");
export const Share = /* @__PURE__ */ glyph(LucideShare, undefined, "Share");
export const ShieldCheck = /* @__PURE__ */ glyph(
  LucideShieldCheck,
  undefined,
  "Trust",
);
export const Shuffle = /* @__PURE__ */ glyph(
  LucideShuffle,
  undefined,
  "Shuffle",
);
export const SlidersHorizontal = /* @__PURE__ */ glyph(
  LucideSlidersHorizontal,
  undefined,
  "Toggles",
);
export const Smartphone = /* @__PURE__ */ glyph(
  LucideSmartphone,
  undefined,
  "MobilePhone",
);
export const Split = /* @__PURE__ */ glyph(
  LucideSplit,
  undefined,
  "ArrowSplitRight",
);
export const Square = /* @__PURE__ */ glyph(LucideSquare, undefined, "Stop");
export const SquareActivity = /* @__PURE__ */ glyph(
  LucideSquareActivity,
  undefined,
  "Activity",
);
export const SquareTerminal = /* @__PURE__ */ glyph(
  LucideSquareTerminal,
  undefined,
  "CommandLine",
);
export const Star = /* @__PURE__ */ glyph(LucideStar, undefined, "Star");
export const Sunrise = /* @__PURE__ */ glyph(
  LucideSunrise,
  undefined,
  "SunHorizon",
);
export const Table2 = /* @__PURE__ */ glyph(LucideTable2, undefined, "Table");
export const TextCursorInput = /* @__PURE__ */ glyph(
  LucideTextCursorInput,
  undefined,
  "TextT",
);
export const Timer = /* @__PURE__ */ glyph(LucideTimer, undefined, "Timer");
export const Trash2 = /* @__PURE__ */ glyph(LucideTrash2, undefined, "Trash");
export const TriangleAlert = /* @__PURE__ */ glyph(
  LucideTriangleAlert,
  undefined,
  "Warning",
);
export const Unlink = /* @__PURE__ */ glyph(
  LucideUnlink,
  undefined,
  "Disconnect",
);
export const Upload = /* @__PURE__ */ glyph(LucideUpload, undefined, "Upload");
export const User = /* @__PURE__ */ glyph(LucideUser, undefined, "User");
export const Users = /* @__PURE__ */ glyph(LucideUsers, undefined, "Users");
export const Volume1 = /* @__PURE__ */ glyph(
  LucideVolume1,
  undefined,
  "Speaker",
);
export const Wrench = /* @__PURE__ */ glyph(LucideWrench, undefined, "Wrench");
export const X = /* @__PURE__ */ glyph(LucideX, undefined, "X");
export const Zap = /* @__PURE__ */ glyph(LucideZap, undefined, "Lightning");
export const ZoomIn = /* @__PURE__ */ glyph(LucideZoomIn, undefined, "ZoomIn");
export const ZoomOut = /* @__PURE__ */ glyph(
  LucideZoomOut,
  undefined,
  "ZoomOut",
);
export const PinFilled = /* @__PURE__ */ glyph(LucidePin, true, "PinFilled");
export const SquareFilled = /* @__PURE__ */ glyph(
  LucideSquare,
  true,
  "StopFilled",
);

export const CalendarClock = Calendar;
export const CalendarDays = Calendar;
export const Clock3 = Clock;
export const Code2 = Code;
export const CodeXml = Code;
export const FileText = File;
export const FlaskConical = Beaker;
export const FolderClosed = Folder;
export const Globe2 = Globe;
export const ListFilter = Filter;
export const LockKeyhole = Lock;
export const Maximize2 = Expand;
export const MessageCircleMore = MessageCircle;
export const MessageSquareMore = MessageSquare;
export const MoreHorizontal = Ellipsis;
export const MoreVertical = EllipsisVertical;
export const MousePointer2 = MousePointer;
export const MoveUpRight = ArrowUpRight;
export const Plug = Blocks;
export const RotateCw = RefreshCw;
export const Settings2 = Settings;
export const SquareCode = FileCode2;
export const Terminal = SquareTerminal;
export const Trash = Trash2;
export const Type = TextCursorInput;
export const Undo2 = Reply;
export const Unplug = Unlink;
export const UserCircle = CircleUserRound;
export const UserRound = User;
export const UsersRound = Users;
export const Volume2 = Volume1;
export const Workflow = ListTree;
export const SquareArrowOutUpRight = ExternalLink;
