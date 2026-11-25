// التخزين الخاص: المستودع الخاص على GitHub، والخادم بيقرأ منه بتوكن مخفي.
const base = env => (env.GITHUB_API_BASE || 'https://api.github.com').replace(/\/$/, '');
const branch = env => env.GITHUB_BRANCH || 'main';
const encPath = p => String(p).split('/').map(encodeURIComponent).join('/');
const headers = (env, accept) => ({
  Authorization: `Bearer ${env.GITHUB_TOKEN}`,
  'User-Agent': 'kayanat-archive',
  Accept: accept || 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
});
const url = (env, p) => `${base(env)}/repos/${env.REPO}/contents/${encPath(p)}?ref=${encodeURIComponent(branch(env))}`;

export function ghRaw(env, path) {
  return fetch(url(env, path), { headers: headers(env, 'application/vnd.github.raw') });
}

export async function ghText(env, path) {
  const r = await ghRaw(env, path);
  return r.ok ? r.text() : null;
}

export async function ghPutJson(env, path, obj, message) {
  const cur = await fetch(url(env, path), { headers: headers(env) });
  const sha = cur.ok ? (await cur.json()).sha : undefined;
  const bytes = new TextEncoder().encode(JSON.stringify(obj, null, 2) + '\n');
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  const put = await fetch(`${base(env)}/repos/${env.REPO}/contents/${encPath(path)}`, {
    method: 'PUT',
    headers: headers(env),
    body: JSON.stringify({ message, content: btoa(bin), sha, branch: branch(env) }),
  });
  return put.ok ? { ok: true } : { ok: false, error: (await put.text()).slice(0, 300) };
}

/* الأرشيف: بيانات الملفات محفوظة بـ index.html اللي بيولّده الإدخال التلقائي (ingest.py) */
let CACHE = { at: 0, data: null };
export async function getArchive(env, fresh) {
  if (!fresh && CACHE.data && Date.now() - CACHE.at < 15e3) return CACHE.data;
  const html = await ghText(env, 'index.html');
  if (!html) throw new Error('archive unavailable');
  const m = html.match(/const DATA=(\{.*?\});\s*\n/s);
  if (!m) throw new Error('archive data not found');
  const data = JSON.parse(m[1]);
  CACHE = { at: Date.now(), data };
  return data;
}

export async function getJsonFile(env, path, fallback) {
  const t = await ghText(env, path);
  if (!t) return fallback;
  try { return JSON.parse(t); } catch (e) { return fallback; }
}
