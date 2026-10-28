/**
 * Loads the stylesheet of the dialog frame the report dialog uses after every
 * other one (src/main.tsx loads slot modules before the first render). The
 * dialog renders from ArtifactChrome; node tests import that component,
 * where a stylesheet import would not resolve.
 */
import "./publish-dialog.css";
