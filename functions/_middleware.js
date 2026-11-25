// كل طلب للموقع (الصفحة، الملفات، الـ API) بيمر من هون. بدون دخول صحيح: ولا إشي.
import { authenticate } from './_lib/auth.js';

const DENY = `<!doctype html><html lang="ar" dir="rtl"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>أرشيف كيانات</title>
<body style="font-family:system-ui;background:#16263b;color:#fff;display:grid;place-items:center;min-height:100vh;margin:0;text-align:center">
<div><h2>🔒 أرشيف كيانات</h2><p>هذا الأرشيف خاص. سجّل الدخول بالإيميل المصرّح له.</p></div></body></html>`;

function harden(res, isApi) {
  const r = new Response(res.body, res);
  r.headers.set('X-Content-Type-Options', 'nosniff');
  r.headers.set('X-Frame-Options', 'SAMEORIGIN');
  r.headers.set('Referrer-Policy', 'no-referrer');
  r.headers.set('X-Robots-Tag', 'noindex, nofollow');
  r.headers.set('Permissions-Policy', 'camera=(), geolocation=(), microphone=(self)');
  if (!isApi) r.headers.set('Cache-Control', 'private, no-store');
  return r;
}

export async function onRequest(ctx) {
  const { request, env } = ctx;
  const url = new URL(request.url);
  const isApi = url.pathname.startsWith('/api/');
  const user = await authenticate(request, env);
  if (!user) {
    return harden(
      isApi
        ? new Response(JSON.stringify({ error: 'login' }), { status: 401, headers: { 'Content-Type': 'application/json' } })
        : new Response(DENY, { status: 401, headers: { 'Content-Type': 'text/html; charset=utf-8' } }),
      isApi,
    );
  }
  // أي طلب يغيّر إشي لازم يجي من نفس الموقع (حماية CSRF)
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    const origin = request.headers.get('Origin');
    if (!origin || origin !== url.origin) return harden(new Response('forbidden', { status: 403 }), isApi);
  }
  ctx.data.user = user;
  return harden(await ctx.next(), isApi);
}
