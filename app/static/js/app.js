(() => {
  'use strict';
  const token = document.querySelector('meta[name="mps-token"]').content;
  const $ = (id) => document.getElementById(id);
  const state = { unlocked: false, selectedId: null, selectedEntry: null, importParent: '', treeItems: [], expanded: new Set(), theme: localStorage.getItem('mps-theme') || 'light-navy', previewUrl: null, lastActivity: Date.now(), idleLocked: false, vaultType: 'file' };
  const screens = ['setupScreen', 'unlockScreen', 'workspace'];
  const dialogs = ['settingsDialog', 'createVaultDialog', 'switchVaultDialog', 'helpDialog', 'trashDialog', 'contextDialog', 'importDialog', 'exportDialog', 'passwordEntryDialog'];

  async function api(path, options = {}) {
    const headers = new Headers(options.headers || {});
    headers.set('X-MPS-Token', token);
    if (options.body && !(options.body instanceof FormData) && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
    const response = await fetch(path, { ...options, headers, cache: 'no-store' });
    const contentType = response.headers.get('content-type') || '';
    const data = contentType.includes('application/json') ? await response.json() : await response.blob();
    if (!response.ok) throw new Error(data.detail || data.message || `Request failed (${response.status})`);
    return data;
  }
  function showMessage(id, message, success = false) { const el = $(id); if (!el) return; el.textContent = message || ''; el.classList.toggle('success', !!success); }
  let toastTimer;
  function clearAllMessages() {
    document.querySelectorAll('.message').forEach(el => { el.textContent = ''; el.classList.remove('success'); });
    const toastEl = $('toast');
    if (toastEl) { toastEl.textContent = ''; toastEl.classList.remove('show'); }
    clearTimeout(toastTimer);
  }
  function toast(message) { const el = $('toast'); el.textContent = message; el.classList.add('show'); clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.remove('show'), 2600); }
  function showScreen(id) { clearAllMessages(); screens.forEach(s => $(s).classList.toggle('hidden', s !== id)); $('lockVaultButton').classList.toggle('hidden', id !== 'workspace'); $('switchVaultButton').classList.toggle('hidden', id !== 'workspace'); $('createVaultButton').classList.toggle('hidden', id !== 'workspace'); }
  function applyTheme(theme) { state.theme = theme; document.body.dataset.theme = theme; localStorage.setItem('mps-theme', theme); if ($('themeSelect')) $('themeSelect').value = theme; }
  function closePreviewUrl() { if (state.previewUrl) URL.revokeObjectURL(state.previewUrl); state.previewUrl = null; }
  function escapeHtml(value) { return String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
  async function refreshTree() {
    const data = await api('/api/tree');
    $('trashCount').textContent = data.trash_count;
    state.treeItems = data.items || [];
    setVaultType(data.vault_type || 'file');
    $('tree').innerHTML = '';
    if (state.vaultType === 'file') renderRootDropTarget($('tree'));
    renderTreeItems(state.treeItems, $('tree'), 0);
    if (state.selectedId) {
      const found = findEntry(data.items, state.selectedId);
      if (!found) { state.selectedId = null; state.selectedEntry = null; resetPreview(); }
      else state.selectedEntry = found;
    }
  }
  function findEntry(items, id) { for (const item of items) { if (item.id === id) return item; const found = findEntry(item.children || [], id); if (found) return found; } return null; }
  function renderRootDropTarget(container) {
    const row = document.createElement('div');
    row.className = 'tree-row tree-root-drop';
    row.dataset.id = '';
    row.tabIndex = 0;
    row.setAttribute('role', 'treeitem');
    row.setAttribute('aria-label', 'Vault root, drop files or folders here');
    row.setAttribute('aria-selected', 'false');
    const chevron = document.createElement('span'); chevron.className = 'tree-chevron'; chevron.textContent = '⌂';
    const icon = document.createElement('span'); icon.className = 'tree-icon folder-tree-icon';
    icon.innerHTML = '<svg viewBox="0 0 32 26" aria-hidden="true"><path d="M2.5 5.5A3 3 0 0 1 5.5 2.5h7l3 3h11A3 3 0 0 1 29.5 8.5v12a3 3 0 0 1-3 3h-21a3 3 0 0 1-3-3Z" fill="#e6b957" stroke="#b98527" stroke-width="1.5"/><path d="M2.5 10h27l-2.2 10.5a3 3 0 0 1-2.9 2.3H5.5a3 3 0 0 1-3-3Z" fill="#ffd978" stroke="#b98527" stroke-width="1.2"/></svg>';
    const label = document.createElement('span'); label.className = 'tree-name'; label.textContent = 'Vault root';
    const hint = document.createElement('span'); hint.className = 'tree-root-hint'; hint.textContent = 'Drop here';
    row.append(chevron, icon, label, hint);
    row.addEventListener('click', () => { state.selectedId = null; state.selectedEntry = null; updateTreeSelection(); resetPreview(); });
    container.append(row);
  }
  function renderTreeItems(items, container, depth) {
    items.forEach(item => {
      const wrapper = document.createElement('div');
      const row = document.createElement('div'); row.className = `tree-row${state.selectedId === item.id ? ' selected' : ''}`; row.dataset.id = item.id; row.tabIndex = 0; row.setAttribute('role', 'treeitem'); row.setAttribute('aria-selected', state.selectedId === item.id ? 'true' : 'false');
      const hasChildren = item.type === 'folder' && item.children && item.children.length;
      const expanded = state.expanded.has(item.id);
      const chevron = document.createElement('span'); chevron.className = 'tree-chevron'; chevron.textContent = item.type === 'folder' ? (item.locked ? '•' : (hasChildren ? (expanded ? '▾' : '▸') : '')) : '';
      const icon = document.createElement('span'); icon.className = `tree-icon${item.type === 'folder' && !item.locked ? ' folder-tree-icon' : ''}`;
      if (item.type === 'folder' && !item.locked) { icon.innerHTML = '<svg viewBox="0 0 32 26" aria-hidden="true"><path d="M2.5 5.5A3 3 0 0 1 5.5 2.5h7l3 3h11A3 3 0 0 1 29.5 8.5v12a3 3 0 0 1-3 3h-21a3 3 0 0 1-3-3Z" fill="#e6b957" stroke="#b98527" stroke-width="1.5"/><path d="M2.5 10h27l-2.2 10.5a3 3 0 0 1-2.9 2.3H5.5a3 3 0 0 1-3-3Z" fill="#ffd978" stroke="#b98527" stroke-width="1.2"/></svg>'; } else { icon.textContent = item.locked ? '🔒' : (item.type === 'password' ? '🔑' : '▤'); }
      const name = document.createElement('span'); name.className = 'tree-name'; name.textContent = item.name;
      row.append(chevron, icon, name);
      if (item.locked) { const lock = document.createElement('span'); lock.className = 'tree-icon'; lock.textContent = '•'; row.append(lock); }
      const more = document.createElement('button'); more.className = 'tree-more'; more.type = 'button'; more.title = 'Item actions'; more.setAttribute('aria-label', `Actions for ${item.name}`); more.textContent = '⋯'; more.addEventListener('click', e => { e.stopPropagation(); openContext(item); }); row.append(more);
      row.addEventListener('click', () => {
        row.focus({ preventScroll: true });
        if (item.locked) askUnlock(item);
        else if (item.type === 'folder') {
          selectFolder(item);
          if (state.expanded.has(item.id)) state.expanded.delete(item.id); else state.expanded.add(item.id);
          renderTreeItemsRoot(item.id);
        } else if (item.type === 'file') selectEntry(item);
        else if (item.type === 'password') selectPassword(item);
      });
      wrapper.append(row); container.append(wrapper);
      if (item.type === 'folder' && expanded && !item.locked && item.children?.length) { const children = document.createElement('div'); children.className = 'tree-children'; wrapper.append(children); renderTreeItems(item.children, children, depth + 1); }
    });
  }
  // Handle tree keyboard navigation at the stable tree container, not on
  // individual rows that are repeatedly destroyed and recreated during folder
  // expansion. Arrow navigation changes both the focused row and the selected
  // item, so the preview always follows the current keyboard selection.
  $('tree').addEventListener('keydown', event => {
    const row = event.target.closest('.tree-row');
    if (!row || event.target.closest('.tree-more')) return;
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    const rows = [...$('tree').querySelectorAll('.tree-row')];
    const index = rows.indexOf(row);
    const nextIndex = index + (event.key === 'ArrowDown' ? 1 : -1);
    if (index < 0 || nextIndex < 0 || nextIndex >= rows.length) return;
    const next = rows[nextIndex];
    const nextItem = findEntry(state.treeItems, next.dataset.id);
    if (!nextItem) return;
    event.preventDefault();
    next.focus({ preventScroll: true });
    next.scrollIntoView({ block: 'nearest' });
    selectTreeItem(nextItem);
  });

  function selectTreeItem(item) {
    if (item.locked) {
      state.selectedId = item.id; state.selectedEntry = item; updateTreeSelection();
      closePreviewUrl();
      $('previewTitle').textContent = item.name;
      $('previewEyebrow').textContent = 'LOCKED ITEM';
      $('previewActions').innerHTML = '';
      $('previewContent').className = 'preview-content empty-state';
      $('previewContent').innerHTML = '<div class="empty-icon">🔒</div><h3>Item locked</h3><p>Unlock this item to access its contents.</p>';
      askUnlock(item);
    } else if (item.type === 'folder') selectFolder(item);
    else if (item.type === 'file') selectEntry(item);
    else if (item.type === 'password') selectPassword(item);
  }
  async function renderTreeItemsRoot(focusId = state.selectedId) {
    await refreshTree();
    if (focusId) $('tree').querySelector(`.tree-row[data-id="${CSS.escape(focusId)}"]`)?.focus({ preventScroll: true });
  }
  function updateTreeSelection() {
    $('tree').querySelectorAll('.tree-row').forEach(row => {
      const selected = row.dataset.id === state.selectedId;
      row.classList.toggle('selected', selected);
      row.setAttribute('aria-selected', selected ? 'true' : 'false');
    });
  }
  function resetPreview() { closePreviewUrl(); state.selectedId = null; state.selectedEntry = null; updateTreeSelection(); $('previewTitle').textContent = 'Select a file'; $('previewEyebrow').textContent = 'PREVIEW'; $('previewActions').innerHTML = ''; $('previewContent').className = 'preview-content empty-state'; $('previewContent').innerHTML = '<div class="empty-icon">▧</div><h3>Your private space</h3><p>Select a file in the navigation tree to preview it here.</p>'; }
  function selectFolder(item) {
    closePreviewUrl(); state.selectedId = item.id; state.selectedEntry = item; updateTreeSelection();
    $('previewTitle').textContent = item.name; $('previewEyebrow').textContent = 'FOLDER'; $('previewActions').innerHTML = '';
    const content = $('previewContent'); content.className = 'preview-content folder-preview empty-state';
    content.innerHTML = '<svg class="folder-preview-art" viewBox="0 0 180 140" role="img" aria-label="Folder"><defs><linearGradient id="folderBack" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#ffe9a8"/><stop offset="1" stop-color="#e9ad39"/></linearGradient><linearGradient id="folderFront" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffd978"/><stop offset="1" stop-color="#f0b63f"/></linearGradient></defs><path d="M20 33a10 10 0 0 1 10-10h39l14 14h67a10 10 0 0 1 10 10v60a10 10 0 0 1-10 10H30a10 10 0 0 1-10-10Z" fill="url(#folderBack)" stroke="#c58b26" stroke-width="2.5"/><path d="M13 51a10 10 0 0 1 10-10h134a10 10 0 0 1 10 12l-11 59a10 10 0 0 1-10 8H24a10 10 0 0 1-10-12Z" fill="url(#folderFront)" stroke="#c58b26" stroke-width="2.5"/><path d="M36 66h107" stroke="#fff0c4" stroke-width="3" stroke-linecap="round" opacity=".9"/></svg><h3>Folder selected</h3><p>The previous file preview has been cleared. Select a file inside this folder to preview its contents.</p>';
  }
  async function selectPassword(item) {
    closePreviewUrl();
    state.selectedId = item.id; state.selectedEntry = item; updateTreeSelection();
    $('previewTitle').textContent = item.name;
    $('previewEyebrow').textContent = 'PASSWORD ENTRY';
    $('previewActions').innerHTML = '';
    const content = $('previewContent'); content.className = 'preview-content empty-state'; content.replaceChildren();
    const art = document.createElement('div'); art.className = 'password-entry-art'; art.textContent = '🔑';
    const heading = document.createElement('h3'); heading.textContent = item.name;
    const message = document.createElement('p'); message.textContent = 'The password is hidden until you choose Show.';
    const value = document.createElement('div'); value.className = 'password-value'; value.textContent = '***'; value.setAttribute('aria-label', 'Password hidden');
    const metadata = document.createElement('div'); metadata.className = 'password-meta-grid';
    const created = document.createElement('div'); created.className = 'password-meta-card';
    const createdLabel = document.createElement('span'); createdLabel.textContent = 'Created';
    const createdValue = document.createElement('strong'); createdValue.textContent = formatEntryTimestamp(item.created_at);
    created.append(createdLabel, createdValue);
    const updated = document.createElement('div'); updated.className = 'password-meta-card';
    const updatedLabel = document.createElement('span'); updatedLabel.textContent = 'Last Updated';
    const updatedValue = document.createElement('strong'); updatedValue.textContent = formatEntryTimestamp(item.updated_at);
    updated.append(updatedLabel, updatedValue);
    metadata.append(created, updated);
    const strength = document.createElement('section'); strength.className = 'password-strength';
    const strengthHeader = document.createElement('div'); strengthHeader.className = 'password-strength-header';
    const strengthLabel = document.createElement('strong'); strengthLabel.textContent = 'Password Strength';
    const strengthValue = document.createElement('span'); strengthValue.textContent = 'Assessing…';
    strengthHeader.append(strengthLabel, strengthValue);
    const strengthTrack = document.createElement('div'); strengthTrack.className = 'password-strength-track'; strengthTrack.setAttribute('role', 'meter'); strengthTrack.setAttribute('aria-label', 'Password strength'); strengthTrack.setAttribute('aria-valuemin', '0'); strengthTrack.setAttribute('aria-valuemax', '4'); strengthTrack.setAttribute('aria-valuenow', '0');
    const strengthFill = document.createElement('div'); strengthFill.className = 'password-strength-fill'; strengthTrack.append(strengthFill);
    const strengthFeedback = document.createElement('p'); strengthFeedback.className = 'password-strength-feedback'; strengthFeedback.textContent = 'Checking locally on this device…';
    strength.append(strengthHeader, strengthTrack, strengthFeedback);
    const actions = document.createElement('div'); actions.className = 'password-preview-actions';
    const show = document.createElement('button'); show.className = 'primary-button'; show.type = 'button'; show.textContent = 'Show';
    let revealed = false, secret = '';
    show.addEventListener('click', async () => {
      if (state.selectedId !== item.id) return;
      if (revealed) { secret = ''; value.textContent = '***'; value.setAttribute('aria-label', 'Password hidden'); show.textContent = 'Show'; revealed = false; return; }
      show.disabled = true;
      try { const result = await api(`/api/passwords/${encodeURIComponent(item.id)}/reveal`); if (state.selectedId !== item.id) return; secret = result.value; value.textContent = secret; value.setAttribute('aria-label', 'Password shown'); show.textContent = 'Hide'; revealed = true; }
      catch (e) { toast(e.message); }
      finally { show.disabled = false; }
    });
    const copy = document.createElement('button'); copy.className = 'secondary-button'; copy.type = 'button'; copy.textContent = 'Copy';
    copy.addEventListener('click', async () => { try { const result = await api(`/api/passwords/${encodeURIComponent(item.id)}/reveal`); if (state.selectedId !== item.id) return; await copySecret(result.value); toast('Password copied to clipboard.'); } catch(e) { toast(e.message); } });
    actions.append(show, copy); content.append(art, heading, message, value, metadata, strength, actions);
    api(`/api/passwords/${encodeURIComponent(item.id)}/strength`).then(result => {
      if (state.selectedId !== item.id) return;
      strengthValue.textContent = result.label;
      strengthTrack.setAttribute('aria-valuenow', String(result.score));
      strengthFill.style.width = `${(result.score / 4) * 100}%`;
      strengthFill.dataset.score = String(result.score);
      strengthFeedback.textContent = (result.feedback || []).join(' ');
    }).catch(() => {
      if (state.selectedId !== item.id) return;
      strengthValue.textContent = 'Unavailable';
      strengthFeedback.textContent = 'Strength could not be assessed.';
    });
  }
  function formatEntryTimestamp(value) {
    if (!value) return 'Not available';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return 'Not available';
    return new Intl.DateTimeFormat(undefined, {year:'numeric', month:'short', day:'numeric', hour:'numeric', minute:'2-digit'}).format(date);
  }
  async function copySecret(value) {
    if (navigator.clipboard?.writeText) {
      try { await navigator.clipboard.writeText(value); return; } catch {}
    }
    const temporary = document.createElement('textarea'); temporary.value = value; temporary.style.position = 'fixed'; temporary.style.opacity = '0'; document.body.append(temporary); temporary.select();
    const ok = document.execCommand('copy'); temporary.remove(); if (!ok) throw new Error('Clipboard access is unavailable in this browser.');
  }

  async function selectEntry(item) {
    state.selectedId = item.id; state.selectedEntry = item; updateTreeSelection();
    $('previewTitle').textContent = item.name; $('previewEyebrow').textContent = 'FILE PREVIEW'; $('previewActions').innerHTML = '';
    const lockButton = document.createElement('button'); lockButton.className = 'secondary-button'; lockButton.textContent = 'Lock'; lockButton.onclick = () => promptLock(item); $('previewActions').append(lockButton);
    $('previewContent').className = 'preview-content'; $('previewContent').innerHTML = '<div class="empty-state"><p>Loading preview…</p></div>';
    try {
      closePreviewUrl();
      const blob = await api(`/api/entries/${encodeURIComponent(item.id)}/preview`);
      if (state.selectedId !== item.id || state.selectedEntry?.type === 'folder') return;
      const mime = blob.type || item.mime || 'application/octet-stream';
      const content = $('previewContent'); content.innerHTML = '';
      const extension = item.name.split('.').pop().toLowerCase();
      if (['zip', 'docx'].includes(extension)) {
        closePreviewUrl();
        content.className = 'preview-content empty-state';
        const isZip = extension === 'zip';
        const accent = isZip ? '#b7791f' : '#2563a6';
        const icon = isZip
          ? '<svg class="unsupported-file-art" viewBox="0 0 120 140" role="img" aria-label="ZIP archive icon"><path d="M25 7h48l24 24v98a4 4 0 0 1-4 4H25a4 4 0 0 1-4-4V11a4 4 0 0 1 4-4Z" fill="#fff8e8" stroke="#b7791f" stroke-width="3"/><path d="M73 7v25h24" fill="#f5d89c" stroke="#b7791f" stroke-width="3"/><path d="M53 36h14v10H53zm0 12h14v10H53zm0 12h14v10H53zm0 12h14v10H53zm0 12h14v10H53z" fill="#b7791f"/><path d="M45 93h30v18H45z" rx="3" fill="#b7791f"/><text x="60" y="106" text-anchor="middle" font-size="10" font-weight="800" fill="#fff">ZIP</text></svg>'
          : '<svg class="unsupported-file-art" viewBox="0 0 120 140" role="img" aria-label="Word document icon"><path d="M25 7h48l24 24v98a4 4 0 0 1-4 4H25a4 4 0 0 1-4-4V11a4 4 0 0 1 4-4Z" fill="#edf5ff" stroke="#2563a6" stroke-width="3"/><path d="M73 7v25h24" fill="#c9def8" stroke="#2563a6" stroke-width="3"/><rect x="30" y="48" width="60" height="48" rx="5" fill="#2563a6"/><path d="m39 60 6 26 8-17 8 17 7-26" fill="none" stroke="#fff" stroke-width="5" stroke-linejoin="round"/><path d="M37 107h46M37 116h36" stroke="#8ab4e6" stroke-width="3" stroke-linecap="round"/></svg>';
        content.innerHTML = `${icon}<h3>${isZip ? 'ZIP archive' : 'Word document'} selected</h3><p>This file cannot be previewed in My Private Space. To view its contents, open it with a compatible application after exporting or decrypting it.</p>`;
      } else {
        state.previewUrl = URL.createObjectURL(blob);
      }
      if (['zip', 'docx'].includes(extension)) { await refreshTree(); return; }
      if (mime.startsWith('image/') && mime !== 'image/svg+xml') { const img = document.createElement('img'); img.className = 'preview-image'; img.alt = item.name; img.src = state.previewUrl; content.append(img); }
      else if (mime === 'application/pdf') { const frame = document.createElement('iframe'); frame.className = 'preview-frame'; frame.title = item.name; frame.src = state.previewUrl + '#toolbar=0&navpanes=0'; content.append(frame); }
      else if (mime.startsWith('audio/')) { const media = document.createElement('audio'); media.className = 'preview-media'; media.controls = true; media.src = state.previewUrl; content.append(media); }
      else if (mime.startsWith('video/')) { const media = document.createElement('video'); media.className = 'preview-media'; media.controls = true; media.autoplay = true; media.muted = true; media.playsInline = true; media.src = state.previewUrl; content.append(media); }
      else if (mime.startsWith('text/') || mime === 'image/svg+xml' || /json|xml|javascript|markdown/.test(mime) || /\.(txt|md|csv|log|json|ya?ml|xml|py|js|css|toml|ini)$/i.test(item.name)) {
        const text = await blob.text(); if (state.selectedId !== item.id || state.selectedEntry?.type === 'folder') return; const pre = document.createElement('pre'); pre.className = 'preview-text'; pre.textContent = text; content.append(pre);
      } else { content.className = 'preview-content empty-state'; content.innerHTML = '<div class="empty-icon">▤</div><h3>Preview unavailable</h3><p>This file type is stored encrypted but has no built-in preview.</p>'; }
      await refreshTree();
    } catch (error) { if (state.selectedId !== item.id || state.selectedEntry?.type === 'folder') return; $('previewContent').className = 'preview-content empty-state'; $('previewContent').innerHTML = `<div class="empty-icon">⚠</div><h3>Preview unavailable</h3><p>${escapeHtml(error.message)}</p>`; }
  }
  function openContext(item) {
    $('contextTitle').textContent = item.name;
    const actions = $('contextActions'); actions.innerHTML = '';
    const add = (label, fn, danger = false) => { const button = document.createElement('button'); button.className = `action-item${danger ? ' danger' : ''}`; button.textContent = label; button.onclick = async () => { $('contextDialog').close(); try { await fn(); } catch (e) { toast(e.message); } }; actions.append(button); };
    if (item.type === 'password') {
      add('Update password…', () => openPasswordEditor(item));
      add('Copy password', async () => { const result = await api(`/api/passwords/${encodeURIComponent(item.id)}/reveal`); await copySecret(result.value); toast('Password copied to clipboard.'); });
      add('Delete (move to Deleted Items)', async () => { if (confirm(`Move “${item.name}” to Deleted Items?`)) { await api(`/api/entries/${encodeURIComponent(item.id)}`, {method:'DELETE'}); if (state.selectedId === item.id) resetPreview(); await refreshTree(); toast('Moved to Deleted Items.'); } }, true);
    } else if (item.locked) add('Unlock…', () => askUnlock(item));
    else {
      if (item.type === 'folder') { add('Add files…', () => openImport(item.id, false)); add('Add folder…', () => openImport(item.id, true)); }
      add('Restore copy to computer…', () => openExport(item));
      add('Lock with secondary password…', () => promptLock(item));
      add('Delete (move to Deleted Items)', async () => { if (confirm(`Move “${item.name}” to Deleted Items?`)) { await api(`/api/entries/${item.id}`, {method:'DELETE'}); if (state.selectedId === item.id) resetPreview(); await refreshTree(); toast('Moved to Deleted Items.'); } }, true);
    }
    $('contextDialog').showModal();
  }
  let exportItem = null;
  function openExport(item) {
    exportItem = item;
    $('exportTitle').textContent = `Restore “${item.name}” outside the vault`;
    $('exportDestination').value = '';
    $('exportOverwrite').checked = false;
    $('exportDeleteSource').checked = false;
    showMessage('exportMessage', '');
    $('exportDialog').showModal();
  }
  $('startExportButton').addEventListener('click', async () => {
    if (!exportItem) return;
    const destination_directory = $('exportDestination').value.trim();
    if (!destination_directory) { showMessage('exportMessage', 'Enter an existing destination directory path.'); return; }
    const overwrite_existing = $('exportOverwrite').checked;
    const delete_from_vault = $('exportDeleteSource').checked;
    if (delete_from_vault && !confirm('After restoration succeeds, move the encrypted vault item to Deleted Items? You can permanently delete it later from there.')) return;
    const button = $('startExportButton'); button.disabled = true;
    try {
      const result = await api(`/api/entries/${encodeURIComponent(exportItem.id)}/export`, {method:'POST', body:JSON.stringify({destination_directory, overwrite_existing, delete_from_vault})});
      $('exportDialog').close();
      if (delete_from_vault) { state.selectedId = null; state.selectedEntry = null; resetPreview(); }
      await refreshTree();
      toast(delete_from_vault ? 'Restored successfully; encrypted vault copy moved to Deleted Items.' : 'Restored copy successfully.');
    } catch (e) { showMessage('exportMessage', e.message); }
    finally { button.disabled = false; }
  });

  async function promptLock(item) {
    const password = prompt(`Choose a secondary password (exactly 8 characters) to lock “${item.name}”.`);
    if (password === null) return;
    try { await api(`/api/entries/${item.id}/lock`, {method:'POST', body:JSON.stringify({password})}); await refreshTree(); if (state.selectedId === item.id) resetPreview(); toast('Item locked.'); }
    catch (e) { toast(e.message); }
  }
  async function askUnlock(item) {
    const password = prompt(`Enter the secondary password to unlock “${item.name}”.`);
    if (password === null) return;
    try { const result = await api(`/api/entries/${item.id}/unlock`, {method:'POST', body:JSON.stringify({password})}); await refreshTree(); toast('Item unlocked.'); if (item.type === 'file') { const found = findEntry((await api('/api/tree')).items, item.id); if (found) await selectEntry(found); } }
    catch (e) { toast(e.message); }
  }
  let editingPasswordId = null;
  function openPasswordEditor(item = null) {
    editingPasswordId = item?.id || null;
    $('passwordEntryDialogTitle').textContent = item ? 'Update password' : 'Add password';
    $('savePasswordEntryButton').textContent = item ? 'Update password' : 'Save password';
    $('passwordEntryName').value = item?.name || '';
    $('passwordEntryValue').value = '';
    $('passwordEntryValue').placeholder = item ? 'Enter the new password value' : 'Enter the password value';
    showMessage('passwordEntryMessage', item ? 'Enter a new value to replace the existing password.' : '');
    $('passwordEntryDialog').showModal();
    $('passwordEntryName').focus();
  }
  async function savePasswordEntry() {
    const name = $('passwordEntryName').value.trim(), value = $('passwordEntryValue').value;
    if (!name || !value) { showMessage('passwordEntryMessage', 'Name and password value are required.'); return; }
    const button = $('savePasswordEntryButton'); button.disabled = true;
    try {
      const editingId = editingPasswordId;
      const result = await api(editingId ? `/api/passwords/${encodeURIComponent(editingId)}` : '/api/passwords', {method: editingId ? 'PUT' : 'POST', body: JSON.stringify({name, value})});
      $('passwordEntryDialog').close(); $('passwordEntryValue').value = '';
      await refreshTree();
      const item = findEntry(state.treeItems, result.id || editingId);
      if (item) await selectPassword(item);
      toast(editingId ? 'Password updated.' : 'Password added.');
    } catch (e) { showMessage('passwordEntryMessage', e.message); }
    finally { button.disabled = false; }
  }

  function selectedImportTarget() {
    if (!state.selectedId) return { id: '', path: 'Root' };
    let match = null;
    function walk(items, ancestors) {
      for (const item of items || []) {
        const itemAncestors = [...ancestors, item];
        if (item.id === state.selectedId) {
          if (item.type === 'folder') {
            match = { id: item.id, path: itemAncestors.map(entry => entry.name).join(' / ') };
          } else {
            const parent = ancestors[ancestors.length - 1];
            match = { id: parent?.id || '', path: ancestors.length ? ancestors.map(entry => entry.name).join(' / ') : 'Root' };
          }
          return true;
        }
        if (walk(item.children || [], itemAncestors)) return true;
      }
      return false;
    }
    walk(state.treeItems, []);
    return match || { id: '', path: 'Root' };
  }
  function openImport(parentId = null, folderMode = null) {
    if (state.vaultType !== 'file') { toast('File and folder imports are only available in file vaults.'); return; }
    const target = parentId === null ? selectedImportTarget() : null;
    state.importParent = parentId === null ? (target.id || '') : parentId;
    let destinationPath = target?.path || 'Root';
    if (parentId !== null && parentId !== '') {
      let found = null;
      function walk(items, ancestors) {
        for (const item of items || []) {
          const path = [...ancestors, item];
          if (item.id === parentId) { found = path.map(entry => entry.name).join(' / '); return true; }
          if (walk(item.children || [], path)) return true;
        }
        return false;
      }
      walk(state.treeItems, []);
      destinationPath = found || 'Root';
    }
    $('importTargetLocation').textContent = destinationPath;
    $('filePicker').value = ''; $('folderPicker').value = '';
    $('filePicker').classList.toggle('hidden', folderMode === true); $('folderPicker').classList.toggle('hidden', folderMode === false);
    $('importTitle').textContent = folderMode === true ? 'Add a folder' : (folderMode === false ? 'Add files' : 'Add files or folder'); showMessage('importMessage', ''); $('importDialog').showModal();
  }
  async function collectDroppedFiles(dataTransfer) {
    const collected = [];
    const readEntry = (entry, relativePath = '') => new Promise((resolve, reject) => {
      if (entry.isFile) {
        entry.file(file => { collected.push({file, path: relativePath ? `${relativePath}/${file.name}` : file.name}); resolve(); }, reject);
      } else if (entry.isDirectory) {
        const reader = entry.createReader();
        const childPath = relativePath ? `${relativePath}/${entry.name}` : entry.name;
        const readBatch = () => reader.readEntries(async entries => {
          if (!entries.length) { resolve(); return; }
          try { for (const child of entries) await readEntry(child, childPath); readBatch(); }
          catch (error) { reject(error); }
        }, reject);
        readBatch();
      } else resolve();
    });
    const transferItems = Array.from(dataTransfer?.items || []).filter(item => item.kind === 'file');
    let usedEntries = false;
    for (const item of transferItems) {
      const entry = item.webkitGetAsEntry?.() || item.getAsEntry?.();
      if (entry) { usedEntries = true; await readEntry(entry); }
    }
    if (!usedEntries) {
      for (const file of Array.from(dataTransfer?.files || [])) collected.push({file, path: file.webkitRelativePath || file.name});
    }
    return collected;
  }
  function itemPathAndParent(targetId) {
    let result = null;
    function walk(items, ancestors) {
      for (const item of items || []) {
        const path = [...ancestors, item];
        if (item.id === targetId) {
          if (item.type === 'folder') result = {id: item.id, path: path.map(x => x.name).join(' / '), item};
          else result = {id: ancestors.length ? ancestors[ancestors.length - 1].id : '', path: ancestors.length ? ancestors.map(x => x.name).join(' / ') : 'Root', item};
          return true;
        }
        if (walk(item.children || [], path)) return true;
      }
      return false;
    }
    walk(state.treeItems, []);
    return result || {id: '', path: 'Root', item: null};
  }
  function dropTargetForEvent(event) {
    const row = event.target.closest?.('.tree-row');
    if (row?.classList.contains('tree-root-drop')) return {id: '', path: 'Root', item: null};
    if (row) return itemPathAndParent(row.dataset.id);
    return {id: '', path: 'Root', item: null};
  }
  async function performImport(items, parentId, destinationPath) {
    if (state.vaultType !== 'file') { toast('Drag-and-drop imports are available only in file vaults.'); return; }
    if (!items.length) { toast('No files or folders were found in that drop.'); return; }
    const data = new FormData(); data.append('parent_id', parentId || '');
    data.append('relative_paths', JSON.stringify(items.map(item => item.path || item.file.webkitRelativePath || item.file.name)));
    items.forEach(item => data.append('files', item.file, item.file.name));
    showMessage('importMessage', `Importing ${items.length} file(s) to ${destinationPath || 'Root'}…`);
    const button = $('startImportButton'); button.disabled = true;
    try {
      const result = await api('/api/import/files', {method:'POST', body:data});
      if ($('importDialog').open) $('importDialog').close();
      await refreshTree();
      toast(`Imported ${result.imported} file(s) to ${destinationPath || 'Root'}.`);
    } catch (e) {
      if ($('importDialog').open) showMessage('importMessage', e.message); else toast(e.message);
    } finally { button.disabled = false; }
  }
  async function runImport() {
    const selected = [...(!$('filePicker').classList.contains('hidden') ? Array.from($('filePicker').files) : []), ...(!$('folderPicker').classList.contains('hidden') ? Array.from($('folderPicker').files) : [])];
    if (!selected.length) { showMessage('importMessage', 'Choose files or a folder, or drop them into the area above.'); return; }
    const target = {id: state.importParent || '', path: $('importTargetLocation').textContent || 'Root'};
    await performImport(selected.map(file => ({file, path: file.webkitRelativePath || file.name})), target.id, target.path);
  }
  const importDropZone = $('importDropZone');
  importDropZone.addEventListener('dragover', event => { event.preventDefault(); importDropZone.classList.add('drag-active'); });
  importDropZone.addEventListener('dragleave', event => { if (!importDropZone.contains(event.relatedTarget)) importDropZone.classList.remove('drag-active'); });
  importDropZone.addEventListener('drop', async event => {
    event.preventDefault(); event.stopPropagation(); importDropZone.classList.remove('drag-active');
    try { const items = await collectDroppedFiles(event.dataTransfer); await performImport(items, state.importParent || '', $('importTargetLocation').textContent || 'Root'); }
    catch (error) { showMessage('importMessage', `Could not read the dropped files or folders: ${error.message}`); }
  });
  const sidebarDropSurface = $('tree').parentElement;
  sidebarDropSurface.addEventListener('dragover', event => {
    if (state.vaultType !== 'file' || !(Array.from(event.dataTransfer?.types || []).includes('Files'))) return;
    event.preventDefault();
    sidebarDropSurface.classList.add('drag-active');
    $('tree').querySelectorAll('.tree-row.drop-target').forEach(row => row.classList.remove('drop-target'));
    const row = event.target.closest?.('.tree-row'); if (row) row.classList.add('drop-target'); else $('tree').querySelector('.tree-root-drop')?.classList.add('drop-target');
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy';
  });
  sidebarDropSurface.addEventListener('dragleave', event => {
    if (!sidebarDropSurface.contains(event.relatedTarget)) {
      sidebarDropSurface.classList.remove('drag-active');
      $('tree').querySelectorAll('.tree-row.drop-target').forEach(row => row.classList.remove('drop-target'));
    }
  });
  sidebarDropSurface.addEventListener('drop', async event => {
    if (event.target.closest?.('#importDropZone')) return;
    if (!(Array.from(event.dataTransfer?.types || []).includes('Files'))) return;
    event.preventDefault();
    sidebarDropSurface.classList.remove('drag-active');
    $('tree').querySelectorAll('.tree-row.drop-target').forEach(row => row.classList.remove('drop-target'));
    if (state.vaultType !== 'file') { toast('Drag-and-drop files and folders are available only in file vaults.'); return; }
    const target = dropTargetForEvent(event);
    if (target.item?.locked) { toast('Unlock this folder before importing into it.'); return; }
    try { const items = await collectDroppedFiles(event.dataTransfer); await performImport(items, target.id || '', target.path || 'Root'); }
    catch (error) { toast(`Could not read the dropped files or folders: ${error.message}`); }
  });
  async function showTrash() {
    const data = await api('/api/trash'); const list = $('trashList'); list.innerHTML = '';
    if (!data.items.length) { list.innerHTML = '<div class="empty-state"><div class="empty-icon">▤</div><h3>Nothing deleted</h3><p>Items you delete will appear here.</p></div>'; }
    for (const item of data.items) {
      const row = document.createElement('div'); row.className = 'trash-row';
      const meta = document.createElement('div'); meta.className = 'trash-meta';
      const name = document.createElement('div'); name.className = 'trash-name'; name.textContent = `${item.type === 'folder' ? '▰' : (item.type === 'password' ? '🔑' : '▤')} ${item.name}`;
      const date = document.createElement('div'); date.className = 'trash-date'; date.textContent = item.deleted_at ? new Date(item.deleted_at).toLocaleString() : 'Deleted'; meta.append(name, date);
      const buttons = document.createElement('div'); buttons.className = 'trash-buttons';
      const restore = document.createElement('button'); restore.className = 'secondary-button'; restore.textContent = 'Restore'; restore.onclick = async () => { try { await api(`/api/entries/${item.id}/restore`, {method:'POST',body:JSON.stringify({})}); await showTrash(); await refreshTree(); toast('Item restored.'); } catch(e) { toast(e.message); } };
      const remove = document.createElement('button'); remove.className = 'secondary-button'; remove.textContent = 'Delete forever'; remove.onclick = async () => { if (!confirm(`Permanently delete “${item.name}” and its contents? This cannot be undone.`)) return; try { await api(`/api/trash/${item.id}?confirm=true`, {method:'DELETE'}); await showTrash(); await refreshTree(); toast('Permanently deleted.'); } catch(e) { toast(e.message); } };
      buttons.append(restore, remove); row.append(meta, buttons); list.append(row);
    }
    $('trashDialog').showModal();
  }
  async function loadSettings() { const s = await api('/api/settings'); $('newTargetDirectory').value = s.target_directory; $('themeSelect').value = state.theme; $('settingsVaultLabel').textContent = s.vault_label || ''; $('settingsVaultPrefix').textContent = s.prefix || '(legacy vault; no prefix)'; }
  async function moveVault() {
    const target = $('newTargetDirectory').value.trim(); if (!target) { showMessage('settingsMessage', 'Enter a destination directory.'); return; }
    if (!confirm('Copy and verify the vault in the destination directory? The original will remain intact.')) return;
    try { await api('/api/settings/target', {method:'POST', body:JSON.stringify({target_directory:target})}); showMessage('settingsMessage', 'Vault copied and location switched.', true); toast('Vault location updated.'); }
    catch(e) { showMessage('settingsMessage', e.message); }
  }
  async function changePassword() {
    const current_password = $('currentPassword').value, new_password = $('newPassword').value, confirm_password = $('confirmNewPassword').value;
    try { await api('/api/settings/password', {method:'POST',body:JSON.stringify({current_password,new_password,confirm_password})}); ['currentPassword','newPassword','confirmNewPassword'].forEach(id => $(id).value=''); showMessage('settingsMessage','Main password changed.',true); toast('Main password changed.'); }
    catch(e) { showMessage('settingsMessage',e.message); }
  }
  // Deterrents against casual saving; these cannot stop screenshots, developer tools, or network capture.
  document.addEventListener('contextmenu', event => {
    if (event.target.closest('#previewContent')) event.preventDefault();
  });
  document.addEventListener('dragstart', event => {
    if (event.target.closest('#previewContent')) event.preventDefault();
  });
  document.addEventListener('keydown', event => {
    if (event.target.closest('#previewContent') && (event.ctrlKey || event.metaKey) && ['s', 'p', 'u'].includes(event.key.toLowerCase())) event.preventDefault();
  });

  function setVaultLabel(label) { $('sidebarVaultLabel').textContent = label || 'Vault locked'; }
  function setVaultType(type) {
    state.vaultType = type === 'password' ? 'password' : 'file';
    $('importRootButton').classList.toggle('hidden', state.vaultType !== 'file');
    $('addPasswordButton').classList.toggle('hidden', state.vaultType !== 'password');
    $('tree').setAttribute('aria-label', state.vaultType === 'password' ? 'Saved passwords' : 'Vault files and folders');
    $('previewTitle').dataset.vaultType = state.vaultType;
  }
  function populateVaultPicker(vaults, selectId = 'vaultSelect') { const select = $(selectId); select.innerHTML = ''; for (const vault of vaults) { const option = document.createElement('option'); option.value = vault.id; option.textContent = `${vault.label} · ${vault.type === 'password' ? 'Password vault' : 'File vault'}`; select.append(option); } }
  async function openSelectedVault() { try { const result = await api('/api/vaults/select', {method:'POST', body:JSON.stringify({vault_id:$('vaultSelect').value})}); state.unlocked = true; resetIdleClock(); setVaultLabel(result.vault_label); $('vaultPicker').classList.add('hidden'); $('unlockForm').classList.remove('hidden'); showScreen('workspace'); resetPreview(); await refreshTree(); toast(`Opened ${result.vault_label}.`); } catch(e) { showMessage('unlockMessage', e.message); } }
  function updateVaultManagementButtons(settings) {
    const vaults = Array.isArray(settings?.vaults) ? settings.vaults : [];
    const selectedId = $('managedVaultSelect').value;
    const active = vaults.find(v => v.label === settings?.vault_label);
    const selectedIsActive = !!active && selectedId === active.id;
    // Switching to the already active vault is a no-op, so only enable Switch
    // after the user selects a different vault.
    $('switchToVaultButton').disabled = !selectedId || selectedIsActive;
    // Remove must remain available regardless of the selected vault.
    $('removeVaultButton').disabled = false;
  }
  async function openVaultManagement() {
    try {
      const settings = await api('/api/settings');
      populateVaultPicker(settings.vaults || [], 'managedVaultSelect');
      const active = (settings.vaults || []).find(v => v.id && v.label === settings.vault_label);
      if (active) $('managedVaultSelect').value = active.id;
      showMessage('vaultManagementMessage', '');
      updateVaultManagementButtons(settings);
      $('switchVaultDialog').showModal();
    } catch (e) { toast(e.message); }
  }
  async function switchToManagedVault() {
    const vaultId = $('managedVaultSelect').value;
    if (!vaultId) return;
    try {
      const result = await api('/api/vaults/select', {method:'POST', body:JSON.stringify({vault_id:vaultId})});
      $('switchVaultDialog').close(); state.unlocked = true; resetIdleClock(); setVaultLabel(result.vault_label);
      resetPreview(); await refreshTree(); toast(`Switched to ${result.vault_label}.`);
    } catch (e) { showMessage('vaultManagementMessage', e.message); }
  }
  async function removeManagedVault() {
    const select = $('managedVaultSelect'); const vaultId = select.value;
    if (!vaultId) return;
    const label = select.options[select.selectedIndex]?.textContent || 'this vault';
    if (!confirm(`Remove “${label}” from the vault list? Its encrypted directory and contents will be preserved.`)) return;
    try {
      const result = await api('/api/vaults/remove', {method:'POST', body:JSON.stringify({vault_id:vaultId})});
      if (result.requires_setup) {
        $('switchVaultDialog').close();
        localStorage.removeItem('mps-session-locked');
        clearSensitiveUi();
        showScreen('setupScreen');
        showMessage('setupMessage', `Removed “${result.removed_label}” from the registry. Its encrypted directory and contents were preserved. Configure a vault to continue.`, true);
        toast('No registered vaults remain. Configure a vault to continue.');
        return;
      }
      populateVaultPicker(result.vaults, 'managedVaultSelect');
      showMessage('vaultManagementMessage', `Removed “${result.removed_label}” from the list. Its encrypted directory was preserved.`, true);
      const settings = await api('/api/settings');
      const active = (settings.vaults || []).find(v => v.label === settings.vault_label);
      if (active) select.value = active.id;
      if (result.active_vault_changed && result.active_vault_label) {
        setVaultLabel(result.active_vault_label);
        resetPreview();
        await refreshTree();
      }
      updateVaultManagementButtons(settings);
      toast(`Removed ${result.removed_label} from the list.`);
    } catch (e) { showMessage('vaultManagementMessage', e.message); }
  }
  function syncCreateVaultTypeOptions() { const isPassword = $('createVaultType').value === 'password'; const conversionLabel = $('convertExistingFolder').closest('label'); conversionLabel.classList.toggle('hidden', isPassword); if (isPassword) $('convertExistingFolder').checked = false; }
  function openCreateVault() { $('createVaultType').value='file'; $('createVaultLabel').value=''; $('createVaultDirectory').value=''; $('createVaultPrefix').value=''; $('convertExistingFolder').checked=false; $('createManageVisibility').checked=false; syncCreateVaultTypeOptions(); showMessage('createVaultMessage',''); $('createVaultDialog').showModal(); }
  async function createVault() { const label=$('createVaultLabel').value.trim(), target_directory=$('createVaultDirectory').value.trim(), prefix=$('createVaultPrefix').value.trim(), convert_existing=$('convertExistingFolder').checked, manage_visibility=$('createManageVisibility').checked, vault_type=$('createVaultType').value; if (!label || !target_directory || !prefix) { showMessage('createVaultMessage','Vault label, destination folder, and storage prefix are required.'); return; } if (convert_existing && !confirm('Convert this ordinary non-empty folder into encrypted vault storage? Files will be encrypted and the originals retained until staging and verification succeed. Continue?')) return; const button=$('confirmCreateVaultButton'); button.disabled=true; try { const result=await api('/api/vaults/create',{method:'POST',body:JSON.stringify({label,target_directory,prefix,convert_existing,manage_visibility,vault_type})}); $('createVaultDialog').close(); localStorage.removeItem('mps-session-locked'); state.unlocked=true; resetIdleClock(); setVaultLabel(result.vault_label); $('vaultPicker').classList.add('hidden'); $('unlockForm').classList.remove('hidden'); showScreen('workspace'); resetPreview(); await refreshTree(); toast(`Created and opened ${result.vault_label}.`); } catch(e) { showMessage('createVaultMessage',e.message); } finally { button.disabled=false; } }
  async function boot() {
    applyTheme(state.theme);
    try {
      const status = await api('/api/status');
      if (!status.configured) showScreen('setupScreen');
      else if (status.lockout_remaining > 0) { showScreen('unlockScreen'); showMessage('unlockMessage', `Login locked. Try again in ${status.lockout_remaining} seconds.`); }
      else if (status.unlocked) { state.unlocked = true; state.lastActivity = Date.now() - Math.max(0, 300000 - (status.idle_remaining * 1000)); showScreen('workspace'); await refreshTree(); }
      else showScreen('unlockScreen');
    } catch(e) { showScreen('unlockScreen'); showMessage('unlockMessage', e.message); }
  }
  $('setupForm').addEventListener('submit', async e => {
    e.preventDefault(); showMessage('setupMessage','Creating encrypted vault…');
    try { const result = await api('/api/setup',{method:'POST',body:JSON.stringify({label:$('setupVaultLabel').value.trim(),prefix:$('setupPrefix').value.trim(),target_directory:$('targetDirectory').value.trim(),manage_visibility:$('setupManageVisibility').checked,vault_type:$('setupVaultType').value,password:$('setupPassword').value,confirm_password:$('setupConfirm').value})}); $('setupPassword').value=''; $('setupConfirm').value=''; state.unlocked=true; resetIdleClock(); setVaultLabel(result.vault_label); setVaultType(result.vault_type || $('setupVaultType').value); showScreen('workspace'); await refreshTree(); toast('Vault created.'); }
    catch(error) { showMessage('setupMessage',error.message); }
  });
  $('unlockForm').addEventListener('submit', async e => {
    e.preventDefault(); showMessage('unlockMessage','Unlocking…');
    try { const result = await api('/api/unlock',{method:'POST',body:JSON.stringify({password:$('unlockPassword').value,resume_last_used:!!localStorage.getItem('mps-session-locked')})}); $('unlockPassword').value=''; if (!result.selected) { localStorage.removeItem('mps-session-locked'); resetIdleClock(); populateVaultPicker(result.vaults); $('vaultPicker').classList.remove('hidden'); $('unlockForm').classList.add('hidden'); showMessage('unlockMessage','Password accepted. Select a vault to continue.',true); return; } state.unlocked=true; resetIdleClock(); setVaultLabel(result.vault_label); $('vaultPicker').classList.add('hidden'); $('unlockForm').classList.remove('hidden'); showScreen('workspace'); resetPreview(); await refreshTree(); toast('Vault unlocked.'); }
    catch(error) { showMessage('unlockMessage',error.message); }
  });
  $('lockVaultButton').addEventListener('click', async () => { if (!confirm('Lock My Private Space now?')) return; try { await api('/api/lock',{method:'POST'}); localStorage.setItem('mps-session-locked', String(Date.now())); clearSensitiveUi(); toast('Vault locked.'); } catch(e) { toast(e.message); } });
  $('openSelectedVaultButton').addEventListener('click', openSelectedVault);
  $('switchVaultButton').addEventListener('click', openVaultManagement);
  $('switchToVaultButton').addEventListener('click', switchToManagedVault);
  $('removeVaultButton').addEventListener('click', removeManagedVault);
  $('managedVaultSelect').addEventListener('change', async () => { try { const settings = await api('/api/settings'); updateVaultManagementButtons(settings); } catch {} });
  $('createVaultFromLoginButton').addEventListener('click', openCreateVault);
  $('createVaultButton').addEventListener('click', openCreateVault);
  $('createVaultSettingsButton').addEventListener('click', openCreateVault);
  $('confirmCreateVaultButton').addEventListener('click', createVault);
  $('settingsButton').addEventListener('click', async () => { if (!state.unlocked) { toast('Unlock the vault to change settings.'); return; } try { await loadSettings(); showMessage('settingsMessage',''); $('settingsDialog').showModal(); } catch(e) { toast(e.message); } });
  $('helpButton').addEventListener('click', () => $('helpDialog').showModal());
  $('aboutButton').addEventListener('click', () => $('aboutDialog').showModal());
  $('refreshButton').addEventListener('click', () => refreshTree().catch(e => toast(e.message)));
  $('trashButton').addEventListener('click', () => showTrash().catch(e => toast(e.message)));
  $('importRootButton').addEventListener('click', () => openImport(null, null));
  $('addPasswordButton').addEventListener('click', () => openPasswordEditor());
  $('savePasswordEntryButton').addEventListener('click', savePasswordEntry);
  $('createVaultType').addEventListener('change', syncCreateVaultTypeOptions);
  $('startImportButton').addEventListener('click', runImport);
  $('themeSelect').addEventListener('change', async () => { applyTheme($('themeSelect').value); try { await api('/api/settings',{method:'PUT',body:JSON.stringify({theme:state.theme})}); } catch(e) { toast(e.message); } });
  $('moveVaultButton').addEventListener('click', moveVault);
  $('changePasswordButton').addEventListener('click', changePassword);
  for (const dialog of dialogs) $(dialog).addEventListener('click', e => { if (e.target === $(dialog)) $(dialog).close(); });
  let lastActivityPing = 0;
  function resetIdleClock() {
    state.lastActivity = Date.now();
    lastActivityPing = state.lastActivity;
    try {
      localStorage.setItem('mps-last-activity', String(state.lastActivity));
    } catch {}
  }
  function hasLocalSession() { return state.unlocked || !$('vaultPicker').classList.contains('hidden'); }
  const activityEvents = ['pointerdown','keydown','mousemove','touchstart','wheel'];
  activityEvents.forEach(name => document.addEventListener(name, () => {
    state.lastActivity = Date.now();
    try {
      if (Date.now() - (state.lastBroadcast || 0) > 1000) {
        localStorage.setItem('mps-last-activity', String(state.lastActivity));
        state.lastBroadcast = Date.now();
      }
    } catch {}
    // Tell the backend about genuine activity, rather than keeping the session alive
    // with unconditional 15-second heartbeats while the user is idle.
    if (hasLocalSession() && Date.now() - lastActivityPing >= 2000) {
      lastActivityPing = Date.now();
      api('/api/activity', {method:'POST'}).catch(() => clearSensitiveUi());
    }
  }, {passive:true}));
  window.addEventListener('storage', event => { if (event.key === 'mps-last-activity' && Number(event.newValue)) state.lastActivity = Math.max(state.lastActivity, Number(event.newValue)); });
  function clearSensitiveUi() {
    clearAllMessages();
    closePreviewUrl();
    document.querySelectorAll('#previewContent audio, #previewContent video').forEach(m => { try { m.pause(); m.removeAttribute('src'); m.load(); } catch {} });
    document.querySelectorAll('dialog[open]').forEach(dialog => { try { dialog.close(); } catch {} });
    $('tree').replaceChildren(); state.selectedId=null; state.selectedEntry=null; state.importParent=''; state.expanded.clear(); state.unlocked=false;
    setVaultLabel(''); $('unlockPassword').value=''; $('vaultPicker').replaceChildren(); $('managedVaultSelect').replaceChildren();
    $('settingsVaultLabel').textContent=''; $('settingsVaultPrefix').textContent=''; $('newTargetDirectory').value='';
    $('vaultPicker').classList.add('hidden'); $('unlockForm').classList.remove('hidden'); resetPreview(); showMessage('unlockMessage', ''); showScreen('unlockScreen');
  }
  setInterval(() => {
    try { state.lastActivity = Math.max(state.lastActivity, Number(localStorage.getItem('mps-last-activity') || 0)); } catch {}
    const hasSession = hasLocalSession();
    const idleFor = Date.now() - state.lastActivity;
    if (hasSession && idleFor >= 300000) {
      // The backend independently enforces the same deadline before protected calls.
      api('/api/lock',{method:'POST'}).catch(()=>{}).finally(() => {
        try { localStorage.setItem('mps-session-locked', String(Date.now())); } catch {}
        clearSensitiveUi();
      });
    }
    if (!state.unlocked) api('/api/status').then(s => { if (s.lockout_remaining > 0) showMessage('unlockMessage', `Login locked. Try again in ${s.lockout_remaining} seconds.`); }).catch(()=>{});
  }, 1000);
  window.addEventListener('storage', event => { if (event.key === 'mps-session-locked') clearSensitiveUi(); });
  const originalLockClick = $('lockVaultButton').onclick;
  window.addEventListener('pagehide', () => { closePreviewUrl(); document.querySelectorAll('audio,video').forEach(m => { try { m.pause(); } catch {} }); });
  boot();
})();
