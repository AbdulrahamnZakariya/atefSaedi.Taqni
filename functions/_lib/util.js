// أدوات مشتركة للخادم · أرشيف كيانات
export const te = new TextEncoder();

export function b64url(bytes) {
  let s = '';
  const a = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  for (let i = 0; i < a.length; i++) s += String.fromCharCode(a[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
export function fromB64url(s) {
  s = String(s).replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
export const b64urlText = s => b64url(te.encode(s));
export const textFromB64url = s => new TextDecoder().decode(fromB64url(s));

async function hmacKey(secret) {
  return crypto.subtle.importKey('raw', te.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
}
export async function hmac(secret, msg) {
  const k = await hmacKey(secret);
  return b64url(await crypto.subtle.sign('HMAC', k, te.encode(msg)));
}
// مقارنة بزمن ثابت
export async function safeEqual(a, b) {
  const h = async s => new Uint8Array(await crypto.subtle.digest('SHA-256', te.encode(String(s))));
  const x = await h(a), y = await h(b);
  let d = 0;
  for (let i = 0; i < x.length; i++) d |= x[i] ^ y[i];
  return d === 0 && String(a).length === String(b).length;
}

export function cookie(req, name) {
  const c = req.headers.get('Cookie') || '';
  for (const part of c.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

export const json = (body, status = 200, extra = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...extra },
  });

export const now = () => Math.floor(Date.now() / 1000);
