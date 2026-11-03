(() => {
  'use strict';
  const token = document.querySelector('meta[name="mps-token"]').content;
  const $ = (id) => document.getElementById(id);
  const state = { vaultLabel: '', unlocked: false, selectedId: null, selectedEntry: null, importParent: '', treeItems: [], expanded: new Set(), theme: localStorage.getItem('mps-theme') || 'light-navy', previewUrl: null, lastActivity: Date.now(), idleLocked: false, vaultType: 'file', noteFontSize: 14, imageZoom: 1, pdfPage: 1, pdfZoom: 100, searchQuery: '', searchScope: 'label' };
  const screens = ['setupScreen', 'unlockScreen', 'workspace'];
  const dialogs = ['settingsDialog', 'createVaultDialog', 'switchVaultDialog', 'helpDialog', 'trashDialog', 'contextDialog', 'importDialog', 'exportDialog', 'passwordEntryDialog', 'noteEntryDialog'];

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
  function showScreen(id) { clearAllMessages(); screens.forEach(s => $(s).classList.toggle('hidden', s !== id)); ['lockVaultButton','switchVaultButton','createVaultButton','exportVaultButton','importVaultButton'].forEach(button => $(button).classList.toggle('hidden', id !== 'workspace')); }
  function applyTheme(theme) { state.theme = theme; document.body.dataset.theme = theme; localStorage.setItem('mps-theme', theme); if ($('themeSelect')) $('themeSelect').value = theme; }
  function closePreviewUrl() { if (state.previewUrl) URL.revokeObjectURL(state.previewUrl); state.previewUrl = null; }
  function escapeHtml(value) { return String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
  function makeActionButton(label, icon, onClick, variant = 'secondary-button', title = label) {
    const paths = {
      copy: '<rect x="9" y="9" width="11" height="12" rx="2"/><path d="M15 5H6a2 2 0 0 0-2 2v10"/>',
      add: '<path d="M12 5v14M5 12h14"/>',
      lock: '<rect x="4" y="10" width="16" height="11" rx="2.5"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/>',
      unlock: '<rect x="4" y="10" width="16" height="11" rx="2.5"/><path d="M8 10V7a4 4 0 0 1 7.2-2.4"/>',
      edit: '<path d="m4 16-.8 4.8L8 20l11-11-4-4L4 16Z"/><path d="m13.5 6.5 4 4"/>',
      show: '<path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/>',
      hide: '<path d="m3 3 18 18M10.6 6.2A10.8 10.8 0 0 1 12 6c6.5 0 10 6 10 6a16 16 0 0 1-3 3.5M6.2 6.3C3.5 8 2 12 2 12s3.5 6 10 6c1.2 0 2.3-.2 3.3-.6"/>',
      download: '<path d="M12 3v12m-5-5 5 5 5-5M4 20h16"/>',
      trash: '<path d="M4 7h16M10 11v6m4-6v6M6 7l1 14h10l1-14M9 7V4h6v3"/>',
      previous: '<path d="m15 18-6-6 6-6"/>',
      next: '<path d="m9 18 6-6-6-6"/>',
      zoomIn: '<circle cx="10.8" cy="10.8" r="6.8"/><path d="M16 16l5 5M10.8 7.5v6.6m-3.3-3.3h6.6"/>',
      zoomOut: '<circle cx="10.8" cy="10.8" r="6.8"/><path d="M16 16l5 5M7.5 10.8h6.6"/>',
      fit: '<path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/>',
      fullscreen: '<path d="M8 3H3v5m13-5h5v5M3 16v5h5m13-5v5h-5"/>',
      refresh: '<path d="M20 7v5h-5M4 17v-5h5"/><path d="M5.5 9A7 7 0 0 1 18 6l2 6M4 12l2 6a7 7 0 0 0 12.5-3"/>',
    };
    const button = document.createElement('button');
    button.type = 'button'; button.className = variant; button.title = title; button.setAttribute('aria-label', title);
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('fill', 'none'); svg.setAttribute('stroke', 'currentColor'); svg.setAttribute('stroke-width', '1.9'); svg.setAttribute('stroke-linecap', 'round'); svg.setAttribute('stroke-linejoin', 'round');
    svg.innerHTML = paths[icon] || paths.add;
    const text = document.createElement('span'); text.textContent = label;
    button.append(svg, text); if (onClick) button.addEventListener('click', onClick); return button;
  }
  async function refreshTree() {
    const data = await api('/api/tree');
    $('trashCount').textContent = data.trash_count;
    state.treeItems = data.items || [];
    setVaultType(data.vault_type || 'file');
    $('tree').innerHTML = '';
    $('vaultSearchScope').classList.toggle('hidden', state.vaultType !== 'notes');
    if (state.vaultType !== 'notes') { $('vaultSearchScope').querySelector('input[value=label]').checked = true; state.searchScope = 'label'; }
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
      if (item.type === 'folder' && !item.locked) { icon.innerHTML = '<svg viewBox="0 0 32 26" aria-hidden="true"><path d="M2.5 5.5A3 3 0 0 1 5.5 2.5h7l3 3h11A3 3 0 0 1 29.5 8.5v12a3 3 0 0 1-3 3h-21a3 3 0 0 1-3-3Z" fill="#e6b957" stroke="#b98527" stroke-width="1.5"/><path d="M2.5 10h27l-2.2 10.5a3 3 0 0 1-2.9 2.3H5.5a3 3 0 0 1-3-3Z" fill="#ffd978" stroke="#b98527" stroke-width="1.2"/></svg>'; }
      else if (item.locked) { icon.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="10" width="16" height="11" rx="2.5"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></svg>'; }
      else if (item.type === 'password') { icon.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="8" cy="12" r="5" fill="#f4c45e" stroke="#a97920" stroke-width="1.5"/><path d="M13 12h8m-3 0v3m-3-3v2" stroke="#a97920" stroke-width="2" stroke-linecap="round"/></svg>'; }
      else if (item.type === 'note') { icon.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 3h10l4 4v14H5z" fill="#dcecff" stroke="#4b78ad" stroke-width="1.5"/><path d="M15 3v5h4M8 12h8M8 16h8" fill="none" stroke="#4b78ad" stroke-width="1.5" stroke-linecap="round"/></svg>'; }
      else { icon.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 2.5h9l5 5V21H5z" fill="#e8eef7" stroke="#607b9e" stroke-width="1.5"/><path d="M14 2.5v5h5M8 12h8M8 16h8" fill="none" stroke="#607b9e" stroke-width="1.5" stroke-linecap="round"/></svg>'; }
      const name = document.createElement('span'); name.className = 'tree-name'; name.textContent = item.name;
      row.append(chevron, icon, name);
      if (item.locked) { const lock = document.createElement('span'); lock.className = 'tree-lock-badge'; lock.textContent = 'LOCKED'; row.append(lock); }
      const more = document.createElement('button'); more.className = 'tree-more'; more.type = 'button'; more.title = 'Item actions'; more.setAttribute('aria-label', `Actions for ${item.name}`); more.textContent = '⋯'; more.addEventListener('click', e => { e.stopPropagation(); openContext(item); }); row.append(more);
      row.addEventListener('click', () => {
        row.focus({ preventScroll: true });
        if (item.locked) selectTreeItem(item);
        else if (item.type === 'folder') {
          selectFolder(item);
          if (state.expanded.has(item.id)) state.expanded.delete(item.id); else state.expanded.add(item.id);
          renderTreeItemsRoot(item.id);
        } else if (item.type === 'file') selectEntry(item);
        else if (item.type === 'password') selectPassword(item);
        else if (item.type === 'note') selectNote(item);
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
      const unlock = makeActionButton('Unlock', 'unlock', () => openItemPasswordDialog('unlock', item), 'primary-button'); $('previewActions').append(unlock);
    } else if (item.type === 'folder') selectFolder(item);
    else if (item.type === 'file') selectEntry(item);
    else if (item.type === 'password') selectPassword(item);
        else if (item.type === 'note') selectNote(item);
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
  function resetPreview() { closePreviewUrl(); state.selectedId = null; state.selectedEntry = null; updateTreeSelection(); $('previewTitle').textContent = 'Select an item'; $('previewEyebrow').textContent = 'PREVIEW'; $('previewActions').innerHTML = ''; $('previewContent').className = 'preview-content empty-state'; $('previewContent').innerHTML = '<div class="empty-icon">▧</div><h3>Your private space</h3><p>Select an item in the navigation tree to view its contents.</p>'; }
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
    const show = makeActionButton('Show', 'show', null, 'primary-button');
    let revealed = false, secret = '';
    show.addEventListener('click', async () => {
      if (state.selectedId !== item.id) return;
      if (revealed) { secret = ''; value.textContent = '***'; value.setAttribute('aria-label', 'Password hidden'); show.querySelector('span').textContent = 'Show'; show.querySelector('svg').innerHTML = '<path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/>'; revealed = false; return; }
      show.disabled = true;
      try { const result = await api(`/api/passwords/${encodeURIComponent(item.id)}/reveal`); if (state.selectedId !== item.id) return; secret = result.value; value.textContent = secret; value.setAttribute('aria-label', 'Password shown'); show.querySelector('span').textContent = 'Hide'; show.querySelector('svg').innerHTML = '<path d="m3 3 18 18M10.6 6.2A10.8 10.8 0 0 1 12 6c6.5 0 10 6 10 6a16 16 0 0 1-3 3.5M6.2 6.3C3.5 8 2 12 2 12s3.5 6 10 6c1.2 0 2.3-.2 3.3-.6"/>'; revealed = true; }
      catch (e) { toast(e.message); }
      finally { show.disabled = false; }
    });
    const copy = makeActionButton('Copy', 'copy', null);
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
  function normalizeSearchForHighlight(value) {
    return String(value).normalize('NFKC').toLocaleLowerCase().replace(/[\u0640\u064B-\u065F\u0670\u06D6-\u06ED]/g, '')
      .replace(/[أإآٱ]/g, 'ا').replace(/[ىئ]/g, 'ي').replace(/ؤ/g, 'و');
  }
  function appendHighlightedNoteText(element, source, query) {
    const normalizedQuery = normalizeSearchForHighlight(query);
    if (!normalizedQuery) { element.textContent = source; return; }
    let normalized = '';
    const starts = [], ends = [];
    let sourceOffset = 0;
    for (const character of source) {
      const start = sourceOffset;
      sourceOffset += character.length;
      const part = normalizeSearchForHighlight(character);
      normalized += part;
      for (let i = 0; i < part.length; i++) { starts.push(start); ends.push(sourceOffset); }
    }
    const fragment = document.createDocumentFragment();
    let sourceCursor = 0, searchFrom = 0, matchAt;
    while ((matchAt = normalized.indexOf(normalizedQuery, searchFrom)) !== -1) {
      const originalStart = starts[matchAt];
      const originalEnd = ends[matchAt + normalizedQuery.length - 1];
      if (originalStart === undefined || originalEnd === undefined || originalEnd <= sourceCursor) { searchFrom = matchAt + 1; continue; }
      fragment.append(document.createTextNode(source.slice(sourceCursor, originalStart)));
      const mark = document.createElement('mark');
      mark.className = 'search-highlight';
      mark.textContent = source.slice(originalStart, originalEnd);
      fragment.append(mark);
      sourceCursor = originalEnd;
      searchFrom = matchAt + Math.max(1, normalizedQuery.length);
    }
    fragment.append(document.createTextNode(source.slice(sourceCursor)));
    element.append(fragment);
  }

  async function selectNote(item) {
    closePreviewUrl();
    state.selectedId = item.id; state.selectedEntry = item; updateTreeSelection();
    $('previewTitle').textContent = item.name;
    $('previewEyebrow').textContent = 'NOTE';
    $('previewActions').innerHTML = '';
    let noteText = '';
    const actions = $('previewActions');
    const copy = makeActionButton('Copy', 'copy', async () => { try { await copySecret(noteText); toast('Note copied to clipboard.'); } catch (error) { toast(error.message); } });
    const decrease = makeActionButton('Smaller text', 'zoomOut', null, 'secondary-button note-font-button', 'Decrease note font size');
    const increase = makeActionButton('Larger text', 'zoomIn', null, 'secondary-button note-font-button', 'Increase note font size');
    const edit = makeActionButton('Edit note', 'edit', () => openNoteEditor(item));
    const lock = makeActionButton('Lock', 'lock', () => openItemPasswordDialog('lock', item));
    actions.append(copy, decrease, increase, edit, lock);
    const content = $('previewContent');
    content.className = 'preview-content note-preview';
    content.replaceChildren();
    const loading = document.createElement('p'); loading.textContent = 'Loading note…'; content.append(loading);
    try {
      const result = await api(`/api/notes/${encodeURIComponent(item.id)}`);
      if (state.selectedId !== item.id) return;
      content.replaceChildren();
      const heading = document.createElement('h3'); heading.textContent = result.name;
      noteText = result.content;
      const text = document.createElement('pre'); text.className = 'note-content';
      if (state.searchScope === 'content' && state.searchQuery) appendHighlightedNoteText(text, noteText, state.searchQuery); else text.textContent = noteText;
      const applyNoteFontSize = () => { text.style.fontSize = `${state.noteFontSize}px`; };
      decrease.addEventListener('click', () => { state.noteFontSize = Math.max(10, state.noteFontSize - 1); applyNoteFontSize(); });
      increase.addEventListener('click', () => { state.noteFontSize = Math.min(32, state.noteFontSize + 1); applyNoteFontSize(); });
      applyNoteFontSize();
      const metadata = document.createElement('div'); metadata.className = 'password-meta-grid';
      for (const [label, value] of [['Created', item.created_at], ['Last Updated', item.updated_at]]) {
        const card = document.createElement('div'); card.className = 'password-meta-card';
        const caption = document.createElement('span'); caption.textContent = label;
        const date = document.createElement('strong'); date.textContent = formatEntryTimestamp(value);
        card.append(caption, date); metadata.append(card);
      }
      content.append(heading, text, metadata);
    } catch (error) {
      if (state.selectedId !== item.id) return;
      content.replaceChildren();
      const message = document.createElement('p'); message.textContent = `Could not load this note: ${error.message}`; content.append(message);
    }
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
    const lockButton = makeActionButton('Lock', 'lock', () => openItemPasswordDialog('lock', item)); $('previewActions').append(lockButton);
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
      if (mime.startsWith('image/') && mime !== 'image/svg+xml') {
        state.imageZoom = 1;
        const zoomLabel = document.createElement('span'); zoomLabel.className = 'image-zoom-status'; zoomLabel.textContent = '100%';
        const stage = document.createElement('div'); stage.className = 'image-viewer-stage';
        const img = document.createElement('img'); img.className = 'preview-image'; img.alt = item.name; img.src = state.previewUrl;
        const updateImageZoom = () => { img.style.transform = `scale(${state.imageZoom})`; zoomLabel.textContent = `${Math.round(state.imageZoom * 100)}%`; };
        $('previewActions').append(
          makeActionButton('Zoom out', 'zoomOut', () => { state.imageZoom = Math.max(.2, state.imageZoom - .1); updateImageZoom(); }, 'secondary-button image-zoom-action', 'Zoom out'),
          makeActionButton('Zoom in', 'zoomIn', () => { state.imageZoom = Math.min(4, state.imageZoom + .1); updateImageZoom(); }, 'secondary-button image-zoom-action', 'Zoom in'),
          makeActionButton('Fit image', 'fit', () => { state.imageZoom = 1; updateImageZoom(); }, 'secondary-button image-zoom-action', 'Fit image'),
          zoomLabel
        );
        stage.append(img); content.append(stage);
      }
      else if (mime === 'application/pdf') {
        // Use the browser's built-in PDF viewer. Its native toolbar owns page
        // navigation, zoom, fit, download and print; do not recreate those controls.
        const viewer = document.createElement('div'); viewer.className = 'pdf-viewer';
        const frame = document.createElement('iframe');
        frame.className = 'preview-frame pdf-frame';
        frame.title = `${item.name} PDF preview`;
        frame.setAttribute('aria-label', `${item.name} PDF preview with browser PDF controls`);
        frame.src = `${state.previewUrl}#toolbar=1&navpanes=0&scrollbar=1&view=Fit`;
        viewer.append(frame);
        content.append(viewer);
      }
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
    const add = (label, fn, danger = false) => { const key = /unlock/i.test(label) ? 'unlock' : /lock/i.test(label) ? 'lock' : /copy/i.test(label) ? 'copy' : /add/i.test(label) ? 'add' : /delete|permanently/i.test(label) ? 'trash' : /restore/i.test(label) ? 'download' : /edit|update/i.test(label) ? 'edit' : 'fit'; const visual = makeActionButton(label, key, null, `action-item${danger ? ' danger' : ''}`); visual.onclick = async () => { $('contextDialog').close(); try { await fn(); } catch (e) { toast(e.message); } }; actions.append(visual); };
    if (item.locked) {
      add('Unlock…', () => openItemPasswordDialog('unlock', item));
    } else if (item.type === 'password') {
      add('Update password…', () => openPasswordEditor(item));
      add('Copy password', async () => { const result = await api(`/api/passwords/${encodeURIComponent(item.id)}/reveal`); await copySecret(result.value); toast('Password copied to clipboard.'); });
      add('Delete (move to Deleted Items)', async () => { if (confirm(`Move “${item.name}” to Deleted Items?`)) { await api(`/api/entries/${encodeURIComponent(item.id)}`, {method:'DELETE'}); if (state.selectedId === item.id) resetPreview(); await refreshTree(); toast('Moved to Deleted Items.'); } }, true);
    } else if (item.type === 'note') {
      add('Edit note…', () => openNoteEditor(item));
      add('Lock with secondary password…', () => openItemPasswordDialog('lock', item));
      add('Delete (move to Deleted Items)', async () => { if (confirm(`Move “${item.name}” to Deleted Items?`)) { await api(`/api/entries/${encodeURIComponent(item.id)}`, {method:'DELETE'}); if (state.selectedId === item.id) resetPreview(); await refreshTree(); toast('Moved to Deleted Items.'); } }, true);
    } else {
      if (item.type === 'folder') { add('Add files…', () => openImport(item.id, false)); add('Add folder…', () => openImport(item.id, true)); }
      add('Restore copy to computer…', () => openExport(item));
      add('Lock with secondary password…', () => openItemPasswordDialog('lock', item));
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

  let itemPasswordAction = null;
  function openItemPasswordDialog(action, item) {
    itemPasswordAction = { action, item };
    const isLock = action === 'lock';
    $('itemPasswordDialogEyebrow').textContent = isLock ? 'LOCK ITEM' : 'UNLOCK ITEM';
    $('itemPasswordDialogTitle').textContent = isLock ? `Lock “${item.name}”` : `Unlock “${item.name}”`;
    $('itemPasswordDialogDescription').textContent = isLock
      ? 'Choose an 8-character secondary password. You will need it to unlock this item later.'
      : 'Enter the 8-character secondary password used to lock this item.';
    $('itemPasswordInput').value = '';
    $('itemPasswordInput').setAttribute('autocomplete', isLock ? 'new-password' : 'current-password');
    $('itemPasswordInput').setAttribute('placeholder', '8-character password');
    $('itemPasswordInput').maxLength = 8;
    showMessage('itemPasswordMessage', '');
    $('confirmItemPasswordButton').textContent = isLock ? 'Lock item' : 'Unlock item';
    $('itemPasswordDialog').showModal();
    $('itemPasswordInput').focus();
  }
  $('confirmItemPasswordButton').addEventListener('click', async () => {
    if (!itemPasswordAction) return;
    const { action, item } = itemPasswordAction;
    const password = $('itemPasswordInput').value;
    if (password.length !== 8) { showMessage('itemPasswordMessage', 'Enter exactly 8 characters.'); return; }
    const button = $('confirmItemPasswordButton'); button.disabled = true;
    try {
      await api(`/api/entries/${encodeURIComponent(item.id)}/${action}`, { method: 'POST', body: JSON.stringify({ password }) });
      $('itemPasswordDialog').close();
      itemPasswordAction = null;
      $('itemPasswordInput').value = '';
      await refreshTree();
      if (action === 'unlock') {
        const tree = (await api('/api/tree')).items;
        const found = findEntry(tree, item.id);
        if (found && state.selectedId === item.id) {
          if (found.type === 'file') await selectEntry(found);
          else if (found.type === 'note') await selectNote(found);
          else selectFolder(found);
        }
        toast('Item unlocked.');
      } else {
        if (state.selectedId === item.id) resetPreview();
        toast('Item locked.');
      }
    } catch (error) {
      if (action === 'unlock') {
        $('itemPasswordDialog').close();
        toast(error.message);
      } else showMessage('itemPasswordMessage', error.message);
    } finally { button.disabled = false; }
  });
  $('itemPasswordInput').addEventListener('keydown', event => {
    if (event.key === 'Enter') { event.preventDefault(); $('confirmItemPasswordButton').click(); }
  });
  $('itemPasswordDialog').addEventListener('close', () => {
    $('itemPasswordInput').value = '';
    itemPasswordAction = null;
    showMessage('itemPasswordMessage', '');
  });
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

  let editingNoteId = null;
  async function openNoteEditor(item = null) {
    editingNoteId = item?.id || null;
    $('noteEntryDialogTitle').textContent = item ? 'Edit note' : 'Add note';
    $('saveNoteEntryButton').textContent = item ? 'Save changes' : 'Save note';
    $('noteEntryName').value = item?.name || '';
    $('noteEntryContent').value = '';
    showMessage('noteEntryMessage', item ? 'Loading note…' : '');
    $('noteEntryDialog').showModal();
    $('noteEntryName').focus();
    if (item) {
      try {
        const result = await api(`/api/notes/${encodeURIComponent(item.id)}`);
        if (editingNoteId === item.id && $('noteEntryDialog').open) {
          $('noteEntryName').value = result.name;
          $('noteEntryContent').value = result.content;
          showMessage('noteEntryMessage', '');
        }
      } catch (e) { showMessage('noteEntryMessage', e.message); }
    }
  }
  async function saveNoteEntry() {
    const name = $('noteEntryName').value.trim(), content = $('noteEntryContent').value;
    if (!name || !content.trim()) { showMessage('noteEntryMessage', 'A note name and text are required.'); return; }
    const button = $('saveNoteEntryButton'); button.disabled = true;
    try {
      const editingId = editingNoteId;
      const result = await api(editingId ? `/api/notes/${encodeURIComponent(editingId)}` : '/api/notes',
        {method: editingId ? 'PUT' : 'POST', body: JSON.stringify({name, content})});
      $('noteEntryDialog').close();
      $('noteEntryContent').value = '';
      await refreshTree();
      const item = findEntry(state.treeItems, result.id || editingId);
      if (item) await selectNote(item);
      toast(editingId ? 'Note updated.' : 'Note added.');
    } catch (e) { showMessage('noteEntryMessage', e.message); }
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
      const name = document.createElement('div'); name.className = 'trash-name'; name.textContent = `${item.type === 'folder' ? '▰' : (item.type === 'password' ? '🔑' : (item.type === 'note' ? '📝' : '▤'))} ${item.name}`;
      const date = document.createElement('div'); date.className = 'trash-date'; date.textContent = item.deleted_at ? new Date(item.deleted_at).toLocaleString() : 'Deleted'; meta.append(name, date);
      const buttons = document.createElement('div'); buttons.className = 'trash-buttons';
      const restore = document.createElement('button'); restore.className = 'secondary-button'; restore.textContent = 'Restore'; restore.onclick = async () => { try { await api(`/api/entries/${item.id}/restore`, {method:'POST',body:JSON.stringify({})}); await showTrash(); await refreshTree(); toast('Item restored.'); } catch(e) { toast(e.message); } };
      const remove = document.createElement('button'); remove.className = 'secondary-button'; remove.textContent = 'Delete forever'; remove.onclick = async () => { if (!confirm(`Permanently delete “${item.name}” and its contents? This cannot be undone.`)) return; try { await api(`/api/trash/${item.id}?confirm=true`, {method:'DELETE'}); await showTrash(); await refreshTree(); toast('Permanently deleted.'); } catch(e) { toast(e.message); } };
      buttons.append(restore, remove); row.append(meta, buttons); list.append(row);
    }
    $('trashDialog').showModal();
  }
  async function loadSettings() { const s = await api('/api/settings'); const hint = await api('/api/settings/password-hint'); $('newTargetDirectory').value = s.target_directory; $('themeSelect').value = state.theme; $('settingsVaultLabel').textContent = s.vault_label || ''; $('settingsVaultPrefix').textContent = s.prefix || '(legacy vault; no prefix)'; $('settingsPasswordHint').value = hint.hint || ''; $('settingsPasswordHint').type = 'password'; $('togglePasswordHintButton').textContent = 'Show'; $('togglePasswordHintButton').setAttribute('aria-pressed', 'false'); }
  async function savePasswordHint() { try { await api('/api/settings/password-hint', {method:'PUT', body:JSON.stringify({hint:$('settingsPasswordHint').value.trim()})}); $('settingsPasswordHint').type = 'password'; $('togglePasswordHintButton').textContent = 'Show'; $('togglePasswordHintButton').setAttribute('aria-pressed', 'false'); showMessage('settingsMessage', 'Password hint saved.', true); toast('Password hint saved.'); } catch(e) { showMessage('settingsMessage', e.message); } }
  function togglePasswordHintVisibility() { const field = $('settingsPasswordHint'); const reveal = field.type === 'password'; field.type = reveal ? 'text' : 'password'; $('togglePasswordHintButton').textContent = reveal ? 'Hide' : 'Show'; $('togglePasswordHintButton').setAttribute('aria-pressed', String(reveal)); }
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

  function setVaultLabel(label) { state.vaultLabel = label || ''; $('sidebarVaultLabel').textContent = label || 'Vault locked'; }
  function setVaultType(type) {
    state.vaultType = ['password', 'notes'].includes(type) ? type : 'file';
    $('importRootButton').classList.toggle('hidden', state.vaultType !== 'file');
    $('addPasswordButton').classList.toggle('hidden', state.vaultType !== 'password');
    $('addNoteButton').classList.toggle('hidden', state.vaultType !== 'notes');
    $('tree').setAttribute('aria-label', state.vaultType === 'password' ? 'Saved passwords' : (state.vaultType === 'notes' ? 'Saved notes' : 'Vault files and folders'));
    $('vaultSearchInput').placeholder = state.vaultType === 'password' ? 'Search password keys…' : (state.vaultType === 'notes' ? 'Search note labels…' : 'Search filenames…');
    $('vaultSearchScope').classList.toggle('hidden', state.vaultType !== 'notes');
    if (state.vaultType !== 'notes') { $('vaultSearchScope').querySelector('input[value=label]').checked = true; state.searchScope = 'label'; }
    $('previewTitle').dataset.vaultType = state.vaultType;
  }
  function populateVaultPicker(vaults, selectId = 'vaultSelect') { const select = $(selectId); select.innerHTML = ''; for (const vault of vaults) { const option = document.createElement('option'); option.value = vault.id; option.textContent = `${vault.label} · ${vault.type === 'password' ? 'Password vault' : (vault.type === 'notes' ? 'Notes vault' : 'File vault')}`; select.append(option); } }
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
  function syncCreateVaultTypeOptions() { const isPassword = ['password', 'notes'].includes($('createVaultType').value); const conversionLabel = $('convertExistingFolder').closest('label'); conversionLabel.classList.toggle('hidden', isPassword); if (isPassword) $('convertExistingFolder').checked = false; }
  function openCreateVault() { $('createVaultType').value='file'; $('createVaultLabel').value=''; $('createVaultDirectory').value=''; $('createVaultPrefix').value=''; $('createVaultCreateDirectory').checked=false; $('convertExistingFolder').checked=false; $('createManageVisibility').checked=false; syncCreateVaultTypeOptions(); showMessage('createVaultMessage',''); $('createVaultDialog').showModal(); }
  async function createVault() { const label=$('createVaultLabel').value.trim(), target_directory=$('createVaultDirectory').value.trim(), prefix=$('createVaultPrefix').value.trim(), convert_existing=$('convertExistingFolder').checked, manage_visibility=$('createManageVisibility').checked, vault_type=$('createVaultType').value; if (!label || !target_directory || !prefix) { showMessage('createVaultMessage','Vault label, destination folder, and storage prefix are required.'); return; } if (convert_existing && !confirm('Convert this ordinary non-empty folder into encrypted vault storage? Files will be encrypted and the originals retained until staging and verification succeed. Continue?')) return; const button=$('confirmCreateVaultButton'); button.disabled=true; try { const result=await api('/api/vaults/create',{method:'POST',body:JSON.stringify({label,target_directory,prefix,convert_existing,manage_visibility,vault_type,create_directory:$('createVaultCreateDirectory').checked})}); $('createVaultDialog').close(); localStorage.removeItem('mps-session-locked'); state.unlocked=true; resetIdleClock(); setVaultLabel(result.vault_label); setVaultType(result.vault_type || vault_type); $('vaultPicker').classList.add('hidden'); $('unlockForm').classList.remove('hidden'); showScreen('workspace'); resetPreview(); await refreshTree(); toast(`Created and opened ${result.vault_label}.`); } catch(e) { showMessage('createVaultMessage',e.message); } finally { button.disabled=false; } }
  let searchTimer = null;
  function expandPathToEntry(items, targetId, ancestors = []) {
    for (const item of items) {
      if (item.id === targetId) { ancestors.forEach(id => state.expanded.add(id)); return true; }
      if (item.children?.length && expandPathToEntry(item.children, targetId, [...ancestors, item.id])) return true;
    }
    return false;
  }
  async function openSearchResult(item) {
    state.searchQuery = $('vaultSearchInput').value.trim();
    state.searchScope = state.vaultType === 'notes' ? $('vaultSearchScope').querySelector('input:checked').value : 'label';
    expandPathToEntry(state.treeItems, item.id);
    await renderTreeItemsRoot(item.id);
    const found = findEntry(state.treeItems, item.id);
    if (found) selectTreeItem(found);
    $('vaultSearchResults').classList.add('hidden');
    $('vaultSearchInput').value = '';
    $('vaultSearchInput').blur();
  }
  async function runVaultSearch() {
    const query = $('vaultSearchInput').value.trim();
    const results = $('vaultSearchResults');
    results.replaceChildren();
    if (!query) { results.classList.add('hidden'); return; }
    const scope = state.vaultType === 'notes' ? $('vaultSearchScope').querySelector('input:checked').value : 'label';
    try {
      const data = await api(`/api/search?q=${encodeURIComponent(query)}&scope=${encodeURIComponent(scope)}`);
      if ($('vaultSearchInput').value.trim() !== query) return;
      results.classList.remove('hidden');
      if (!data.items.length) {
        const empty = document.createElement('div'); empty.className = 'search-empty'; empty.textContent = 'No matching items'; results.append(empty); return;
      }
      data.items.forEach(item => {
        const button = document.createElement('button'); button.type = 'button'; button.className = 'search-result'; button.setAttribute('role', 'option');
        const name = document.createElement('strong'); name.textContent = item.name;
        const kind = document.createElement('span'); kind.textContent = item.type === 'password' ? 'Password' : item.type === 'note' ? 'Note' : item.type === 'folder' ? 'Folder' : 'File';
        button.append(name, kind);
        button.addEventListener('click', () => openSearchResult(item).catch(error => toast(error.message)));
        results.append(button);
      });
    } catch (error) { results.classList.remove('hidden'); const item = document.createElement('div'); item.className = 'search-empty'; item.textContent = error.message; results.append(item); }
  }
  function openVaultImport() {
    $('vaultArchiveFile').value = ''; $('vaultImportMode').value = 'create'; $('vaultImportLabel').value = ''; $('vaultImportDirectory').value = ''; $('vaultImportCreateDirectory').checked = false;
    syncVaultImportMode(); showMessage('vaultImportMessage', ''); $('vaultImportDialog').showModal();
  }
  function syncVaultImportMode() {
    const replace = $('vaultImportMode').value === 'replace';
    $('vaultImportCreateFields').classList.toggle('hidden', replace);
    $('vaultReplaceWarning').classList.toggle('hidden', !replace);
    $('confirmVaultImportButton').textContent = replace ? 'Replace current vault' : 'Import as new vault';
  }
  function defaultVaultExportFilename() {
    const safeLabel = (state.vaultLabel || 'vault').replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').replace(/[. ]+$/g, '').trim() || 'vault';
    return `${safeLabel}.zip`;
  }
  function openVaultExportConfirmation() {
    showMessage('vaultExportMessage', '');
    $('vaultExportFilename').value = defaultVaultExportFilename();
    $('vaultExportConfirmDialog').showModal();
    $('vaultExportFilename').focus();
    $('vaultExportFilename').select();
  }
  async function exportVaultArchive() {
    const button = $('confirmVaultExportButton');
    const filenameInput = $('vaultExportFilename');
    let filename = filenameInput.value.trim();
    if (!filename) { showMessage('vaultExportMessage', 'Enter a filename for the backup.'); filenameInput.focus(); return; }
    filename = filename.replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').replace(/[. ]+$/g, '').trim();
    if (!filename) { showMessage('vaultExportMessage', 'Enter a valid filename for the backup.'); filenameInput.focus(); return; }
    if (!/\.zip$/i.test(filename)) filename += '.zip';
    const buttonLabel = button.textContent;
    button.disabled = true;
    showMessage('vaultExportMessage', 'Preparing encrypted backup…');
    try {
      const blob = await api('/api/vaults/export');
      const url = URL.createObjectURL(blob); const a = document.createElement('a');
      a.href = url; a.download = filename; document.body.append(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 30000);
      $('vaultExportConfirmDialog').close();
      toast('Encrypted vault export started.');
    } catch (error) {
      showMessage('vaultExportMessage', `Export failed: ${error.message}`);
    } finally { button.disabled = false; }
  }
  async function importVaultArchive() {
    const file = $('vaultArchiveFile').files[0];
    if (!file) { showMessage('vaultImportMessage', 'Choose an encrypted vault ZIP first.'); return; }
    const mode = $('vaultImportMode').value;
    if (mode === 'replace' && !confirm('This will replace all data in the currently open vault. Export a backup first. Continue?')) return;
    const form = new FormData(); form.set('archive', file); form.set('mode', mode);
    if (mode === 'create') {
      const target = $('vaultImportDirectory').value.trim(); const label = $('vaultImportLabel').value.trim();
      if (!target) { showMessage('vaultImportMessage', 'Destination folder path is required.'); return; }
      form.set('target_directory', target); form.set('label', label); form.set('create_directory', String($('vaultImportCreateDirectory').checked));
    }
    const button = $('confirmVaultImportButton'); button.disabled = true; showMessage('vaultImportMessage', 'Verifying and importing encrypted archive…');
    try {
      const result = await api('/api/vaults/import', {method:'POST', body:form});
      $('vaultImportDialog').close(); state.unlocked = true; resetIdleClock(); setVaultLabel(result.vault_label); setVaultType(result.vault_type); resetPreview(); await refreshTree();
      toast(mode === 'replace' ? 'Current vault replaced successfully.' : `Imported and opened ${result.vault_label}.`);
    } catch (error) { showMessage('vaultImportMessage', error.message); }
    finally { button.disabled = false; }
  }

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
    try { const result = await api('/api/setup',{method:'POST',body:JSON.stringify({label:$('setupVaultLabel').value.trim(),prefix:$('setupPrefix').value.trim(),target_directory:$('targetDirectory').value.trim(),manage_visibility:$('setupManageVisibility').checked,vault_type:$('setupVaultType').value,create_directory:$('setupCreateDirectory').checked,password:$('setupPassword').value,confirm_password:$('setupConfirm').value,})}); $('setupPassword').value=''; $('setupConfirm').value=''; state.unlocked=true; resetIdleClock(); setVaultLabel(result.vault_label); setVaultType(result.vault_type || $('setupVaultType').value); showScreen('workspace'); await refreshTree(); toast('Vault created.'); }
    catch(error) { showMessage('setupMessage',error.message); }
  });
  $('unlockForm').addEventListener('submit', async e => {
    e.preventDefault(); showMessage('unlockMessage','Unlocking…');
    try { const result = await api('/api/unlock',{method:'POST',body:JSON.stringify({password:$('unlockPassword').value,resume_last_used:!!localStorage.getItem('mps-session-locked')})}); $('unlockPassword').value=''; if (!result.selected) { localStorage.removeItem('mps-session-locked'); resetIdleClock(); populateVaultPicker(result.vaults); $('vaultPicker').classList.remove('hidden'); $('unlockForm').classList.add('hidden'); showMessage('unlockMessage','Password accepted. Select a vault to continue.',true); return; } state.unlocked=true; resetIdleClock(); setVaultLabel(result.vault_label); $('vaultPicker').classList.add('hidden'); $('unlockForm').classList.remove('hidden'); showScreen('workspace'); resetPreview(); await refreshTree(); toast('Vault unlocked.'); }
    catch(error) { showMessage('unlockMessage',error.message); }
  });
  $('forgotPasswordButton').addEventListener('click', async () => {
    try { const result = await api('/api/password-hint'); showMessage('passwordHintMessage', result.hint ? `Your password hint: ${result.hint}` : 'No password hint has been configured in Settings. The main password cannot be recovered.'); }
    catch (error) { showMessage('passwordHintMessage', error.message); }
  });
  $('vaultSearchInput').addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(runVaultSearch, 180); });
  $('vaultSearchScope').addEventListener('change', event => { if (event.target.matches('input[type=radio]')) { state.searchScope = event.target.value; runVaultSearch(); } });
  $('exportVaultButton').addEventListener('click', openVaultExportConfirmation);
  $('cancelVaultExportButton').addEventListener('click', () => $('vaultExportConfirmDialog').close());
  $('confirmVaultExportButton').addEventListener('click', exportVaultArchive);
  $('importVaultButton').addEventListener('click', openVaultImport);
  $('vaultImportMode').addEventListener('change', syncVaultImportMode);
  $('confirmVaultImportButton').addEventListener('click', importVaultArchive);
  $('lockVaultButton').addEventListener('click', async () => { if (!confirm('Lock My Private Space now?')) return; try { await api('/api/lock',{method:'POST'}); localStorage.setItem('mps-session-locked', String(Date.now())); clearSensitiveUi(); toast('Vault locked.'); } catch(e) { toast(e.message); } });
  $('closeAppButton').addEventListener('click', async () => {
    if (!confirm('Exit My Private Space and shut down its local server?')) return;
    const button = $('closeAppButton');
    button.disabled = true;
    try {
      await api('/api/shutdown', {method: 'POST'});
      closePreviewUrl();
      document.body.innerHTML = '<main class="shutdown-screen"><div class="shutdown-card"><div class="shutdown-mark">✓</div><h1>My Private Space has stopped</h1><p>The local server has been asked to shut down. You can close this tab.</p></div></main>';
      document.title = 'My Private Space — Stopped';
      // Browsers may block closing tabs that were not opened by this script.
      window.close();
    } catch (e) {
      button.disabled = false;
      toast(`Could not stop My Private Space: ${e.message}`);
    }
  });
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
  $('addNoteButton').addEventListener('click', () => openNoteEditor());
  $('saveNoteEntryButton').addEventListener('click', saveNoteEntry);
  $('savePasswordEntryButton').addEventListener('click', savePasswordEntry);
  $('createVaultType').addEventListener('change', syncCreateVaultTypeOptions);
  $('startImportButton').addEventListener('click', runImport);
  $('themeSelect').addEventListener('change', async () => { applyTheme($('themeSelect').value); try { await api('/api/settings',{method:'PUT',body:JSON.stringify({theme:state.theme})}); } catch(e) { toast(e.message); } });
  $('moveVaultButton').addEventListener('click', moveVault);
  $('changePasswordButton').addEventListener('click', changePassword);
  $('savePasswordHintButton').addEventListener('click', savePasswordHint);
  $('togglePasswordHintButton').addEventListener('click', togglePasswordHintVisibility);
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
