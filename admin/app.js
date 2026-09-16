const loginView = document.getElementById('login-view');
const editorView = document.getElementById('editor-view');
const loginForm = document.getElementById('login-form');
const passwordInput = document.getElementById('password');
const loginError = document.getElementById('login-error');
const loginBtn = document.getElementById('login-btn');

const tradeForm = document.getElementById('trade-form');
const paymentMethod = document.getElementById('paymentMethod');
const tradeId = document.getElementById('tradeId');
const amount = document.getElementById('amount');
const statusEl = document.getElementById('status');
const saveBtn = document.getElementById('apply-trade-btn');
const saveError = document.getElementById('save-error');
const saveStatus = document.getElementById('save-status');
const lastSaved = document.getElementById('last-saved');
const logoutBtn = document.getElementById('logout-btn');

const pvMethod = document.getElementById('pv-method');
const pvTrade = document.getElementById('pv-trade');
const pvAmount = document.getElementById('pv-amount');
const pvStatus = document.getElementById('pv-status');

let dirty = false;

// ================= Trade target file UI =================
const tradeFileSelect = document.getElementById('trade-file-select');
const tradeFileRefreshBtn = document.getElementById('trade-file-refresh-btn');
const tradeFileOpenLink = document.getElementById('trade-file-open-link');
const tradeFileMeta = document.getElementById('trade-file-meta');
const tradeFileEditor = document.getElementById('trade-file-editor'); // optional textarea preview
const tradeFileReloadBtn = document.getElementById('trade-file-reload-btn');
const tradeFileStatus = document.getElementById('trade-file-status');
const tradeFileError = document.getElementById('trade-file-error');

let currentFile = '';
let fileContent = '';
let fileSize = 0;

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

// ================= load file list + load current file =================

async function loadFileList(preferred) {
  clearError(tradeFileError);

  const data = await api('/admin/api/files');
  const files = data.files || [];

  // Only allow html pages that can show trade details
  const htmlFiles = files.filter((f) => /\.html?$/i.test(f.path));

  tradeFileSelect.innerHTML = '';

  const addOptions = (list) => {
    for (const f of list) {
      const opt = document.createElement('option');
      opt.value = f.path;
      opt.textContent = f.path;
      tradeFileSelect.appendChild(opt);
    }
  };

  addOptions(htmlFiles);

  if (!tradeFileSelect.options.length) {
    tradeFileMeta.textContent = 'No HTML files found in /public';
    tradeFileOpenLink.style.display = 'none';
    tradeFileEditor.value = '';
    tradeFileEditor.disabled = true;
    tradeFileStatus.textContent = '';
    return;
  }

  let target = preferred || currentFile;
  if (target && Array.from(tradeFileSelect.options).some((o) => o.value === target)) {
    tradeFileSelect.value = target;
  } else {
    tradeFileSelect.selectedIndex = 0;
    target = tradeFileSelect.value;
  }

  await loadFile(target);
}

async function loadFile(filePath) {
  clearError(tradeFileError);
  tradeFileStatus.textContent = 'Loading…';

  try {
    const data = await api(`/admin/api/content?file=${encodeURIComponent(filePath)}`);
    currentFile = data.file;
    fileContent = data.content || '';
    fileSize = Number(data.size || 0);

    if (tradeFileEditor) {
      tradeFileEditor.value = fileContent;
      tradeFileEditor.disabled = true; // we don't want manual editing anymore
    }

    tradeFileMeta.textContent =
      `${data.file} · ${fileSize.toLocaleString()} bytes · last saved ` +
      new Date(data.savedAt).toLocaleString() +
      (data.source ? ` · source: ${data.source}` : '');

    tradeFileOpenLink.href = `/${encodeURIComponent(currentFile)}`;
    tradeFileOpenLink.style.display = 'inline-block';

    tradeFileStatus.textContent = `Loaded ${currentFile}`;
  } catch (err) {
    showError(tradeFileError, err.message);
    tradeFileMeta.textContent = filePath;
    tradeFileStatus.textContent = '';
  }
}

// ================= applying trade details into selected file =================
//
// Replace strategy (customize if your HTML uses different selectors):
// - Payment method: data-payment-method="..."
// - Trade id: data-trade-id="..."
// - Amount: data-amount="..."
// - Status: data-status="waiting|complete"
//
// We search and replace those attributes first.
// If not found, we fail with a clear message so you can tell us your template markers.

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

  // Replace attribute values inside the HTML string
  for (const p of patterns) {
    const re = new RegExp(`(${p.key}\\s*=\\s*")([^"]*)(")`, 'g');
    if (re.test(out)) {
      out = out.replace(re, `$1${p.value}$3`);
      didReplaceAny = true;
    }
  }

  if (!didReplaceAny) {
    // Try a common alternative: text in specific IDs
    // (optional fallback)
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
        'Could not find a known trade details marker in the selected file. ' +
        'Use data-payment-method / data-trade-id / data-amount / data-status attributes, ' +
        'or tell me what your HTML uses and I’ll match it.'
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
      await showEditor();
    } else {
      loginView.classList.remove('hidden');
      passwordInput.focus();
    }
  } catch {
    showError(loginError, 'Cannot reach the server.');
    loginView.classList.remove('hidden');
  }
}

async function showEditor() {
  loginView.classList.add('hidden');
  editorView.classList.remove('hidden');

  updatePreview();

  try {
    await loadFileList();
  } catch (err) {
    showError(tradeFileError, `File list failed: ${err.message}`);
  }
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
    await showEditor();
  } catch (err) {
    showError(loginError, err.message);
  } finally {
    loginBtn.disabled = false;
    loginBtn.textContent = 'Sign in';
  }
});

// ================= trade form submission (apply to selected file only) =================

tradeForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  clearError(saveError);

  saveStatus.textContent = '';
  saveBtn.disabled = true;
  saveBtn.textContent = 'Applying…';

  const trade = {
    paymentMethod: paymentMethod.value.trim(),
    tradeId: tradeId.value.trim(),
    amount: amount.value.trim(),
    status: statusEl.value,
  };

  try {
    if (!currentFile) throw new Error('Select a target file first.');

    const newHtml = applyTradeToHtml(fileContent, trade);

    // save only the selected file content
    const data = await api('/admin/api/content', {
      method: 'POST',
      body: JSON.stringify({ file: currentFile, content: newHtml }),
    });

    // refresh local cache
    fileContent = newHtml;

    dirty = false;
    const via = data.savedVia ? ` via ${data.savedVia}` : '';
    saveStatus.textContent =
      `Saved ${data.file} at ${new Date(data.savedAt).toLocaleTimeString()}${via}`;

    lastSaved.textContent = `Last saved: ${new Date(data.savedAt).toLocaleString()}`;

    if (tradeFileEditor) {
      tradeFileEditor.value = newHtml;
      tradeFileEditor.disabled = true;
    }

    tradeFileStatus.textContent = `Updated ${data.file}`;
    tradeFileMeta.textContent =
      `${data.file} · updated ${new Date(data.savedAt).toLocaleString()}`;
  } catch (err) {
    showError(saveError, err.message);
    saveStatus.textContent = '';
  } finally {
    saveBtn.disabled = false;
    saveBtn.textContent = 'Apply to selected file';
  }
});

// preview & dirty tracking
for (const el of [paymentMethod, tradeId, amount, statusEl]) {
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

// ================= dropdown / reload behaviors =================

tradeFileSelect.addEventListener('change', async () => {
  if (dirty && !confirm('You have unsaved trade changes. Discard them and open another file?')) return;
  dirty = false;
  await loadFile(tradeFileSelect.value);
});

if (tradeFileReloadBtn) {
  tradeFileReloadBtn.addEventListener('click', async () => {
    if (dirty && !confirm('Discard unsaved changes and reload the selected file?')) return;
    dirty = false;
    await loadFile(currentFile);
  });
}

if (tradeFileRefreshBtn) {
  tradeFileRefreshBtn.addEventListener('click', () => loadFileList(currentFile));
}

init();
