/**
 * Loads the file viewer's narrow-window rules after every other stylesheet
 * (src/main.tsx loads slot modules before the first render), so they win over
 * file-viewer.css and the responsive sheets. The panel renders from FileViewer,
 * which node tests import, where a stylesheet import would not resolve.
 */
import "./artifact-narrow.css";
