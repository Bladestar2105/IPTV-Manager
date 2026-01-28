/**
 * Author: Bladestar2105
 * License: MIT
 */
// JWT Token Management
function getToken() {
  return localStorage.getItem('jwt_token');
}

function setToken(token) {
  localStorage.setItem('jwt_token', token);
}

function removeToken() {
  localStorage.removeItem('jwt_token');
}

function isTokenExpired() {
  const token = getToken();
  if (!token) return true;
  
  try {
    const payload = JSON.parse(atob(token.split('.')[1]));
    return payload.exp * 1000 < Date.now();
  } catch {
    return true;
  }
}

async function fetchJSON(url, options = {}) {
  // Add JWT token to requests
  const token = getToken();
  if (token && !isTokenExpired()) {
    options.headers = {
      ...options.headers,
      'Authorization': `Bearer ${token}`
    };
  }
  
  const res = await fetch(url, options);
  
  // Handle token expiration
  if (res.status === 401 || res.status === 403) {
    removeToken();
    showLoginModal();
    throw new Error('Authentication required');
  }
  
  if (!res.ok) {
    // Try to parse error response
    try {
      const errorData = await res.json();
      const error = new Error(errorData.message || 'HTTP ' + res.status);
      error.response = errorData;
      throw error;
    } catch (e) {
      if (e.response) throw e; // Re-throw if we successfully parsed the error
      throw new Error('HTTP ' + res.status);
    }
  }
  return res.json();
}

let selectedUser = null;
let selectedUserId = null;
let selectedCategoryId = null;
let providerChannelsCache = [];
let categorySortable = null;
let channelSortable = null;

// i18n: Seite übersetzen
function translatePage() {
  // Texte übersetzen
  document.querySelectorAll('[data-i18n]').forEach(el => {
    const key = el.getAttribute('data-i18n');
    el.textContent = t(key);
  });
  
  // Platzhalter übersetzen
  document.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
    const key = el.getAttribute('data-i18n-placeholder');
    el.placeholder = t(key);
  });
  
  // HTML title
  document.title = t('title');
  
  // HTML lang Attribut
  document.documentElement.lang = currentLang;
  
  console.log(`🌍 Page translated to: ${currentLang}`);
}

// Language Switcher
document.addEventListener('DOMContentLoaded', () => {
  const langSelector = document.getElementById('language-selector');
  if (langSelector) {
    langSelector.value = currentLang;
    langSelector.addEventListener('change', (e) => {
      if (setLanguage(e.target.value)) {
        translatePage();
        // Listen neu laden
        if (selectedUserId) {
          loadUserCategories();
          if (selectedCategoryId) {
            loadUserCategoryChannels();
          }
        }
      }
    });
  }
});

// === User Management ===
async function loadUsers() {
  const users = await fetchJSON('/api/users');
  const list = document.getElementById('user-list');
  list.innerHTML = '';
  
  users.forEach(u => {
    const li = document.createElement('li');
    li.className = 'list-group-item d-flex justify-content-between align-items-center';
    
    const span = document.createElement('span');
    span.textContent = `${u.username} (id=${u.id})`;
    span.style.cursor = 'pointer';
    span.onclick = () => {
      selectedUser = u;
      selectedUserId = u.id;
      document.getElementById('selected-user-label').textContent = `${t('selectedUser')}: ${u.username} (id=${u.id})`;
      document.getElementById('xtream-user').textContent = u.username;
      document.getElementById('xtream-pass').textContent = t('passwordPlaceholder');
      loadUserCategories();
    };
    
    const delBtn = document.createElement('button');
    delBtn.className = 'btn btn-sm btn-danger';
    delBtn.textContent = t('delete');
    delBtn.onclick = async () => {
      if (!confirm(t('deleteUserConfirm', {name: u.username}))) return;
      await fetchJSON(`/api/users/${u.id}`, {method: 'DELETE'});
      loadUsers();
    };
    
    li.appendChild(span);
    li.appendChild(delBtn);
    list.appendChild(li);
  });
}

// === Provider Management ===
async function loadProviders() {
  const providers = await fetchJSON('/api/providers');
  const list = document.getElementById('provider-list');
  const select = document.getElementById('channel-provider-select');
  list.innerHTML = '';
  select.innerHTML = `<option value="">${t('selectProviderPlaceholder')}</option>`;

  providers.forEach(p => {
    const li = document.createElement('li');
    li.className = 'list-group-item';
    
    const row = document.createElement('div');
    row.className = 'd-flex justify-content-between align-items-center';
    row.innerHTML = `<strong>${p.name}</strong> <small>(${p.url})</small>`;
    
    const btnGroup = document.createElement('div');
    
    const syncBtn = document.createElement('button');
    syncBtn.className = 'btn btn-sm btn-outline-primary me-1';
    syncBtn.textContent = t('sync');
    syncBtn.onclick = async () => {
      if (!selectedUserId) {
        alert(t('pleaseSelectUserFirst'));
        return;
      }
      syncBtn.disabled = true;
      syncBtn.textContent = t('syncing');
      try {
        const res = await fetchJSON(`/api/providers/${p.id}/sync`, {
          method: 'POST',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({user_id: selectedUserId})
        });
        alert(t('syncSuccess', {
          added: res.channels_added,
          updated: res.channels_updated,
          categories: res.categories_added
        }));
      } catch (e) {
        alert(t('errorPrefix') + ' ' + e.message);
      } finally {
        syncBtn.disabled = false;
        syncBtn.textContent = t('sync');
      }
    };
    
    const configBtn = document.createElement('button');
    configBtn.className = 'btn btn-sm btn-outline-secondary me-1';
    configBtn.innerHTML = '⚙️';
    configBtn.title = t('syncConfig');
    configBtn.onclick = () => showSyncConfigModal(p.id);
    
    const logsBtn = document.createElement('button');
    logsBtn.className = 'btn btn-sm btn-outline-info me-1';
    logsBtn.innerHTML = '📊';
    logsBtn.title = t('syncLogs');
    logsBtn.onclick = () => showSyncLogs(p.id);
    
    const delBtn = document.createElement('button');
    delBtn.className = 'btn btn-sm btn-danger';
    delBtn.textContent = t('delete');
    delBtn.onclick = async () => {
      if (!confirm(t('deleteProviderConfirm', {name: p.name}))) return;
      await fetchJSON(`/api/providers/${p.id}`, {method: 'DELETE'});
      loadProviders();
    };
    
    btnGroup.appendChild(syncBtn);
    btnGroup.appendChild(configBtn);
    btnGroup.appendChild(logsBtn);
    btnGroup.appendChild(delBtn);
    row.appendChild(btnGroup);
    li.appendChild(row);
    list.appendChild(li);

    const opt = document.createElement('option');
    opt.value = p.id;
    opt.textContent = p.name;
    select.appendChild(opt);
  });
}

// === Category Management ===
async function loadUserCategories() {
  if (!selectedUserId) return;
  const cats = await fetchJSON(`/api/users/${selectedUserId}/categories`);
  const list = document.getElementById('category-list');
  list.innerHTML = '';
  selectedCategoryId = null;

  cats.forEach(c => {
    const li = document.createElement('li');
    li.className = 'list-group-item d-flex justify-content-between align-items-center';
    li.dataset.id = c.id;
    
    // Adult-Kennzeichnung
    if (c.is_adult) {
      li.style.borderLeft = '4px solid #dc3545';
    }
    
    // Drag Handle
    const dragHandle = document.createElement('span');
    dragHandle.className = 'drag-handle';
    dragHandle.innerHTML = '⋮⋮';
    dragHandle.title = t('dragToSort');
    li.appendChild(dragHandle);
    
    const span = document.createElement('span');
    span.textContent = c.is_adult ? `🔞 ${c.name}` : c.name;
    span.style.cursor = 'pointer';
    span.style.flex = '1';
    span.onclick = () => {
      [...list.children].forEach(el => el.classList.remove('active'));
      li.classList.add('active');
      selectedCategoryId = c.id;
      loadUserCategoryChannels();
    };
    li.appendChild(span);
    
    const btnGroup = document.createElement('div');
    
    // Adult-Toggle Button
    const adultBtn = document.createElement('button');
    adultBtn.className = c.is_adult ? 'btn btn-sm btn-danger me-1' : 'btn btn-sm btn-outline-secondary me-1';
    adultBtn.textContent = t('adult');
    adultBtn.title = c.is_adult ? t('markedAsAdult') : t('markAsAdult');
    adultBtn.onclick = async () => {
      const newState = c.is_adult ? 0 : 1;
      await fetchJSON(`/api/user-categories/${c.id}/adult`, {
        method: 'PUT',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({is_adult: newState})
      });
      loadUserCategories();
    };
    btnGroup.appendChild(adultBtn);
    
    const editBtn = document.createElement('button');
    editBtn.className = 'btn btn-sm btn-outline-secondary me-1';
    editBtn.textContent = t('edit');
    editBtn.onclick = async () => {
      const newName = prompt(t('newName'), c.name);
      if (!newName) return;
      await fetchJSON(`/api/user-categories/${c.id}`, {
        method: 'PUT',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({name: newName})
      });
      loadUserCategories();
    };
    
    const delBtn = document.createElement('button');
    delBtn.className = 'btn btn-sm btn-danger';
    delBtn.textContent = t('delete');
    delBtn.onclick = async () => {
      if (!confirm(t('deleteCategoryConfirm', {name: c.name}))) return;
      await fetchJSON(`/api/user-categories/${c.id}`, {method: 'DELETE'});
      loadUserCategories();
    };
    
    btnGroup.appendChild(editBtn);
    btnGroup.appendChild(delBtn);
    li.appendChild(btnGroup);
    
    list.appendChild(li);
  });
  
  // Sortable initialisieren
  initCategorySortable();
}

function initCategorySortable() {
  if (categorySortable) {
    categorySortable.destroy();
  }
  
  const list = document.getElementById('category-list');
  if (!list || list.children.length === 0) return;
  
  categorySortable = Sortable.create(list, {
    animation: 150,
    handle: '.drag-handle',
    ghostClass: 'sortable-ghost',
    dragClass: 'sortable-drag',
    onEnd: async function(evt) {
      const categoryIds = Array.from(list.children).map(li => Number(li.dataset.id));
      
      try {
        await fetchJSON(`/api/users/${selectedUserId}/categories/reorder`, {
          method: 'PUT',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({category_ids: categoryIds})
        });
        console.log('✅ Category order saved');
      } catch (e) {
        console.error('❌ Save error:', e);
        alert(t('errorPrefix') + ' ' + e.message);
        loadUserCategories();
      }
    }
  });
}

// === Provider Category Import ===
let providerCategories = [];

async function loadProviderCategories() {
  if (!selectedUserId) {
    alert(t('pleaseSelectUserFirst'));
    return;
  }

  const select = document.getElementById('channel-provider-select');
  const providerId = select.value;
  
  if (!providerId) {
    alert(t('pleaseSelectProvider'));
    return;
  }

  const modalEl = document.getElementById('importCategoryModal');
  const list = document.getElementById('provider-categories-list');
  list.innerHTML = `<li class="list-group-item text-muted">${t('loadingCategories')}</li>`;
  
  const modal = new bootstrap.Modal(modalEl);
  modal.show();

  try {
    providerCategories = await fetchJSON(`/api/providers/${providerId}/categories`);
    renderProviderCategories();
  } catch (e) {
    console.error('❌ Error:', e);
    list.innerHTML = `<li class="list-group-item text-danger">${t('loadingError')}</li>`;
  }
}

function renderProviderCategories() {
  const list = document.getElementById('provider-categories-list');
  const searchInput = document.getElementById('category-import-search');
  const search = searchInput.value.toLowerCase().trim();
  
  list.innerHTML = '';
  
  if (!providerCategories || providerCategories.length === 0) {
    list.innerHTML = `<li class="list-group-item text-muted">${t('noCategoriesFound')}</li>`;
    return;
  }

  const filtered = search 
    ? providerCategories.filter(cat => cat.category_name.toLowerCase().includes(search))
    : providerCategories;

  if (filtered.length === 0) {
    list.innerHTML = `<li class="list-group-item text-muted">${t('noResults', {search: search})}</li>`;
    return;
  }

  filtered.forEach(cat => {
    const li = document.createElement('li');
    li.className = 'list-group-item';
    
    if (cat.is_adult) {
      li.style.borderLeft = '4px solid #dc3545';
    }
    
    const row = document.createElement('div');
    row.className = 'd-flex justify-content-between align-items-center';
    
    const info = document.createElement('div');
    const catNameDisplay = cat.is_adult ? `🔞 ${cat.category_name}` : cat.category_name;
    info.innerHTML = `
      <strong>${catNameDisplay}</strong><br>
      <small class="text-muted">${cat.channel_count} ${t('channels')}</small>
    `;
    row.appendChild(info);
    
    const btnGroup = document.createElement('div');
    
    const importBtn = document.createElement('button');
    importBtn.className = 'btn btn-sm btn-primary me-1';
    importBtn.textContent = t('importCategoryOnly');
    importBtn.onclick = async () => {
      await importCategory(cat, false);
    };
    
    const importWithChannelsBtn = document.createElement('button');
    importWithChannelsBtn.className = 'btn btn-sm btn-success';
    importWithChannelsBtn.textContent = t('importWithChannels');
    importWithChannelsBtn.onclick = async () => {
      await importCategory(cat, true);
    };
    
    btnGroup.appendChild(importBtn);
    btnGroup.appendChild(importWithChannelsBtn);
    row.appendChild(btnGroup);
    
    li.appendChild(row);
    list.appendChild(li);
  });
}

async function importCategory(cat, withChannels) {
  if (!selectedUserId) {
    alert(t('pleaseSelectUserFirst'));
    return;
  }

  const select = document.getElementById('channel-provider-select');
  const providerId = select.value;

  try {
    const result = await fetchJSON(`/api/providers/${providerId}/import-category`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({
        user_id: selectedUserId,
        category_id: cat.category_id,
        category_name: cat.category_name,
        import_channels: withChannels
      })
    });

    let msg = withChannels 
      ? t('categoryImportedWithChannels', {name: cat.category_name, count: result.channels_imported})
      : t('categoryImportedOnly', {name: cat.category_name});
    
    if (result.is_adult) {
      msg += '\n' + t('markedAsAdultContent');
    }
    
    alert(msg);

    loadUserCategories();
    
    const modalEl = document.getElementById('importCategoryModal');
    const modalInstance = bootstrap.Modal.getInstance(modalEl);
    if (modalInstance) {
      modalInstance.hide();
    }
  } catch (e) {
    console.error('❌ Import error:', e);
    alert(t('errorPrefix') + ' ' + e.message);
  }
}

// === Channel Management ===
async function loadProviderChannels() {
  const select = document.getElementById('channel-provider-select');
  const providerId = select.value;
  const searchInput = document.getElementById('channel-search');
  const list = document.getElementById('provider-channel-list');
  
  if (!providerId) {
    list.innerHTML = `<li class="list-group-item text-muted">${t('pleaseSelectProvider')}</li>`;
    searchInput.disabled = true;
    searchInput.value = '';
    providerChannelsCache = [];
    return;
  }
  
  list.innerHTML = `<li class="list-group-item text-muted">${t('loadingChannels')}</li>`;
  searchInput.disabled = true;
  
  try {
    const chans = await fetchJSON(`/api/providers/${providerId}/channels`);
    providerChannelsCache = chans;
    searchInput.disabled = false;
    searchInput.value = '';
    renderProviderChannels();
  } catch (e) {
    list.innerHTML = `<li class="list-group-item text-danger">${t('loadingError')}</li>`;
    console.error('Channel load error:', e);
  }
}

function renderProviderChannels() {
  const list = document.getElementById('provider-channel-list');
  const searchInput = document.getElementById('channel-search');
  const search = searchInput.value.toLowerCase().trim();
  
  list.innerHTML = '';
  
  if (!providerChannelsCache || providerChannelsCache.length === 0) {
    list.innerHTML = `<li class="list-group-item text-muted">${t('noChannelsAvailable')}</li>`;
    return;
  }
  
  const filtered = search 
    ? providerChannelsCache.filter(ch => ch.name.toLowerCase().includes(search))
    : providerChannelsCache;
  
  if (filtered.length === 0) {
    list.innerHTML = `<li class="list-group-item text-muted">${t('noResults', {search: search})}</li>`;
    return;
  }
  
  const displayCount = Math.min(filtered.length, 100);
  
  for (let i = 0; i < displayCount; i++) {
    const ch = filtered[i];
    const li = document.createElement('li');
    li.className = 'list-group-item d-flex justify-content-between align-items-center';
    
    const nameSpan = document.createElement('span');
    nameSpan.textContent = ch.name;
    nameSpan.style.flex = '1';
    nameSpan.style.overflow = 'hidden';
    nameSpan.style.textOverflow = 'ellipsis';
    li.appendChild(nameSpan);
    
    if (ch.logo) {
      const img = document.createElement('img');
      img.src = ch.logo;
      img.style.width = '20px';
      img.style.height = '20px';
      img.style.marginLeft = '5px';
      img.onerror = () => img.style.display = 'none';
      li.appendChild(img);
    }
    
    const btn = document.createElement('button');
    btn.className = 'btn btn-sm btn-success ms-2';
    btn.textContent = t('add');
    btn.onclick = async () => {
      if (!selectedUserId || !selectedCategoryId) {
        alert(t('selectUserAndCategory'));
        return;
      }
      try {
        await fetchJSON(`/api/user-categories/${selectedCategoryId}/channels`, {
          method: 'POST',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({provider_channel_id: ch.id})
        });
        loadUserCategoryChannels();
      } catch (e) {
        alert(t('errorPrefix') + ' ' + e.message);
      }
    };
    
    li.appendChild(btn);
    list.appendChild(li);
  }
  
  if (filtered.length > 100) {
    const li = document.createElement('li');
    li.className = 'list-group-item text-muted text-center';
    li.textContent = t('moreChannels', {count: filtered.length - 100});
    list.appendChild(li);
  }
}

async function loadUserCategoryChannels() {
  if (!selectedCategoryId) return;
  const chans = await fetchJSON(`/api/user-categories/${selectedCategoryId}/channels`);
  const list = document.getElementById('user-channel-list');
  list.innerHTML = '';
  
  if (chans.length === 0) {
    list.innerHTML = `<li class="list-group-item text-muted">${t('noChannels')}</li>`;
    if (channelSortable) {
      channelSortable.destroy();
      channelSortable = null;
    }
    return;
  }
  
  chans.forEach(ch => {
    const li = document.createElement('li');
    li.className = 'list-group-item d-flex justify-content-between align-items-center';
    li.dataset.id = ch.user_channel_id;
    
    // Drag Handle
    const dragHandle = document.createElement('span');
    dragHandle.className = 'drag-handle';
    dragHandle.innerHTML = '⋮⋮';
    dragHandle.title = t('dragToSort');
    li.appendChild(dragHandle);
    
    const nameSpan = document.createElement('span');
    nameSpan.textContent = ch.name;
    nameSpan.style.flex = '1';
    li.appendChild(nameSpan);
    
    if (ch.logo) {
      const img = document.createElement('img');
      img.src = ch.logo;
      img.style.width = '20px';
      img.style.height = '20px';
      img.style.marginLeft = '5px';
      img.onerror = () => img.style.display = 'none';
      li.appendChild(img);
    }
    
    const delBtn = document.createElement('button');
    delBtn.className = 'btn btn-sm btn-danger ms-2';
    delBtn.textContent = t('delete');
    delBtn.onclick = async () => {
      await fetchJSON(`/api/user-channels/${ch.user_channel_id}`, {method: 'DELETE'});
      loadUserCategoryChannels();
    };
    
    li.appendChild(delBtn);
    list.appendChild(li);
  });
  
  // Sortable initialisieren
  initChannelSortable();
}

function initChannelSortable() {
  if (channelSortable) {
    channelSortable.destroy();
  }
  
  const list = document.getElementById('user-channel-list');
  if (!list || list.children.length === 0) return;
  
  channelSortable = Sortable.create(list, {
    animation: 150,
    handle: '.drag-handle',
    ghostClass: 'sortable-ghost',
    dragClass: 'sortable-drag',
    onEnd: async function(evt) {
      const channelIds = Array.from(list.children).map(li => Number(li.dataset.id));
      
      try {
        await fetchJSON(`/api/user-categories/${selectedCategoryId}/channels/reorder`, {
          method: 'PUT',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({channel_ids: channelIds})
        });
        console.log('✅ Channel order saved');
      } catch (e) {
        console.error('❌ Save error:', e);
        alert(t('errorPrefix') + ' ' + e.message);
        loadUserCategoryChannels();
      }
    }
  });
}

// === Form Handlers ===
document.getElementById('user-form').addEventListener('submit', async e => {
  e.preventDefault();
  const f = e.target;
  try {
    await fetchJSON('/api/users', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({username: f.username.value, password: f.password.value})
    });
    f.reset();
    loadUsers();
    alert(t('userCreated'));
  } catch (e) {
    // Show user-friendly error message
    const errorData = e.response || {};
    const errorMessage = errorData.message || e.message || 'Unknown error';
    alert(t('errorPrefix') + ' ' + errorMessage);
  }
});

document.getElementById('provider-form').addEventListener('submit', async e => {
  e.preventDefault();
  const f = e.target;
  try {
    await fetchJSON('/api/providers', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({
        name: f.name.value,
        url: f.url.value,
        username: f.username.value,
        password: f.password.value,
        epg_url: f.epg_url.value || null
      })
    });
    f.reset();
    loadProviders();
    alert(t('providerCreated'));
  } catch (e) {
    alert(t('errorPrefix') + ' ' + e.message);
  }
});

document.getElementById('category-form').addEventListener('submit', async e => {
  e.preventDefault();
  if (!selectedUserId) {
    alert(t('pleaseSelectUserFirst'));
    return;
  }
  const f = e.target;
  try {
    await fetchJSON(`/api/users/${selectedUserId}/categories`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({name: f.name.value})
    });
    f.reset();
    loadUserCategories();
    alert(t('categoryCreated'));
  } catch (e) {
    alert(t('errorPrefix') + ' ' + e.message);
  }
});

// === Event Handlers ===
document.getElementById('channel-provider-select').addEventListener('change', loadProviderChannels);
document.getElementById('channel-search').addEventListener('input', () => {
  renderProviderChannels();
});

// === Sync Configuration Management ===
let currentSyncConfig = null;

async function loadSyncConfig(providerId, userId) {
  try {
    const config = await fetchJSON(`/api/sync-configs/${providerId}/${userId}`);
    currentSyncConfig = config;
    return config;
  } catch (e) {
    console.error('Failed to load sync config:', e);
    return null;
  }
}

async function showSyncConfigModal(providerId) {
  if (!selectedUserId) {
    alert(t('pleaseSelectUserFirst'));
    return;
  }
  
  const config = await loadSyncConfig(providerId, selectedUserId);
  
  const modal = document.getElementById('sync-config-modal');
  const form = document.getElementById('sync-config-form');
  
  // Set form values
  document.getElementById('sync-provider-id').value = providerId;
  document.getElementById('sync-user-id').value = selectedUserId;
  document.getElementById('sync-enabled').checked = config ? config.enabled : true;
  document.getElementById('sync-interval').value = config ? config.sync_interval : 'daily';
  document.getElementById('sync-auto-categories').checked = config ? config.auto_add_categories : true;
  document.getElementById('sync-auto-channels').checked = config ? config.auto_add_channels : true;
  
  // Show last sync info if available
  const lastSyncInfo = document.getElementById('last-sync-info');
  if (config && config.last_sync) {
    const date = new Date(config.last_sync * 1000);
    lastSyncInfo.textContent = `${t('lastSync')}: ${date.toLocaleString()}`;
    lastSyncInfo.style.display = 'block';
  } else {
    lastSyncInfo.style.display = 'none';
  }
  
  const bsModal = new bootstrap.Modal(modal);
  bsModal.show();
}

async function saveSyncConfig(e) {
  e.preventDefault();
  const form = e.target;
  
  const providerId = Number(form['sync-provider-id'].value);
  const userId = Number(form['sync-user-id'].value);
  const enabled = form['sync-enabled'].checked;
  const syncInterval = form['sync-interval'].value;
  const autoCategories = form['sync-auto-categories'].checked;
  const autoChannels = form['sync-auto-channels'].checked;
  
  try {
    const config = await loadSyncConfig(providerId, userId);
    
    if (config) {
      // Update existing
      await fetchJSON(`/api/sync-configs/${config.id}`, {
        method: 'PUT',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({
          enabled,
          sync_interval: syncInterval,
          auto_add_categories: autoCategories,
          auto_add_channels: autoChannels
        })
      });
    } else {
      // Create new
      await fetchJSON('/api/sync-configs', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({
          provider_id: providerId,
          user_id: userId,
          enabled,
          sync_interval: syncInterval,
          auto_add_categories: autoCategories,
          auto_add_channels: autoChannels
        })
      });
    }
    
    alert(t('syncConfigSaved'));
    bootstrap.Modal.getInstance(document.getElementById('sync-config-modal')).hide();
  } catch (e) {
    alert(t('errorPrefix') + ' ' + e.message);
  }
}

async function showSyncLogs(providerId) {
  if (!selectedUserId) {
    alert(t('pleaseSelectUserFirst'));
    return;
  }
  
  try {
    const logs = await fetchJSON(`/api/sync-logs?provider_id=${providerId}&user_id=${selectedUserId}&limit=20`);
    
    const tbody = document.getElementById('sync-logs-tbody');
    tbody.innerHTML = '';
    
    if (logs.length === 0) {
      tbody.innerHTML = '<tr><td colspan="6" class="text-center">' + t('noSyncLogs') + '</td></tr>';
    } else {
      logs.forEach(log => {
        const tr = document.createElement('tr');
        const date = new Date(log.sync_time * 1000);
        const statusClass = log.status === 'success' ? 'success' : 'danger';
        
        tr.innerHTML = `
          <td>${date.toLocaleString()}</td>
          <td><span class="badge bg-${statusClass}">${log.status}</span></td>
          <td>${log.channels_added || 0}</td>
          <td>${log.channels_updated || 0}</td>
          <td>${log.categories_added || 0}</td>
          <td>${log.error_message || '-'}</td>
        `;
        tbody.appendChild(tr);
      });
    }
    
    const modal = new bootstrap.Modal(document.getElementById('sync-logs-modal'));
    modal.show();
  } catch (e) {
    alert(t('errorPrefix') + ' ' + e.message);
  }
}

// === EPG Sources Management ===
let availableEpgSources = [];

async function loadEpgSources() {
  try {
    const sources = await fetchJSON('/api/epg-sources');
    const list = document.getElementById('epg-sources-list');
    list.innerHTML = '';
    
    if (sources.length === 0) {
      list.innerHTML = `<li class="list-group-item text-muted">${t('noEpgSourcesConfigured')}</li>`;
      return;
    }
    
    sources.forEach(source => {
      const li = document.createElement('li');
      li.className = 'list-group-item d-flex justify-content-between align-items-center';
      
      const isProvider = typeof source.id === 'string' && source.id.startsWith('provider_');
      const lastUpdate = source.last_update ? new Date(source.last_update * 1000).toLocaleString() : t('never');
      const isUpdating = source.is_updating ? `🔄 ${t('updating')}` : '';
      const enabledStatus = source.enabled ? `✅ ${t('enabled')}` : `❌ ${t('disable')}`;
      
      const info = document.createElement('div');
      info.innerHTML = `
        <strong>${source.name}</strong>
        <br><small class="text-muted">${source.url}</small>
        <br><small>${enabledStatus} | Update: ${source.update_interval / 3600}h | Last: ${lastUpdate} ${isUpdating}</small>
      `;
      
      const btnGroup = document.createElement('div');
      btnGroup.className = 'd-flex gap-1';
      
      // Update button
      const updateBtn = document.createElement('button');
      updateBtn.className = 'btn btn-sm btn-outline-info';
      updateBtn.innerHTML = '🔄';
      updateBtn.title = t('updateNow');
      updateBtn.disabled = source.is_updating;
      updateBtn.onclick = async () => {
        updateBtn.disabled = true;
        updateBtn.innerHTML = '⏳';
        try {
          await fetchJSON(`/api/epg-sources/${source.id}/update`, {method: 'POST'});
          alert(t('epgUpdateSuccess'));
          loadEpgSources();
        } catch (e) {
          alert(t('errorPrefix') + ' ' + e.message);
        } finally {
          updateBtn.disabled = false;
          updateBtn.innerHTML = '🔄';
        }
      };
      
      btnGroup.appendChild(updateBtn);
      
      // Only show edit/toggle/delete for non-provider sources
      if (!isProvider) {
        const editBtn = document.createElement('button');
        editBtn.className = 'btn btn-sm btn-outline-secondary';
        editBtn.innerHTML = '✏️';
        editBtn.title = t('edit');
        editBtn.onclick = () => showEditEpgSourceModal(source);
        
        const toggleBtn = document.createElement('button');
        toggleBtn.className = `btn btn-sm ${source.enabled ? 'btn-warning' : 'btn-success'}`;
        toggleBtn.textContent = source.enabled ? t('disable') : t('enable');
        toggleBtn.onclick = async () => {
          await fetchJSON(`/api/epg-sources/${source.id}`, {
            method: 'PUT',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({enabled: !source.enabled})
          });
          loadEpgSources();
        };
        
        const delBtn = document.createElement('button');
        delBtn.className = 'btn btn-sm btn-danger';
        delBtn.textContent = '🗑';
        delBtn.onclick = async () => {
          if (!confirm(t('confirmDeleteEpgSource', {name: source.name}))) return;
          await fetchJSON(`/api/epg-sources/${source.id}`, {method: 'DELETE'});
          loadEpgSources();
        };
        
        btnGroup.appendChild(editBtn);
        btnGroup.appendChild(toggleBtn);
        btnGroup.appendChild(delBtn);
      }
      
      li.appendChild(info);
      li.appendChild(btnGroup);
      list.appendChild(li);
    });
  } catch (e) {
    console.error('Failed to load EPG sources:', e);
  }
}

async function showEditEpgSourceModal(source) {
  const modal = new bootstrap.Modal(document.getElementById('edit-epg-source-modal'));
  document.getElementById('edit-epg-source-id').value = source.id;
  document.getElementById('edit-epg-source-name').value = source.name;
  document.getElementById('edit-epg-source-url').value = source.url;
  document.getElementById('edit-epg-update-interval').value = source.update_interval;
  document.getElementById('edit-epg-source-enabled').checked = source.enabled;
  modal.show();
}

async function editEpgSource(e) {
  e.preventDefault();
  const form = e.target;
  const id = form['edit-epg-source-id'].value;
  
  try {
    await fetchJSON(`/api/epg-sources/${id}`, {
      method: 'PUT',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({
        name: form['edit-epg-source-name'].value,
        url: form['edit-epg-source-url'].value,
        enabled: form['edit-epg-source-enabled'].checked,
        update_interval: Number(form['edit-epg-update-interval'].value)
      })
    });
    
    bootstrap.Modal.getInstance(document.getElementById('edit-epg-source-modal')).hide();
    loadEpgSources();
    alert(t('epgSourceUpdated'));
  } catch (e) {
    alert(t('errorPrefix') + ' ' + e.message);
  }
}

async function showAddEpgSourceModal() {
  const modal = new bootstrap.Modal(document.getElementById('add-epg-source-modal'));
  document.getElementById('add-epg-source-form').reset();
  modal.show();
}

async function addEpgSource(e) {
  e.preventDefault();
  const form = e.target;
  
  try {
    await fetchJSON('/api/epg-sources', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({
        name: form['epg-source-name'].value,
        url: form['epg-source-url'].value,
        enabled: form['epg-source-enabled'].checked,
        update_interval: Number(form['epg-update-interval'].value),
        source_type: 'custom'
      })
    });
    
    bootstrap.Modal.getInstance(document.getElementById('add-epg-source-modal')).hide();
    loadEpgSources();
    alert(t('epgSourceAdded'));
  } catch (e) {
    alert(t('errorPrefix') + ' ' + e.message);
  }
}

async function showBrowseEpgSourcesModal() {
  const modal = new bootstrap.Modal(document.getElementById('browse-epg-sources-modal'));
  modal.show();
  
  const list = document.getElementById('available-epg-sources-list');
  list.innerHTML = `<li class="list-group-item text-muted">${t('loading')}</li>`;
  
  try {
    availableEpgSources = await fetchJSON('/api/epg-sources/available');
    renderAvailableEpgSources();
  } catch (e) {
    list.innerHTML = `<li class="list-group-item text-danger">${t('failedToLoadSources')}</li>`;
  }
}

function renderAvailableEpgSources() {
  const list = document.getElementById('available-epg-sources-list');
  const search = document.getElementById('epg-browse-search').value.toLowerCase();
  
  const filtered = availableEpgSources.filter(s => 
    s.name.toLowerCase().includes(search)
  );
  
  list.innerHTML = '';
  
  if (filtered.length === 0) {
    list.innerHTML = `<li class="list-group-item text-muted">${t('noSourcesFound')}</li>`;
    return;
  }
  
  filtered.forEach(source => {
    const li = document.createElement('li');
    li.className = 'list-group-item d-flex justify-content-between align-items-center';
    
    const info = document.createElement('div');
    info.innerHTML = `
      <strong>${source.name}</strong>
      <br><small class="text-muted">${(source.size / 1024 / 1024).toFixed(2)} MB</small>
    `;
    
    const addBtn = document.createElement('button');
    addBtn.className = 'btn btn-sm btn-primary';
    addBtn.textContent = t('add');
    addBtn.onclick = async () => {
      try {
        await fetchJSON('/api/epg-sources', {
          method: 'POST',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({
            name: source.name,
            url: source.url,
            enabled: true,
            update_interval: 86400,
            source_type: 'globetv'
          })
        });
        
        alert(t('epgSourceAddedName', {name: source.name}));
        loadEpgSources();
      } catch (e) {
        alert(t('errorPrefix') + ' ' + e.message);
      }
    };
    
    li.appendChild(info);
    li.appendChild(addBtn);
    list.appendChild(li);
  });
}

// === Init ===
document.addEventListener('DOMContentLoaded', () => {
  // Seite übersetzen
  translatePage();
  
  document.getElementById('xtream-url').textContent = window.location.origin;
  document.getElementById('xtream-pass').textContent = t('passwordPlaceholder');
  document.getElementById('epg-url').textContent = window.location.origin + '/xmltv.php?username=<USER>&password=<PASS>';
  
  const importBtn = document.getElementById('import-categories-btn');
  if (importBtn) {
    importBtn.addEventListener('click', loadProviderCategories);
  }
  
  const catSearch = document.getElementById('category-import-search');
  if (catSearch) {
    catSearch.addEventListener('input', renderProviderCategories);
  }
  
  const syncConfigForm = document.getElementById('sync-config-form');
  if (syncConfigForm) {
    syncConfigForm.addEventListener('submit', saveSyncConfig);
  }
  
  const addEpgSourceBtn = document.getElementById('add-epg-source-btn');
  if (addEpgSourceBtn) {
    addEpgSourceBtn.addEventListener('click', showAddEpgSourceModal);
  }
  
  const browseEpgSourcesBtn = document.getElementById('browse-epg-sources-btn');
  if (browseEpgSourcesBtn) {
    browseEpgSourcesBtn.addEventListener('click', showBrowseEpgSourcesModal);
  }
  
  const updateAllEpgBtn = document.getElementById('update-all-epg-btn');
  if (updateAllEpgBtn) {
    updateAllEpgBtn.addEventListener('click', async () => {
      if (!confirm(t('epgUpdateAllConfirm'))) return;
      updateAllEpgBtn.disabled = true;
      updateAllEpgBtn.innerHTML = `⏳ ${t('updating')}`;
      try {
        const result = await fetchJSON('/api/epg-sources/update-all', {method: 'POST'});
        const success = result.results.filter(r => r.success).length;
        const failed = result.results.filter(r => !r.success).length;
        alert(t('epgUpdateAllSuccess', {success: success, failed: failed}));
        loadEpgSources();
      } catch (e) {
        alert(t('errorPrefix') + ' ' + e.message);
      } finally {
        updateAllEpgBtn.disabled = false;
        updateAllEpgBtn.innerHTML = t('updateAllEpg');
      }
    });
  }
  
  const addEpgSourceForm = document.getElementById('add-epg-source-form');
  if (addEpgSourceForm) {
    addEpgSourceForm.addEventListener('submit', addEpgSource);
  }
  
  const editEpgSourceForm = document.getElementById('edit-epg-source-form');
  if (editEpgSourceForm) {
    editEpgSourceForm.addEventListener('submit', editEpgSource);
  }
  
  const epgBrowseSearch = document.getElementById('epg-browse-search');
  if (epgBrowseSearch) {
    epgBrowseSearch.addEventListener('input', renderAvailableEpgSources);
  }
  
  // EPG Mapping Events
  const epgMappingProviderSelect = document.getElementById('epg-mapping-provider-select');
  if (epgMappingProviderSelect) {
    epgMappingProviderSelect.addEventListener('change', loadEpgMappingChannels);
  }

  const autoMapBtn = document.getElementById('auto-map-btn');
  if (autoMapBtn) {
    autoMapBtn.addEventListener('click', handleAutoMap);
  }

  const epgMappingSearch = document.getElementById('epg-mapping-search');
  if (epgMappingSearch) {
    epgMappingSearch.addEventListener('input', renderEpgMappingChannels);
  }

  const epgSelectSearch = document.getElementById('epg-select-search');
  if (epgSelectSearch) {
    epgSelectSearch.addEventListener('input', filterEpgSelectionList);
  }

  // Check authentication on page load
  checkAuthentication();
  
  console.log('✅ IPTV-Manager loaded with i18n & local assets');
});

// === View Management ===
function switchView(viewName) {
  // Hide all views
  document.getElementById('view-dashboard').classList.add('d-none');
  document.getElementById('view-epg-mapping').classList.add('d-none');

  // Update nav active state
  document.querySelectorAll('.nav-link').forEach(el => el.classList.remove('active'));

  // Show selected view
  if (viewName === 'dashboard') {
    document.getElementById('view-dashboard').classList.remove('d-none');
    document.getElementById('nav-dashboard').classList.add('active');
  } else if (viewName === 'epg-mapping') {
    document.getElementById('view-epg-mapping').classList.remove('d-none');
    document.getElementById('nav-epg-mapping').classList.add('active');
    loadEpgMappingProviders();
  }
}

// === EPG Mapping Logic ===
let epgMappingChannels = [];
let availableEpgChannels = [];

async function loadEpgMappingProviders() {
  const providers = await fetchJSON('/api/providers');
  const select = document.getElementById('epg-mapping-provider-select');
  const currentVal = select.value;

  select.innerHTML = `<option value="" data-i18n="selectProviderPlaceholder">${t('selectProviderPlaceholder')}</option>`;

  providers.forEach(p => {
    const opt = document.createElement('option');
    opt.value = p.id;
    opt.textContent = p.name;
    select.appendChild(opt);
  });

  if (currentVal) select.value = currentVal;
}

async function loadEpgMappingChannels() {
  const providerId = document.getElementById('epg-mapping-provider-select').value;
  const tbody = document.getElementById('epg-mapping-tbody');
  const autoMapBtn = document.getElementById('auto-map-btn');

  if (!providerId) {
    tbody.innerHTML = `<tr><td colspan="5" class="text-center p-4 text-muted">${t('selectProviderFirst')}</td></tr>`;
    autoMapBtn.disabled = true;
    epgMappingChannels = [];
    return;
  }

  tbody.innerHTML = `<tr><td colspan="5" class="text-center p-4 text-muted">${t('loading')}</td></tr>`;
  autoMapBtn.disabled = true;

  try {
    const [channels, mappings] = await Promise.all([
      fetchJSON(`/api/providers/${providerId}/channels`),
      fetchJSON(`/api/mapping/${providerId}`)
    ]);

    // Merge data
    epgMappingChannels = channels.map(ch => ({
      ...ch,
      current_epg_id: ch.epg_channel_id,
      manual_epg_id: mappings[ch.id] || null
    }));

    renderEpgMappingChannels();
    autoMapBtn.disabled = false;

    // Update stats
    updateMappingStats();

    // Preload available EPG channels for the modal
    loadAvailableEpgChannels();

  } catch (e) {
    tbody.innerHTML = `<tr><td colspan="5" class="text-center p-4 text-danger">${t('errorPrefix')} ${e.message}</td></tr>`;
  }
}

function renderEpgMappingChannels() {
  const tbody = document.getElementById('epg-mapping-tbody');
  const search = document.getElementById('epg-mapping-search').value.toLowerCase();

  const filtered = epgMappingChannels.filter(ch =>
    ch.name.toLowerCase().includes(search) ||
    (ch.manual_epg_id && ch.manual_epg_id.toLowerCase().includes(search)) ||
    (ch.current_epg_id && ch.current_epg_id.toLowerCase().includes(search))
  );

  tbody.innerHTML = '';

  if (filtered.length === 0) {
    tbody.innerHTML = `<tr><td colspan="5" class="text-center p-4 text-muted">${t('noResults', {search: search})}</td></tr>`;
    return;
  }

  // Render only first 100 for performance
  const toRender = filtered.slice(0, 100);

  toRender.forEach((ch, idx) => {
    const tr = document.createElement('tr');

    // Highlight manual mappings
    if (ch.manual_epg_id) {
      tr.classList.add('table-info');
    }

    const displayEpgId = ch.manual_epg_id || ch.current_epg_id || '<span class="text-muted">-</span>';
    const manualDisplay = ch.manual_epg_id ? `<b>${ch.manual_epg_id}</b>` : '<span class="text-muted">-</span>';

    tr.innerHTML = `
      <td>${idx + 1}</td>
      <td>
        <div class="d-flex align-items-center">
          ${ch.logo ? `<img src="${ch.logo}" width="24" height="24" class="me-2" onerror="this.style.display='none'">` : ''}
          <span>${ch.name}</span>
        </div>
      </td>
      <td>${displayEpgId}</td>
      <td>${manualDisplay}</td>
      <td>
        <div class="btn-group btn-group-sm">
          <button class="btn btn-outline-primary map-btn" data-id="${ch.id}">${t('map')}</button>
          ${ch.manual_epg_id ? `<button class="btn btn-outline-danger unmap-btn" data-id="${ch.id}">${t('unmap')}</button>` : ''}
        </div>
      </td>
    `;

    tbody.appendChild(tr);
  });

  // Add listeners
  tbody.querySelectorAll('.map-btn').forEach(btn => {
    btn.onclick = () => showEpgSelectionModal(Number(btn.dataset.id));
  });

  tbody.querySelectorAll('.unmap-btn').forEach(btn => {
    btn.onclick = () => handleUnmap(Number(btn.dataset.id));
  });

  if (filtered.length > 100) {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td colspan="5" class="text-center text-muted">${t('moreChannels', {count: filtered.length - 100})}</td>`;
    tbody.appendChild(tr);
  }
}

function updateMappingStats() {
  const total = epgMappingChannels.length;
  const mapped = epgMappingChannels.filter(ch => ch.manual_epg_id || ch.current_epg_id).length;
  const manual = epgMappingChannels.filter(ch => ch.manual_epg_id).length;

  const stats = document.getElementById('mapping-stats');
  if (stats) {
    stats.textContent = `Total: ${total} | Mapped: ${mapped} (${Math.round(mapped/total*100)}%) | Manual: ${manual}`;
  }
}

async function loadAvailableEpgChannels() {
  try {
    availableEpgChannels = await fetchJSON('/api/epg/channels');
  } catch (e) {
    console.error('Failed to load EPG channels', e);
  }
}

// === Auto Mapping ===
async function handleAutoMap() {
  const providerId = document.getElementById('epg-mapping-provider-select').value;
  if (!providerId) return;

  if (!confirm(t('autoMapConfirm'))) return;

  const btn = document.getElementById('auto-map-btn');
  btn.disabled = true;
  btn.innerHTML = '⏳ ...';

  try {
    const res = await fetchJSON('/api/mapping/auto', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({provider_id: providerId})
    });

    alert(t('autoMapSuccess', {count: res.matched}));
    loadEpgMappingChannels();
  } catch (e) {
    alert(t('errorPrefix') + ' ' + e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = t('autoMap');
  }
}

// === Manual Mapping ===
let currentMappingChannelId = null;

function showEpgSelectionModal(channelId) {
  currentMappingChannelId = channelId;
  const modal = new bootstrap.Modal(document.getElementById('epg-select-modal'));

  // Reset search
  document.getElementById('epg-select-search').value = '';
  filterEpgSelectionList();

  modal.show();
}

function filterEpgSelectionList() {
  const list = document.getElementById('epg-select-list');
  const search = document.getElementById('epg-select-search').value.toLowerCase();

  list.innerHTML = '';

  const filtered = availableEpgChannels.filter(epg =>
    epg.name.toLowerCase().includes(search) ||
    epg.id.toLowerCase().includes(search)
  );

  // Limit to 100
  const toRender = filtered.slice(0, 100);

  if (toRender.length === 0) {
    list.innerHTML = `<li class="list-group-item text-center text-muted">${t('noResults', {search: search})}</li>`;
    return;
  }

  toRender.forEach(epg => {
    const li = document.createElement('li');
    li.className = 'list-group-item list-group-item-action';
    li.style.cursor = 'pointer';
    li.innerHTML = `
      <div class="d-flex justify-content-between align-items-center">
        <div>
          <strong>${epg.name}</strong> <br>
          <small class="text-muted">${epg.id}</small>
        </div>
        ${epg.logo ? `<img src="${epg.logo}" height="30" onerror="this.style.display='none'">` : ''}
      </div>
    `;

    li.onclick = () => selectEpgMapping(epg.id);
    list.appendChild(li);
  });
}

async function selectEpgMapping(epgId) {
  if (!currentMappingChannelId) return;

  try {
    await fetchJSON('/api/mapping/manual', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({
        provider_channel_id: currentMappingChannelId,
        epg_channel_id: epgId
      })
    });

    bootstrap.Modal.getInstance(document.getElementById('epg-select-modal')).hide();
    loadEpgMappingChannels();

    // Optional: Toast or small notification
  } catch (e) {
    alert(t('errorPrefix') + ' ' + e.message);
  }
}

async function handleUnmap(channelId) {
  try {
    await fetchJSON(`/api/mapping/${channelId}`, {method: 'DELETE'});
    loadEpgMappingChannels();
  } catch (e) {
    alert(t('errorPrefix') + ' ' + e.message);
  }
}

// Authentication Functions
function showLoginModal() {
  const modal = document.getElementById('login-modal');
  if (modal) {
    const bsModal = new bootstrap.Modal(modal);
    bsModal.show();
  }
}

function hideLoginModal() {
  const modal = document.getElementById('login-modal');
  if (modal) {
    const bsModal = bootstrap.Modal.getInstance(modal);
    if (bsModal) bsModal.hide();
  }
}

async function checkAuthentication() {
  const token = getToken();
  
  if (!token || isTokenExpired()) {
    showLoginModal();
    return false;
  }
  
  try {
    await fetchJSON('/api/verify-token');
    
    // Show the main UI if token is valid
    document.getElementById('main-navbar').style.display = 'block';
    document.getElementById('main-content').style.display = 'block';
    
    loadUsers();
    loadProviders();
    loadEpgSources();
    return true;
  } catch {
    removeToken();
    showLoginModal();
    return false;
  }
}

async function handleLogin(event) {
  event.preventDefault();
  
  const username = document.getElementById('login-username').value;
  const password = document.getElementById('login-password').value;
  const loginBtn = document.getElementById('login-btn');
  const errorDiv = document.getElementById('login-error');
  
  if (!username || !password) {
    errorDiv.textContent = t('missing_credentials');
    errorDiv.style.display = 'block';
    return;
  }
  
  loginBtn.disabled = true;
  loginBtn.textContent = t('logging_in');
  errorDiv.style.display = 'none';
  
  try {
    const response = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    });
    
    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || 'login_failed');
    }
    
    const data = await response.json();
    setToken(data.token);
    
    hideLoginModal();
    
    // Show the main UI after successful login
    document.getElementById('main-navbar').style.display = 'block';
    document.getElementById('main-content').style.display = 'block';
    
    loadUsers();
    loadProviders();
    loadEpgSources();
    
    // Clear form
    document.getElementById('login-username').value = '';
    document.getElementById('login-password').value = '';
    
  } catch (error) {
    errorDiv.textContent = t(error.message) || t('login_failed');
    errorDiv.style.display = 'block';
  } finally {
    loginBtn.disabled = false;
    loginBtn.textContent = t('login');
  }
}

function handleLogout() {
  removeToken();
  selectedUser = null;
  selectedUserId = null;
  selectedCategoryId = null;
  
  // Hide the main UI when logging out
  document.getElementById('main-navbar').style.display = 'none';
  document.getElementById('main-content').style.display = 'none';
  
  showLoginModal();
}

// Change Password Functions
function showChangePasswordModal() {
  const modal = document.getElementById('change-password-modal');
  if (modal) {
    // Clear form
    document.getElementById('old-password').value = '';
    document.getElementById('new-password').value = '';
    document.getElementById('confirm-password').value = '';
    document.getElementById('change-password-error').style.display = 'none';
    document.getElementById('change-password-success').style.display = 'none';
    
    const bsModal = new bootstrap.Modal(modal);
    bsModal.show();
  }
}

async function handleChangePassword(event) {
  event.preventDefault();
  
  const oldPassword = document.getElementById('old-password').value;
  const newPassword = document.getElementById('new-password').value;
  const confirmPassword = document.getElementById('confirm-password').value;
  const changePasswordBtn = document.getElementById('change-password-btn');
  const errorDiv = document.getElementById('change-password-error');
  const successDiv = document.getElementById('change-password-success');
  
  // Hide previous messages
  errorDiv.style.display = 'none';
  successDiv.style.display = 'none';
  
  // Validate passwords match
  if (newPassword !== confirmPassword) {
    errorDiv.textContent = t('passwords_dont_match');
    errorDiv.style.display = 'block';
    return;
  }
  
  // Validate password length
  if (newPassword.length < 8) {
    errorDiv.textContent = t('password_too_short');
    errorDiv.style.display = 'block';
    return;
  }
  
  changePasswordBtn.disabled = true;
  changePasswordBtn.textContent = t('changing_password');
  
  try {
    const response = await fetch('/api/change-password', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${getToken()}`
      },
      body: JSON.stringify({
        oldPassword,
        newPassword,
        confirmPassword
      })
    });
    
    const data = await response.json();
    
    if (!response.ok) {
      throw new Error(data.error || 'change_password_failed');
    }
    
    // Success
    successDiv.textContent = t('password_changed_successfully');
    successDiv.style.display = 'block';
    
    // Clear form
    document.getElementById('old-password').value = '';
    document.getElementById('new-password').value = '';
    document.getElementById('confirm-password').value = '';
    
    // Close modal after 2 seconds
    setTimeout(() => {
      const modal = bootstrap.Modal.getInstance(document.getElementById('change-password-modal'));
      if (modal) modal.hide();
    }, 2000);
    
  } catch (error) {
    errorDiv.textContent = t(error.message) || t('change_password_failed');
    errorDiv.style.display = 'block';
  } finally {
    changePasswordBtn.disabled = false;
    changePasswordBtn.textContent = t('change_password');
  }
}
