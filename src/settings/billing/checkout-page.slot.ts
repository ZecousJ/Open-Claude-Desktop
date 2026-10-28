/**
 * Loads the checkout page's rules (checkout-page.css). The checkout renders
 * from components node tests import, where a stylesheet import would not
 * resolve (as sheet-card.slot.ts).
 */
import "./checkout-page.css";
