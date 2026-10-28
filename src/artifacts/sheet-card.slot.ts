/**
 * Loads the sheet card's rules (artifact and file cards, sheet-card.css)
 * after every other stylesheet (src/main.tsx loads slot modules before the
 * first render), so they win over file-viewer.css and the light and web
 * sheets. The cards render from components node tests import, where a
 * stylesheet import would not resolve.
 */
import "./sheet-card.css";
