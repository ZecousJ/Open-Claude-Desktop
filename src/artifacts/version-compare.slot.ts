/**
 * Loads the version compare dialog's stylesheet after every other one
 * (src/main.tsx loads slot modules before the first render). The dialog
 * renders from the file viewer; node tests import that component, where a
 * stylesheet import would not resolve.
 */
import "./version-compare.css";
