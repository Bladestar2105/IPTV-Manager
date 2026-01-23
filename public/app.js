async function fetchJSON(url, options = {}) {
  const res = await fetch(url, options);
  if (!res.ok) throw new Error('HTTP ' + res.status);
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
      syncBtn.disabled = true;
      syncBtn.textContent = t('syncing');
      try {
        const res = await fetchJSON(`/api/providers/${p.id}/sync`, {method: 'POST'});
        alert(t('syncSuccess', {count: res.synced}));
      } catch (e) {
        alert(t('errorPrefix') + ' ' + e.message);
      } finally {
        syncBtn.disabled = false;
        syncBtn.textContent = t('sync');
      }
    };
    
    const delBtn = document.createElement('button');
    delBtn.className = 'btn btn-sm btn-danger';
    delBtn.textContent = t('delete');
    delBtn.onclick = async () => {
      if (!confirm(t('deleteProviderConfirm', {name: p.name}))) return;
      await fetchJSON(`/api/providers/${p.id}`, {method: 'DELETE'});
      loadProviders();
    };
    
    btnGroup.appendChild(syncBtn);
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
    alert(t('errorPrefix') + ' ' + e.message);
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
  
  loadUsers();
  loadProviders();
  
  console.log('✅ IPTV Manager loaded with i18n & local assets');
});
