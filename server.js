require('dotenv').config();
const express = require('express');
const helmet = require('helmet');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'Joan5078';
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const SESSION_SECRET =
  process.env.SESSION_SECRET || process.env.ADMIN_PASSWORD || 'Joan5078-session-secret';
const MAX_BODY_BYTES = 8 * 1024 * 1024;
const ALLOWED_EXTS = new Set(['.html', '.htm', '.css', '.js', '.json', '.txt', '.svg', '.xml']);

// On Vercel, set these so admin can save trade fields (filesystem is read-only)
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '';
const GITHUB_REPO = process.env.GITHUB_REPO || 'ecocashloans/DERIV-APP';
const GITHUB_BRANCH = process.env.GITHUB_BRANCH || 'main';
const GITHUB_TRADE_PATH = process.env.GITHUB_TRADE_PATH || 'public/trade-config.json';
// Folder inside the repo where the public pages live (index1.html … index20.html).
const GITHUB_PUBLIC_PATH = process.env.GITHUB_PUBLIC_PATH || 'public';

const PUBLIC_DIR = path.join(__dirname, 'public');
const ADMIN_DIR = path.join(__dirname, 'admin');
const TRADE_CONFIG_FILE = path.join(PUBLIC_DIR, 'trade-config.json');
const IS_VERCEL = Boolean(process.env.VERCEL || process.env.NOW_REGION);

// Only these files may be read/written via /admin/api/content and /admin/api/batch
const TRADE_TARGET_FILES = new Set(
  Array.from({ length: 20 }, (_, i) => `index${i + 1}.html`)
);

const DEFAULT_TRADE = {
  paymentMethod: 'joelhadson@gmail.com',
  tradeId: 'TR-810136',
  amount: '19,000 USD',
  status: 'waiting',
};

// Survives within a warm serverless instance; cold starts fall back to file/GitHub
let tradeCache = null;
let tradeCacheSavedAt = null;

// Best-effort rate limit (per instance only on Vercel)
const loginAttempts = new Map();

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: '8mb' }));

// ---------------------------------------------------------------- helpers

function normalizeTradeStatus(status) {
  const value = String(status || '').toLowerCase().trim();
  if (value === 'complete' || value === 'transfer complete' || value === 'completed') {
    return 'complete';
  }
  return 'waiting';
}

function sanitizeTrade(raw = {}) {
  return {
    paymentMethod: String(raw.paymentMethod || DEFAULT_TRADE.paymentMethod).trim().slice(0, 200) || DEFAULT_TRADE.paymentMethod,
    tradeId: String(raw.tradeId || DEFAULT_TRADE.tradeId).trim().slice(0, 120) || DEFAULT_TRADE.tradeId,
    amount: String(raw.amount || DEFAULT_TRADE.amount).trim().slice(0, 80) || DEFAULT_TRADE.amount,
    status: normalizeTradeStatus(raw.status),
  };
}

function parseCookies(req) {
  const header = req.headers.cookie || '';
  const out = {};
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

/** Stateless signed session: base64url(exp).hmac */
function signSession() {
  const exp = String(Date.now() + SESSION_TTL_MS);
  const sig = crypto.createHmac('sha256', SESSION_SECRET).update(exp).digest('base64url');
  return `${exp}.${sig}`;
}

function verifySession(token) {
  if (!token || typeof token !== 'string') return false;
  const i = token.lastIndexOf('.');
  if (i <= 0) return false;
  const exp = token.slice(0, i);
  const sig = token.slice(i + 1);
  const expected = crypto.createHmac('sha256', SESSION_SECRET).update(exp).digest('base64url');
  try {
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;
  } catch {
    return false;
  }
  const expMs = Number(exp);
  if (!Number.isFinite(expMs) || expMs < Date.now()) return false;
  return true;
}

function isAuthenticated(req) {
  return verifySession(parseCookies(req).admin_session);
}

function sameOrigin(req) {
  const origin = req.get('origin');
  if (!origin) return false;
  try {
    const u = new URL(origin);
    return u.host === req.get('host') && (u.protocol === 'http:' || u.protocol === 'https:');
  } catch {
    return false;
  }
}

function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

function requireAuth(req, res, next) {
  if (!isAuthenticated(req)) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

function cookieFlags(req) {
  const host = req.get('host') || '';
  const xfProto = (req.get('x-forwarded-proto') || '').split(',')[0].trim();
  const secure =
    process.env.FORCE_SECURE_COOKIE === '1' ||
    process.env.NODE_ENV === 'production' ||
    IS_VERCEL ||
    xfProto === 'https' ||
    host.includes('vercel.app');
  return `HttpOnly; SameSite=Lax; Path=/${secure ? '; Secure' : ''}`;
}

function setSessionCookie(req, res, token) {
  res.setHeader(
    'Set-Cookie',
    `admin_session=${encodeURIComponent(token)}; ${cookieFlags(req)}; Max-Age=${SESSION_TTL_MS / 1000}`
  );
}

function clearSessionCookie(req, res) {
  res.setHeader('Set-Cookie', `admin_session=; ${cookieFlags(req)}; Max-Age=0`);
}

function checkRateLimit(ip) {
  const rec = loginAttempts.get(ip);
  if (rec && rec.lockedUntil && rec.lockedUntil > Date.now()) {
    return { locked: true, retryAfter: Math.ceil((rec.lockedUntil - Date.now()) / 1000) };
  }
  return { locked: false };
}

function recordFailure(ip) {
  const now = Date.now();
  const rec = loginAttempts.get(ip) || { failures: 0, lockedUntil: 0 };
  rec.failures += 1;
  if (rec.failures >= 10) {
    rec.lockedUntil = now + 15 * 60 * 1000;
    rec.failures = 0;
  }
  loginAttempts.set(ip, rec);
}

function recordSuccess(ip) {
  loginAttempts.delete(ip);
}

// ---------------------------------------------------------------- trade config (disk + GitHub)

function readTradeFromDisk() {
  try {
    if (fs.existsSync(TRADE_CONFIG_FILE)) {
      return sanitizeTrade(JSON.parse(fs.readFileSync(TRADE_CONFIG_FILE, 'utf8')));
    }
  } catch (err) {
    console.error('disk read trade-config:', err.message);
  }
  return null;
}

async function readTradeFromGitHub() {
  if (!GITHUB_TOKEN) return null;
  try {
    const url = `https://api.github.com/repos/${GITHUB_REPO}/contents/${GITHUB_TRADE_PATH}?ref=${encodeURIComponent(GITHUB_BRANCH)}`;
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${GITHUB_TOKEN}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'deriv-app-admin',
      },
    });
    if (!res.ok) {
      console.error('GitHub read failed:', res.status, await res.text());
      return null;
    }
    const data = await res.json();
    const text = Buffer.from(data.content.replace(/\n/g, ''), 'base64').toString('utf8');
    return { trade: sanitizeTrade(JSON.parse(text)), sha: data.sha };
  } catch (err) {
    console.error('GitHub read error:', err.message);
    return null;
  }
}

async function writeTradeToGitHub(trade) {
  if (!GITHUB_TOKEN) {
    const err = new Error(
      'Filesystem is read-only (Vercel). Set GITHUB_TOKEN env var so admin can save trade settings.'
    );
    err.code = 'NO_GITHUB_TOKEN';
    throw err;
  }
  const bodyText = JSON.stringify(trade, null, 2) + '\n';
  const existing = await readTradeFromGitHub();
  const url = `https://api.github.com/repos/${GITHUB_REPO}/contents/${GITHUB_TRADE_PATH}`;
  const payload = {
    message: `Update trade-config via admin (${trade.tradeId})`,
    content: Buffer.from(bodyText, 'utf8').toString('base64'),
    branch: GITHUB_BRANCH,
  };
  if (existing && existing.sha) payload.sha = existing.sha;

  const res = await fetch(url, {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${GITHUB_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
      'User-Agent': 'deriv-app-admin',
    },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const t = await res.text();
    console.error('GitHub write failed:', res.status, t);
    const err = new Error(`GitHub save failed (${res.status}): ${t}`);
    err.code = 'GITHUB_WRITE_FAILED';
    throw err;
  }
  return true;
}

function writeTradeToDisk(trade) {
  if (!fs.existsSync(PUBLIC_DIR)) fs.mkdirSync(PUBLIC_DIR, { recursive: true });
  fs.writeFileSync(TRADE_CONFIG_FILE, JSON.stringify(trade, null, 2) + '\n', 'utf8');
}

async function readTradeConfig() {
  if (tradeCache) return { trade: tradeCache, savedAt: tradeCacheSavedAt };

  if (IS_VERCEL && GITHUB_TOKEN) {
    const gh = await readTradeFromGitHub();
    if (gh && gh.trade) {
      tradeCache = gh.trade;
      tradeCacheSavedAt = new Date().toISOString();
      return { trade: tradeCache, savedAt: tradeCacheSavedAt };
    }
  }

  const disk = readTradeFromDisk();
  if (disk) {
    tradeCache = disk;
    try {
      tradeCacheSavedAt = fs.statSync(TRADE_CONFIG_FILE).mtime.toISOString();
    } catch {
      tradeCacheSavedAt = null;
    }
    return { trade: tradeCache, savedAt: tradeCacheSavedAt };
  }
  const gh = await readTradeFromGitHub();
  if (gh && gh.trade) {
    tradeCache = gh.trade;
    tradeCacheSavedAt = new Date().toISOString();
    return { trade: gh.trade, savedAt: tradeCacheSavedAt };
  }
  return { trade: { ...DEFAULT_TRADE }, savedAt: null };
}

async function writeTradeConfig(input) {
  const trade = sanitizeTrade(input);
  let savedVia = 'memory';
  let warn = '';

  try {
    writeTradeToDisk(trade);
    savedVia = 'disk';
  } catch (diskErr) {
    console.warn('Disk write failed (expected on Vercel):', diskErr.message);
    if (GITHUB_TOKEN) {
      try {
        await writeTradeToGitHub(trade);
        savedVia = 'github';
      } catch (ghErr) {
        console.warn('GitHub write failed, using in-memory cache:', ghErr.message);
        savedVia = 'memory';
        warn = `GitHub save failed (${ghErr.code || 'error'}): ${ghErr.message}`;
      }
    } else {
      console.warn('No GITHUB_TOKEN; trade save is in-memory only on this instance');
      savedVia = 'memory';
      warn = 'No GITHUB_TOKEN set: save is temporary (lost on server restart). Set GITHUB_TOKEN in Vercel env for permanent saves.';
    }
  }

  if (savedVia === 'disk' && GITHUB_TOKEN && IS_VERCEL) {
    try {
      await writeTradeToGitHub(trade);
      savedVia = 'disk+github';
    } catch (err) {
      console.warn('Optional GitHub sync failed:', err.message);
      warn = `GitHub sync failed (${err.code || 'error'}): ${err.message}`;
    }
  }

  tradeCache = trade;
  tradeCacheSavedAt = new Date().toISOString();
  return { trade, savedAt: tradeCacheSavedAt, savedVia, warn };
}

// ---------------------------------------------------------------- file path resolution

// STRICT whitelist: only index1.html … index20.html may be read/written
// through the admin content API. Everything else is rejected.
function resolveTradeTargetFile(relPath) {
  if (typeof relPath !== 'string' || !relPath.trim()) {
    return { ok: false, status: 400, error: 'file is required' };
  }
  const name = relPath.replace(/\\/g, '/').replace(/^\/+/, '').trim().toLowerCase();
  if (name.includes('..') || name.includes('\0') || name.includes('/')) {
    return { ok: false, status: 400, error: 'Invalid file path' };
  }
  if (!TRADE_TARGET_FILES.has(name)) {
    return {
      ok: false,
      status: 400,
      error: 'Only index1.html - index20.html may be edited',
    };
  }
  return { ok: true, rel: name, abs: path.join(PUBLIC_DIR, name) };
}

function listPublicFiles(dir = PUBLIC_DIR, base = '') {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const name of fs.readdirSync(dir)) {
    if (name.startsWith('.')) continue;
    const full = path.join(dir, name);
    const rel = base ? `${base}/${name}` : name;
    let st;
    try {
      st = fs.statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) out.push(...listPublicFiles(full, rel));
    else if (st.isFile()) {
      const ext = path.extname(name).toLowerCase();
      if (ALLOWED_EXTS.has(ext)) {
        out.push({ path: rel, size: st.size, mtime: st.mtime.toISOString() });
      }
    }
  }
  out.sort((a, b) => a.path.localeCompare(b.path));
  return out;
}

// ---------------------------------------------------------------- GitHub raw-file helpers (for Vercel, read-only disk)

function repoPathFor(relPath) {
  const base = (GITHUB_PUBLIC_PATH || '').replace(/^\/+|\/+$/g, '');
  const rel = String(relPath).replace(/^\/+/, '');
  return base ? `${base}/${rel}` : rel;
}

function ghUrl(relPath, withRef) {
  const encoded = repoPathFor(relPath).split('/').map(encodeURIComponent).join('/');
  return `https://api.github.com/repos/${GITHUB_REPO}/contents/${encoded}${withRef ? `?ref=${encodeURIComponent(GITHUB_BRANCH)}` : ''}`;
}

async function readFileFromGitHub(relPath) {
  if (!GITHUB_TOKEN) return null;
  try {
    const res = await fetch(ghUrl(relPath, true), {
      headers: {
        Authorization: `Bearer ${GITHUB_TOKEN}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'deriv-app-admin',
      },
    });
    if (!res.ok) return null;
    const data = await res.json();
    const text = Buffer.from(data.content.replace(/\n/g, ''), 'base64').toString('utf8');
    return { content: text, sha: data.sha, size: data.size };
  } catch (err) {
    console.error('GitHub file read error:', err.message);
    return null;
  }
}

async function writeFileToGitHub(relPath, content) {
  if (!GITHUB_TOKEN) {
    const err = new Error(
      'Filesystem is read-only (Vercel). Set GITHUB_TOKEN env var so admin can save page files.'
    );
    err.code = 'NO_GITHUB_TOKEN';
    throw err;
  }
  if (Buffer.byteLength(content, 'utf8') > 1024 * 1024) {
    const err = new Error('File is larger than 1 MB — the GitHub Contents API limit. Keep pages under 1 MB.');
    err.code = 'GITHUB_SIZE_LIMIT';
    throw err;
  }
  const existing = await readFileFromGitHub(relPath);
  if (!existing) {
    const err = new Error(`File not found on GitHub: ${repoPathFor(relPath)}`);
    err.code = 'FILE_NOT_FOUND';
    throw err;
  }
  const payload = {
    message: `Update ${relPath} via admin`,
    content: Buffer.from(content, 'utf8').toString('base64'),
    branch: GITHUB_BRANCH,
  };
  if (existing.sha) payload.sha = existing.sha;

  const res = await fetch(ghUrl(relPath, false), {
    method: 'PUT',
    headers: {
      Authorization: `Bearer ${GITHUB_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
      'User-Agent': 'deriv-app-admin',
    },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const t = await res.text();
    console.error('GitHub file write failed:', res.status, t);
    const err = new Error(`GitHub save failed (${res.status}): ${t}`);
    err.code = 'GITHUB_WRITE_FAILED';
    throw err;
  }
  return true;
}

// Batch commit: update multiple files in ONE commit (single redeploy).
async function writeFilesToGitHubBatch(files) {
  if (!GITHUB_TOKEN) {
    const err = new Error(
      'Filesystem is read-only (Vercel). Set GITHUB_TOKEN env var so admin can save page files.'
    );
    err.code = 'NO_GITHUB_TOKEN';
    throw err;
  }
  if (!Array.isArray(files) || !files.length) {
    const err = new Error('No files to save');
    err.code = 'NO_FILES';
    throw err;
  }
  for (const f of files) {
    if (!TRADE_TARGET_FILES.has(f.file)) {
      const err = new Error(`File not allowed: ${f.file}`);
      err.code = 'FILE_NOT_ALLOWED';
      throw err;
    }
    if (Buffer.byteLength(f.content, 'utf8') > 1024 * 1024) {
      const err = new Error(`${f.file} is larger than 1 MB (GitHub blob limit).`);
      err.code = 'GITHUB_SIZE_LIMIT';
      throw err;
    }
  }

  const api = 'https://api.github.com';
  const headers = {
    Authorization: `Bearer ${GITHUB_TOKEN}`,
    Accept: 'application/vnd.github+json',
    'Content-Type': 'application/json',
    'User-Agent': 'deriv-app-admin',
  };

  // 1. Get current branch head commit
  const refRes = await fetch(`${api}/repos/${GITHUB_REPO}/git/ref/heads/${GITHUB_BRANCH}`, { headers });
  if (!refRes.ok) {
    const err = new Error(`Failed to read branch ref (${refRes.status}): ${await refRes.text()}`);
    err.code = 'GITHUB_REF_FAILED';
    throw err;
  }
  const refData = await refRes.json();
  const headSha = refData.object.sha;

  const commitRes = await fetch(`${api}/repos/${GITHUB_REPO}/git/commits/${headSha}`, { headers });
  if (!commitRes.ok) {
    const err = new Error(`Failed to read head commit (${commitRes.status}): ${await commitRes.text()}`);
    err.code = 'GITHUB_COMMIT_READ_FAILED';
    throw err;
  }
  const headCommit = await commitRes.json();
  const baseTreeSha = headCommit.tree.sha;

  // 2. Create blobs
  const tree = [];
  for (const f of files) {
    const blobRes = await fetch(`${api}/repos/${GITHUB_REPO}/git/blobs`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        content: Buffer.from(f.content, 'utf8').toString('base64'),
        encoding: 'base64',
      }),
    });
    if (!blobRes.ok) {
      const err = new Error(`Blob creation failed for ${f.file} (${blobRes.status}): ${await blobRes.text()}`);
      err.code = 'GITHUB_BLOB_FAILED';
      throw err;
    }
    const blob = await blobRes.json();
    tree.push({ path: repoPathFor(f.file), mode: '100644', type: 'blob', sha: blob.sha });
  }

  // 3. Create tree
  const treeRes = await fetch(`${api}/repos/${GITHUB_REPO}/git/trees`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ base_tree: baseTreeSha, tree }),
  });
  if (!treeRes.ok) {
    const err = new Error(`Tree creation failed (${treeRes.status}): ${await treeRes.text()}`);
    err.code = 'GITHUB_TREE_FAILED';
    throw err;
  }
  const newTree = await treeRes.json();

  // 4. Create commit
  const newCommitRes = await fetch(`${api}/repos/${GITHUB_REPO}/git/commits`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      message: `Update trade details via admin (${files.map((f) => f.file).join(', ')})`,
      tree: newTree.sha,
      parents: [headSha],
    }),
  });
  if (!newCommitRes.ok) {
    const err = new Error(`Commit creation failed (${newCommitRes.status}): ${await newCommitRes.text()}`);
    err.code = 'GITHUB_COMMIT_FAILED';
    throw err;
  }
  const newCommit = await newCommitRes.json();

  // 5. Update branch ref
  const updateRes = await fetch(`${api}/repos/${GITHUB_REPO}/git/refs/heads/${GITHUB_BRANCH}`, {
    method: 'PATCH',
    headers,
    body: JSON.stringify({ sha: newCommit.sha }),
  });
  if (!updateRes.ok) {
    const err = new Error(`Branch update failed (${updateRes.status}): ${await updateRes.text()}`);
    err.code = 'GITHUB_REF_UPDATE_FAILED';
    throw err;
  }

  return { commit: newCommit.sha, files: files.map((f) => f.file) };
}

// ---------------------------------------------------------------- routes

app.get('/admin', (req, res) => {
  res.sendFile(path.join(ADMIN_DIR, 'index.html'));
});

app.get('/admin/api/session', (req, res) => {
  res.json({ authed: isAuthenticated(req) });
});

app.post('/admin/api/login', (req, res) => {
  const ip = req.ip || 'unknown';
  const rl = checkRateLimit(ip);
  if (rl.locked) {
    return res.status(429).json({ error: `Too many attempts. Try again in ${rl.retryAfter}s.` });
  }
  const { password } = req.body || {};
  if (typeof password !== 'string' || !safeEqual(password, ADMIN_PASSWORD)) {
    recordFailure(ip);
    return res.status(401).json({ error: 'Invalid password' });
  }
  recordSuccess(ip);
  const token = signSession();
  setSessionCookie(req, res, token);
  res.json({ ok: true });
});

app.post('/admin/api/logout', (req, res) => {
  clearSessionCookie(req, res);
  res.json({ ok: true });
});

// Public trade values (no auth) — used by index.html / other pages that fetch config
app.get('/api/trade-public', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  try {
    const { trade, savedAt } = await readTradeConfig();
    res.json({ ...trade, savedAt });
  } catch (err) {
    console.error(err);
    res.json({ ...DEFAULT_TRADE });
  }
});

// Serve trade-config.json dynamically
app.get('/trade-config.json', async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.type('json');
  try {
    const { trade } = await readTradeConfig();
    res.send(JSON.stringify(trade, null, 2) + '\n');
  } catch {
    res.send(JSON.stringify(DEFAULT_TRADE, null, 2) + '\n');
  }
});

app.get('/admin/api/trade', requireAuth, async (req, res) => {
  try {
    const { trade, savedAt } = await readTradeConfig();
    res.json({ trade, savedAt });
  } catch (err) {
    console.error('Failed to load trade config:', err);
    res.json({ trade: { ...DEFAULT_TRADE }, savedAt: null, warning: 'Using defaults' });
  }
});

app.post('/admin/api/trade', requireAuth, async (req, res) => {
  if (!sameOrigin(req)) {
    return res.status(403).json({ error: 'Cross-origin request rejected' });
  }
  const body = req.body || {};
  if (!body.paymentMethod && !body.tradeId && !body.amount && !body.status) {
    return res.status(400).json({ error: 'Provide paymentMethod, tradeId, amount, and/or status' });
  }
  try {
    const current = (await readTradeConfig()).trade;
    const result = await writeTradeConfig({
      paymentMethod: body.paymentMethod != null ? body.paymentMethod : current.paymentMethod,
      tradeId: body.tradeId != null ? body.tradeId : current.tradeId,
      amount: body.amount != null ? body.amount : current.amount,
      status: body.status != null ? body.status : current.status,
    });
    res.json({ ok: true, trade: result.trade, savedAt: result.savedAt, savedVia: result.savedVia, warn: result.warn });
  } catch (err) {
    console.error('Failed to save trade config:', err);
    const msg =
      err.code === 'NO_GITHUB_TOKEN'
        ? err.message
        : err.message || 'Failed to save trade settings';
    res.status(500).json({ error: msg });
  }
});

app.get('/admin/api/files', requireAuth, (req, res) => {
  try {
    res.json({ files: listPublicFiles() });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to list files' });
  }
});

// Read one of the whitelisted index pages
app.get('/admin/api/content', requireAuth, async (req, res) => {
  const resolved = resolveTradeTargetFile(req.query.file || 'index1.html');
  if (!resolved.ok) return res.status(resolved.status).json({ error: resolved.error });

  if (IS_VERCEL && GITHUB_TOKEN) {
    const gh = await readFileFromGitHub(resolved.rel);
    if (gh) {
      return res.json({
        file: resolved.rel,
        content: gh.content,
        savedAt: new Date().toISOString(),
        size: gh.size,
        source: 'github',
      });
    }
  }

  if (!fs.existsSync(resolved.abs) || !fs.statSync(resolved.abs).isFile()) {
    return res.status(404).json({ error: `File not found: ${resolved.rel}` });
  }
  try {
    const content = fs.readFileSync(resolved.abs, 'utf8');
    const stat = fs.statSync(resolved.abs);
    res.json({ file: resolved.rel, content, savedAt: stat.mtime.toISOString(), size: stat.size, source: 'disk' });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to read file' });
  }
});

// Write one of the whitelisted index pages
app.post('/admin/api/content', requireAuth, async (req, res) => {
  if (!sameOrigin(req)) {
    return res.status(403).json({ error: 'Cross-origin request rejected' });
  }
  const { content, file } = req.body || {};
  const resolved = resolveTradeTargetFile(file);
  if (!resolved.ok) return res.status(resolved.status).json({ error: resolved.error });
  if (typeof content !== 'string') {
    return res.status(400).json({ error: 'content must be a string' });
  }
  if (Buffer.byteLength(content, 'utf8') > MAX_BODY_BYTES) {
    return res.status(413).json({ error: 'Content too large' });
  }

  if (IS_VERCEL) {
    try {
      await writeFileToGitHub(resolved.rel, content);
      return res.json({ ok: true, file: resolved.rel, savedAt: new Date().toISOString(), savedVia: 'github' });
    } catch (err) {
      console.error(err);
      const msg =
        err.code === 'NO_GITHUB_TOKEN'
          ? err.message
          : err.message || 'Failed to save file to GitHub';
      return res.status(500).json({ error: msg });
    }
  }

  if (!fs.existsSync(resolved.abs)) {
    return res.status(404).json({ error: `File not found: ${resolved.rel}` });
  }
  try {
    fs.writeFileSync(resolved.abs, content, 'utf8');
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Failed to save. Check filesystem permissions.' });
  }
  res.json({ ok: true, file: resolved.rel, savedAt: new Date().toISOString(), savedVia: 'disk' });
});

// Batch write multiple whitelisted index pages in ONE GitHub commit (one redeploy).
app.post('/admin/api/batch', requireAuth, async (req, res) => {
  if (!sameOrigin(req)) {
    return res.status(403).json({ error: 'Cross-origin request rejected' });
  }
  const { files } = req.body || {};
  if (!Array.isArray(files) || !files.length) {
    return res.status(400).json({ error: 'files must be a non-empty array of { file, content }' });
  }
  if (files.length > 20) {
    return res.status(400).json({ error: 'Maximum 20 files per batch' });
  }

  for (const entry of files) {
    const resolved = resolveTradeTargetFile(entry && entry.file);
    if (!resolved.ok) return res.status(resolved.status).json({ error: `${entry && entry.file}: ${resolved.error}` });
    if (typeof entry.content !== 'string') {
      return res.status(400).json({ error: `${entry.file}: content must be a string` });
    }
  }

  // Local (writable disk): just write each file
  if (!IS_VERCEL) {
    const results = [];
    const errors = [];
    for (const entry of files) {
      const resolved = resolveTradeTargetFile(entry.file);
      try {
        if (!fs.existsSync(resolved.abs)) throw new Error(`File not found: ${resolved.rel}`);
        fs.writeFileSync(resolved.abs, entry.content, 'utf8');
        results.push(resolved.rel);
      } catch (err) {
        errors.push(`${resolved.rel}: ${err.message}`);
      }
    }
    if (errors.length) {
      return res.status(500).json({ error: `Some files failed: ${errors.join('; ')}`, saved: results });
    }
    return res.json({ ok: true, saved: results, savedAt: new Date().toISOString(), savedVia: 'disk' });
  }

  // Vercel: single commit via Git Data API
  try {
    const result = await writeFilesToGitHubBatch(files);
    return res.json({
      ok: true,
      saved: result.files,
      commit: result.commit,
      savedAt: new Date().toISOString(),
      savedVia: 'github-batch',
    });
  } catch (err) {
    console.error('Batch save failed:', err);
    const msg =
      err.code === 'NO_GITHUB_TOKEN'
        ? err.message
        : err.message || 'Failed to save files to GitHub';
    return res.status(500).json({ error: msg });
  }
});

app.use('/admin', express.static(ADMIN_DIR));
app.use(express.static(PUBLIC_DIR, { index: 'index.html' }));

app.use((err, req, res, next) => {
  if (err && err.type === 'entity.too.large') {
    return res.status(413).json({ error: 'Content too large (max 8 MB)' });
  }
  if (err && err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'Malformed JSON body' });
  }
  next(err);
});

// Vercel serverless export
module.exports = app;

if (!IS_VERCEL) {
  app.listen(PORT, () => {
    console.log(`DERIV-APP running on http://localhost:${PORT}`);
    console.log(`Admin panel:   http://localhost:${PORT}/admin`);
    console.log(
      `Admin password: ${process.env.ADMIN_PASSWORD ? '(from env/.env)' : 'DEFAULT Joan5078'}`
    );
  });
}
