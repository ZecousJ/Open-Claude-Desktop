/**
 * Claude's Browser tool rows (R8-G) mount in the transcript's tool rows;
 * this module only brings their stylesheet in after the app's own
 * (src/main.tsx loads every `*.slot.ts` before the first render) and keeps
 * the components free of CSS imports so they render in node tests.
 */
import "./browser-tools.css";
