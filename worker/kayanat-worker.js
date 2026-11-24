/* وسيط مساعد أرشيف كيانات · Cloudflare Worker
   - /chat : يمرّر المحادثة لـ Claude مع أدوات الأرشيف (المفتاح مخفي هون، مش بالموقع)
   - /save : يحفظ القوائم/الفهارس/المهام بالمستودع (data/*.json) ← GitHub Action بيبعت تنبيه واتساب
   المتغيرات (Settings → Variables and Secrets):
     ANTHROPIC_API_KEY  مفتاح Claude
     GITHUB_TOKEN       Fine-grained token بصلاحية Contents: Read & Write على المستودع فقط
     PIN                رمز المزامنة (8 خانات أو أكثر) اللي بيكتبه أبو أنفال مرة وحدة
     REPO               AbdulrahamnZakariya/atefSaedi.Taqni
     ALLOWED_ORIGIN     https://abdulrahamnzakariya.github.io
*/
const MODEL = 'claude-sonnet-5-5';
const FILES = { lists: 'data/lists.json', indexes: 'data/indexes.json', tasks: 'data/tasks.json' };

const SYSTEM = (ctx) => `أنت «مساعد أرشيف كيانات»، مساعد الأستاذ عاطف الصاعدي (أبو أنفال) في شركة كيانات للتطوير العقاري بالمدينة المنورة.
مهمتك توصله لأي ملف بأقل خطوات، وتدير قوائمه وفهارسه ومهامه.
- احكِ بلهجة سعودية/بيضاء مختصرة ومهذبة. جملة أو جملتين بس، والملفات بتنعرض كبطاقات لحالها.
- لأي طلب ملف: استخدم search_files، وإذا في نتيجة وحدة واضحة استخدم open_file فوراً، وإذا أكثر استخدم show_files واسأله أيّهم.
- لا تخترع ملفات أو أرقام. إذا ما لقيت، قول بصراحة واقترح كلمة بحث ثانية.
- الإضافة لقائمة أو حذف من قائمة أو مهمة: نفّذ مباشرة بالأداة المناسبة. الحذف من قائمة ما بيحذف الملف من الأرشيف. ما في أداة لحذف ملفات، وما بتحذف ولا تنقل ملفات أبداً.
- الفهرس: make_index بكلمة (مشروع/قسم/جهة) أو بقائمة أرقام ملفات.
- القسم الخاص ${ctx.unlocked ? 'مفتوح بهالجلسة' : 'مقفول: لا تذكر محتواه ولا تلمّح لوجود ملفات فيه'}.
اليوم ${ctx.today}. المشاريع: ${(ctx.projects||[]).join('، ')}. المستثمرين: ${(ctx.investors||[]).join('، ') || 'لسا ما في'}. القوائم: ${(ctx.lists||[]).join('، ') || 'ما في'}.`;

const TOOLS = [
  { name: 'search_files', description: 'بحث في ملفات الأرشيف بكلمات عربية (اسم مشروع، نوع، جهة، رقم مثل f12). يرجع حتى 10 ملفات.', input_schema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } },
  { name: 'open_file', description: 'يفتح ملف بالمعاينة على شاشة أبو أنفال.', input_schema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
  { name: 'show_files', description: 'يعرض بطاقات ملفات ليختار منها.', input_schema: { type: 'object', properties: { ids: { type: 'array', items: { type: 'string' } }, caption: { type: 'string' } }, required: ['ids'] } },
  { name: 'list_lists', description: 'أسماء القوائم وعدد ملفات كل وحدة.', input_schema: { type: 'object', properties: {} } },
  { name: 'get_list', description: 'محتوى قائمة.', input_schema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] } },
  { name: 'add_to_list', description: 'يضيف ملف لقائمة (وبينشئها إذا مش موجودة).', input_schema: { type: 'object', properties: { id: { type: 'string' }, list: { type: 'string' } }, required: ['id', 'list'] } },
  { name: 'remove_from_list', description: 'يشيل ملف من قائمة (بدون حذف الملف).', input_schema: { type: 'object', properties: { id: { type: 'string' }, list: { type: 'string' } }, required: ['id', 'list'] } },
  { name: 'make_index', description: 'يعمل فهرس جدول قابل للطباعة PDF والتنزيل Excel.', input_schema: { type: 'object', properties: { query: { type: 'string' }, ids: { type: 'array', items: { type: 'string' } }, title: { type: 'string' } } } },
  { name: 'whats_new', description: 'آخر الملفات اللي وصلت وعدد المهام المفتوحة.', input_schema: { type: 'object', properties: {} } },
  { name: 'list_tasks', description: 'كل المهام.', input_schema: { type: 'object', properties: {} } },
  { name: 'add_task', description: 'يسجل مهمة جديدة.', input_schema: { type: 'object', properties: { title: { type: 'string' } }, required: ['title'] } },
  { name: 'complete_task', description: 'يعلّم مهمة منجزة برقمها (t1…).', input_schema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] } },
];

// حماية الرمز: مقارنة بزمن ثابت + حد للمحاولات الفاشلة (لكل نسخة Worker؛ للحماية الأقوى فعّل Rate Limiting من Cloudflare)
const BAD = new Map();
function fails(ip) { const r = BAD.get(ip) || { n: 0, t: Date.now() }; r.n++; BAD.set(ip, r); }
function tooMany(ip) { const r = BAD.get(ip); if (!r) return false; if (Date.now() - r.t > 15 * 60e3) { BAD.delete(ip); return false; } return r.n >= 8; }
async function same(a, b) { const h = async s => new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(s))));
  const x = await h(a), y = await h(b); let d = 0; for (let i = 0; i < x.length; i++) d |= x[i] ^ y[i]; return d === 0; }
const b64 = s => btoa(String.fromCharCode(...new TextEncoder().encode(s)));
function cors(env) { return { 'Access-Control-Allow-Origin': env.ALLOWED_ORIGIN || 'null', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, X-Kayanat-Pin', 'Vary': 'Origin' }; }
const json = (env, body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', ...cors(env) } });

export default {
  async fetch(req, env) {
    if (!env.ALLOWED_ORIGIN || req.headers.get('Origin') !== env.ALLOWED_ORIGIN) return new Response('forbidden', { status: 403 });
    if (req.method === 'OPTIONS') return new Response(null, { headers: cors(env) });
    if (req.method !== 'POST') return json(env, { ok: true, name: 'kayanat-worker' });
    const ip = req.headers.get('CF-Connecting-IP') || 'x';
    if (tooMany(ip)) return json(env, { error: 'slow down' }, 429);
    if (!env.PIN || String(env.PIN).length < 8 || !(await same(req.headers.get('X-Kayanat-Pin') || '', env.PIN))) { fails(ip); return json(env, { error: 'pin' }, 401); }
    const raw = await req.text(); if (raw.length > 200000) return json(env, { error: 'too large' }, 413);
    const url = new URL(req.url); let body = {}; try { body = JSON.parse(raw) || {}; } catch (e) {}

    if (url.pathname.endsWith('/chat')) {
      const r = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST',
        headers: { 'x-api-key': env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
        body: JSON.stringify({ model: MODEL, max_tokens: 1024, system: SYSTEM(body.context || {}), tools: TOOLS, messages: (Array.isArray(body.messages) ? body.messages : []).slice(-16) }) });
      const out = await r.json();
      return json(env, r.ok ? { content: out.content, stop_reason: out.stop_reason } : { error: out }, r.ok ? 200 : 502);
    }

    if (url.pathname.endsWith('/save')) {
      const path = Object.hasOwn(FILES, body.file) ? FILES[body.file] : null;
      const c = body.content;
      if (!path || !c || typeof c !== 'object' || Array.isArray(c) || !Object.hasOwn(c, body.file) || typeof c[body.file] !== 'object' || c[body.file] === null) return json(env, { error: 'bad file' }, 400);
      const api = `https://api.github.com/repos/${env.REPO}/contents/${path}`;
      const gh = { Authorization: `Bearer ${env.GITHUB_TOKEN}`, 'User-Agent': 'kayanat-worker', Accept: 'application/vnd.github+json' };
      const cur = await fetch(api, { headers: gh }); const sha = cur.ok ? (await cur.json()).sha : undefined;
      const put = await fetch(api, { method: 'PUT', headers: gh, body: JSON.stringify({ message: `مساعد الأرشيف: تحديث ${body.file}`, content: b64(JSON.stringify(body.content, null, 2) + '\n'), sha }) });
      return json(env, put.ok ? { ok: true } : { error: await put.text() }, put.ok ? 200 : 502);
    }
    return json(env, { error: 'not found' }, 404);
  },
};
