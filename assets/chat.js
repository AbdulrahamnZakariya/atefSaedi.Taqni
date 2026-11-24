/* مساعد أرشيف كيانات · فريق تقني واعي
   يشتغل محلياً بدون أي مفتاح (بحث، عرض، قوائم، فهارس، مهام)،
   وبيتحول للوضع الذكي (Claude) لما ينحط workerUrl في data/config.json. */
(function () {
  'use strict';
  const D = () => window.DATA || (typeof DATA !== 'undefined' ? DATA : { files: [], projects: [], investors: [] });
  const isUnlocked = () => { try { return typeof unlocked !== 'undefined' && unlocked; } catch (e) { return false; } };
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const N = s => (s || '').toLowerCase().replace(/[أإآا]/g, 'ا').replace(/ة/g, 'ه').replace(/ى/g, 'ي').replace(/[ؤ]/g, 'و').replace(/[ئ]/g, 'ي').replace(/[ًٌٍَُِّْـ]/g, '').replace(/[·_\-()،,.؟?!:«»"]/g, ' ');
  const encP = p => p.split('/').map(encodeURIComponent).join('/');
  const today = () => new Date().toISOString().slice(0, 10);
  const LS = { get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch (e) { return d; } },
               set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} } };

  /* ---------- البيانات ---------- */
  const S = { lists: {}, indexes: [], tasks: [], config: {}, ready: false };
  async function getJSON(p) { try { const r = await fetch(p + '?t=' + Date.now(), { cache: 'no-store' }); return r.ok ? r.json() : null; } catch (e) { return null; } }
  async function load() {
    const [l, i, t, c] = await Promise.all(['data/lists.json', 'data/indexes.json', 'data/tasks.json', 'data/config.json'].map(getJSON));
    S.lists = (l && l.lists) || {}; S.indexes = (i && i.indexes) || []; S.tasks = (t && t.tasks) || []; S.config = c || {};
    const loc = LS.get('kayanat-local', null);           // تعديلات هالجهاز بتندمج مع ملفات الفريق بدل ما تغطي عليها
    if (loc && !S.config.workerUrl) {
      if (loc.lists) S.lists = Object.assign({}, S.lists, loc.lists);
      const byId = (a, b) => { const m = new Map(a.map(x => [x.id, x])); (b || []).forEach(x => m.set(x.id, x)); return [...m.values()]; };
      S.indexes = byId(S.indexes, loc.indexes); S.tasks = byId(S.tasks, loc.tasks);
    }
    S.ready = true; updateMode();
  }
  async function persist(kind) {
    const payload = { lists: { updated: today(), lists: S.lists }, indexes: { updated: today(), indexes: S.indexes }, tasks: { updated: today(), tasks: S.tasks } };
    if (S.config.workerUrl) {
      const pin = await getPin(); if (!pin) return 'local';
      try {
        const r = await fetch(S.config.workerUrl.replace(/\/$/, '') + '/save', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Kayanat-Pin': pin },
          body: JSON.stringify({ file: kind, content: payload[kind] }) });
        if (r.ok) return 'synced';
        if (r.status === 401) { LS.set('kayanat-pin', null); }
      } catch (e) {}
    }
    LS.set('kayanat-local', { lists: S.lists, indexes: S.indexes, tasks: S.tasks });
    return 'local';
  }
  const savedNote = m => m === 'synced' ? '<small class="kc-ok">✓ انحفظت وبتوصل تنبيه على واتساب</small>' : '<small class="kc-mute">انحفظت على هالجهاز</small>';
  let pinAsk = null;
  function getPin() { const p = LS.get('kayanat-pin', null); if (p) return Promise.resolve(p);
    return new Promise(res => { pinAsk = res; bot('لتشغيل المساعد الذكي والحفظ المشترك اكتب <b>رمز المزامنة</b> (مرة وحدة بس على هالجهاز):', [], true); }); }

  /* ---------- البحث ---------- */
  const STOP = new Set(['ملف', 'الملف', 'ملفات', 'لي', 'الي', 'اللي', 'تبع', 'تبعت', 'حق', 'عن', 'في', 'من', 'على', 'عل', 'يا', 'لو', 'سمحت', 'بدي', 'ابي', 'ابغي', 'ابغا', 'اريد', 'اعرض', 'اعرضلي', 'افتح', 'افتحلي', 'جيب', 'جيبلي', 'جبلي', 'وريني', 'ورجيني', 'هات', 'هاتلي', 'عطني', 'اعطني', 'ابحث', 'دور', 'دورلي', 'شوف', 'مباشره', 'هلا', 'الله', 'لو', 'سمحتي', 'ممكن', 'الـ', 'و', 'ال', 'هو', 'هي', 'هذا', 'هاد', 'هذي', 'كل']);
  const SYN = { 'رخصه': ['رخص', 'اعتماد', 'رخصه'], 'ترخيص': ['رخص', 'اعتماد'], 'صك': ['صك'], 'صكوك': ['صك'], 'عقد': ['عقد'], 'عقود': ['عقد'], 'صور': ['صوره', 'jpeg', 'jpg'], 'صوره': ['صوره', 'jpeg', 'jpg'], 'فيديو': ['فيديو', 'mp4', 'mov'], 'مخططات': ['مخطط'], 'مالي': ['مالي', 'جدوي'], 'جدوي': ['جدوي'], 'شراكه': ['شراكه', 'مشاركه', 'تفاهم'], 'هويه': ['هويه', 'قوالب'] };
  function variants(t) { const v = new Set([t]); for (const p of ['بال', 'وال', 'لل', 'ال', 'ل', 'ب', 'و']) if (t.startsWith(p) && t.length - p.length >= 3) v.add(t.slice(p.length)); (SYN[t] || []).forEach(x => v.add(x)); [...v].forEach(x => (SYN[x] || []).forEach(y => v.add(y))); return [...v]; }
  const tokens = q => N(q).split(/\s+/).filter(w => w && !STOP.has(w));
  const pool = () => D().files.filter(f => f.section !== 'priv' || isUnlocked());
  const secName = id => ({ eng: 'المكاتب الهندسية', proj: 'المشاريع', inv: 'المستثمرين', off: 'العروض', priv: 'الملف الخاص', todo: 'بحاجة تصنيف' }[id] || '');
  function search(q, max) {
    const ts = tokens(q); if (!ts.length) return [];
    const idm = q.match(/\bf\d+\b/gi);
    if (idm) { const hits = idm.map(x => pool().find(f => f.id.toLowerCase() === x.toLowerCase())).filter(Boolean); if (hits.length) return hits; }
    const res = pool().map(f => {
      const T = N(f.title), M = N([f.project, f.party, f.sub, secName(f.section)].join(' ')), R = N([f.note, f.path, f.kw, f.source].join(' '));
      let s = 0, hit = 0;
      ts.forEach(t => { const vs = variants(t); let b = 0; vs.forEach(v => { if (T.includes(v)) b = Math.max(b, 3); else if (M.includes(v)) b = Math.max(b, 2); else if (R.includes(v)) b = Math.max(b, 1); }); if (b) hit++; s += b; });
      return { f, s, hit };
    }).filter(r => r.hit >= Math.max(1, Math.ceil(ts.length * 0.6))).sort((a, b) => b.hit - a.hit || b.s - a.s);
    return res.slice(0, max || 12).map(r => Object.assign(r.f, { _s: r.s, _h: r.hit }));
  }
  function filesFor(q) {               // للفهارس: مشروع / قسم / جهة / بحث
    const n = N(q).trim(); const d = D();
    if (!n || /^(كل|الكل|الارشيف|كامل)/.test(n)) return pool();
    const proj = d.projects.find(p => n.includes(N(p.name).replace(/^ال/, ''))); if (proj) return pool().filter(f => f.project === proj.name);
    const inv = (d.investors || []).find(p => n.includes(N(p.name))); if (inv) return pool().filter(f => f.party === inv.name);
    const secs = { 'هندس': 'eng', 'مكاتب': 'eng', 'مستثمر': 'inv', 'عروض': 'off', 'العروض': 'off', 'تصنيف': 'todo', 'خاص': 'priv' };
    for (const k in secs) if (n.includes(k)) return pool().filter(f => f.section === secs[k]);
    return search(q, 200);
  }
  const typeLabel = f => { const e = (f.path || '').split('.').pop().toLowerCase(); return e === 'pdf' ? 'PDF' : ['jpg', 'jpeg', 'png', 'webp'].includes(e) ? 'صورة' : ['mp4', 'mov'].includes(e) ? 'فيديو' : ['docx', 'doc'].includes(e) ? 'Word' : ['xlsx', 'xls'].includes(e) ? 'Excel' : e.toUpperCase(); };
  const where = f => [secName(f.section), f.sub, f.project, f.party].filter(Boolean).join(' · ');

  /* ---------- الواجهة ---------- */
  let root, log, input;
  function build() {
    root = document.createElement('div'); root.id = 'kc';
    root.innerHTML = `<button class="kc-fab" aria-label="مساعد الأرشيف"><span class="kc-mark"><i></i><i></i><i></i></span><b>اسأل الأرشيف</b></button>
    <section class="kc-panel" role="dialog" aria-label="مساعد أرشيف كيانات"><header><div><b>مساعد الأرشيف</b><small id="kc-mode">جاري التحميل…</small></div><button class="kc-x" aria-label="إغلاق">✕</button></header>
    <div class="kc-log" aria-live="polite"></div>
    <div class="kc-sug"></div>
    <form class="kc-in"><button type="button" class="kc-mic" aria-label="أمر صوتي" title="اضغط واحكي"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/></svg></button><input type="text" placeholder="اكتب أو اضغط المايك واحكي" autocomplete="off" enterkeyhint="send"><button aria-label="إرسال">➤</button></form></section>`;
    document.body.appendChild(root);
    log = root.querySelector('.kc-log'); input = root.querySelector('input');
    root.querySelector('.kc-fab').onclick = () => toggle(true);
    root.querySelector('.kc-x').onclick = () => toggle(false);
    root.querySelector('form').onsubmit = e => { e.preventDefault(); const v = input.value.trim(); if (!v) return; input.value = ''; send(v); };
    root.addEventListener('click', onAction);
    setupVoice();
    setSug(['شو الجديد؟', 'اعرض صك السقيا', 'اعمل فهرس للجصة', 'قوائمي', 'المهام', 'شو بتقدر تعمل؟']);
  }
  function toggle(on) { root.classList.toggle('on', on); if (on) { if (!log.children.length) greet(); setTimeout(() => input.focus(), 50); } }
  function setSug(a) { root.querySelector('.kc-sug').innerHTML = a.map(x => `<button data-say="${esc(x)}">${esc(x)}</button>`).join(''); }
  function updateMode() { const m = root && root.querySelector('#kc-mode'); if (m) m.textContent = S.config.workerUrl ? 'الوضع الذكي · Claude' : 'يشتغل على الأرشيف مباشرة'; }
  function me(t) { const d = document.createElement('div'); d.className = 'kc-m kc-me'; d.textContent = t; log.appendChild(d); scroll(); }
  function bot(html, files, raw) { const d = document.createElement('div'); d.className = 'kc-m kc-bot'; d.innerHTML = html + (files && files.length ? cards(files) : ''); log.appendChild(d); scroll(); if (!/kc-dots/.test(html)) say(html); return d; }
  const scroll = () => { log.scrollTop = log.scrollHeight; };
  function cards(fs, opts) { opts = opts || {};
    return `<div class="kc-files">${fs.map(f => `<div class="kc-f"><button class="kc-open" data-open="${f.id}"><span class="kc-t">${typeLabel(f)}</span><span><b>${esc(f.title)}</b><small>${esc(where(f))} · ${f.id}</small></span></button>
      <div class="kc-acts">${f.pdf ? `<a href="${encP(f.pdf)}" target="_blank" rel="noopener">PDF</a>` : ''}${opts.list ? `<button data-unlist="${f.id}" data-list="${esc(opts.list)}">شيل من القائمة</button>` : `<button data-pick="${f.id}">أضف لقائمة</button>`}</div></div>`).join('')}</div>`; }
  function greet() { bot(`أهلاً أبو أنفال 👋 أنا مساعد أرشيف كيانات.<br>اطلب أي ملف وبفتحه لك مباشرة، أو قلّي أضيفه لقائمة، أو أعمل فهرس لمشروع.<br>🎙️ وبتقدر تضغط المايك وتحكي الأمر بصوتك.`); }
  function help() { return bot(`<b>شو بقدر أعمل:</b><ul>
    <li><b>أعرض ملف:</b> «اعرض صك السقيا»، «جيبلي المخطط النهائي للفلل»، «افتح f12»</li>
    <li><b>أضيف لقائمة:</b> «أضف دراسة جدوى الجصة لقائمة المستثمرين»</li>
    <li><b>القوائم:</b> «قوائمي»، «اعرض قائمة الصكوك»، «أنشئ قائمة اجتماع الخميس»</li>
    <li><b>فهرس:</b> «اعمل فهرس للجصة»، «فهرس العروض»، «فهرس كل الأرشيف» ← وبتقدر تطبعه PDF أو تنزله Excel</li>
    <li><b>بالصوت:</b> اضغط 🎙️ واحكي: «افتح صك السقيا»، «افتح ملف رقم 12»، «خلصت مهمة رقم 3»</li>
    <li><b>الجديد والمهام:</b> «شو الجديد؟»، «المهام»، «أضف مهمة: …»، «خلصت t3»</li></ul>`); }

  /* ---------- فهم الأوامر (محلي) ---------- */
  const RX = {
    hello: /^(مرحبا|هلا|السلام|اهلا|صباح|مساء|هاي)/,
    help: /(شو بتقدر|ماذا تستطيع|وش تقدر|مساعده|ساعدني|كيف استخدم|^مساعد|الاوامر)/,
    news: /(شو الجديد|ايش الجديد|وش الجديد|الجديد|اخر الملفات|اخر شي|شو وصل|جديد)/,
    tasksShow: /^(المهام|مهامي|شو المهام|اعرض المهام|المهام المفتوحه)/,
    taskAdd: /^(اضف|ضيف|سجل|اكتب)\s*مهمه\s*[:：]?\s*(.+)/,
    taskDone: /(خلصت|انجزت|تمت|خلص|سكر|اقفل)\s*(المهمه)?\s*(t\d+)/i,
    listsShow: /^(قوا[ئي]مي|القوا[ئي]م|اعرض القوا[ئي]م|شو القوا[ئي]م)/,
    listCreate: /^(انشئ|انشي|انشا|اعمل|سوي|افتح)\s*(قا[ئي]مه|لسته)\s+(.+)/,
    listShow: /^(اعرض|افتح|وريني|جيب|جيبلي)?\s*(قا[ئي]مه|لسته)\s+(.+)/,
    listAdd: /^(اضف|ضيف|حط|انقل|ضم)\s+(.+?)\s+(الي|ل|على|عل|في|لـ)\s*(قا[ئي]مه|لسته|(ال)?قا[ئي]مه)\s*(.+)$/,
    listAdd2: /^(اضف|ضيف|حط)\s+(.+?)\s+(لقا[ئي]مه|بقا[ئي]مه|للقا[ئي]مه|للسته)\s*(.+)$/,
    unlist: /^(شيل|احذف|امسح|اشطب)\s+(.+?)\s+(من)\s*(قا[ئي]مه|لسته)\s*(.+)$/,
    indexShow: /^(فهارسي|الفهارس|اعرض الفهارس)/,
    index: /(فهرس|كشف|جدول)\s*(ب|ل|لـ|عن|حق|تبع)?\s*(.*)$/,
  };
  /* ---------- الأوامر الصوتية ---------- */
  let rec = null, listening = false, viaVoice = false;
  function spoken(t) {                       // تنظيف ما بيطلع من التعرّف الصوتي
    return t.replace(/[٠-٩]/g, d => '٠١٢٣٤٥٦٧٨٩'.indexOf(d))
      .replace(/(?:^|\s)(?:اف|إف|ملف رقم|الملف رقم)\s*(\d+)/g, ' f$1')
      .replace(/(?:^|\s)(?:تي|مهمة رقم|المهمة رقم|المهمه رقم)\s*(\d+)/g, ' t$1')
      .replace(/\s*(فاصلة|نقطتين)\s*/g, ': ').replace(/\s+/g, ' ').trim();
  }
  function setupVoice() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    const mic = root.querySelector('.kc-mic');
    if (!SR) { mic.addEventListener('click', () => bot('المتصفح هاد ما بيدعم الأوامر الصوتية. على الآيفون افتح الموقع من Safari، وعلى الأندرويد من Chrome. وبتقدر كمان تستخدم مايك الكيبورد 🎙️ وتحكي، والكلام بينكتب لحاله.')); return; }
    rec = new SR(); rec.lang = 'ar-SA'; rec.interimResults = true; rec.continuous = false; rec.maxAlternatives = 1;
    let finalText = '';
    rec.onstart = () => { listening = true; finalText = ''; root.classList.add('kc-listening'); input.value = ''; input.placeholder = 'عم بسمعك… احكي الأمر'; };
    rec.onresult = e => { let t = ''; for (let i = 0; i < e.results.length; i++) { t += e.results[i][0].transcript; if (e.results[i].isFinal) finalText = t; } input.value = t; };
    rec.onerror = e => { if (e.error === 'not-allowed' || e.error === 'service-not-allowed') bot('لازم تسمح للموقع يستخدم المايك: من إعدادات المتصفح ← الموقع ← المايكروفون ← سماح.'); else if (e.error === 'no-speech') bot('<small class="kc-mute">ما سمعت إشي، اضغط المايك وجرّب كمان مرة.</small>'); };
    rec.onend = () => { listening = false; root.classList.remove('kc-listening'); input.placeholder = 'اكتب أو اضغط المايك واحكي';
      const t = spoken(finalText || input.value); input.value = ''; if (t) { viaVoice = true; send(t); } };
    mic.addEventListener('click', () => { if (listening) { rec.stop(); return; } if (window.speechSynthesis) window.speechSynthesis.cancel(); try { rec.start(); } catch (e) {} });
  }
  function say(html) {                       // رد صوتي قصير لما يكون الأمر بالصوت
    if (!viaVoice) return; viaVoice = false; if (!window.speechSynthesis) return;
    const d = document.createElement('div'); d.innerHTML = html; d.querySelectorAll('.kc-files,.kc-tbl,.kc-row,.kc-chips,small,ul').forEach(x => x.remove());
    let t = d.textContent.replace(/\s+/g, ' ').trim(); if (!t) return; if (t.length > 160) t = t.slice(0, 160);
    const v = speechSynthesis.getVoices().find(x => /^ar/i.test(x.lang)); if (!v) return;
    const u = new SpeechSynthesisUtterance(t); u.lang = v.lang; u.voice = v; u.rate = 1.05;
    speechSynthesis.cancel(); speechSynthesis.speak(u);
  }

  async function send(text) {
    if (pinAsk) { me('••••••••'); const r = pinAsk; pinAsk = null; LS.set('kayanat-pin', text.trim()); r(text.trim()); return; }
    me(text);
    if (S.config.workerUrl) { try { return await ai(text); } catch (e) { bot('<small class="kc-mute">الوضع الذكي مش متاح هلّق، بكمّل بالبحث المباشر.</small>'); } }
    local(text);
  }
  function local(text) {
    const n = N(text).replace(/\s+/g, ' ').trim(); let m;
    if (RX.help.test(n)) return help();
    if ((m = n.match(RX.taskDone))) return taskDone(m[3]);
    if ((m = text.match(/^\s*(أضف|اضف|ضيف|سجل|سجّل|اكتب)\s*مهمة\s*[:：]?\s*(.+)/))) return taskAdd(m[2]);
    if (RX.tasksShow.test(n)) return tasksShow();
    if (RX.indexShow.test(n)) return indexesShow();
    if (RX.listsShow.test(n)) return listsShow();
    if ((m = n.match(RX.unlist))) return unlist(m[2], m[5]);
    if ((m = n.match(RX.listAdd)) || (m = n.match(RX.listAdd2))) return listAdd(m[2], m[m.length - 1]);
    if ((m = n.match(RX.listCreate))) { const o = text.match(/(قائمة|قائمه|لستة|لسته)\s+(.+)$/); return listCreate(o ? o[2].replace(/[؟?.!،]+$/, '') : m[3]); }
    if ((m = n.match(RX.listShow))) return listShow(m[3]);
    if ((m = n.match(RX.index)) && /(فهرس|كشف)/.test(n)) { const o = text.match(/(فهرس|كشف)\s*(.*)$/); return makeIndex(((o && o[2]) || '').replace(/^(لـ|لل|ل|ب|عن|حق|تبع)\s*/, '').replace(/[؟?.!]+$/, '')); }
    if (RX.news.test(n)) return news();
    if (RX.hello.test(n) && tokens(n).length <= 2) return bot('هلا والله 🌿 شو الملف اللي بدك ياه؟');
    return openFile(text);
  }

  /* ---------- الأوامر ---------- */
  function openFile(q) {
    const hits = search(q, 8);
    if (!hits.length) return bot(`ما لقيت ملف بهالوصف. جرّب كلمة ثانية (اسم المشروع، نوع الملف، أو رقمه مثل f12).${isUnlocked() ? '' : '<br><small class="kc-mute">إذا الملف بالقسم الخاص، افتح القفل من الرئيسية أولاً.</small>'}`);
    const top = hits[0], second = hits[1];
    const clear = hits.length === 1 || (top._h > second._h) || (top._s >= second._s + 2);
    if (clear) { bot(`فتحتلك: <b>${esc(top.title)}</b>`, [top]); if (typeof openV === 'function') openV(top.id); return; }
    bot(`لقيت ${hits.length} ملفات قريبة، أيّهم بدك؟`, hits);
  }
  function news() {
    const fs = [...pool()].sort((a, b) => (b.date || '').localeCompare(a.date || '') || (+b.id.slice(1)) - (+a.id.slice(1))).slice(0, 6);
    const todo = pool().filter(f => f.section === 'todo' || /تأكيد/.test(f.status || '')).length;
    const open = S.tasks.filter(t => t.status !== 'منجزة').length;
    bot(`<b>آخر ما وصل للأرشيف</b> (تحديث ${esc(D().updated || '')}):`, fs);
    bot(`📌 ${todo} ملف بحاجة تصنيف أو تأكيد · ${open} مهمة مفتوحة. اكتب «المهام» لتشوفها.`);
  }
  function tasksShow() {
    const open = S.tasks.filter(t => t.status !== 'منجزة'), done = S.tasks.filter(t => t.status === 'منجزة');
    if (!S.tasks.length) return bot('ما في مهام مسجلة. اكتب «أضف مهمة: …»');
    bot(`<b>المهام المفتوحة (${open.length})</b><ul class="kc-tasks">${open.map(t => `<li><span>${esc(t.id)}</span> ${esc(t.title)}<small>${esc(t.owner || '')} · ${esc(t.date || '')}${t.file ? ` · <a href="#" data-open="${esc(t.file)}">الملف</a>` : ''}</small><button data-done="${esc(t.id)}">✓ خلصت</button></li>`).join('')}</ul>${done.length ? `<small class="kc-mute">${done.length} مهمة منجزة</small>` : ''}`);
  }
  async function taskAdd(title) {
    const id = 't' + (S.tasks.reduce((m, t) => Math.max(m, +String(t.id).slice(1) || 0), 0) + 1);
    S.tasks.push({ id, title: title.trim(), owner: 'أ. عاطف', status: 'مفتوحة', date: today() });
    const r = await persist('tasks'); bot(`سجّلت المهمة <b>${id}</b>: ${esc(title)} ${savedNote(r)}`);
  }
  async function taskDone(id) {
    const t = S.tasks.find(x => String(x.id).toLowerCase() === id.toLowerCase()); if (!t) return bot(`ما في مهمة برقم ${esc(id)}.`);
    t.status = 'منجزة'; t.done = today(); const r = await persist('tasks'); bot(`تمام ✓ المهمة ${esc(t.id)} صارت منجزة. ${savedNote(r)}`);
  }
  const visible = ids => (ids || []).filter(id => { const f = D().files.find(x => x.id === id); return f && (f.section !== 'priv' || isUnlocked()); });
  const findList = q => { const n = N(q).replace(/^(ال)?(قايمه|لسته)\s*/, '').trim(); const names = Object.keys(S.lists);
    return names.find(x => N(x) === n) || names.find(x => N(x).includes(n) || n.includes(N(x))) || null; };
  function listsShow() {
    const names = Object.keys(S.lists); if (!names.length) return bot('ما عندك قوائم لسا. اكتب «أنشئ قائمة …»');
    bot(`<b>قوائمك (${names.length})</b><div class="kc-chips">${names.map(x => `<button data-say="اعرض قائمة ${esc(x)}">${esc(x)} <small>${visible(S.lists[x]).length}</small></button>`).join('')}</div>`);
  }
  function listShow(q) {
    const name = findList(q); if (!name) return bot(`ما في قائمة اسمها «${esc(q)}». ${Object.keys(S.lists).length ? 'اكتب «قوائمي» لتشوفهم.' : ''}`);
    const fs = S.lists[name].map(id => D().files.find(f => f.id === id)).filter(f => f && (f.section !== 'priv' || isUnlocked()));
    bot(`<b>قائمة ${esc(name)}</b> · ${fs.length} ملف <button class="kc-link" data-idx-list="${esc(name)}">اعمل منها فهرس</button>`, []).insertAdjacentHTML('beforeend', fs.length ? cards(fs, { list: name }) : '<div class="kc-mute">القائمة فاضية</div>');
  }
  async function listCreate(name) {
    name = name.replace(/^["«]|["»]$/g, '').trim(); if (S.lists[name]) return bot(`القائمة «${esc(name)}» موجودة.`);
    S.lists[name] = []; const r = await persist('lists'); bot(`أنشأت قائمة <b>${esc(name)}</b>. ${savedNote(r)}`);
  }
  let pending = null;
  async function listAdd(fq, lq) {
    lq = lq.trim(); let name = findList(lq);
    const hits = search(fq, 6);
    if (!hits.length) return bot(`ما لقيت ملف اسمه «${esc(fq)}».`);
    if (!name) name = Object.keys(S.lists).find(x => N(x) === N(lq)) || lq.replace(/^(ال)?(قائمة|قائمه|قايمه)\s*/, '');
    const top = hits[0], clear = hits.length === 1 || top._h > hits[1]._h || top._s >= hits[1]._s + 2;
    if (!clear) { pending = name; return bot(`أي ملف بدك أضيفه لقائمة <b>${esc(name)}</b>؟`, []).insertAdjacentHTML('beforeend', `<div class="kc-files">${hits.map(f => `<div class="kc-f"><button class="kc-open" data-addto="${f.id}"><span class="kc-t">${typeLabel(f)}</span><span><b>${esc(f.title)}</b><small>${esc(where(f))}</small></span></button></div>`).join('')}</div>`); }
    return addTo(top, name);
  }
  async function addTo(f, name) {
    const real = Object.keys(S.lists).find(x => N(x) === N(name)) || name; const isNew = !S.lists[real];
    S.lists[real] = S.lists[real] || []; if (S.lists[real].includes(f.id)) return bot(`«${esc(f.title)}» موجود أصلاً بقائمة ${esc(real)}.`);
    S.lists[real].push(f.id); const r = await persist('lists');
    bot(`أضفت <b>${esc(f.title)}</b> لقائمة <b>${esc(real)}</b>${isNew ? ' (قائمة جديدة)' : ''} · صار فيها ${visible(S.lists[real]).length} ملف. ${savedNote(r)}`);
  }
  async function unlist(fq, lq) {
    const name = findList(lq); if (!name) return bot(`ما في قائمة «${esc(lq)}».`);
    const f = search(fq, 1)[0]; if (!f || !S.lists[name].includes(f.id)) return bot('هالملف مش بالقائمة.');
    S.lists[name] = S.lists[name].filter(x => x !== f.id); const r = await persist('lists');
    bot(`شلت «${esc(f.title)}» من قائمة ${esc(name)} (الملف نفسه ما انحذف من الأرشيف). ${savedNote(r)}`);
  }
  let lastIndex = null;
  function makeIndex(q, ids, title) {
    q = (q || '').trim(); const fs = ids ? ids.map(id => D().files.find(f => f.id === id)).filter(f => f && (f.section !== 'priv' || isUnlocked())) : filesFor(q);
    if (!fs.length) return bot(`ما لقيت ملفات لـ«${esc(q)}» عشان أعمل فهرس.`);
    const pj = !ids && D().projects.find(p => N(q).includes(N(p.name).replace(/^ال/, '')));
    const all = !ids && (!q || /^(كل|الكل|الارشيف|الأرشيف|كامل)/.test(q.trim()));
    const name = title || (all ? 'فهرس الأرشيف كامل' : pj ? 'فهرس مشروع ' + pj.name : 'فهرس ' + (q ? (/^ال/.test(q) ? q : 'ال' + q) : 'الأرشيف كامل'));
    lastIndex = { id: 'x' + Date.now().toString(36), name, query: q, ids: fs.map(f => f.id), date: today() };
    bot(`<b>${esc(name)}</b> · ${fs.length} ملف<div class="kc-tbl"><table><thead><tr><th>#</th><th>الملف</th><th>المكان</th><th>النوع</th><th>رقم</th></tr></thead><tbody>${fs.map((f, i) => `<tr><td>${i + 1}</td><td><a href="#" data-open="${f.id}">${esc(f.title)}</a></td><td>${esc(where(f))}</td><td>${typeLabel(f)}</td><td>${f.id}</td></tr>`).join('')}</tbody></table></div>
      <div class="kc-row"><button data-idx="save">حفظ الفهرس</button><button data-idx="print">طباعة / PDF</button><button data-idx="csv">تنزيل Excel</button></div>`);
  }
  function indexesShow() {
    if (!S.indexes.length) return bot('ما في فهارس محفوظة لسا. جرّب «اعمل فهرس للجصة».');
    bot(`<b>الفهارس المحفوظة</b><div class="kc-chips">${S.indexes.map(x => `<button data-idx-open="${esc(x.id)}">${esc(x.name)} <small>${x.ids.length}</small></button>`).join('')}</div>`);
  }
  function rowsOf(ix) { return ix.ids.map(id => D().files.find(f => f.id === id)).filter(f => f && (f.section !== 'priv' || isUnlocked())); }
  function printIndex(ix) {
    const fs = rowsOf(ix), base = location.href.split('#')[0].replace(/[^/]*$/, '');
    const w = window.open('', '_blank'); if (!w) return bot('المتصفح منع النافذة. اسمح بالنوافذ المنبثقة وجرب كمان مرة.');
    w.document.write(`<!DOCTYPE html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><title>${esc(ix.name)}</title><link href="https://fonts.googleapis.com/css2?family=Alexandria:wght@600;700&family=IBM+Plex+Sans+Arabic:wght@400;600&display=swap" rel="stylesheet"><style>
      @page{size:A4;margin:16mm}body{font-family:"IBM Plex Sans Arabic",Tahoma,sans-serif;color:#22304A;margin:0}
      .h{display:flex;justify-content:space-between;align-items:flex-end;border-bottom:2px solid #C8A45D;padding-bottom:10px;margin-bottom:18px}
      .lg{display:flex;align-items:center;gap:10px}.lg i{display:grid;grid-template-columns:12px 9px;grid-template-rows:12px 12px;gap:3px}.lg i b{background:#6B7480}.lg i b:first-child{grid-row:span 2;background:#C8A45D}
      h1{font-family:Alexandria;font-size:22px;margin:0}.s{color:#6B7480;font-size:12px}
      table{width:100%;border-collapse:collapse;font-size:12px}th{background:#22304A;color:#fff;text-align:right;padding:7px}td{border-bottom:1px solid #e7e1d4;padding:7px;vertical-align:top}tr:nth-child(even) td{background:#F7F5F0}
      a{color:#22304A}.f{margin-top:18px;font-size:10px;color:#6B7480;text-align:center}</style></head><body>
      <div class="h"><div class="lg"><i><b></b><b></b><b></b></i><div><h1>كيانات</h1><div class="s">للتطوير العقاري</div></div></div><div style="text-align:left"><h1 style="font-size:17px">${esc(ix.name)}</h1><div class="s">${fs.length} ملف · ${esc(ix.date)}</div></div></div>
      <table><thead><tr><th>#</th><th>الملف</th><th>القسم والمكان</th><th>النوع</th><th>التاريخ</th><th>رقم</th></tr></thead><tbody>
      ${fs.map((f, i) => `<tr><td>${i + 1}</td><td><a href="${base + encP(f.path)}">${esc(f.title)}</a></td><td>${esc(where(f))}</td><td>${typeLabel(f)}</td><td>${esc(f.date || '')}</td><td>${f.id}</td></tr>`).join('')}</tbody></table>
      <div class="f">أرشيف كيانات · أ. عاطف الصاعدي · إعداد تقني واعي</div><script>document.fonts.ready.then(()=>setTimeout(()=>print(),300))<\/script></body></html>`);
    w.document.close();
  }
  function csvIndex(ix) {
    const fs = rowsOf(ix), base = location.href.split('#')[0].replace(/[^/]*$/, '');
    const q = s => '"' + String(s == null ? '' : s).replace(/"/g, '""') + '"';
    const rows = [['#', 'الملف', 'القسم', 'القسم الفرعي', 'المشروع', 'الجهة', 'النوع', 'التاريخ', 'رقم', 'الرابط']].concat(fs.map((f, i) => [i + 1, f.title, secName(f.section), f.sub, f.project, f.party, typeLabel(f), f.date, f.id, base + encP(f.path)]));
    const blob = new Blob(['﻿' + rows.map(r => r.map(q).join(',')).join('\r\n')], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = ix.name.replace(/[\\/:*?"<>|]/g, '-') + '.csv'; document.body.appendChild(a); a.click(); a.remove();
  }

  /* ---------- الأزرار داخل المحادثة ---------- */
  async function onAction(e) {
    const b = e.target.closest('[data-say],[data-open],[data-pick],[data-addto],[data-unlist],[data-done],[data-idx],[data-idx-open],[data-idx-list]'); if (!b) return;
    e.preventDefault(); const ds = b.dataset;
    if (ds.say) return send(ds.say);
    if (ds.open) { if (typeof openV === 'function') openV(ds.open); return; }
    if (ds.pick) { const f = D().files.find(x => x.id === ds.pick); const names = Object.keys(S.lists);
      pending = null; return bot(`لأي قائمة أضيف «${esc(f.title)}»؟<div class="kc-chips">${names.map(x => `<button data-addto="${f.id}" data-to="${esc(x)}">${esc(x)}</button>`).join('')}</div><small class="kc-mute">أو اكتب: أضف ${esc(f.id)} لقائمة (اسم جديد)</small>`); }
    if (ds.addto) { const f = D().files.find(x => x.id === ds.addto); const to = ds.to || pending; pending = null; if (f && to) return addTo(f, to); return; }
    if (ds.unlist) return unlist(ds.unlist, ds.list);
    if (ds.done) return taskDone(ds.done);
    if (ds.idxList) return makeIndex('', S.lists[ds.idxList], 'فهرس قائمة ' + ds.idxList);
    if (ds.idxOpen) { const ix = S.indexes.find(x => x.id === ds.idxOpen); if (ix) { lastIndex = ix; return makeIndex('', ix.ids, ix.name); } }
    if (ds.idx && lastIndex) {
      if (ds.idx === 'print') return printIndex(lastIndex);
      if (ds.idx === 'csv') return csvIndex(lastIndex);
      if (ds.idx === 'save') { if (S.indexes.some(x => x.name === lastIndex.name)) S.indexes = S.indexes.filter(x => x.name !== lastIndex.name);
        S.indexes.push(lastIndex); const r = await persist('indexes'); return bot(`انحفظ «${esc(lastIndex.name)}». بتلاقيه بـ«فهارسي». ${savedNote(r)}`); }
    }
  }

  /* ---------- الوضع الذكي (Claude عبر الوسيط) ---------- */
  const hist = [];
  const TOOLS = {
    search_files: a => { const h = search(a.query || '', 10); return h.map(f => ({ id: f.id, title: f.title, where: where(f), type: typeLabel(f), date: f.date })); },
    open_file: a => { const f = pool().find(x => x.id === a.id); if (!f) return { error: 'not found' }; bot(`فتحتلك: <b>${esc(f.title)}</b>`, [f]); if (typeof openV === 'function') openV(f.id); return { ok: true }; },
    show_files: a => { const fs = (a.ids || []).map(id => pool().find(x => x.id === id)).filter(Boolean); if (fs.length) bot(a.caption ? esc(a.caption) : '', fs); return { shown: fs.length }; },
    list_lists: () => Object.fromEntries(Object.entries(S.lists).map(([k, v]) => [k, visible(v).length])),
    get_list: a => { const n = findList(a.name || ''); return n ? { name: n, files: visible(S.lists[n]) } : { error: 'no such list' }; },
    add_to_list: async a => { const f = pool().find(x => x.id === a.id); if (!f) return { error: 'file not found' }; await addTo(f, a.list); return { ok: true }; },
    remove_from_list: async a => { await unlist(a.id, a.list); return { ok: true }; },
    make_index: a => { makeIndex(a.query || '', a.ids, a.title); return { ok: true, count: lastIndex ? lastIndex.ids.length : 0 }; },
    whats_new: () => { news(); return { ok: true }; },
    list_tasks: () => S.tasks,
    add_task: async a => { await taskAdd(a.title); return { ok: true }; },
    complete_task: async a => { await taskDone(a.id); return { ok: true }; },
  };
  async function ai(text) {
    const pin = await getPin(); if (!pin) throw new Error('nopin');
    hist.push({ role: 'user', content: text });
    const typing = bot('<span class="kc-dots"><i></i><i></i><i></i></span>');
    try {
      for (let step = 0; step < 6; step++) {
        const r = await fetch(S.config.workerUrl.replace(/\/$/, '') + '/chat', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Kayanat-Pin': pin },
          body: JSON.stringify({ messages: hist.slice(-16), context: { today: today(), unlocked: isUnlocked(), projects: D().projects.map(p => p.name), investors: (D().investors || []).map(p => p.name), lists: Object.keys(S.lists) } }) });
        if (r.status === 401) { LS.set('kayanat-pin', null); throw new Error('pin'); }
        if (!r.ok) throw new Error('http ' + r.status);
        const msg = await r.json(); hist.push({ role: 'assistant', content: msg.content });
        const uses = msg.content.filter(c => c.type === 'tool_use');
        const txt = msg.content.filter(c => c.type === 'text').map(c => c.text).join('\n').trim();
        if (txt) bot(esc(txt).replace(/\n/g, '<br>'));
        if (!uses.length) break;
        const results = [];
        for (const u of uses) { let out; try { out = await (TOOLS[u.name] || (() => ({ error: 'unknown tool' })))(u.input || {}); } catch (e) { out = { error: String(e) }; } results.push({ type: 'tool_result', tool_use_id: u.id, content: JSON.stringify(out).slice(0, 6000) }); }
        hist.push({ role: 'user', content: results });
      }
    } catch (e) { hist.length = 0; typing.remove(); throw e; }
    typing.remove();
  }

  /* ---------- تشغيل ---------- */
  function start() { build(); load(); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
  window.KayanatChat = { send, search, state: S };
})();
