const loginView = document.getElementById('login-view');
const editorView = document.getElementById('editor-view');
const loginForm = document.getElementById('login-form');
const passwordInput = document.getElementById('password');
const loginError = document.getElementById('login-error');
const loginBtn = document.getElementById('login-btn');

const tradeForm = document.getElementById('trade-form');
const targetPages = document.getElementById('targetPages');
const paymentMethod = document.getElementById('paymentMethod');
const tradeId = document.getElementById('tradeId');
const amount = document.getElementById('amount');
const statusEl = document.getElementById('status');
const saveBtn = document.getElementById('save-btn');
const saveError = document.getElementById('save-error');
const saveStatus = document.getElementById('save-status');
const lastSaved = document.getElementById('last-saved');
const logoutBtn = document.getElementById('logout-btn');

const pvMethod = document.getElementById('pv-method');
const pvTrade = document.getElementById('pv-trade');
const pvAmount = document.getElementById('pv-amount');
const pvStatus = document.getElementById('pv-status');

let dirty = false;

// ================= helpers =================

async function api(path, options = {}) {
  const res = await fetch(path, {
    credentials: 'same-origin',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      ...(options.headers || {}),
    },
    ...options,
  });

  const text = await res.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { error: text || `Request failed (${res.status})` };
  }
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

function showError(el, msg) {
  el.textContent = msg;
  el.classList.remove('hidden');
}

function clearError(el) {
  el.classList.add('hidden');
  el.textContent = '';
}

function statusLabel(value) {
  return value === 'complete' ? 'Transfer complete' : 'Waiting confirmation';
}

function updatePreview() {
  pvMethod.textContent = paymentMethod.value || '—';
  pvTrade.textContent = tradeId.value || '—';
  pvAmount.textContent = amount.value || '—';
  pvStatus.textContent = statusLabel(statusEl.value);
}

// Resolve dropdown value -> list of index1..index20 filenames
function resolveTargetFiles() {
  const value = targetPages.value;

  if (value === 'all') {
    return Array.from({ length: 20 }, (_, i) => `index${i + 1}.html`);
  }

  if (value.startsWith('range:')) {
    const [a, b] = value.slice(6).split('-').map(Number);
    if (!Number.isInteger(a) || !Number.isInteger(b) || a < 1 || b > 20 || a > b) {
      throw new Error('Invalid range selected.');
    }
    return Array.from({ length: b - a + 1 }, (_, i) => `index${a + i}.html`);
  }

  const n = Number(value.replace(/^index/, ''));
  if (!Number.isInteger(n) || n < 1 || n > 20) {
    throw new Error('Invalid target page selected.');
  }
  return [`index${n}.html`];
}

// ================= HTML trade marker replacement =================

function escapeAttr(s) {
  return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

function applyTradeToHtml(html, trade) {
  const pm = escapeAttr(trade.paymentMethod);
  const tid = escapeAttr(trade.tradeId);
  const amt = escapeAttr(trade.amount);
  const st = escapeAttr(trade.status);

  const patterns = [
    { key: 'data-payment-method', value: pm },
    { key: 'data-trade-id', value: tid },
    { key: 'data-amount', value: amt },
    { key: 'data-status', value: st },
  ];

  let out = html;

  for (const p of patterns) {
    const re = new RegExp(`(${p.key}\\s*=\\s*")([^"]*)(")`, 'g');
    out = out.replace(re, `$1${p.value}$3`);
  }

  // Replace the hardcoded fallback values used by the inline page scripts
  const fallbackPairs = [
    { find: `tradeId: "TR-810136"`, replace: `tradeId: "${tid}"` },
    { find: `amount: "19,000 USD"`, replace: `amount: "${amt}"` },
    { find: `paymentMethod: "joelhadson@gmail.com"`, replace: `paymentMethod: "${pm}"` },
    { find: `status: "waiting",`, replace: `status: "${st}",` },
  ];
  for (const f of fallbackPairs) {
    out = out.split(f.find).join(f.replace);
  }

  return out;
}

// ================= auth + init =================

async function init() {
  try {
    const { authed } = await api('/admin/api/session');
    if (authed) {
      showEditor();
    } else {
      loginView.classList.remove('hidden');
      passwordInput.focus();
    }
  } catch {
    showError(loginError, 'Cannot reach the server.');
    loginView.classList.remove('hidden');
  }
}

function showEditor() {
  loginView.classList.add('hidden');
  editorView.classList.remove('hidden');
  updatePreview();
}

loginForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  clearError(loginError);

  loginBtn.disabled = true;
  loginBtn.textContent = 'Signing in…';

  try {
    await api('/admin/api/login', {
      method: 'POST',
      body: JSON.stringify({ password: passwordInput.value }),
    });
    passwordInput.value = '';
    showEditor();
  } catch (err) {
    showError(loginError, err.message);
  } finally {
    loginBtn.disabled = false;
    loginBtn.textContent = 'Sign in';
  }
});

// ================= save =================

tradeForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  clearError(saveError);

  saveStatus.textContent = 'Applying…';
  saveBtn.disabled = true;

  const trade = {
    paymentMethod: paymentMethod.value.trim(),
    tradeId: tradeId.value.trim(),
    amount: amount.value.trim(),
    status: statusEl.value,
  };

  try {
    const targets = resolveTargetFiles();

    // 1. Update trade-config.json FIRST (instant live values for all pages
    //    that fetch the config)
    await api('/admin/api/trade', {
      method: 'POST',
      body: JSON.stringify(trade),
    });

    // 2. Then rewrite the selected HTML pages (baked-in values)
    const contents = await Promise.all(
      targets.map(async (file) => {
        const data = await api(`/admin/api/content?file=${encodeURIComponent(file)}`);
        return { file, content: applyTradeToHtml(data.content, trade) };
      })
    );

    // Save all pages in ONE request (single GitHub commit on Vercel)
    const result = await api('/admin/api/batch', {
      method: 'POST',
      body: JSON.stringify({ files: contents }),
    });

    dirty = false;
    saveStatus.textContent = `Saved config + ${result.saved.length} page(s) via ${result.savedVia || 'unknown'}`;
    lastSaved.textContent = `Last saved: ${new Date(result.savedAt || Date.now()).toLocaleString()}`;
  } catch (err) {
    showError(saveError, err.message);
    saveStatus.textContent = '';
  } finally {
    saveBtn.disabled = false;
    saveBtn.textContent = 'Save changes';
  }
});

// preview & dirty tracking
for (const el of [paymentMethod, tradeId, amount, statusEl, targetPages]) {
  el.addEventListener('input', () => {
    dirty = true;
    saveStatus.textContent = 'Unsaved changes';
    updatePreview();
  });
}

logoutBtn.addEventListener('click', async () => {
  try {
    await api('/admin/api/logout', { method: 'POST' });
  } catch {
    /* ignore */
  }
  location.reload();
});

window.addEventListener('beforeunload', (e) => {
  if (dirty) {
    e.preventDefault();
    e.returnValue = '';
  }
});

init();
