// كل طلب للموقع (الصفحة، الملفات، الـ API) بيمر من هون. بدون دخول صحيح: ولا إشي.
import { authenticate, checkLogin, sessionToken, sessionCookie, SESSION_TTL, authFile } from './_lib/auth.js';
import { hmac } from './_lib/util.js';

const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const LOGIN = (msg = '') => `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>أرشيف كيانات · تسجيل الدخول</title>
<style>*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:#16263b;font-family:"IBM Plex Sans Arabic",system-ui,sans-serif;color:#16263b;padding:20px}
.c{background:#faf8f3;border-radius:20px;padding:30px 24px;width:100%;max-width:360px;border-top:4px solid #c9a55c;box-shadow:0 20px 60px rgba(0,0,0,.3)}
h1{margin:0 0 4px;font-size:22px}p{margin:0 0 22px;color:#6b7280;font-size:14px}label{display:block;font-size:13px;font-weight:600;margin:14px 0 6px}
input{width:100%;padding:13px 14px;border:1.5px solid #e2ddd1;border-radius:12px;font:inherit;font-size:16px;background:#fff;direction:ltr;text-align:left}input:focus{outline:none;border-color:#c9a55c}
button{width:100%;margin-top:22px;padding:14px;border:0;border-radius:12px;background:#c9a55c;color:#16263b;font:inherit;font-size:16px;font-weight:700;cursor:pointer}
.e{background:#fbeaea;color:#8c2f26;border-radius:10px;padding:10px 12px;font-size:13.5px;margin-bottom:6px}</style></head>
<body><form class="c" method="post" action="/__login"><h1>🔒 أرشيف كيانات</h1><p>الأرشيف خاص. سجّل الدخول بحسابك.</p>${msg ? `<div class="e">${esc(msg)}</div>` : ''}
<label for="e">الإيميل</label><input id="e" name="email" type="email" autocomplete="username" required>
<label for="p">كلمة السر</label><input id="p" name="password" type="password" autocomplete="current-password" required>
<button>دخول</button></form></body></html>`;

function harden(res, isApi) {
  const r = new Response(res.body, res);
  r.headers.set('X-Content-Type-Options', 'nosniff');
  r.headers.set('X-Frame-Options', 'SAMEORIGIN');
  r.headers.set('Referrer-Policy', 'same-origin'); // no-referrer بيخلي المتصفح يبعت Origin: null مع الفورم
  r.headers.set('X-Robots-Tag', 'noindex, nofollow');
  r.headers.set('Strict-Transport-Security', 'max-age=31536000');
  r.headers.set('Permissions-Policy', 'camera=(), geolocation=(), microphone=(self)');
  if (!isApi) r.headers.set('Cache-Control', 'private, no-store');
  return r;
}
const html = (body, status, extra = {}) => new Response(body, { status, headers: { 'Content-Type': 'text/html; charset=utf-8', ...extra } });

/* حد لمحاولات الدخول الغلط: 8 محاولات لكل عنوان IP كل ربع ساعة (لكل نسخة خادم) */
const FAILS = new Map();
const blocked = ip => { const r = FAILS.get(ip); if (!r) return false; if (Date.now() - r.t > 15 * 60e3) { FAILS.delete(ip); return false; } return r.n >= 8; };
const failed = ip => { const r = FAILS.get(ip) || { n: 0, t: Date.now() }; r.n++; FAILS.set(ip, r); };

// الطلب جاي من نفس الموقع؟ (Origin، وإلا Sec-Fetch-Site للمتصفحات اللي بتبعت Origin: null)
function sameSite(request, url) {
  const o = request.headers.get('Origin');
  if (o && o !== 'null') return o === url.origin;
  return request.headers.get('Sec-Fetch-Site') === 'same-origin';
}

export async function onRequest(ctx) {
  const { request, env } = ctx;
  // مفتاح التوقيع: من SIGNING_KEY، وإلا بيتولّد ثابتاً من توكن GitHub السري
  if (!env.SIGNING_KEY && env.GITHUB_TOKEN) env.SIGNING_KEY = await hmac(env.GITHUB_TOKEN, 'kayanat-signing-v1');
  const url = new URL(request.url);
  const isApi = url.pathname.startsWith('/api/');

  if (url.pathname === '/__login' && request.method === 'POST') {
    if (!sameSite(request, url)) return harden(new Response('forbidden', { status: 403 }), false);
    const ip = request.headers.get('CF-Connecting-IP') || 'local';
    if (blocked(ip)) return harden(html(LOGIN('محاولات كثيرة. استنى ربع ساعة.'), 429), false);
    const f = await request.formData().catch(() => null);
    const email = f && (await checkLogin(f.get('email'), f.get('password'), env));
    if (!email || !env.SIGNING_KEY) { failed(ip); await new Promise(r => setTimeout(r, 600)); return harden(html(LOGIN('الإيميل أو كلمة السر غلط.'), 401), false); }
    FAILS.delete(ip);
    return harden(new Response(null, { status: 303, headers: { Location: '/', 'Set-Cookie': sessionCookie(await sessionToken(email, env), SESSION_TTL) } }), false);
  }
  // فحص صحة الإعدادات بدون أي بيانات: هل الخادم بيوصل للمستودع؟ هل مفتاح الذكاء موجود؟
  if (url.pathname === '/__health') {
    const a = await authFile(env).catch(() => null);
    return harden(new Response(JSON.stringify({ storage: !!(a && a.accounts && Object.keys(a.accounts).length), ai: !!env.GEMINI_API_KEY, signing: !!env.SIGNING_KEY }), { headers: { 'Content-Type': 'application/json' } }), true);
  }
  if (url.pathname === '/__logout') {
    return harden(new Response(null, { status: 303, headers: { Location: '/', 'Set-Cookie': sessionCookie('', 0) } }), false);
  }

  const user = await authenticate(request, env);
  if (!user) {
    return harden(isApi
      ? new Response(JSON.stringify({ error: 'login' }), { status: 401, headers: { 'Content-Type': 'application/json' } })
      : html(LOGIN(), 401), isApi);
  }
  // أي طلب يغيّر إشي لازم يجي من نفس الموقع (حماية CSRF)
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    if (!sameSite(request, url)) return harden(new Response('forbidden', { status: 403 }), isApi);
  }
  ctx.data.user = user;
  return harden(await ctx.next(), isApi);
}
