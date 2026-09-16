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

// ---------------- file editor elements ----------------
const fileSelect = document.getElementById('file-select');
const fileRefreshBtn = document.getElementById('file-refresh-btn');
const fileOpenLink = document.getElementById('file-open-link');
const fileMeta = document.getElementById('file-meta');
const fileEditor = document.getElementById('file-editor');
const fileSaveBtn = document.getElementById('file-save-btn');
const fileReloadBtn = document.getElementById('file-reload-btn');
const fileStatus = document.getElementById('file-status');
const fileError = document.getElementById('file-error');

let currentFile = '';
let fileDirty = false;

async function api(path, options = {}) {
  const res = await fetch(path, {
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...(options.headers || {}) },
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

function fillForm(trade) {
  paymentMethod.value = trade.paymentMethod || '';
  tradeId.value = trade.tradeId || '';
  amount.value = trade.amount || '';
  statusEl.value = trade.status === 'complete' ? 'complete' : 'waiting';
  updatePreview();
  dirty = false;
}

function updatePreview() {
  pvMethod.textContent = paymentMethod.value || '—';
  pvTrade.textContent = tradeId.value || '—';
  pvAmount.textContent = amount.value || '—';
  pvStatus.textContent = statusLabel(statusEl.value);
}

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
  const data = await api('/admin/api/trade');
  fillForm(data.trade || {});
  if (data.savedAt) {
    lastSaved.textContent = `Last saved: ${new Date(data.savedAt).toLocaleString()}`;
  }
  try {
    await loadFileList();
  } catch (err) {
    showError(fileError, `File list failed: ${err.message}`);
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

tradeForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  clearError(saveError);
  saveStatus.textContent = '';
  saveBtn.disabled = true;
  saveBtn.textContent = 'Saving…';
  try {
    const data = await api('/admin/api/trade', {
      method: 'POST',
      body: JSON.stringify({
        paymentMethod: paymentMethod.value.trim(),
        tradeId: tradeId.value.trim(),
        amount: amount.value.trim(),
        status: statusEl.value,
      }),
    });
    fillForm(data.trade);
    dirty = false;
    const via = data.savedVia ? ` via ${data.savedVia}` : '';
    saveStatus.textContent = `Saved at ${new Date(data.savedAt).toLocaleTimeString()}${via}`;
    lastSaved.textContent = `Last saved: ${new Date(data.savedAt).toLocaleString()}`;
    if (data.savedVia === 'github' || (data.savedVia || '').includes('github')) {
      saveStatus.textContent += ' (permanent in repo; site auto-redeploys)';
    } else if (data.warn) {
      saveStatus.textContent += ` ⚠ ${data.warn}`;
    } else if (data.savedVia === 'memory') {
      saveStatus.textContent += ' ⚠ Temporary only — set GITHUB_TOKEN in Vercel env for permanent saves';
    }
  } catch (err) {
    showError(saveError, err.message);
  } finally {
    saveBtn.disabled = false;
    saveBtn.textContent = 'Save changes';
  }
});

for (const el of [paymentMethod, tradeId, amount, statusEl]) {
  el.addEventListener('input', () => {
    dirty = true;
    saveStatus.textContent = 'Unsaved changes';
    updatePreview();
  });
  el.addEventListener('change', () => {
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
  if (dirty || fileDirty) {
    e.preventDefault();
    e.returnValue = '';
  }
});

// ================= file editor =================

function fileBytes() {
  try {
    return new TextEncoder().encode(fileEditor.value).length;
  } catch {
    return fileEditor.value.length;
  }
}

function updateFileStatus() {
  const bytes = fileBytes();
  let msg = `${bytes.toLocaleString()} bytes / 2 MB max`;
  if (fileDirty) msg += ' · unsaved changes';
  fileStatus.textContent = msg;
  fileStatus.classList.remove('ok');
}

async function loadFileList(preferred) {
  clearError(fileError);
  const data = await api('/admin/api/files');
  const files = data.files || [];

  const htmlFiles = files.filter((f) => /\.html?$/i.test(f.path));
  const otherFiles = files.filter((f) => !/\.html?$/i.test(f.path));

  fileSelect.innerHTML = '';
  const addGroup = (label, list) => {
    if (!list.length) return;
    const og = document.createElement('optgroup');
    og.label = label;
    for (const f of list) {
      const opt = document.createElement('option');
      opt.value = f.path;
      opt.textContent = f.path;
      og.appendChild(opt);
    }
    fileSelect.appendChild(og);
  };
  addGroup('HTML pages', htmlFiles);
  addGroup('Other editable files', otherFiles);

  if (!fileSelect.options.length) {
    fileMeta.textContent = 'No editable files found in /public';
    fileEditor.value = '';
    fileEditor.disabled = true;
    fileSaveBtn.disabled = true;
    fileOpenLink.style.display = 'none';
    updateFileStatus();
    return;
  }

  let target = preferred || currentFile;
  if (target && Array.from(fileSelect.options).some((o) => o.value === target)) {
    fileSelect.value = target;
  } else {
    fileSelect.selectedIndex = 0;
    target = fileSelect.value;
  }

  fileEditor.disabled = false;
  await loadFile(target);
}

async function loadFile(filePath) {
  clearError(fileError);
  fileStatus.textContent = 'Loading…';
  fileSaveBtn.disabled = true;
  try {
    const data = await api(`/admin/api/content?file=${encodeURIComponent(filePath)}`);
    currentFile = data.file;
    fileEditor.value = data.content;
    fileMeta.textContent =
      `${data.file} · ${Number(data.size || 0).toLocaleString()} bytes · last saved ` +
      new Date(data.savedAt).toLocaleString() +
      (data.source ? ` · source: ${data.source}` : '');
    fileOpenLink.href = `/${encodeURIComponent(currentFile)}`;
    fileOpenLink.style.display = 'inline-block';
    fileDirty = false;
    updateFileStatus();
    fileStatus.classList.add('ok');
    fileStatus.textContent = `Loaded ${currentFile}`;
  } catch (err) {
    showError(fileError, err.message);
    fileMeta.textContent = filePath;
    updateFileStatus();
  } finally {
    fileSaveBtn.disabled = false;
  }
}

fileSelect.addEventListener('change', async () => {
  if (fileDirty && !confirm('You have unsaved changes in the current file. Discard them and open another file?')) {
    fileSelect.value = currentFile;
    return;
  }
  await loadFile(fileSelect.value);
});

fileEditor.addEventListener('input', () => {
  fileDirty = true;
  updateFileStatus();
});

fileSaveBtn.addEventListener('click', async () => {
  clearError(fileError);
  fileSaveBtn.disabled = true;
  const originalText = fileSaveBtn.textContent;
  fileSaveBtn.textContent = 'Saving…';
  try {
    const data = await api('/admin/api/content', {
      method: 'POST',
      body: JSON.stringify({ file: currentFile, content: fileEditor.value }),
    });
    fileDirty = false;
    fileStatus.classList.add('ok');
    fileStatus.textContent = `Saved ${data.file} at ${new Date(data.savedAt).toLocaleTimeString()}` +
      (data.savedVia ? ` (${data.savedVia})` : '');
    if (data.savedVia === 'github') {
      fileStatus.textContent += ' — commit pushed; site redeploys from the repo';
    }
    fileMeta.textContent = `${data.file} · updated ${new Date(data.savedAt).toLocaleString()}`;
  } catch (err) {
    showError(fileError, err.message);
    fileStatus.textContent = '';
  } finally {
    fileSaveBtn.disabled = false;
    fileSaveBtn.textContent = originalText;
    updateFileStatus();
  }
});

fileReloadBtn.addEventListener('click', () => {
  if (fileDirty && !confirm('Discard unsaved changes and reload this file from the server?')) return;
  loadFile(currentFile);
});

fileRefreshBtn.addEventListener('click', () => loadFileList(currentFile));

init();
