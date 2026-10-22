(() => {
  'use strict';
  const token = document.querySelector('meta[name="mps-token"]').content;
  const $ = (id) => document.getElementById(id);
  const state = { unlocked: false, selectedId: null, selectedEntry: null, importParent: '', expanded: new Set(), theme: localStorage.getItem('mps-theme') || 'light-navy', previewUrl: null, lastActivity: Date.now(), idleLocked: false };
  const screens = ['setupScreen', 'unlockScreen', 'workspace'];
  const dialogs = ['settingsDialog', 'createVaultDialog', 'switchVaultDialog', 'helpDialog', 'trashDialog', 'contextDialog', 'importDialog', 'exportDialog'];

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
  function showMessage(id, message, success = false) { const el = $(id); el.textContent = message || ''; el.classList.toggle('success', !!success); }
  let toastTimer;
  function toast(message) { const el = $('toast'); el.textContent = message; el.classList.add('show'); clearTimeout(toastTimer); toastTimer = setTimeout(() => el.classList.remove('show'), 2600); }
  function showScreen(id) { screens.forEach(s => $(s).classList.toggle('hidden', s !== id)); $('lockVaultButton').classList.toggle('hidden', id !== 'workspace'); $('switchVaultButton').classList.toggle('hidden', id !== 'workspace'); }
  function applyTheme(theme) { state.theme = theme; document.body.dataset.theme = theme; localStorage.setItem('mps-theme', theme); if ($('themeSelect')) $('themeSelect').value = theme; }
  function closePreviewUrl() { if (state.previewUrl) URL.revokeObjectURL(state.previewUrl); state.previewUrl = null; }
  function escapeHtml(value) { return String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
  async function refreshTree() {
    const data = await api('/api/tree');
    $('trashCount').textContent = data.trash_count;
    $('tree').innerHTML = '';
    renderTreeItems(data.items, $('tree'), 0);
    if (state.selectedId) {
      const found = findEntry(data.items, state.selectedId);
      if (!found) { state.selectedId = null; state.selectedEntry = null; resetPreview(); }
      else state.selectedEntry = found;
    }
  }
  function findEntry(items, id) { for (const item of items) { if (item.id === id) return item; const found = findEntry(item.children || [], id); if (found) return found; } return null; }
  function renderTreeItems(items, container, depth) {
    items.forEach(item => {
      const wrapper = document.createElement('div');
      const row = document.createElement('div'); row.className = `tree-row${state.selectedId === item.id ? ' selected' : ''}`; row.dataset.id = item.id;
      const hasChildren = item.type === 'folder' && item.children && item.children.length;
      const expanded = state.expanded.has(item.id);
      const chevron = document.createElement('span'); chevron.className = 'tree-chevron'; chevron.textContent = item.type === 'folder' ? (item.locked ? '•' : (hasChildren ? (expanded ? '▾' : '▸') : '')) : '';
      const icon = document.createElement('span'); icon.className = `tree-icon${item.type === 'folder' && !item.locked ? ' folder-tree-icon' : ''}`;
      if (item.type === 'folder' && !item.locked) { icon.innerHTML = '<svg viewBox="0 0 32 26" aria-hidden="true"><path d="M2.5 5.5A3 3 0 0 1 5.5 2.5h7l3 3h11A3 3 0 0 1 29.5 8.5v12a3 3 0 0 1-3 3h-21a3 3 0 0 1-3-3Z" fill="#e6b957" stroke="#b98527" stroke-width="1.5"/><path d="M2.5 10h27l-2.2 10.5a3 3 0 0 1-2.9 2.3H5.5a3 3 0 0 1-3-3Z" fill="#ffd978" stroke="#b98527" stroke-width="1.2"/></svg>'; } else { icon.textContent = item.locked ? '🔒' : '▤'; }
      const name = document.createElement('span'); name.className = 'tree-name'; name.textContent = item.name;
      row.append(chevron, icon, name);
      if (item.locked) { const lock = document.createElement('span'); lock.className = 'tree-icon'; lock.textContent = '•'; row.append(lock); }
      const more = document.createElement('button'); more.className = 'tree-more'; more.type = 'button'; more.title = 'Item actions'; more.setAttribute('aria-label', `Actions for ${item.name}`); more.textContent = '⋯'; more.addEventListener('click', e => { e.stopPropagation(); openContext(item); }); row.append(more);
      row.addEventListener('click', () => { if (item.locked) askUnlock(item); else if (item.type === 'folder') { selectFolder(item); if (state.expanded.has(item.id)) state.expanded.delete(item.id); else state.expanded.add(item.id); renderTreeItemsRoot(); } else if (item.type === 'file') selectEntry(item); });
      wrapper.append(row); container.append(wrapper);
      if (item.type === 'folder' && expanded && !item.locked && item.children?.length) { const children = document.createElement('div'); children.className = 'tree-children'; wrapper.append(children); renderTreeItems(item.children, children, depth + 1); }
    });
  }
  async function renderTreeItemsRoot() { await refreshTree(); }
  function resetPreview() { closePreviewUrl(); state.selectedId = null; state.selectedEntry = null; $('previewTitle').textContent = 'Select a file'; $('previewEyebrow').textContent = 'PREVIEW'; $('previewActions').innerHTML = ''; $('previewContent').className = 'preview-content empty-state'; $('previewContent').innerHTML = '<div class="empty-icon">▧</div><h3>Your private space</h3><p>Select a file in the navigation tree to preview it here.</p>'; }
  function selectFolder(item) {
    closePreviewUrl(); state.selectedId = item.id; state.selectedEntry = item;
    $('previewTitle').textContent = item.name; $('previewEyebrow').textContent = 'FOLDER'; $('previewActions').innerHTML = '';
    const content = $('previewContent'); content.className = 'preview-content folder-preview empty-state';
    content.innerHTML = '<svg class="folder-preview-art" viewBox="0 0 180 140" role="img" aria-label="Folder"><defs><linearGradient id="folderBack" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#ffe9a8"/><stop offset="1" stop-color="#e9ad39"/></linearGradient><linearGradient id="folderFront" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffd978"/><stop offset="1" stop-color="#f0b63f"/></linearGradient></defs><path d="M20 33a10 10 0 0 1 10-10h39l14 14h67a10 10 0 0 1 10 10v60a10 10 0 0 1-10 10H30a10 10 0 0 1-10-10Z" fill="url(#folderBack)" stroke="#c58b26" stroke-width="2.5"/><path d="M13 51a10 10 0 0 1 10-10h134a10 10 0 0 1 10 12l-11 59a10 10 0 0 1-10 8H24a10 10 0 0 1-10-12Z" fill="url(#folderFront)" stroke="#c58b26" stroke-width="2.5"/><path d="M36 66h107" stroke="#fff0c4" stroke-width="3" stroke-linecap="round" opacity=".9"/></svg><h3>Folder selected</h3><p>The previous file preview has been cleared. Select a file inside this folder to preview its contents.</p>';
  }
  async function selectEntry(item) {
    state.selectedId = item.id; state.selectedEntry = item;
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
    if (item.locked) add('Unlock…', () => askUnlock(item));
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
  function openImport(parentId = '', folderMode = null) {
    state.importParent = parentId;
    $('filePicker').value = ''; $('folderPicker').value = '';
    $('filePicker').classList.toggle('hidden', folderMode === true); $('folderPicker').classList.toggle('hidden', folderMode === false);
    $('importTitle').textContent = folderMode === true ? 'Add a folder' : (folderMode === false ? 'Add files' : 'Add files or folder'); showMessage('importMessage', ''); $('importDialog').showModal();
  }
  async function runImport() {
    const selected = [...(!$('filePicker').classList.contains('hidden') ? Array.from($('filePicker').files) : []), ...(!$('folderPicker').classList.contains('hidden') ? Array.from($('folderPicker').files) : [])];
    if (!selected.length) { showMessage('importMessage', 'Choose at least one file or folder.'); return; }
    const data = new FormData(); data.append('parent_id', state.importParent || '');
    const paths = selected.map(file => file.webkitRelativePath || file.name); data.append('relative_paths', JSON.stringify(paths));
    selected.forEach(file => data.append('files', file, file.name));
    $('startImportButton').disabled = true; showMessage('importMessage', `Importing ${selected.length} file(s)…`);
    try { const result = await api('/api/import/files', {method:'POST', body:data}); $('importDialog').close(); await refreshTree(); toast(`Imported ${result.imported} file(s).`); }
    catch (e) { showMessage('importMessage', e.message); }
    finally { $('startImportButton').disabled = false; }
  }
  async function showTrash() {
    const data = await api('/api/trash'); const list = $('trashList'); list.innerHTML = '';
    if (!data.items.length) { list.innerHTML = '<div class="empty-state"><div class="empty-icon">▤</div><h3>Nothing deleted</h3><p>Items you delete will appear here.</p></div>'; }
    for (const item of data.items) {
      const row = document.createElement('div'); row.className = 'trash-row';
      const meta = document.createElement('div'); meta.className = 'trash-meta';
      const name = document.createElement('div'); name.className = 'trash-name'; name.textContent = `${item.type === 'folder' ? '▰' : '▤'} ${item.name}`;
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
  function populateVaultPicker(vaults, selectId = 'vaultSelect') { const select = $(selectId); select.innerHTML = ''; for (const vault of vaults) { const option = document.createElement('option'); option.value = vault.id; option.textContent = vault.label; select.append(option); } }
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
  function openCreateVault() { $('createVaultLabel').value=''; $('createVaultDirectory').value=''; $('createVaultPrefix').value=''; $('convertExistingFolder').checked=false; $('createManageVisibility').checked=false; showMessage('createVaultMessage',''); $('createVaultDialog').showModal(); }
  async function createVault() { const label=$('createVaultLabel').value.trim(), target_directory=$('createVaultDirectory').value.trim(), prefix=$('createVaultPrefix').value.trim(), convert_existing=$('convertExistingFolder').checked, manage_visibility=$('createManageVisibility').checked; if (!label || !target_directory || !prefix) { showMessage('createVaultMessage','Vault label, destination folder, and storage prefix are required.'); return; } if (convert_existing && !confirm('Convert this ordinary non-empty folder into encrypted vault storage? Files will be encrypted and the originals retained until staging and verification succeed. Continue?')) return; const button=$('confirmCreateVaultButton'); button.disabled=true; try { const result=await api('/api/vaults/create',{method:'POST',body:JSON.stringify({label,target_directory,prefix,convert_existing,manage_visibility})}); $('createVaultDialog').close(); localStorage.removeItem('mps-session-locked'); state.unlocked=true; resetIdleClock(); setVaultLabel(result.vault_label); $('vaultPicker').classList.add('hidden'); $('unlockForm').classList.remove('hidden'); showScreen('workspace'); resetPreview(); await refreshTree(); toast(`Created and opened ${result.vault_label}.`); } catch(e) { showMessage('createVaultMessage',e.message); } finally { button.disabled=false; } }
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
    try { const result = await api('/api/setup',{method:'POST',body:JSON.stringify({label:$('setupVaultLabel').value.trim(),prefix:$('setupPrefix').value.trim(),target_directory:$('targetDirectory').value.trim(),manage_visibility:$('setupManageVisibility').checked,password:$('setupPassword').value,confirm_password:$('setupConfirm').value})}); $('setupPassword').value=''; $('setupConfirm').value=''; state.unlocked=true; resetIdleClock(); setVaultLabel(result.vault_label); showScreen('workspace'); await refreshTree(); toast('Vault created.'); }
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
  $('importRootButton').addEventListener('click', () => openImport('', null));
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
    closePreviewUrl();
    document.querySelectorAll('#previewContent audio, #previewContent video').forEach(m => { try { m.pause(); m.removeAttribute('src'); m.load(); } catch {} });
    document.querySelectorAll('dialog[open]').forEach(dialog => { try { dialog.close(); } catch {} });
    $('tree').replaceChildren(); state.selectedId=null; state.selectedEntry=null; state.importParent=''; state.expanded.clear(); state.unlocked=false;
    setVaultLabel(''); $('unlockPassword').value=''; $('vaultPicker').replaceChildren(); $('managedVaultSelect').replaceChildren();
    $('settingsVaultLabel').textContent=''; $('settingsVaultPrefix').textContent=''; $('newTargetDirectory').value='';
    $('vaultPicker').classList.add('hidden'); $('unlockForm').classList.remove('hidden'); resetPreview(); showScreen('unlockScreen');
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
