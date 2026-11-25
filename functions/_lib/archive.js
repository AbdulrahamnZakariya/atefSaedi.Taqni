// منطق عمليات الأرشيف (بدون شبكة) · أرشيف كيانات
// كل عملية بتنحسب أولاً كـ «خطة» (قبل/بعد لكل ملف)، وما بتتنفذ إلا بعد زر «تأكيد».

export const SEC_DIR = { todo: '0-بحاجة-تصنيف', eng: '1-المكاتب-الهندسية', proj: '2-المشاريع', inv: '3-المستثمرين', off: '4-العروض', priv: '5-الملف-الخاص' };
export const SEC_NAME = { todo: 'بحاجة تصنيف', eng: 'المكاتب الهندسية', proj: 'المشاريع', inv: 'المستثمرين', off: 'العروض', priv: 'الملف الخاص' };
export const ENG_SUBS = ['المساحات', 'الواجهات', 'المخطط الإنشائي', 'المخطط المعماري', 'الرخص والاعتمادات', 'الملف المالي', 'الحقوق الخاصة', 'عام'];
export const OFF_SUBS = ['أراضي', 'استثمار', 'مشاركة', 'هوية وقوالب'];
export const TRASH_DIR = '_سلة-المحذوفات';
export const PDF_DIR = '_نسخ-PDF';
export const TRASH_DAYS = 30;
const MUTATING = new Set(['move', 'rename', 'reorder', 'create_section', 'update_metadata', 'delete', 'restore', 'undo', 'purge']);

export class PlanError extends Error {}
const err = m => { throw new PlanError(m); };

export const dash = s => String(s || '').trim().replace(/\s+/g, '-').replace(/[\\/:*?"<>|]/g, '-');
// نص من المستخدم أو النموذج: بدون رموز HTML أو تحكم
const clean = s => String(s == null ? '' : s).replace(/[\u0000-\u001f<>`]/g, ' ').replace(/\s+/g, ' ').trim();
const clone = o => JSON.parse(JSON.stringify(o));

export function subsFor(data, section) {
  const extra = (data.subs && data.subs[section]) || [];
  if (section === 'off') return [...OFF_SUBS, ...extra];
  if (section === 'eng' || section === 'proj') return [...ENG_SUBS, ...extra];
  return extra;
}

/* ---------- نظام التسمية (نفس الإدخال التلقائي) ----------
   {المجلد}/{البادئة}_{القسم-الفرعي}_{العنوان}_{التاريخ}[_vN].{الامتداد}
   البادئة: المشروع، وإلا الجهة، وإلا اسم القسم. */
export function dirOf(f) {
  switch (f.section) {
    case 'proj': return `${SEC_DIR.proj}/${dash(f.project)}/${dash(f.sub || 'عام')}`;
    case 'eng': return `${SEC_DIR.eng}/${dash(f.sub || 'عام')}`;
    case 'off': return `${SEC_DIR.off}/${dash(f.sub || 'عام')}`;
    case 'inv': return `${SEC_DIR.inv}/${dash(f.party || 'عام')}`;
    case 'priv': return SEC_DIR.priv;
    default: return SEC_DIR.todo;
  }
}
function prefixOf(f) {
  if (f.section === 'priv') return 'الملف-الخاص';
  if (f.section === 'todo') return 'بحاجة-تصنيف';
  return dash(f.project || f.party || SEC_NAME[f.section]);
}
export const extOf = p => { const m = String(p).match(/\.([^./]+)$/); return m ? m[1] : ''; };
const verOf = p => { const m = String(p).match(/_(v\d+)\.[^./]+$/); return m ? '_' + m[1] : ''; };
export function nameFor(f, ext, ver) {
  const sub = f.section === 'priv' || f.section === 'todo' ? '' : dash(f.sub || 'عام') + '_';
  return `${prefixOf(f)}_${sub}${dash(f.title)}_${f.date || today()}${ver || ''}${ext ? '.' + ext : ''}`;
}
export const pathFor = (f, ext, ver) => `${dirOf(f)}/${nameFor(f, ext, ver)}`;
export const pdfFor = p => `${PDF_DIR}/${p.replace(/\.[^./]+$/, '')}.pdf`;
export const today = () => new Date().toISOString().slice(0, 10);

// مسار جديد بدون تصادم: إذا محجوز بنزيد _v2، _v3...
function freePath(f, ext, taken) {
  let ver = '';
  for (let n = 2; n < 100; n++) {
    const p = pathFor(f, ext, ver);
    if (!taken.has(p)) return p;
    ver = '_v' + n;
  }
  err('ما قدرت ألاقي اسم متاح');
}

/* ---------- أدوات مساعدة ---------- */
const visibleTo = (f, ctx) => f.section !== 'priv' && !(f.trash && f.trash.fromSection === 'priv') || ctx.unlocked;
function getFiles(data, ids, ctx, { trash } = {}) {
  if (!Array.isArray(ids) || !ids.length) err('ما حددت ولا ملف');
  if (ids.length > 200) err('العدد كبير، قسّم العملية');
  const out = [];
  for (const id of [...new Set(ids.map(String))]) {
    const f = data.files.find(x => x.id === id);
    if (!f || !visibleTo(f, ctx)) err(`ما لقيت الملف ${id}`);
    if (trash === true && !f.trash) err(`الملف ${id} مش بالسلة`);
    if (trash === false && f.trash) err(`الملف ${id} بالسلة، رجّعه أول`);
    out.push(f);
  }
  return out;
}
function takenPaths(data, except) {
  const s = new Set();
  for (const f of data.files) {
    if (except && except.has(f.id)) continue;
    if (f.path) s.add(f.path);
    if (f.pdf) s.add(f.pdf);
  }
  return s;
}
// بيحسب المسار الجديد للملف ونسخة PDF تبعته
function relocate(before, after, taken) {
  const ext = extOf(before.path);
  after.path = freePath(after, ext, taken);
  taken.add(after.path);
  if (before.pdf) { after.pdf = pdfFor(after.path); taken.add(after.pdf); }
  return after;
}
const label = f => `${f.title} (${f.id})`;
const placeOf = f => [SEC_NAME[f.section], f.project, f.party && f.section !== 'proj' ? f.party : '', f.sub].filter(Boolean).join(' › ') || '—';

/* ---------- بناء الخطط ---------- */
export function planOp(data, log, op, args, ctx) {
  args = args || {};
  if (!MUTATING.has(op)) err('عملية مش معروفة');
  if (ctx.role === 'viewer') err('صلاحيتك للأسئلة فقط');
  const P = { op, args: clone(args), changes: [], meta: null, title: '', warnings: [] };

  if (op === 'move') {
    const files = getFiles(data, args.ids, ctx, { trash: false });
    const section = args.section;
    if (!SEC_DIR[section]) err('القسم المطلوب مش واضح');
    if ((section === 'priv' || files.some(f => f.section === 'priv')) && !ctx.unlocked) err('افتح قفل الملف الخاص أول');
    let project = clean(args.project), party = clean(args.party), sub = clean(args.sub);
    if (section === 'proj') {
      if (!project) err('لأي مشروع؟');
      if (!(data.projects || []).some(p => p.name === project)) err(`ما في مشروع اسمه «${project}». بدك أنشئه؟`);
    }
    if (section === 'inv') {
      if (!party) err('لأي مستثمر؟');
      if (!(data.investors || []).some(p => p.name === party)) err(`ما في مستثمر اسمه «${party}». بدك أنشئ ملفه؟`);
    }
    const subs = subsFor(data, section);
    if (sub && subs.length && !subs.includes(sub)) err(`القسم الفرعي «${sub}» مش موجود. الموجود: ${subs.join('، ')}`);
    const ids = new Set(files.map(f => f.id));
    const taken = takenPaths(data, ids);
    for (const f of files) {
      const a = clone(f);
      a.section = section;
      if (section === 'proj') { a.project = project; a.sub = sub || (subs.includes(f.sub) ? f.sub : 'عام'); if (party) a.party = party; }
      else if (section === 'eng' || section === 'off') { a.sub = sub || (subs.includes(f.sub) ? f.sub : (section === 'off' ? 'استثمار' : 'عام')); if (project) a.project = project; if (party) a.party = party; }
      else if (section === 'inv') { a.party = party; a.sub = sub || f.sub || ''; }
      else { a.sub = ''; if (section === 'priv') { a.project = ''; a.party = ''; } }
      if (section === 'off' && !sub && !OFF_SUBS.includes(f.sub) && !(data.subs && (data.subs.off || []).includes(f.sub))) err('لأي نوع عروض؟ (أراضي، استثمار، مشاركة، هوية وقوالب)');
      if (a.section !== 'todo' && (f.section === 'todo' || f.status === 'بحاجة تصنيف')) a.status = 'مصنّف';
      if (a.section === 'todo') a.status = 'بحاجة تصنيف';
      delete a.order;
      relocate(f, a, taken);
      P.changes.push({ id: f.id, before: f, after: a });
    }
    P.title = files.length > 1 ? `نقل ${files.length} ملفات` : `نقل «${files[0].title}»`;
  }

  else if (op === 'rename') {
    const [f] = getFiles(data, [args.id], ctx, { trash: false });
    const title = clean(args.title).slice(0, 150);
    if (!title) err('شو الاسم الجديد؟');
    if (title === f.title) err('هذا نفس الاسم الحالي');
    const a = clone(f); a.title = title;
    relocate(f, a, takenPaths(data, new Set([f.id])));
    P.changes.push({ id: f.id, before: f, after: a });
    P.title = `إعادة تسمية «${f.title}»`;
  }

  else if (op === 'reorder') {
    const section = args.section;
    if (!SEC_DIR[section]) err('أي قسم بدك ترتّب؟');
    if (section === 'priv' && !ctx.unlocked) err('افتح قفل الملف الخاص أول');
    let group = data.files.filter(f => !f.trash && f.section === section && (!args.project || f.project === args.project) && (!args.sub || f.sub === args.sub) && (!args.party || f.party === args.party));
    if (!group.length) err('ما في ملفات بهالمكان');
    const mode = args.mode || 'date_desc';
    const byId = new Map(group.map(f => [f.id, f]));
    let sorted;
    if (mode === 'date_desc' || mode === 'date_asc') {
      const k = f => (f.date || '') + '|' + f.id.slice(1).padStart(6, '0');
      sorted = [...group].sort((a, b) => k(a).localeCompare(k(b)));
      if (mode === 'date_desc') sorted.reverse();
    } else if (mode === 'title') sorted = [...group].sort((a, b) => a.title.localeCompare(b.title, 'ar'));
    else if (mode === 'manual') {
      const ids = (args.ids || []).map(String).filter(id => byId.has(id));
      if (!ids.length) err('حدد ترتيب الملفات');
      sorted = [...ids.map(id => byId.get(id)), ...group.filter(f => !ids.includes(f.id))];
    } else err('طريقة الترتيب مش معروفة');
    sorted.forEach((f, i) => { if (f.order !== i + 1) { const a = clone(f); a.order = i + 1; P.changes.push({ id: f.id, before: f, after: a }); } });
    if (!P.changes.length) err('الملفات أصلاً مرتبة هيك');
    const where = [SEC_NAME[section], args.project, args.party, args.sub].filter(Boolean).join(' › ');
    P.title = `ترتيب ${where} ${{ date_desc: 'من الأحدث للأقدم', date_asc: 'من الأقدم للأحدث', title: 'أبجدياً', manual: 'يدوياً' }[mode]}`;
    P.order = sorted.map(f => ({ id: f.id, title: f.title, date: f.date }));
  }

  else if (op === 'create_section') {
    const name = clean(args.name).slice(0, 60);
    if (!name) err('شو اسم القسم؟');
    const kind = args.kind;
    if (kind === 'project') { if ((data.projects || []).some(p => p.name === name)) err('المشروع موجود أصلاً'); }
    else if (kind === 'investor') { if ((data.investors || []).some(p => p.name === name)) err('المستثمر موجود أصلاً'); }
    else if (kind === 'sub') { if (!['eng', 'off', 'proj'].includes(args.section)) err('القسم الفرعي بيكون تحت: المكاتب الهندسية، العروض، أو المشاريع'); if (subsFor(data, args.section).includes(name)) err('القسم الفرعي موجود أصلاً'); }
    else err('شو نوع القسم؟ مشروع، مستثمر، ولا قسم فرعي؟');
    P.meta = { kind, name, section: args.section || '', summary: clean(args.summary).slice(0, 400) };
    P.title = { project: `إنشاء مشروع «${name}»`, investor: `إنشاء ملف المستثمر «${name}»`, sub: `إنشاء قسم فرعي «${name}» تحت ${SEC_NAME[args.section]}` }[kind];
  }

  else if (op === 'update_metadata') {
    const files = getFiles(data, args.ids, ctx, { trash: false });
    for (const f of files) {
      const a = clone(f);
      if (typeof args.desc === 'string') a.desc = clean(args.desc).slice(0, 500);
      if (typeof args.note === 'string') a.note = clean(args.note).slice(0, 300);
      const tags = new Set(a.tags || []);
      (args.tags_add || []).forEach(t => clean(t) && tags.add(clean(t).slice(0, 30)));
      (args.tags_remove || []).forEach(t => tags.delete(clean(t)));
      if (tags.size) a.tags = [...tags]; else delete a.tags;
      if (args.confirm && a.status === 'يحتاج تأكيد') a.status = 'مصنّف';
      if (JSON.stringify(a) !== JSON.stringify(f)) P.changes.push({ id: f.id, before: f, after: a });
    }
    if (!P.changes.length) err('ما في إشي يتغيّر');
    P.title = files.length > 1 ? `تعديل بيانات ${P.changes.length} ملفات` : `تعديل بيانات «${files[0].title}»`;
  }

  else if (op === 'delete') {
    const files = getFiles(data, args.ids, ctx, { trash: false });
    if (files.some(f => f.section === 'priv') && !ctx.unlocked) err('افتح قفل الملف الخاص أول');
    const taken = takenPaths(data, new Set(files.map(f => f.id)));
    for (const f of files) {
      const a = clone(f);
      a.trash = { at: ctx.now, by: ctx.email, fromPath: f.path, fromPdf: f.pdf || '', fromSection: f.section };
      a.path = uniq(`${TRASH_DIR}/${f.path}`, taken);
      if (f.pdf) a.pdf = uniq(`${TRASH_DIR}/${f.pdf}`, taken);
      P.changes.push({ id: f.id, before: f, after: a });
    }
    P.title = files.length > 1 ? `نقل ${files.length} ملفات لسلة المحذوفات` : `نقل «${files[0].title}» لسلة المحذوفات`;
  }

  else if (op === 'restore') {
    const files = getFiles(data, args.ids, ctx, { trash: true });
    const taken = takenPaths(data, new Set(files.map(f => f.id)));
    for (const f of files) {
      const a = clone(f);
      delete a.trash;
      a.path = taken.has(f.trash.fromPath) ? freePath(a, extOf(f.trash.fromPath), taken) : f.trash.fromPath;
      taken.add(a.path);
      if (f.pdf) { a.pdf = f.trash.fromPdf && !taken.has(f.trash.fromPdf) && a.path === f.trash.fromPath ? f.trash.fromPdf : pdfFor(a.path); taken.add(a.pdf); }
      P.changes.push({ id: f.id, before: f, after: a });
    }
    P.title = files.length > 1 ? `استرجاع ${files.length} ملفات من السلة` : `استرجاع «${files[0].title}» من السلة`;
  }

  else if (op === 'purge') {
    if (ctx.role !== 'owner') err('الحذف النهائي للمالك بس');
    const files = getFiles(data, args.ids, ctx, { trash: true });
    for (const f of files) P.changes.push({ id: f.id, before: f, after: null });
    P.title = `حذف نهائي لـ ${files.length} ${files.length > 1 ? 'ملفات' : 'ملف'} (ما بيرجع)`;
    P.warnings.push('هذا حذف نهائي قبل مرور 30 يوم، وما في استرجاع بعده.');
  }

  else if (op === 'undo') {
    const last = [...(log.ops || [])].reverse().find(o => !o.undone && o.op !== 'undo' && o.op !== 'purge');
    if (!last) err('ما في عملية أتراجع عنها');
    for (const c of last.changes || []) {
      const cur = data.files.find(x => x.id === c.id);
      if (c.after && (!cur || JSON.stringify(cur) !== JSON.stringify(c.after))) err(`ما بقدر أتراجع: الملف ${c.id} انعدّل بعد العملية`);
      if (!cur && !c.after) continue;
      if (cur && (cur.section === 'priv' || c.before.section === 'priv') && !ctx.unlocked) err('افتح قفل الملف الخاص أول');
      P.changes.push({ id: c.id, before: cur, after: c.before });
    }
    if (last.meta) {
      const m = last.meta;
      const used = m.kind === 'project' ? data.files.some(f => f.project === m.name) : m.kind === 'investor' ? data.files.some(f => f.party === m.name) : data.files.some(f => f.section === m.section && f.sub === m.name);
      if (used) err(`ما بقدر أتراجع: في ملفات صارت بـ «${m.name}»`);
      P.meta = { ...m, remove: true };
    }
    P.undoOf = last.n;
    P.title = `تراجع عن: ${last.title}`;
  }

  if (!P.changes.length && !P.meta) err('ما في إشي يتغيّر');
  P.rows = P.changes.map(c => row(c));
  return P;
}

function uniq(p, taken) {
  let q = p, n = 2;
  while (taken.has(q)) q = p.replace(/(\.[^./]+)?$/, m => `_${n}${m}`), n++;
  taken.add(q);
  return q;
}

// سطر بطاقة الخطة: من وين لوين
function row(c) {
  const b = c.before, a = c.after;
  if (!a) return { id: b.id, title: b.title, from: placeOf(b.trash ? { ...b, section: b.trash.fromSection } : b), to: 'حذف نهائي' };
  if (b.trash && !a.trash) return { id: b.id, title: b.title, from: 'سلة المحذوفات', to: placeOf(a) };
  if (!b.trash && a.trash) return { id: b.id, title: b.title, from: placeOf(b), to: 'سلة المحذوفات' };
  const r = { id: b.id, title: b.title, from: placeOf(b), to: placeOf(a) };
  if (a.title !== b.title) { r.from = `الاسم: ${b.title}`; r.to = `الاسم: ${a.title}`; }
  if (a.order !== b.order) { r.from = b.order ? `#${b.order}` : 'بدون ترتيب'; r.to = `#${a.order}`; }
  if (r.from === r.to) {
    const d = [];
    if (a.status !== b.status) d.push(`الحالة: ${a.status}`);
    if (JSON.stringify(a.tags || []) !== JSON.stringify(b.tags || [])) d.push(`الوسوم: ${(a.tags || []).join('، ') || '—'}`);
    if ((a.desc || '') !== (b.desc || '')) d.push('الوصف');
    if ((a.note || '') !== (b.note || '')) d.push('الملاحظة');
    r.to = d.join(' · ') || r.to;
  }
  if (a.path !== b.path) { r.pathFrom = b.path; r.pathTo = a.path; }
  return r;
}

/* ---------- التنفيذ على البيانات ---------- */
// بيرجّع: البيانات الجديدة + عمليات الملفات (نقل/حذف) لنفس الـ commit
export function applyPlan(data, P) {
  const d = clone(data);
  const moves = [], deletes = [];
  for (const c of P.changes) {
    const i = d.files.findIndex(x => x.id === c.id);
    const cur = i >= 0 ? d.files[i] : null;
    if (c.after === null) {
      if (cur) { d.files.splice(i, 1); deletes.push(cur.path); if (cur.pdf) deletes.push(cur.pdf); }
      continue;
    }
    if (cur && cur.path !== c.after.path) moves.push({ from: cur.path, to: c.after.path });
    if (cur && cur.pdf && c.after.pdf && cur.pdf !== c.after.pdf) moves.push({ from: cur.pdf, to: c.after.pdf });
    if (i >= 0) d.files[i] = clone(c.after); else d.files.push(clone(c.after));
  }
  if (P.meta) {
    const m = P.meta;
    if (m.kind === 'project') d.projects = m.remove ? (d.projects || []).filter(p => p.name !== m.name) : [...(d.projects || []), { name: m.name, summary: m.summary || '' }];
    if (m.kind === 'investor') d.investors = m.remove ? (d.investors || []).filter(p => p.name !== m.name) : [...(d.investors || []), { name: m.name, summary: m.summary || '' }];
    if (m.kind === 'sub') {
      d.subs = d.subs || {};
      const l = d.subs[m.section] || [];
      d.subs[m.section] = m.remove ? l.filter(x => x !== m.name) : [...l, m.name];
    }
  }
  d.updated = today();
  return { data: d, moves, deletes };
}

// بصمة الحالة الحالية للملفات المتأثرة: إذا تغيّرت بين العرض والتأكيد، بنرفض
export function planKey(P) {
  return JSON.stringify({ op: P.op, c: P.changes.map(c => [c.id, c.before, c.after]), m: P.meta, u: P.undoOf || 0 });
}

/* ---------- بيانات JSON بنفس تنسيق Python (json.dumps, ensure_ascii=False) ---------- */
export function pyDumps(v) {
  if (v === null || v === undefined) return 'null';
  if (Array.isArray(v)) return '[' + v.map(pyDumps).join(', ') + ']';
  if (typeof v === 'object') return '{' + Object.keys(v).filter(k => v[k] !== undefined).map(k => JSON.stringify(k) + ': ' + pyDumps(v[k])).join(', ') + '}';
  return JSON.stringify(v);
}
export function replaceData(html, data) {
  const re = /const DATA=\{.*?\};[ \t]*\n/s;
  if (!re.test(html)) throw new Error('DATA not found');
  return html.replace(re, () => 'const DATA=' + pyDumps(data) + ';\n');
}
export function readData(html) {
  const m = html.match(/const DATA=(\{.*?\});\s*\n/s);
  if (!m) throw new Error('DATA not found');
  return JSON.parse(m[1]);
}
