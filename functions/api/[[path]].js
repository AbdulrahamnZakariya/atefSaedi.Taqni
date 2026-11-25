// واجهة الخادم · أرشيف كيانات
// كل الطلبات هون وصلت بعد ما الـ middleware تأكد من تسجيل الدخول (ctx.data.user).
import { json, safeEqual, now } from '../_lib/util.js';
import { isUnlocked, privToken, privCookie, PRIV_TTL, signLink, checkLink } from '../_lib/auth.js';
import { getArchive, ghRaw, getJsonFile, ghPutJson } from '../_lib/github.js';
import { systemPrompt, toGeminiContents, fromGemini, callGemini } from '../_lib/gemini.js';

const JSON_FILES = { lists: 'data/lists.json', indexes: 'data/indexes.json', tasks: 'data/tasks.json' };
const EXTRA_FILES = ['فهرس-أرشيف-كيانات.xlsx']; // الفهرس العام (بدون الملف الخاص)

const MIME = {
  pdf: 'application/pdf', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif', heic: 'image/heic',
  mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', '3gp': 'video/3gpp',
  mp3: 'audio/mpeg', ogg: 'audio/ogg', opus: 'audio/ogg', m4a: 'audio/mp4', wav: 'audio/wav', aac: 'audio/aac',
  doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', csv: 'text/csv; charset=utf-8',
};
// أنواع ممكن تشغّل كود بالمتصفح: دايماً تنزيل، ما بتنفتح جوّا الموقع
const ALWAYS_DOWNLOAD = new Set(['html', 'htm', 'svg', 'xml', 'js', 'xhtml', 'mht', 'mhtml']);

/* حد بسيط لمحاولات كلمة السر الغلط (لكل نسخة خادم) */
const BAD = new Map();
const tooMany = k => { const r = BAD.get(k); if (!r) return false; if (Date.now() - r.t > 15 * 60e3) { BAD.delete(k); return false; } return r.n >= 6; };
const fail = k => { const r = BAD.get(k) || { n: 0, t: Date.now() }; r.n++; BAD.set(k, r); };

function visible(data, unlocked) {
  return unlocked ? data.files : data.files.filter(f => f.section !== 'priv');
}

async function readBody(request) {
  const raw = await request.text();
  if (raw.length > 200000) return null;
  try { return JSON.parse(raw) || {}; } catch (e) { return {}; }
}

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
      const data = await getArchive(env);
      const unlocked = await isUnlocked(request, env, user);
      return json({ updated: data.updated, projects: data.projects || [], investors: data.investors || [], files: visible(data, unlocked), unlocked });
    }

    /* فتح ملف: تحقق ← رابط موقّع ينتهي بعد 10 دقايق */
    if (route === 'f' && method === 'GET') {
      const path = parts.slice(1).join('/');
      const data = await getArchive(env);
      const f = data.files.find(x => x.path === path || x.pdf === path);
      if (!f && !EXTRA_FILES.includes(path)) return json({ error: 'not found' }, 404);
      if (f && f.section === 'priv' && !(await isUnlocked(request, env, user))) return json({ error: 'locked' }, 403);
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
      const body = await readBody(request);
      if (!body) return json({ error: 'too large' }, 413);
      const path = Object.hasOwn(JSON_FILES, body.file) ? JSON_FILES[body.file] : null;
      const c = body.content;
      if (!path || !c || typeof c !== 'object' || Array.isArray(c) || !Object.hasOwn(c, body.file) || typeof c[body.file] !== 'object' || c[body.file] === null)
        return json({ error: 'bad file' }, 400);
      const r = await ghPutJson(env, path, c, `مساعد الأرشيف: تحديث ${body.file} (${user.email})`);
      return json(r.ok ? { ok: true } : { error: r.error }, r.ok ? 200 : 502);
    }

    if (route === 'chat' && method === 'POST') {
      if (!env.GEMINI_API_KEY) return json({ error: 'ai not configured' }, 503);
      const body = await readBody(request);
      if (!body) return json({ error: 'too large' }, 413);
      const ctxIn = body.context || {};
      const unlocked = await isUnlocked(request, env, user); // من الخادم، مش من المتصفح
      const contents = toGeminiContents((Array.isArray(body.messages) ? body.messages : []).slice(-16));
      if (!contents.length) return json({ error: 'empty' }, 400);
      const model = env.GEMINI_MODEL_FAST || 'gemini-3.5-flash';
      const system = systemPrompt({ ...ctxIn, unlocked, email: user.email, today: new Date(now() * 1000).toISOString().slice(0, 10) });
      const r = await callGemini(env, { model, system, contents });
      if (!r.ok) return json({ error: (r.out && r.out.error && r.out.error.message) || 'ai error' }, 502);
      return json(fromGemini(r.out));
    }

    return json({ error: 'not found' }, 404);
  } catch (e) {
    return json({ error: 'server error' }, 500);
  }
}
