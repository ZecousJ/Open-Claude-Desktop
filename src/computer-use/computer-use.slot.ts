/**
 * Computer use (R10-U) has no panel or overlay of its own: its Settings
 * section, access cards and tool rows mount where they belong. This module
 * only brings its stylesheet in after the app's own (src/main.tsx loads
 * every `*.slot.ts` before the first render), and keeps the components
 * free of CSS imports so they render in node tests.
 */
import "./computer-use.css";
