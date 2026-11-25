#!/usr/bin/env python3
"""صيانة الأرشيف التلقائية (GitHub Actions).

  python3 tools/maintain.py reconcile   بعد ما يعيد الإدخال التلقائي (ingest.py) بناء index.html:
                                         بيرجّع تعديلات الوكيل (نقل/تسمية/ترتيب/سلة...) إذا انمسحت،
                                         وبيشيل أي نسخة مكررة رجعت بمسارها القديم (بس إذا محتواها مطابق).
  python3 tools/maintain.py purge       بيحذف نهائياً ملفات السلة اللي مر عليها 30 يوم.
  python3 tools/maintain.py content     بيبني فهرس البحث بمحتوى الملفات (data/content-index.json).

ما في حذف لأي ملف إلا: (1) ملفات بالسلة عمرها أكثر من 30 يوم، (2) نسخة مكررة محتواها مطابق 100% لملف موجود.
"""
import hashlib, json, os, re, subprocess, sys
from datetime import datetime, timezone, timedelta
from archive_tools import P, ROOT, read_data, write_data, read_log, write_xlsx, read_html

TRASH_DAYS = 30


def git(*a):
    return subprocess.run(["git", "-C", ROOT, *a], check=True, capture_output=True, text=True).stdout


def digest(path):
    try:
        return hashlib.sha256(open(P(path), "rb").read()).hexdigest()
    except FileNotFoundError:
        return None


def move(src, dst):
    os.makedirs(os.path.dirname(P(dst)), exist_ok=True)
    git("mv", "-k", "--", src, dst)


def reconcile():
    log = read_log()
    if not log.get("ops"):
        print("ما في عمليات للوكيل")
        return False
    html = read_html()
    data = read_data(html)
    want = {}          # آخر حالة قررها الوكيل لكل ملف
    meta = []
    for op in log["ops"]:
        for c in op.get("changes") or []:
            want[c["id"]] = c.get("after")
        if op.get("meta"):
            meta.append(op["meta"])
    changed = False
    by_id = {f["id"]: i for i, f in enumerate(data["files"])}
    for fid, after in want.items():
        i = by_id.get(fid)
        cur = data["files"][i] if i is not None else None
        if after is None:                       # حذف نهائي من الوكيل
            if cur is not None:
                for p in (cur.get("path"), cur.get("pdf")):
                    if p and os.path.exists(P(p)):
                        git("rm", "-q", "-f", "--", p)
                data["files"] = [f for f in data["files"] if f["id"] != fid]
                by_id = {f["id"]: i for i, f in enumerate(data["files"])}
                changed = True
            continue
        if cur == after:
            continue
        # الملفات: إذا المسار الجديد مش موجود والقديم موجود ← انقل. إذا الاثنين موجودين بنفس المحتوى ← شيل المكرر.
        for k in ("path", "pdf"):
            old, new = (cur or {}).get(k), after.get(k)
            if not new or old == new:
                continue
            if old and os.path.exists(P(old)):
                if not os.path.exists(P(new)):
                    move(old, new)
                elif digest(old) == digest(new):
                    git("rm", "-q", "-f", "--", old)
        if i is None:
            data["files"].append(after)
        else:
            data["files"][i] = after
        changed = True
    for m in meta:
        key = {"project": "projects", "investor": "investors"}.get(m["kind"])
        if key:
            names = [p["name"] for p in data.get(key, [])]
            if m.get("remove") and m["name"] in names:
                data[key] = [p for p in data[key] if p["name"] != m["name"]]; changed = True
            elif not m.get("remove") and m["name"] not in names:
                data.setdefault(key, []).append({"name": m["name"], "summary": m.get("summary", "")}); changed = True
        elif m["kind"] == "sub":
            subs = data.setdefault("subs", {}).setdefault(m["section"], [])
            if m.get("remove") and m["name"] in subs:
                subs.remove(m["name"]); changed = True
            elif not m.get("remove") and m["name"] not in subs:
                subs.append(m["name"]); changed = True
    if changed:
        data["updated"] = max(data.get("updated") or "", datetime.now(timezone.utc).strftime("%Y-%m-%d"))
        write_data(data, read_html())
        write_xlsx(data)
        print("✓ رجّعت تعديلات الوكيل")
    else:
        print("كل إشي متطابق")
    return changed


def purge():
    data = read_data()
    now = datetime.now(timezone.utc)
    old = [f for f in data["files"] if f.get("trash") and now - datetime.fromisoformat(f["trash"]["at"].replace("Z", "+00:00")) > timedelta(days=TRASH_DAYS)]
    if not old:
        print("ما في ملفات بالسلة عمرها أكثر من 30 يوم")
        return False
    for f in old:
        for p in (f.get("path"), f.get("pdf")):
            if p and os.path.exists(P(p)):
                git("rm", "-q", "-f", "--", p)
    ids = {f["id"] for f in old}
    data["files"] = [f for f in data["files"] if f["id"] not in ids]
    data["updated"] = now.strftime("%Y-%m-%d")
    write_data(data)
    write_xlsx(data)
    log = read_log()
    n = max([o.get("n", 0) for o in log["ops"]] + [0]) + 1
    log["ops"].append({"n": n, "at": now.strftime("%Y-%m-%dT%H:%M:%SZ"), "by": "النظام (تنظيف السلة)", "op": "purge", "title": f"حذف تلقائي لـ {len(old)} ملف من السلة بعد 30 يوم",
                       "args": {"ids": sorted(ids)}, "changes": [{"id": f["id"], "before": f, "after": None} for f in old], "meta": None, "undone": False})
    json.dump(log, open(P("data", "agent-log.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    print(f"✓ انحذف {len(old)} ملف نهائياً")
    return True


def text_of(path):
    fp, ext = P(path), path.rsplit(".", 1)[-1].lower()
    try:
        if ext == "pdf":
            return subprocess.run(["pdftotext", "-q", "-l", "30", fp, "-"], capture_output=True, text=True, timeout=60).stdout
        if ext == "docx":
            import docx
            d = docx.Document(fp)
            return "\n".join([p.text for p in d.paragraphs] + [c.text for t in d.tables for r in t.rows for c in r.cells])
        if ext in ("xlsx", "xlsm"):
            from openpyxl import load_workbook
            wb = load_workbook(fp, read_only=True, data_only=True)
            return "\n".join(" ".join(str(v) for v in r if v is not None) for ws in wb for r in ws.iter_rows(values_only=True))
        if ext in ("html", "htm", "txt", "csv", "md"):
            import re
            return re.sub(r"<[^>]+>", " ", open(fp, encoding="utf-8", errors="ignore").read())
    except Exception as e:
        print("تخطيت", path, e)
    return ""


def content():
    data = read_data()
    out = {}
    for f in data["files"]:
        if f.get("trash") or f["section"] == "priv":   # الملف الخاص ما بينفهرس محتواه
            continue
        src = f["path"] if os.path.exists(P(f["path"])) else None
        txt = text_of(src) if src else ""
        if not txt.strip() and f.get("pdf") and os.path.exists(P(f["pdf"])):
            txt = text_of(f["pdf"])
        txt = " ".join(re.sub(r"[\u200e\u200f\u202a-\u202e\u2066-\u2069]", "", txt).split())[:20000]
        if txt:
            out[f["id"]] = txt
    path = P("data", "content-index.json")
    new = json.dumps({"updated": data.get("updated"), "files": out}, ensure_ascii=False, indent=0)
    if os.path.exists(path) and open(path, encoding="utf-8").read() == new:
        print("فهرس المحتوى ما تغيّر")
        return False
    open(path, "w", encoding="utf-8").write(new)
    print(f"✓ فهرس المحتوى: {len(out)} ملف فيه نص")
    return True


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else ""
    fn = {"reconcile": reconcile, "purge": purge, "content": content}.get(cmd)
    if not fn:
        raise SystemExit(__doc__)
    fn()
