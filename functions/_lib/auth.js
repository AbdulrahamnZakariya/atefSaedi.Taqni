// تسجيل الدخول: Cloudflare Access (كود على الإيميل) + تحقق مستقل من التوقيع هون بالخادم.
// إذا Access انضبط غلط أو انشال، الخادم برضو بيرفض أي طلب بدون توكن صحيح لإيميل مسموح.
import { cookie, fromB64url, textFromB64url, te, now, hmac, safeEqual, b64urlText, b64url } from './util.js';
import { getJsonFile } from './github.js';

let CERTS = { at: 0, keys: [] };

async function accessKeys(env) {
  if (Date.now() - CERTS.at < 3600e3 && CERTS.keys.length) return CERTS.keys;
  const url = env.ACCESS_CERTS_URL || `https://${env.ACCESS_TEAM_DOMAIN}/cdn-cgi/access/certs`;
  const r = await fetch(url);
  if (!r.ok) return CERTS.keys;
  const j = await r.json();
  CERTS = { at: Date.now(), keys: j.keys || [] };
  return CERTS.keys;
}

export async function verifyAccessJwt(token, env) {
  try {
    const [h, p, s] = String(token).split('.');
    if (!h || !p || !s) return null;
    const header = JSON.parse(textFromB64url(h));
    if (header.alg !== 'RS256') return null;
    const jwk = (await accessKeys(env)).find(k => k.kid === header.kid);
    if (!jwk) return null;
    const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
    const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, fromB64url(s), te.encode(`${h}.${p}`));
    if (!ok) return null;
    const pl = JSON.parse(textFromB64url(p));
    const aud = Array.isArray(pl.aud) ? pl.aud : [pl.aud];
    if (!aud.includes(env.ACCESS_AUD)) return null;
    if (!pl.exp || pl.exp < now()) return null;
    if (pl.nbf && pl.nbf > now() + 60) return null;
    if (pl.iss && pl.iss !== `https://${env.ACCESS_TEAM_DOMAIN}`) return null;
    return pl;
  } catch (e) {
    return null;
  }
}

const list = v => String(v || '').toLowerCase().split(',').map(s => s.trim()).filter(Boolean);

export function roleOf(email, env) {
  if (email === String(env.OWNER_EMAIL || '').toLowerCase().trim()) return 'owner';
  if (list(env.ALLOWED_EMAILS).includes(email)) return 'admin';
  return 'viewer'; // زائر مسجّل للأسئلة فقط (VIEWER_EMAILS)
}

/* ---------- تسجيل دخول الموقع: إيميل + كلمة سر (بدون خدمات خارجية) ----------
   ACCOUNTS = "email1:password1,email2:password2" (سر بمتغيرات Cloudflare) */
// الحسابات: من المتغير ACCOUNTS (نص)، وإلا من data/auth.json بالمستودع (بصمات PBKDF2، مش كلمات سر)
let AUTH = { at: 0, data: null };
export async function authFile(env) {
  if (AUTH.data && Date.now() - AUTH.at < 60e3) return AUTH.data;
  const d = await getJsonFile(env, 'data/auth.json', null);
  if (d) AUTH = { at: Date.now(), data: d };
  return d || { accounts: {} };
}
export async function accounts(env) {
  const m = new Map();
  if (env.ACCOUNTS) {
    for (const part of String(env.ACCOUNTS).split(',')) {
      const i = part.indexOf(':');
      if (i > 0) m.set(part.slice(0, i).trim().toLowerCase(), { plain: part.slice(i + 1).trim() });
    }
    return m;
  }
  const a = (await authFile(env)).accounts || {};
  for (const [e, v] of Object.entries(a)) m.set(e.toLowerCase(), v);
  return m;
}
export async function pbkdf2(password, salt, iter) {
  const k = await crypto.subtle.importKey('raw', te.encode(String(password)), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: fromB64url(salt), iterations: Math.min(Number(iter) || 100000, 100000) }, k, 256);
  return b64url(new Uint8Array(bits));
}
// مقارنة كلمة سر مع حساب (نص أو بصمة)
export async function matches(password, rec) {
  if (!rec) { await safeEqual(String(password || ''), '\u0000'); return false; }
  if (rec.plain) return rec.plain.length >= 10 && (await safeEqual(String(password || ''), rec.plain));
  if (!rec.salt || !rec.hash) return false;
  return safeEqual(await pbkdf2(password || '', rec.salt, rec.iter), rec.hash);
}
export const SESSION_TTL = 14 * 24 * 3600;
export async function checkLogin(email, password, env) {
  const e = String(email || '').trim().toLowerCase();
  const rec = (await accounts(env)).get(e);
  const allowed = [...list(env.ALLOWED_EMAILS), ...list(env.VIEWER_EMAILS)];
  const ok = await matches(password, rec);
  return ok && allowed.includes(e) ? e : null;
}
// التوقيع مربوط بكلمة سر الحساب: تغيير كلمة السر بيلغي كل الجلسات القديمة فوراً
const pwFp = async (email, env) => { const r = (await accounts(env)).get(email) || {}; return hmac(env.SIGNING_KEY, 'pw|' + (r.plain || r.hash || '')); };
export async function sessionToken(email, env) {
  const body = `${b64urlText(email)}.${now() + SESSION_TTL}`;
  return `${body}.${await hmac(env.SIGNING_KEY, 'sess|' + body + '|' + (await pwFp(email, env)))}`;
}
async function sessionUser(request, env) {
  const t = cookie(request, 'ks');
  if (!t || !env.SIGNING_KEY) return null;
  const [e, exp, sig] = t.split('.');
  if (!e || !exp || !sig || Number(exp) < now()) return null;
  const email = textFromB64url(e);
  if (!(await accounts(env)).has(email)) return null; // حذف الحساب بيلغي جلسته فوراً
  if (!(await safeEqual(sig, await hmac(env.SIGNING_KEY, `sess|${e}.${exp}|${await pwFp(email, env)}`)))) return null;
  return email;
}
export const sessionCookie = (v, maxAge) => `ks=${encodeURIComponent(v)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;

export async function authenticate(request, env) {
  const allowed = [...list(env.ALLOWED_EMAILS), ...list(env.VIEWER_EMAILS)];
  if (!allowed.length) return null; // بدون قائمة إيميلات: ولا حدا بيدخل
  const host = new URL(request.url).hostname;
  // تجربة محلية فقط (wrangler على جهازك). على الإنترنت ما بيشتغل.
  if (env.DEV_AUTH_EMAIL && (host === 'localhost' || host === '127.0.0.1')) {
    const e = String(env.DEV_AUTH_EMAIL).toLowerCase().trim();
    return allowed.includes(e) ? { email: e, role: roleOf(e, env) } : null;
  }
  const se = await sessionUser(request, env);
  if (se) return allowed.includes(se) ? { email: se, role: roleOf(se, env) } : null;
  if (!env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD) return null;
  const token = request.headers.get('Cf-Access-Jwt-Assertion') || cookie(request, 'CF_Authorization');
  if (!token) return null;
  const pl = await verifyAccessJwt(token, env);
  if (!pl) return null;
  const email = String(pl.email || '').toLowerCase().trim();
  if (!allowed.includes(email)) return null;
  return { email, role: roleOf(email, env) };
}

/* ---------- قفل الملف الخاص (من الخادم) ---------- */
const PRIV_TTL = 2 * 3600;
export async function privToken(email, env) {
  const exp = now() + PRIV_TTL;
  const body = `${b64urlText(email)}.${exp}`;
  return `${body}.${await hmac(env.SIGNING_KEY, 'priv|' + body)}`;
}
export async function isUnlocked(request, env, user) {
  if (!env.SIGNING_KEY) return false;
  const t = cookie(request, 'kp');
  if (!t) return false;
  const [e, exp, sig] = t.split('.');
  if (!e || !exp || !sig || Number(exp) < now()) return false;
  if (textFromB64url(e) !== user.email) return false;
  return safeEqual(sig, await hmac(env.SIGNING_KEY, `priv|${e}.${exp}`));
}
export const privCookie = (v, maxAge) =>
  `kp=${encodeURIComponent(v)}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${maxAge}`;
export { PRIV_TTL };

/* ---------- روابط موقّعة للملفات (تنتهي بعد 10 دقايق) ---------- */
export const LINK_TTL = 600;
export async function signLink(path, email, env) {
  const e = now() + LINK_TTL;
  const s = await hmac(env.SIGNING_KEY, `blob|${path}|${e}|${email}`);
  return { e, s };
}
export async function checkLink(path, e, s, email, env) {
  if (!env.SIGNING_KEY || !e || !s || Number(e) < now()) return false;
  return safeEqual(s, await hmac(env.SIGNING_KEY, `blob|${path}|${e}|${email}`));
}
