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

// Resolve the dropdown value to a list of target files (index1..index20 only)
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

// ================= applying trade details into HTML =================
//
// Replace strategy:
// - Payment method: data-payment-method="..."
// - Trade id:       data-trade-id="..."
// - Amount:         data-amount="..."
// - Status:         data-status="waiting|complete"
//
// If no attributes found, fall back to elements with matching ids.

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

  let didReplaceAny = false;
  let out = html;

  for (const p of patterns) {
    const re = new RegExp(`(${p.key}\\s*=\\s*")([^"]*)(")`, 'g');
    if (re.test(out)) {
      out = out.replace(re, `$1${p.value}$3`);
      didReplaceAny = true;
    }
  }

  if (!didReplaceAny) {
    const fallbackMap = [
      { id: 'paymentMethod', value: pm },
      { id: 'tradeId', value: tid },
      { id: 'amount', value: amt },
      { id: 'status', value: st },
    ];
    let fallbackDid = false;
    for (const f of fallbackMap) {
      const idRe = new RegExp(`(<[^>]+id=["']${f.id}["'][^>]*>)([\\s\\S]*?)(</[^>]+>)`, 'g');
      if (idRe.test(out)) {
        out = out.replace(idRe, `$1${f.value}$3`);
        fallbackDid = true;
      }
    }
    if (!fallbackDid) {
      throw new Error(
        'Could not find a known trade details marker in the target file. ' +
        'Use data-payment-method / data-trade-id / data-amount / data-status attributes.'
      );
    }
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

// ================= trade form submission (apply to selected files) =================

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
    const results = [];
    let failed = 0;

    for (const file of targets) {
      try {
        // Fetch current content (server returns GitHub copy on Vercel)
        const { content } = await api(
          `/admin/api/content?file=${encodeURIComponent(file)}`
        );

        const newHtml = applyTradeToHtml(content, trade);

        const data = await api('/admin/api/content', {
          method: 'POST',
          body: JSON.stringify({ file, content: newHtml }),
        });

        results.push(`${data.file} ✓`);
      } catch (err) {
        failed += 1;
        results.push(`${file} ✗ (${err.message})`);
      }
    }

    dirty = false;

    const summary = `${targets.length - failed}/${targets.length} files saved`;
    saveStatus.textContent = summary;
    lastSaved.textContent = `Last saved: ${new Date().toLocaleString()} — ${results.join(', ')}`;

    if (failed > 0) {
      showError(saveError, `${failed} file(s) failed. See details next to Last saved.`);
    }
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
