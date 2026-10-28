/**
 * Excel (.xlsx) and PowerPoint (.pptx) previews inside the sandboxed frame
 * (global `ClaudexOffice`). Both formats are zip archives of XML: the sheets
 * render as the original's spreadsheet viewer draws them (below), each
 * slide as a box of its own proportions with its text boxes, pictures and tables placed where the
 * file puts them. Text takes its size, weight, colour, alignment and
 * bullets from the run, the paragraph, the shape and the layout and master
 * placeholders it inherits from; other formatting is not drawn.
 */
export { renderXlsx } from "./office-xlsx";
export { formatValue } from "./office-xlsx-styles";
export { renderPptx } from "./office-pptx";
