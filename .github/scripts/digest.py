#!/usr/bin/env python3
"""تنبيهات واتساب لأرشيف كيانات (رامي + هالة + يزن).
يقرأ الأرشيف (DATA داخل index.html) والمهام والقوائم، يقارنها بآخر إرسال، ويبعت رسالة عربية.
قناة الإرسال: CallMeBot (WA_PHONE + CALLMEBOT_APIKEY) أو WhatsApp Cloud API (WA_TOKEN + WA_PHONE_ID + WA_PHONE).
ملفات القسم الخاص ما بتنذكر أسماؤها أبداً، بس عددها."""
import json, os, re, sys, urllib.parse, urllib.request
from datetime import datetime, timezone, timedelta

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
P = lambda *a: os.path.join(ROOT, *a)
SITE = (os.environ.get("SITE_URL") or "https://abdulrahamnzakariya.github.io/atefSaedi.Taqni/").rstrip("/") + "/"
MODE = (os.environ.get("MODE") or "daily").strip()
SEC = {"eng": "المكاتب الهندسية", "proj": "المشاريع", "inv": "المستثمرين", "off": "العروض", "priv": "الملف الخاص", "todo": "بحاجة تصنيف"}


def load_json(path, default):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return default


def archive():
    html = open(P("index.html"), encoding="utf-8").read()
    m = re.search(r"const DATA=(\{.*?\});\s*\n", html, re.S)
    return json.loads(m.group(1)) if m else {"files": [], "projects": []}


def build():
    data = archive()
    files = [f for f in data.get("files", []) if not f.get("trash")]  # سلة المحذوفات ما بتنحسب
    tasks = load_json(P("data", "tasks.json"), {}).get("tasks", [])
    lists = load_json(P("data", "lists.json"), {}).get("lists", {})
    state = load_json(P("data", "digest-state.json"), {})
    seen = set(state.get("files", []))
    first_run = not state
    new_files = [f for f in files if f["id"] not in seen] if not first_run else []
    old_tasks = state.get("tasks", {})
    new_tasks = [t for t in tasks if t["id"] not in old_tasks] if not first_run else []
    done_tasks = [t for t in tasks if t.get("status") == "منجزة" and old_tasks.get(t["id"]) not in (None, "منجزة")]
    old_lists = state.get("lists", {})
    list_changes = [(k, len(v) - old_lists.get(k, 0)) for k, v in lists.items() if len(v) != old_lists.get(k, -1)] if not first_run else []
    open_tasks = [t for t in tasks if t.get("status") != "منجزة"]
    pending = [f for f in files if f.get("section") != "priv" and (f.get("section") == "todo" or "تأكيد" in (f.get("status") or ""))]

    now = datetime.now(timezone(timedelta(hours=3)))
    L = []
    if MODE == "test":
        L = ["✅ *تجربة تنبيهات أرشيف كيانات*", "الربط مع واتساب شغّال. رح توصلك رسالة كل يوم الساعة 8 الصبح، وتنبيه فوري مع كل جديد.", SITE]
    elif MODE == "changes":
        if not (new_files or new_tasks or done_tasks or list_changes):
            return None, state_of(files, tasks, lists)
        L.append("🔔 *جديد بأرشيف كيانات*")
        L += files_block(new_files)
        if new_tasks:
            L.append(f"\n📝 *مهام جديدة ({len(new_tasks)})*")
            L += [f"• {t['id']} · {t['title']}" for t in new_tasks[:8]]
        if done_tasks:
            L.append(f"\n✅ *انجزت ({len(done_tasks)})*")
            L += [f"• {t['id']} · {t['title']}" for t in done_tasks[:8]]
        for k, d in list_changes[:6]:
            L.append(f"📂 قائمة «{k}»: {'+' if d > 0 else ''}{d} ملف" if k in old_lists else f"📂 قائمة جديدة: «{k}»")
        L.append(f"\n{SITE}")
    else:  # daily
        L.append(f"☀️ *صباح الخير · ملخص أرشيف كيانات*\n{now.strftime('%Y-%m-%d')}")
        pub = [f for f in files if f.get("section") != "priv"]
        L.append(f"📁 بالأرشيف: {len(pub)} ملف عام + القسم الخاص المقفول")
        if new_files:
            L.append(f"\n🆕 *وصل من آخر ملخص ({len(new_files)})*")
            L += files_block(new_files, header=False)
        else:
            L.append("🆕 ما وصل ملفات جديدة من آخر ملخص")
        if pending:
            L.append(f"\n❓ *بحاجة تصنيف أو تأكيد ({len(pending)})*")
            L += [f"• {f['id']} · {f['title']}" + (f" — {f['note'].split('·')[-1].strip()}" if "سؤال" in (f.get("note") or "") or "تأكيد" in (f.get("note") or "") else "") for f in pending[:6]]
        L.append(f"\n📝 *المهام المفتوحة ({len(open_tasks)})*")
        L += [f"• {t['id']} · {t['title']} ({t.get('owner', '')})" for t in open_tasks[:10]] or ["• ما في مهام مفتوحة 👌"]
        if lists:
            L.append("\n📂 القوائم: " + " · ".join(f"{k} ({len(v)})" for k, v in list(lists.items())[:6]))
        L.append(f"\nافتح الأرشيف: {SITE}")
    return "\n".join(L), state_of(files, tasks, lists)


def files_block(new_files, header=True):
    out = []
    pub = [f for f in new_files if f.get("section") != "priv"]
    priv = len(new_files) - len(pub)
    if header and new_files:
        out.append(f"\n📄 *ملفات جديدة ({len(new_files)})*")
    for f in pub[:10]:
        where = " · ".join(x for x in [SEC.get(f.get("section"), ""), f.get("project"), f.get("sub")] if x)
        out.append(f"• {f['title']}\n   {where}")
    if len(pub) > 10:
        out.append(f"• و{len(pub) - 10} ملفات ثانية")
    if priv:
        out.append(f"• 🔒 {priv} ملف بالقسم الخاص")
    return out


def state_of(files, tasks, lists):
    return {"files": [f["id"] for f in files], "tasks": {t["id"]: t.get("status") for t in tasks},
            "lists": {k: len(v) for k, v in lists.items()}, "sent": datetime.now(timezone.utc).isoformat(timespec="seconds")}


def send(text):
    sent = False
    targets = [(os.environ.get("WA_PHONE"), os.environ.get("CALLMEBOT_APIKEY")), (os.environ.get("WA_PHONE_2"), os.environ.get("CALLMEBOT_APIKEY_2"))]
    if os.environ.get("WA_TOKEN") and os.environ.get("WA_PHONE_ID"):
        for phone in [t[0] for t in targets if t[0]]:
            body = json.dumps({"messaging_product": "whatsapp", "to": phone.lstrip("+"), "type": "text", "text": {"body": text[:4000], "preview_url": True}}).encode()
            req = urllib.request.Request(f"https://graph.facebook.com/v21.0/{os.environ['WA_PHONE_ID']}/messages", data=body,
                                         headers={"Authorization": "Bearer " + os.environ["WA_TOKEN"], "Content-Type": "application/json"})
            print("cloud api:", urllib.request.urlopen(req, timeout=30).status); sent = True
        return sent
    for phone, key in targets:
        if not (phone and key):
            continue
        url = "https://api.callmebot.com/whatsapp.php?" + urllib.parse.urlencode({"phone": phone, "text": text[:3800], "apikey": key})
        r = urllib.request.urlopen(url, timeout=60)
        print("callmebot:", r.status, r.read(200).decode("utf-8", "ignore")); sent = True
    return sent


if __name__ == "__main__":
    text, state = build()
    if text is None:
        print("ما في تغييرات تستاهل تنبيه.")
    else:
        print(text)
        if "--dry" in sys.argv:
            sys.exit(0)
        if not send(text):
            print("⚠️ ما في أسرار واتساب (WA_PHONE + CALLMEBOT_APIKEY). الرسالة ما انبعتت.")
            sys.exit(0)  # لا نحفظ الحالة إذا ما انبعتت، عشان ما يضيع الجديد
    if "--dry" not in sys.argv and MODE != "test":
        with open(P("data", "digest-state.json"), "w", encoding="utf-8") as f:
            json.dump(state, f, ensure_ascii=False, indent=1)
