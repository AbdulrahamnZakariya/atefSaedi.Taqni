// واجهة الخادم · أرشيف كيانات
// كل الطلبات هون وصلت بعد ما الـ middleware تأكد من تسجيل الدخول (ctx.data.user).
import { json, safeEqual, now, hmac } from '../_lib/util.js';
import { isUnlocked, privToken, privCookie, PRIV_TTL, signLink, checkLink } from '../_lib/auth.js';
import { getArchive, ghRaw, getJsonFile, ghPutJson } from '../_lib/github.js';
import { systemPrompt, toGeminiContents, fromGemini, callGemini, TOOLS, READ_TOOLS } from '../_lib/gemini.js';
import { planOp, applyPlan, planKey, replaceData, readData, PlanError, TRASH_DAYS, SEC_NAME } from '../_lib/archive.js';
import { buildIndexXlsx } from '../_lib/xlsx.js';
import { snapshot, commitChanges, StaleError } from '../_lib/gitops.js';

const JSON_FILES = { lists: 'data/lists.json', indexes: 'data/indexes.json', tasks: 'data/tasks.json' };
const LOG_PATH = 'data/agent-log.json';
const XLSX_PATH = 'فهرس-أرشيف-كيانات.xlsx';
const EXTRA_FILES = [XLSX_PATH]; // الفهرس العام (بدون الملف الخاص)
const PLAN_TTL = 15 * 60;

const MIME = {
  pdf: 'application/pdf', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif', heic: 'image/heic',
  mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', '3gp': 'video/3gpp',
  mp3: 'audio/mpeg', ogg: 'audio/ogg', opus: 'audio/ogg', m4a: 'audio/mp4', wav: 'audio/wav', aac: 'audio/aac',
  doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', csv: 'text/csv; charset=utf-8',
};
// أنواع ممكن تشغّل كود بالمتصفح: دايماً تنزيل، ما بتنفتح جوّا الموقع
const ALWAYS_DOWNLOAD = new Set(['html', 'htm', 'svg', 'xml', 'js', 'xhtml', 'mht', 'mhtml']);
// كلمات العمليات: بتروح لموديل Pro، والباقي لـ Flash
const OP_WORDS = /(انقل|نقل|حول|سم[يّ]|سمي|غير اسم|غيّر اسم|اسم جديد|رتب|رتّب|ترتيب|احذف|امسح|شيل الملف|سله|سلة|رجع|رجّع|استرجع|تراجع|انشئ|أنشئ|انشي|سوي قسم|قسم جديد|مشروع جديد|عدل|عدّل|وسم|اكد|أكد|تاكيد|تأكيد|يحتاج تاكيد)/;

/* حد بسيط لمحاولات كلمة السر الغلط (لكل نسخة خادم) */
const BAD = new Map();
const tooMany = k => { const r = BAD.get(k); if (!r) return false; if (Date.now() - r.t > 15 * 60e3) { BAD.delete(k); return false; } return r.n >= 6; };
const fail = k => { const r = BAD.get(k) || { n: 0, t: Date.now() }; r.n++; BAD.set(k, r); };

const isPrivFile = f => f.section === 'priv' || (f.trash && f.trash.fromSection === 'priv');

async function readBody(request) {
  const raw = await request.text();
  if (raw.length > 200000) return null;
  try { return JSON.parse(raw) || {}; } catch (e) { return {}; }
}
const sha256 = async s => [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)))].map(b => b.toString(16).padStart(2, '0')).join('');
const norm = s => String(s || '').toLowerCase().replace(/[أإآا]/g, 'ا').replace(/ة/g, 'ه').replace(/ى/g, 'ي').replace(/[ًٌٍَُِّْـ]/g, '');

export async function onRequest(ctx) {
  const { request, env, params } = ctx;
  const user = ctx.data.user;
  const dec = p => { try { return decodeURIComponent(p); } catch (e) { return p; } };
  const parts = (Array.isArray(params.path) ? params.path : [params.path].filter(Boolean)).map(dec);
  const route = parts[0] || '';
  const method = request.method;

  try {
    if (route === 'me' && method === 'GET') return json({ email: user.email, role: user.role });

    if (route === 'data' && method === 'GET') {
      const data = await getArchive(env, new URL(request.url).searchParams.has('fresh'));
      const unlocked = await isUnlocked(request, env, user);
      const vis = data.files.filter(f => unlocked || !isPrivFile(f));
      const t = now();
      return json({
        updated: data.updated, projects: data.projects || [], investors: data.investors || [], subs: data.subs || {},
        files: vis.filter(f => !f.trash),
        trash: vis.filter(f => f.trash).map(f => ({ ...f, daysLeft: Math.max(0, TRASH_DAYS - Math.floor((t - Date.parse(f.trash.at) / 1000) / 86400)) })),
        unlocked, role: user.role, email: user.email,
      });
    }

    /* بحث بالمحتوى (نص الملفات المستخرج) */
    if (route === 'search' && method === 'GET') {
      const q = new URL(request.url).searchParams.get('q') || '';
      const words = norm(q).split(/\s+/).filter(w => w.length > 1).slice(0, 8);
      if (!words.length) return json({ ids: [] });
      const [data, idx, unlocked] = await Promise.all([getArchive(env), getJsonFile(env, 'data/content-index.json', { files: {} }), isUnlocked(request, env, user)]);
      const ok = new Set(data.files.filter(f => !f.trash && (unlocked || !isPrivFile(f))).map(f => f.id));
      const hits = Object.entries(idx.files || {}).filter(([id, txt]) => ok.has(id) && words.every(w => norm(txt).includes(w)))
        .map(([id, txt]) => { const n = norm(txt), i = n.indexOf(words[0]); return { id, snippet: txt.slice(Math.max(0, i - 40), i + 80) }; });
      return json({ ids: hits.slice(0, 15).map(h => h.id), hits: hits.slice(0, 15) });
    }

    /* فتح ملف: تحقق ← رابط موقّع ينتهي بعد 10 دقايق */
    if (route === 'f' && method === 'GET') {
      const path = parts.slice(1).join('/');
      const data = await getArchive(env);
      const f = data.files.find(x => x.path === path || x.pdf === path);
      if (!f && !EXTRA_FILES.includes(path)) return json({ error: 'not found' }, 404);
      if (f && isPrivFile(f) && !(await isUnlocked(request, env, user))) return json({ error: 'locked' }, 403);
      if (!env.SIGNING_KEY) return json({ error: 'server not configured' }, 500);
      const { e, s } = await signLink(path, user.email, env);
      const dl = new URL(request.url).searchParams.get('dl') ? '&dl=1' : '';
      const loc = `/api/blob/${path.split('/').map(encodeURIComponent).join('/')}?e=${e}&s=${s}${dl}`;
      return new Response(null, { status: 302, headers: { Location: loc, 'Cache-Control': 'no-store' } });
    }

    if (route === 'blob' && method === 'GET') {
      const path = parts.slice(1).join('/');
      const q = new URL(request.url).searchParams;
      if (!(await checkLink(path, q.get('e'), q.get('s'), user.email, env))) return json({ error: 'link expired' }, 403);
      const r = await ghRaw(env, path);
      if (!r.ok) return json({ error: 'not found' }, 404);
      const ext = (path.split('.').pop() || '').toLowerCase();
      const name = path.split('/').pop();
      const attach = q.get('dl') || ALWAYS_DOWNLOAD.has(ext) || !MIME[ext];
      return new Response(r.body, {
        headers: {
          'Content-Type': ALWAYS_DOWNLOAD.has(ext) ? 'application/octet-stream' : (MIME[ext] || 'application/octet-stream'),
          'Content-Disposition': `${attach ? 'attachment' : 'inline'}; filename*=UTF-8''${encodeURIComponent(name)}`,
          'Cache-Control': 'private, no-store',
        },
      });
    }

    if (route === 'unlock' && method === 'POST') {
      const k = user.email + '|' + (request.headers.get('CF-Connecting-IP') || '');
      if (tooMany(k)) return json({ error: 'slow down' }, 429);
      const body = await readBody(request);
      if (!env.PRIV_PASSWORD || !env.SIGNING_KEY) return json({ error: 'server not configured' }, 500);
      if (!body || !(await safeEqual(String(body.password || ''), env.PRIV_PASSWORD))) { fail(k); return json({ error: 'wrong' }, 401); }
      BAD.delete(k);
      return json({ ok: true }, 200, { 'Set-Cookie': privCookie(await privToken(user.email, env), PRIV_TTL) });
    }
    if (route === 'lock' && method === 'POST') return json({ ok: true }, 200, { 'Set-Cookie': privCookie('', 0) });

    if (route === 'json' && method === 'GET') {
      const name = parts[1];
      if (name === 'config') return json({ workerUrl: 'api', session: true, user: user.email, role: user.role });
      if (!Object.hasOwn(JSON_FILES, name)) return json({ error: 'not found' }, 404);
      return json(await getJsonFile(env, JSON_FILES[name], {}));
    }

    if (route === 'save' && method === 'POST') {
      if (user.role === 'viewer') return json({ error: 'read only' }, 403);
      const body = await readBody(request);
      if (!body) return json({ error: 'too large' }, 413);
      const path = Object.hasOwn(JSON_FILES, body.file) ? JSON_FILES[body.file] : null;
      const c = body.content;
      if (!path || !c || typeof c !== 'object' || Array.isArray(c) || !Object.hasOwn(c, body.file) || typeof c[body.file] !== 'object' || c[body.file] === null)
        return json({ error: 'bad file' }, 400);
      const r = await ghPutJson(env, path, c, `مساعد الأرشيف: تحديث ${body.file} (${user.email})`);
      return json(r.ok ? { ok: true } : { error: r.error }, r.ok ? 200 : 502);
    }

    /* ---------- الوكيل: خطة ← تأكيد ← تنفيذ ---------- */
    if (route === 'plan' && method === 'POST') {
      if (user.role === 'viewer') return json({ error: 'صلاحيتك للأسئلة فقط' }, 403);
      const body = await readBody(request);
      if (!body || typeof body.op !== 'string') return json({ error: 'bad request' }, 400);
      const unlocked = await isUnlocked(request, env, user);
      const snap = await snapshot(env, ['index.html', LOG_PATH]);
      const data = readData(snap.texts['index.html']);
      const log = snap.texts[LOG_PATH] ? JSON.parse(snap.texts[LOG_PATH]) : { ops: [] };
      const at = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
      let P;
      try { P = planOp(data, log, body.op, body.args || {}, { role: user.role, email: user.email, unlocked, now: at }); }
      catch (e) { if (e instanceof PlanError) return json({ error: e.message }, 422); throw e; }
      const exp = now() + PLAN_TTL;
      const token = await hmac(env.SIGNING_KEY, `plan|${user.email}|${exp}|${await sha256(planKey(P))}`);
      return json({ plan: { op: P.op, args: P.args, at, exp, title: P.title, rows: P.rows, warnings: P.warnings, order: P.order || null, meta: P.meta || null, second: P.op === 'purge' }, token });
    }

    if (route === 'execute' && method === 'POST') {
      if (user.role === 'viewer') return json({ error: 'صلاحيتك للأسئلة فقط' }, 403);
      const body = await readBody(request);
      const pl = body && body.plan;
      if (!pl || typeof pl.op !== 'string' || !body.token) return json({ error: 'bad request' }, 400);
      if (!(Number(pl.exp) > now())) return json({ error: 'الخطة انتهت، اطلبها من جديد' }, 410);
      if (pl.op === 'purge' && body.second !== true) return json({ error: 'الحذف النهائي بدّه تأكيد ثاني' }, 400);
      const unlocked = await isUnlocked(request, env, user);
      for (let attempt = 0; attempt < 2; attempt++) {
        const snap = await snapshot(env, ['index.html', LOG_PATH]);
        const html = snap.texts['index.html'];
        const data = readData(html);
        const log = snap.texts[LOG_PATH] ? JSON.parse(snap.texts[LOG_PATH]) : { ops: [] };
        let P;
        try { P = planOp(data, log, pl.op, pl.args || {}, { role: user.role, email: user.email, unlocked, now: pl.at }); }
        catch (e) { if (e instanceof PlanError) return json({ error: 'الأرشيف تغيّر: ' + e.message }, 409); throw e; }
        const want = await hmac(env.SIGNING_KEY, `plan|${user.email}|${pl.exp}|${await sha256(planKey(P))}`);
        if (!(await safeEqual(want, body.token))) return json({ error: 'الأرشيف تغيّر من وقت ما انعرضت الخطة. اطلبها من جديد.' }, 409);
        const { data: nd, moves, deletes } = applyPlan(data, P);
        const n = (log.ops.reduce((m, o) => Math.max(m, o.n || 0), 0)) + 1;
        const entry = { n, at: new Date().toISOString().replace(/\.\d+Z$/, 'Z'), by: user.email, op: P.op, title: P.title, args: P.args, changes: P.changes, meta: P.meta || null, undone: false };
        if (P.undoOf) { entry.undoOf = P.undoOf; const o = log.ops.find(x => x.n === P.undoOf); if (o) o.undone = true; }
        log.ops.push(entry);
        const writes = [
          { path: 'index.html', content: replaceData(html, nd) },
          { path: XLSX_PATH, content: buildIndexXlsx(nd) },
          { path: LOG_PATH, content: JSON.stringify(log, null, 1) + '\n' },
        ];
        try {
          const sha = await commitChanges(env, snap, { message: `الوكيل: ${P.title}\n\nنفّذها: ${user.email}\nرقم العملية: ${n}`, moves, deletes, writes });
          return json({ ok: true, n, commit: sha, title: P.title, count: P.changes.length });
        } catch (e) {
          if (e instanceof StaleError && attempt === 0) continue;
          if (e instanceof StaleError) return json({ error: e.message + '، جرّب كمان مرة' }, 409);
          throw e;
        }
      }
    }

    /* سجل العمليات: مين، شو، إمتى */
    if (route === 'audit' && method === 'GET') {
      const [log, unlocked] = await Promise.all([getJsonFile(env, LOG_PATH, { ops: [] }), isUnlocked(request, env, user)]);
      const hide = c => !unlocked && [c.before, c.after].some(x => x && isPrivFile(x));
      return json({ ops: (log.ops || []).slice().reverse().slice(0, 300).map(o => ({
        n: o.n, at: o.at, by: o.by, op: o.op, title: (o.changes || []).some(hide) && (o.changes || []).length === 1 ? 'عملية على ملف خاص' : o.title,
        undone: !!o.undone, undoOf: o.undoOf || null,
        files: (o.changes || []).map(c => hide(c) ? { id: c.id, title: 'ملف خاص' } : { id: c.id, title: (c.after || c.before).title }),
      })) });
    }

    if (route === 'chat' && method === 'POST') {
      if (!env.GEMINI_API_KEY) return json({ error: 'ai not configured' }, 503);
      const body = await readBody(request);
      if (!body) return json({ error: 'too large' }, 413);
      const ctxIn = body.context || {};
      const unlocked = await isUnlocked(request, env, user); // من الخادم، مش من المتصفح
      const msgs = (Array.isArray(body.messages) ? body.messages : []).slice(-20);
      const contents = toGeminiContents(msgs);
      if (!contents.length) return json({ error: 'empty' }, 400);
      const lastUser = [...msgs].reverse().find(m => m.role === 'user' && typeof m.content === 'string');
      const heavy = lastUser && OP_WORDS.test(norm(lastUser.content));
      const fast = env.GEMINI_MODEL_FAST || 'gemini-3.5-flash';
      const pro = env.GEMINI_MODEL_PRO || 'gemini-3.1-pro-preview';
      const system = systemPrompt({ ...ctxIn, unlocked, email: user.email, role: user.role, today: new Date(now() * 1000).toISOString().slice(0, 10) });
      const tools = user.role === 'viewer' ? READ_TOOLS.filter(t => !['add_to_list', 'remove_from_list', 'add_task', 'complete_task'].includes(t.name)) : TOOLS;
      let r = await callGemini(env, { model: heavy ? pro : fast, system, contents, tools });
      if (!r.ok && heavy && (r.status === 404 || r.status === 400 || r.status === 429)) r = await callGemini(env, { model: fast, system, contents, tools });
      if (!r.ok) return json({ error: (r.out && r.out.error && r.out.error.message) || 'ai error' }, 502);
      const out = fromGemini(r.out);
      if (user.role === 'viewer') out.content = out.content.filter(c => c.type !== 'tool_use' || tools.some(t => t.name === c.name));
      return json({ ...out, model: heavy ? 'pro' : 'fast' });
    }

    return json({ error: 'not found' }, 404);
  } catch (e) {
    return json({ error: 'server error', detail: env.DEBUG ? String(e && e.stack || e) : undefined }, 500);
  }
}
