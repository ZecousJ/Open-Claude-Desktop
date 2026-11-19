"""Disposable valid document fixtures, not user deliverables."""
from pathlib import Path
import sys
from docx import Document
from pptx import Presentation
from pptx.util import Inches
from openpyxl import Workbook
from reportlab.pdfgen import canvas

out=Path(sys.argv[1]);out.mkdir(parents=True,exist_ok=True)
doc=Document();doc.add_heading('DOCX PREVIEW PROOF',0);doc.add_paragraph('DOCX_TOKEN_7926');table=doc.add_table(rows=2,cols=2);table.cell(0,0).text='Item';table.cell(0,1).text='Count';table.cell(1,0).text='Alpha';table.cell(1,1).text='42';doc.save(out/'proof.docx')
deck=Presentation()
for title,body in [('PPTX PREVIEW PROOF','PPTX_TOKEN_4381'),('Second slide','PPTX_SECOND_9274')]:
 slide=deck.slides.add_slide(deck.slide_layouts[1]);slide.shapes.title.text=title;slide.placeholders[1].text=body
deck.save(out/'proof.pptx')
book=Workbook();sheet=book.active;sheet.title='Proof';sheet.append(['XLSX_TOKEN_6137','Amount']);sheet.append(['Alpha',42]);sheet.append(['Beta',58]);sheet.append(['Total','=SUM(B2:B3)']);sheet.column_dimensions['A'].width=32;sheet.column_dimensions['B'].width=16;book.create_sheet('Second')['A1']='XLSX_SECOND_7531';book.save(out/'proof.xlsx')
pdf=canvas.Canvas(str(out/'proof.pdf'))
for line in ['PDF_TOKEN_8254','PDF_SECOND_7492']:
 pdf.setFont('Helvetica',22);pdf.drawString(65,740,line);pdf.showPage()
pdf.save()
print(str(out))

# A separately cached formula result is part of the fixture, as a saved Excel workbook would carry it.
import zipfile
xlsx=out/'proof.xlsx'
with zipfile.ZipFile(xlsx) as z:parts={n:z.read(n) for n in z.namelist()}
parts['xl/worksheets/sheet1.xml']=parts['xl/worksheets/sheet1.xml'].replace(b'<f>SUM(B2:B3)</f><v></v>',b'<f>SUM(B2:B3)</f><v>100</v>')
with zipfile.ZipFile(xlsx,'w',zipfile.ZIP_DEFLATED) as z:
 for n,v in parts.items():z.writestr(n,v)
