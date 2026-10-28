#!/bin/sh
# Checks the image's file tools end to end; run at the end of the build
# (Dockerfile) and, to check a runner host, inside a sandbox.
set -eu
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
cd "$work"

for tool in git curl jq rg sqlite3 python3 pip node npm uv ipython \
  soffice pdftotext pdfinfo pdftoppm gs tesseract ffmpeg ffprobe pandoc \
  rsvg-convert chromium fc-list; do
  command -v "$tool" >/dev/null || { echo "missing: $tool" >&2; exit 1; }
done
langs=$(tesseract --list-langs 2>/dev/null)
for lang in eng chi_sim chi_tra; do
  echo "$langs" | grep -qx "$lang" || { echo "missing OCR language: $lang" >&2; exit 1; }
done
fc-list :lang=zh family | grep -q "Noto Sans CJK" || { echo "missing CJK font" >&2; exit 1; }
fc-list | grep -qi "emoji" || { echo "missing emoji font" >&2; exit 1; }

python3 - <<'EOF'
import importlib
modules = """numpy pandas scipy matplotlib seaborn plotly kaleido sympy pyarrow duckdb
polars PIL pillow_heif rawpy cairosvg cv2 fontTools docx pptx openpyxl xlsxwriter
xlrd python_calamine docxtpl pypdf pdfplumber pypdfium2 reportlab pdf2image
pytesseract ocrmypdf soundfile pydub requests httpx bs4 lxml playwright markdown
IPython ipykernel""".split()
for name in modules:
    importlib.import_module(name)

# A chart with Chinese text, saved as PNG and rendered to a PDF by ReportLab.
import matplotlib
from matplotlib import font_manager, pyplot as plt
assert any("Noto Sans CJK" in f.name for f in font_manager.fontManager.ttflist)
plt.rcParams["font.sans-serif"] = ["Noto Sans CJK SC"]
plt.plot([1, 2, 3], [2, 1, 3])
plt.title("中文标题")
plt.savefig("chart.png")

# OCR reads Chinese back from an image Pillow drew.
from PIL import Image, ImageDraw, ImageFont
import pytesseract
font = ImageFont.truetype(font_manager.findfont("Noto Sans CJK SC"), 64)
image = Image.new("RGB", (700, 140), "white")
ImageDraw.Draw(image).text((20, 30), "你好世界 Hello", fill="black", font=font)
text = pytesseract.image_to_string(image, lang="chi_sim+eng")
assert "Hello" in text and "世界" in text.replace(" ", ""), text

# Office files written by Python, converted by LibreOffice.
import docx, openpyxl
document = docx.Document()
document.add_paragraph("中文段落")
document.save("a.docx")
book = openpyxl.Workbook()
book.active["A1"] = 2
book.active["A2"] = "=A1*21"
book.save("a.xlsx")

# Plotly image export through the image's Chromium.
import plotly.graph_objects as go
go.Figure(go.Bar(x=["甲", "乙"], y=[1, 2])).write_image("plot.png")
print("python ok")
EOF

soffice --headless --convert-to pdf a.docx >/dev/null 2>&1
pdftotext a.pdf - | grep -q "中文段落" || { echo "LibreOffice PDF lost the Chinese text" >&2; exit 1; }
soffice --headless --convert-to csv a.xlsx >/dev/null 2>&1
grep -q "^2$" a.csv && grep -q "^42$" a.csv || { echo "LibreOffice did not recalculate" >&2; exit 1; }
ffmpeg -loglevel error -f lavfi -i sine=duration=1 a.mp3
ffprobe -loglevel error -show_entries format=duration -of csv=p=0 a.mp3 | grep -q "^1\."
printf '# 标题\n\n正文\n' | pandoc -f markdown -t docx -o b.docx
test -s b.docx

python3 - <<'EOF'
from playwright.sync_api import sync_playwright
with sync_playwright() as p:
    browser = p.chromium.launch()
    page = browser.new_page()
    page.set_content("<h1>你好</h1>")
    page.screenshot(path="page.png")
    page.pdf(path="page.pdf")
    browser.close()
print("chromium ok")
EOF
echo "smoke ok"
