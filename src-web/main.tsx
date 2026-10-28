/**
 * The web version's entry (web.html). The bridge installs `window.desktop`
 * first; then the desktop renderer starts unchanged (styles, slots and the
 * sign-in gate come from src/main.tsx). Import order is evaluation order.
 */
import "./stale-build";
import "./bridge/install";
import "../src/main";
