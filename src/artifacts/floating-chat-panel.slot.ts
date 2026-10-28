/**
 * Loads the stylesheet of the chat that floats over an expanded Artifact After
 * every other one (src/main.tsx loads slot modules before the first render), so
 * it wins over file-viewer.css. The panel renders from FileViewer, which node
 * tests import, where a stylesheet import would not resolve.
 */
import "./floating-chat-panel.css";
