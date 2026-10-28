/** pdf.js's packed Adobe CMaps as base64, by file name. */
declare module "claudex:pdf-cmaps" {
  const maps: Record<string, string>;
  export default maps;
}
