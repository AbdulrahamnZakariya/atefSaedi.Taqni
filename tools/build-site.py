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
    # التشغيل: نجيب البيانات من الخادم أول، وبعدين نرسم
    html = sub_once(r"window\.addEventListener\('hashchange',\(\)=>\{\$\('#q'\)\.value='';route\(\)\}\);route\(\);",
                    "window.addEventListener('hashchange',()=>{$('#q').value='';route()});\n"
                    "async function loadData(){const r=await fetch('api/data',{cache:'no-store'});if(r.status===401){location.reload();return}if(!r.ok)throw new Error(r.status);"
                    "DATA=await r.json();unlocked=!!DATA.unlocked;document.getElementById('upd').textContent=DATA.updated}\n"
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
