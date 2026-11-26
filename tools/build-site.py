#!/usr/bin/env python3
"""يبني مجلد site/ (الموقع الآمن على Cloudflare Pages) من index.html اللي بيولّده ingest.py.

- بيشيل بيانات الملفات (DATA) وبصمة كلمة السر (PRIV_HASH) من الصفحة نهائياً.
- الصفحة بتجيب البيانات من الخادم بعد تسجيل الدخول (/api/data).
- روابط الملفات بتمر من الخادم (/api/f/...) وبتتحول لروابط موقّعة تنتهي صلاحيتها.
- قفل الملف الخاص صار من الخادم (/api/unlock).

أي تغيير بقالب index.html ما بيطابق التوقعات: السكربت بيوقف بخطأ بدل ما يطلع موقع فيه تسريب.
التشغيل: python3 tools/build-site.py   (Cloudflare Pages بيشغّله لحاله مع كل نشر)
"""
import os, re, shutil, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "site")


def die(msg):
    print("✗ build-site:", msg, file=sys.stderr)
    sys.exit(1)


def sub_once(pattern, repl, s, label, flags=0):
    new, n = re.subn(pattern, lambda m: repl, s, count=1, flags=flags)
    if n != 1:
        die(f"ما لقيت «{label}» بـ index.html (تغيّر القالب؟)")
    return new


def build():
    html = open(os.path.join(ROOT, "index.html"), encoding="utf-8").read()

    html = sub_once(r"const DATA=\{.*?\};[ \t]*\n",
                    "let DATA={updated:'',projects:[],investors:[],files:[]};\n", html, "const DATA", re.S)
    html = sub_once(r'const PRIV_HASH="[0-9a-f]*";[ \t]*\n', "", html, "PRIV_HASH")
    html = sub_once(r"document\.getElementById\('upd'\)\.textContent=DATA\.updated;[ \t]*\n", "", html, "upd")
    html = sub_once(r"let unlocked=sessionStorageGet\('kp'\)==='1';", "let unlocked=false;", html, "let unlocked")
    html = sub_once(r"const enc=p=>p\.split\('/'\)\.map\(encodeURIComponent\)\.join\('/'\);",
                    "const enc=p=>'api/f/'+p.split('/').map(encodeURIComponent).join('/');", html, "const enc")
    html = sub_once(r"async function sha\(s\)\{.*?\}\n", "", html, "function sha", re.S)
    html = sub_once(r"async function tryUnlock\(\)\{.*?\}\}\n",
                    "async function tryUnlock(){const v=$('#pw').value;let r;try{r=await fetch('api/unlock',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:v})})}catch(e){}"
                    "if(r&&r.ok){await loadData();route()}else{$('#pwm').textContent=r&&r.status===429?'محاولات كثيرة، استنى ربع ساعة':'كلمة السر غلط'}}\n"
                    "async function lockPriv(){try{await fetch('api/lock',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'})}catch(e){}await loadData();location.hash='#/';route()}\n",
                    html, "function tryUnlock", re.S)
    html = sub_once(r"return crumb\(\[\[sec\.name\]\]\)\+`<h2>الملف الخاص</h2>`",
                    "return crumb([[sec.name]])+`<h2>الملف الخاص <small><a href=\"javascript:lockPriv()\" style=\"color:var(--gold)\">قفل</a></small></h2>`",
                    html, "priv header")
    # حماية النصوص + ترتيب يدوي + وسوم
    html = sub_once(r"const enc=p=>'api/f/'",
                    "const h=s=>String(s==null?'':s).replace(/[&<>\"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;',\"'\":'&#39;'}[c]));\n"
                    "const sortO=fs=>fs.some(f=>f.order)?[...fs].sort((a,b)=>(a.order||1e9)-(b.order||1e9)):fs;\nconst enc=p=>'api/f/'", html, "helpers")
    html = sub_once(r"<div class=\"m\"><b>\$\{f\.title\}</b>",
                    "<div class=\"m\"><b>${h(f.title)}</b>${(f.tags||[]).map(t=>`<span class=\"tag\">${h(t)}</span>`).join('')}", html, "fileRow title")
    html = sub_once(r"\$\{where\}\$\{f\.date\?", "${h(where)}${f.date?", html, "fileRow where")
    html = sub_once(r"const list=\(fs,emptyMsg\)=>fs\.length\?", "const list=(fs,emptyMsg)=>(fs=sortO(fs)).length?", html, "list sort")
    # صفحات السلة وسجل العمليات
    html = sub_once(r"<h2>طريقة الاستخدام</h2>",
                    "<h2>الإدارة</h2><div class=\"grid\"><a class=\"sec\" href=\"#/trash\"><div class=\"ic\">🗑</div><b>سلة المحذوفات</b><span>بترجع خلال 30 يوم</span><div class=\"n\">${(DATA.trash||[]).length} ملف</div></a>"
                    "<a class=\"sec\" href=\"#/log\"><div class=\"ic\">📜</div><b>سجل العمليات</b><span>مين عمل شو وإمتى</span></a><a class=\"sec\" href=\"/__logout\"><div class=\"ic\">🚪</div><b>تسجيل الخروج</b><span>${h(DATA.email||'')}</span></a></div>\n <h2>طريقة الاستخدام</h2>", html, "home admin")
    html = sub_once(r"else if\(s==='help'\)h=help\(\);",
                    "else if(s==='help')h=help();\n else if(s==='trash')h=trashView();\n else if(s==='log'){h=crumb([['سجل العمليات']])+'<h2>سجل العمليات</h2><div id=\"logv\" class=\"empty\">جاري التحميل…</div>';setTimeout(logView,0)}", html, "routes")
    html = sub_once(r"function closeV\(\)",
                    "function trashView(){const t=DATA.trash||[];const own=DATA.role==='owner';return crumb([['سلة المحذوفات']])+`<h2>سلة المحذوفات <small>${t.length} ملف · بتنحذف لحالها بعد 30 يوم</small></h2>`+(t.length?`<div class=\"list\">${t.map(f=>`<div class=\"file\"><div class=\"t\">🗑</div><div class=\"m\"><b>${h(f.title)}</b><span>${f.id} · انحذف ${h((f.trash.at||'').slice(0,10))} · باقي ${f.daysLeft} يوم</span><span><a class=\"tag\" href=\"javascript:KayanatChat.plan('restore',{ids:['${f.id}']})\">رجّعه</a>${own?` <a class=\"tag warn\" href=\"javascript:KayanatChat.plan('purge',{ids:['${f.id}']})\">حذف نهائي</a>`:''}</span></div></div>`).join('')}</div>`:'<div class=\"empty\">السلة فاضية</div>')}\n"
                    "async function logView(){const el=document.getElementById('logv');if(!el)return;try{const r=await fetch('api/audit',{cache:'no-store'});const j=await r.json();el.className='';el.innerHTML=j.ops.length?`<div class=\"list\">${j.ops.map(o=>`<div class=\"file\"><div class=\"t\">${o.n}</div><div class=\"m\"><b>${h(o.title)}</b><span>${h(o.by)} · ${h(o.at.replace('T',' ').slice(0,16))}${o.undone?' · <span class=\"tag warn\">انتراجع عنها</span>':''}</span><span>${o.files.slice(0,8).map(f=>h(f.title)).join('، ')}${o.files.length>8?' …':''}</span></div></div>`).join('')}</div>`:'<div class=\"empty\">ما في عمليات لسا</div>'}catch(e){el.textContent='ما قدرت أحمّل السجل'}}\n"
                    "function closeV()", html, "trash/log views")
    # التشغيل: نجيب البيانات من الخادم أول، وبعدين نرسم
    html = sub_once(r"window\.addEventListener\('hashchange',\(\)=>\{\$\('#q'\)\.value='';route\(\)\}\);route\(\);",
                    "window.addEventListener('hashchange',()=>{$('#q').value='';route()});\n"
                    "async function loadData(fresh){const r=await fetch('api/data'+(fresh?'?fresh=1':''),{cache:'no-store'});if(r.status===401){location.reload();return}if(!r.ok)throw new Error(r.status);"
                    "DATA=await r.json();unlocked=!!DATA.unlocked;document.getElementById('upd').textContent=DATA.updated;"
                    "((DATA.subs||{}).eng||[]).forEach(x=>ENG_SUBS.includes(x)||ENG_SUBS.push(x));((DATA.subs||{}).off||[]).forEach(x=>OFF_SUBS.includes(x)||OFF_SUBS.push(x))}\n"
                    "loadData().then(route).catch(()=>{$('#app').innerHTML='<div class=\"empty\">ما قدرت أحمّل الأرشيف، حدّث الصفحة.</div>'});",
                    html, "route() boot")
    html = sub_once(r'<script src="assets/chat\.js" defer></script>',
                    '<script>window.KAYANAT_SESSION=true</script>\n<script src="assets/chat.js" defer></script>', html, "chat.js tag")
    if '<meta name="robots"' not in html:
        html = html.replace("<head>", '<head>\n<meta name="robots" content="noindex, nofollow">', 1)

    # فحص أخير: ولا بيانات ملفات ولا بصمة كلمة سر بالصفحة
    for bad in ('PRIV_HASH', '"files": [{', '"files":[{', '"path": "', 'sessionStorageSet(\'kp\''):
        if bad in html:
            die(f"الصفحة لسا فيها «{bad}»")
    if re.search(r'"id":\s*"f\d+"', html):
        die("الصفحة لسا فيها أرقام ملفات")

    if os.path.isdir(OUT):
        shutil.rmtree(OUT)
    os.makedirs(os.path.join(OUT, "assets"))
    open(os.path.join(OUT, "index.html"), "w", encoding="utf-8").write(html)
    for f in ("chat.js", "chat.css"):
        shutil.copy2(os.path.join(ROOT, "assets", f), os.path.join(OUT, "assets", f))
    shutil.copytree(os.path.join(ROOT, "assets", "brand"), os.path.join(OUT, "assets", "brand"))
    print("✓ site/ جاهز:", len(html), "حرف، بدون بيانات ملفات")


if __name__ == "__main__":
    build()
