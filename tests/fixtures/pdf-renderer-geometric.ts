/** Self-authored valid two-page PDF; no fonts, scripts, links, or external resources. */
export function rendererGeometricPdf(): Uint8Array {
  const objects=['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R 5 0 R] /Count 2 >>'];
  for(let i=0;i<2;i++){
    const stream=i===0?'1 0 0 rg 0 0 100 100 re f\n0 0 1 rg 100 0 100 100 re f\n':'0 1 0 rg 0 0 200 100 re f\n';
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] /Resources << >> /Contents ${4+i*2} 0 R >>`,`<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}endstream`);
  }
  let text='%PDF-1.4\n';const offsets:number[]=[];
  for(const [i,object] of objects.entries()){offsets.push(Buffer.byteLength(text));text+=`${i+1} 0 obj\n${object}\nendobj\n`;}
  const xref=Buffer.byteLength(text);text+=`xref\n0 ${objects.length+1}\n0000000000 65535 f \n`;
  for(const offset of offsets)text+=`${String(offset).padStart(10,'0')} 00000 n \n`;
  text+=`trailer\n<< /Size ${objects.length+1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(text);
}
