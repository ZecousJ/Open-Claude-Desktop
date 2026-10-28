import type { ReactNode, SVGProps } from "react";

/*
 * Account-area icons, drawn on the 16px grid of src/ui/icons.tsx from the 2x
 * captures R-Chat-首页-新建-深色-侧栏展开 (the download glyph right of the
 * account). Shapes are eyeballed from 8x crops, not fitted. The account
 * menu's own rows use the icon font's glyphs (AccountMenu.tsx).
 */
type Props = SVGProps<SVGSVGElement> & { size?: number };
function Icon({
  size = 16,
  children,
  ...rest
}: Props & { children: ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      {children}
    </svg>
  );
}

/** The account-area update and Get apps buttons: an arrow into a tray. */
export function DownloadTrayIcon(props: Props) {
  return (
    <Icon {...props}>
      {/* 10×10 ink as in R-个人菜单 and R-Chat home (stem, wings ±2.75, 9px tray). */}
      <path d="M8 3.125V8.9M5.25 6.2 8 8.925l2.75-2.725M3.5 9.125v3h9v-3" />
    </Icon>
  );
}

/** Learn more: a serif i in a circle. */
export function InfoCircleIcon(props: Props) {
  return (
    <Icon {...props}>
      <circle cx="8" cy="8" r="5.75" />
      <path d="M7.25 7.4H8v3.35M7.15 10.75h1.7" />
      <circle cx="7.95" cy="5.4" r="0.55" fill="currentColor" stroke="none" />
    </Icon>
  );
}
