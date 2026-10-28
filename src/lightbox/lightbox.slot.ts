/**
 * Loads the lightbox's rules (lightbox.css) with the other slot modules
 * (src/main.tsx). Lightbox.tsx is imported by components node tests render,
 * where a stylesheet import would not resolve.
 */
import "./lightbox.css";
