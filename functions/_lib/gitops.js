// commit واحد لكل عملية (Git Data API): نقل الملفات + index.html + فهرس Excel + سجل العمليات، كلهم مع بعض.
const base = env => (env.GITHUB_API_BASE || 'https://api.github.com').replace(/\/$/, '');
const branch = env => env.GITHUB_BRANCH || 'main';
const H = env => ({ Authorization: `Bearer ${env.GITHUB_TOKEN}`, 'User-Agent': 'kayanat-archive', Accept: 'application/vnd.github+json', 'Content-Type': 'application/json', 'X-GitHub-Api-Version': '2022-11-28' });

export class StaleError extends Error {}

async function gh(env, method, path, body) {
  const r = await fetch(`${base(env)}/repos/${env.REPO}${path}`, { method, headers: H(env), body: body ? JSON.stringify(body) : undefined });
  const t = await r.text();
  let j = null; try { j = JSON.parse(t); } catch (e) {}
  if (!r.ok) { const e = new Error(`github ${method} ${path.split('?')[0]} ${r.status}: ${(j && j.message) || t.slice(0, 120)}`); e.status = r.status; throw e; }
  return j;
}

const b64 = bytes => { let s = ''; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000)); return btoa(s); };
const unb64 = s => { const bin = atob(String(s).replace(/\s/g, '')); const out = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i); return out; };

// لقطة من آخر commit: شجرة الملفات + أي ملفات نصية بدنا نقرأها
export async function snapshot(env, readPaths) {
  const ref = await gh(env, 'GET', `/git/ref/heads/${encodeURIComponent(branch(env))}`);
  const head = ref.object.sha;
  const commit = await gh(env, 'GET', `/git/commits/${head}`);
  const tree = await gh(env, 'GET', `/git/trees/${commit.tree.sha}?recursive=1`);
  if (tree.truncated) throw new Error('tree truncated');
  const entries = new Map(tree.tree.filter(e => e.type === 'blob').map(e => [e.path, e]));
  const texts = {};
  for (const p of readPaths || []) {
    const e = entries.get(p);
    if (!e) { texts[p] = null; continue; }
    const blob = await gh(env, 'GET', `/git/blobs/${e.sha}`);
    texts[p] = new TextDecoder().decode(unb64(blob.content));
  }
  return { head, tree: commit.tree.sha, entries, texts };
}

export async function commitChanges(env, snap, { message, moves = [], deletes = [], writes = [] }) {
  const final = new Map(); // path -> entry | null
  for (const m of moves) {
    const src = snap.entries.get(m.from);
    if (!src) throw new Error(`missing file: ${m.from}`);
    if (!final.has(m.from)) final.set(m.from, null);
    final.set(m.to, { path: m.to, mode: src.mode, type: 'blob', sha: src.sha });
  }
  for (const p of deletes) if (snap.entries.has(p) && !final.get(p)) final.set(p, null);
  for (const w of writes) {
    const bytes = typeof w.content === 'string' ? new TextEncoder().encode(w.content) : w.content;
    const blob = await gh(env, 'POST', '/git/blobs', { content: b64(bytes), encoding: 'base64' });
    final.set(w.path, { path: w.path, mode: '100644', type: 'blob', sha: blob.sha });
  }
  const tree = [];
  for (const [p, e] of final) {
    if (e) tree.push(e);
    else if (snap.entries.has(p)) tree.push({ path: p, mode: snap.entries.get(p).mode, type: 'blob', sha: null });
  }
  const t = await gh(env, 'POST', '/git/trees', { base_tree: snap.tree, tree });
  const c = await gh(env, 'POST', '/git/commits', { message, tree: t.sha, parents: [snap.head] });
  try {
    await gh(env, 'PATCH', `/git/refs/heads/${encodeURIComponent(branch(env))}`, { sha: c.sha, force: false });
  } catch (e) {
    if (e.status === 422 || e.status === 409) throw new StaleError('الأرشيف تحدّث بنفس اللحظة');
    throw e;
  }
  return c.sha;
}
