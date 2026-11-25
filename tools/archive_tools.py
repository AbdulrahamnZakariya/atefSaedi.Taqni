"""أدوات مشتركة لسكربتات صيانة الأرشيف (GitHub Actions).
نفس منطق الخادم: قراءة/كتابة DATA داخل index.html، وبناء فهرس Excel بنفس التصميم."""
import json, os, re

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
P = lambda *a: os.path.join(ROOT, *a)
SEC_NAME = {"todo": "بحاجة تصنيف", "eng": "المكاتب الهندسية", "proj": "المشاريع", "inv": "المستثمرين", "off": "العروض", "priv": "الملف الخاص"}
SECS = ["eng", "proj", "inv", "off", "priv", "todo"]
HEAD = ['رقم الملف', 'اسم الملف', 'القسم', 'القسم الفرعي', 'المشروع', 'الجهة / المستثمر', 'التاريخ', 'الحالة', 'ملاحظات', 'المسار', 'الاسم الأصلي', 'نسخة PDF']
WIDTHS = [10, 40, 16, 20, 14, 20, 12, 16, 45, 60, 35, 50]
XLSX = "فهرس-أرشيف-كيانات.xlsx"
LOG = os.path.join("data", "agent-log.json")
RX = re.compile(r"const DATA=(\{.*?\});[ \t]*\n", re.S)


def read_html():
    return open(P("index.html"), encoding="utf-8").read()


def read_data(html=None):
    m = RX.search(html or read_html())
    if not m:
        raise SystemExit("DATA مش موجودة بـ index.html")
    return json.loads(m.group(1))


def write_data(data, html=None):
    html = html or read_html()
    new = RX.sub(lambda m: "const DATA=" + json.dumps(data, ensure_ascii=False) + ";\n", html, count=1)
    open(P("index.html"), "w", encoding="utf-8").write(new)


def read_log():
    try:
        return json.load(open(P(LOG), encoding="utf-8"))
    except Exception:
        return {"ops": []}


def index_rows(data):
    live = [f for f in data["files"] if not f.get("trash")]
    pub = [f for f in live if f["section"] != "priv"]

    def row(f):
        pdf = f.get("pdf") or ("الأصل PDF" if f["path"].lower().endswith(".pdf") else "—")
        return [f["id"], f["title"], SEC_NAME.get(f["section"], ""), f.get("sub") or None, f.get("project") or None, f.get("party") or None,
                f.get("date") or None, f.get("status") or None, f.get("note") or None, f["path"], f.get("source") or None, pdf]

    summary = [["القسم", "عدد الملفات"]] + [[SEC_NAME[s], sum(1 for f in live if f["section"] == s)] for s in SECS] + [[None, None], ["المشروع", "عدد الملفات"]]
    summary += [[p["name"], sum(1 for f in live if f.get("project") == p["name"])] for p in data.get("projects", [])] + [[None, None], ["آخر تحديث", data.get("updated")]]
    return {"full": [HEAD] + [row(f) for f in pub],
            "todo": [HEAD] + [row(f) for f in pub if f["section"] == "todo" or f.get("status") == "بحاجة تصنيف"],
            "summary": summary}


def write_xlsx(data):
    from openpyxl import Workbook
    from openpyxl.styles import Font, PatternFill
    R = index_rows(data)
    wb = Workbook()
    head_font, head_fill = Font(bold=True, color="FFFFFF"), PatternFill("solid", fgColor="16263B")
    for i, (name, rows, widths, filt) in enumerate([("الفهرس الكامل", R["full"], WIDTHS, True), ("بحاجة تصنيف", R["todo"], WIDTHS, True), ("ملخص", R["summary"], [22, 14], False)]):
        ws = wb.active if i == 0 else wb.create_sheet()
        ws.title = name
        ws.sheet_view.rightToLeft = True
        for r in rows:
            ws.append(r)
        heads = [1] if filt else [1, next(k for k, r in enumerate(rows, 1) if r[0] == "المشروع")]
        for hr in heads:
            for c in ws[hr]:
                if c.value is not None:
                    c.font, c.fill = head_font, head_fill
        for k, w in enumerate(widths):
            ws.column_dimensions[chr(65 + k)].width = w
        if filt:
            ws.freeze_panes = "A2"
            ws.auto_filter.ref = f"A1:L{len(rows)}"
    wb.save(P(XLSX))
