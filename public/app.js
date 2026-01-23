async function fetchJSON(url, options = {}) {
  const res = await fetch(url, options);
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return res.json();
}

let selectedUser = null;
let selectedUserId = null;
let selectedCategoryId = null;
let providerChannelsCache = [];

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
      document.getElementById('selected-user-label').textContent = `User: ${u.username} (id=${u.id})`;
      document.getElementById('xtream-user').textContent = u.username;
      document.getElementById('xtream-pass').textContent = '<dein Passwort>';
      loadUserCategories();
    };
    
    const delBtn = document.createElement('button');
    delBtn.className = 'btn btn-sm btn-danger';
    delBtn.textContent = '🗑';
    delBtn.onclick = async () => {
      if (!confirm(`User "${u.username}" wirklich löschen?`)) return;
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
  select.innerHTML = '<option value="">-- Provider wählen --</option>';

  providers.forEach(p => {
    const li = document.createElement('li');
    li.className = 'list-group-item';
    
    const row = document.createElement('div');
    row.className = 'd-flex justify-content-between align-items-center';
    row.innerHTML = `<strong>${p.name}</strong> <small>(${p.url})</small>`;
    
    const btnGroup = document.createElement('div');
    
    const syncBtn = document.createElement('button');
    syncBtn.className = 'btn btn-sm btn-outline-primary me-1';
    syncBtn.textContent = 'Sync';
    syncBtn.onclick = async () => {
      syncBtn.disabled = true;
      syncBtn.textContent = 'Sync...';
      try {
        const res = await fetchJSON(`/api/providers/${p.id}/sync`, {method: 'POST'});
        alert(`✅ ${res.synced} Kanäle synchronisiert`);
      } catch (e) {
        alert('❌ Fehler: ' + e.message);
      } finally {
        syncBtn.disabled = false;
        syncBtn.textContent = 'Sync';
      }
    };
    
    const delBtn = document.createElement('button');
    delBtn.className = 'btn btn-sm btn-danger';
    delBtn.textContent = '🗑';
    delBtn.onclick = async () => {
      if (!confirm(`Provider "${p.name}" wirklich löschen?`)) return;
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
    
    const span = document.createElement('span');
    span.textContent = c.name;
    span.style.cursor = 'pointer';
    span.onclick = () => {
      [...list.children].forEach(el => el.classList.remove('active'));
      li.classList.add('active');
      selectedCategoryId = c.id;
      loadUserCategoryChannels();
    };
    
    const btnGroup = document.createElement('div');
    
    const editBtn = document.createElement('button');
    editBtn.className = 'btn btn-sm btn-outline-secondary me-1';
    editBtn.textContent = '✏️';
    editBtn.onclick = async () => {
      const newName = prompt('Neuer Name:', c.name);
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
    delBtn.textContent = '🗑';
    delBtn.onclick = async () => {
      if (!confirm(`Kategorie "${c.name}" wirklich löschen?`)) return;
      await fetchJSON(`/api/user-categories/${c.id}`, {method: 'DELETE'});
      loadUserCategories();
    };
    
    btnGroup.appendChild(editBtn);
    btnGroup.appendChild(delBtn);
    
    li.appendChild(span);
    li.appendChild(btnGroup);
    list.appendChild(li);
  });
}

// === Channel Management ===
// === Channel Management ===
async function loadProviderChannels() {
  const select = document.getElementById('channel-provider-select');
  const providerId = select.value;
  const searchInput = document.getElementById('channel-search');
  const list = document.getElementById('provider-channel-list');
  
  if (!providerId) {
    list.innerHTML = '<li class="list-group-item text-muted">Bitte Provider auswählen</li>';
    searchInput.disabled = true;
    searchInput.value = '';
    return;
  }
  
  list.innerHTML = '<li class="list-group-item text-muted">Lade Kanäle...</li>';
  searchInput.disabled = true;
  
  try {
    const chans = await fetchJSON(`/api/providers/${providerId}/channels`);
    providerChannelsCache = chans;
    searchInput.disabled = false;
    searchInput.focus();
    renderProviderChannels(chans);
  } catch (e) {
    list.innerHTML = '<li class="list-group-item text-danger">Fehler beim Laden</li>';
    alert('Fehler: ' + e.message);
  }
}

// Provider-Select Change Event
document.getElementById('channel-provider-select').addEventListener('change', loadProviderChannels);

function renderProviderChannels(channels) {
  const list = document.getElementById('provider-channel-list');
  const search = document.getElementById('channel-search').value.toLowerCase();
  
  list.innerHTML = '';
  
  const filtered = channels.filter(ch => 
    ch.name.toLowerCase().includes(search)
  );
  
  if (filtered.length === 0) {
    list.innerHTML = '<li class="list-group-item text-muted">Keine Kanäle gefunden</li>';
    return;
  }
  
  filtered.slice(0, 100).forEach(ch => {
    const li = document.createElement('li');
    li.className = 'list-group-item d-flex justify-content-between align-items-center';
    li.innerHTML = `<span>${ch.name}</span>`;
    
    if (ch.logo) {
      const img = document.createElement('img');
      img.src = ch.logo;
      img.style.width = '20px';
      img.style.height = '20px';
      img.style.marginLeft = '5px';
      li.appendChild(img);
    }
    
    const btn = document.createElement('button');
    btn.className = 'btn btn-sm btn-success ms-2';
    btn.textContent = '+';
    btn.onclick = async () => {
      if (!selectedUserId || !selectedCategoryId) {
        alert('Bitte User und Kategorie wählen');
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
        alert('Fehler: ' + e.message);
      }
    };
    
    li.appendChild(btn);
    list.appendChild(li);
  });
  
  if (filtered.length > 100) {
    const li = document.createElement('li');
    li.className = 'list-group-item text-muted';
    li.textContent = `... und ${filtered.length - 100} weitere (Suche verfeinern)`;
    list.appendChild(li);
  }
}

async function loadUserCategoryChannels() {
  if (!selectedCategoryId) return;
  const chans = await fetchJSON(`/api/user-categories/${selectedCategoryId}/channels`);
  const list = document.getElementById('user-channel-list');
  list.innerHTML = '';
  
  chans.forEach(ch => {
    const li = document.createElement('li');
    li.className = 'list-group-item d-flex justify-content-between align-items-center';
    li.innerHTML = `<span>${ch.name}</span>`;
    
    if (ch.logo) {
      const img = document.createElement('img');
      img.src = ch.logo;
      img.style.width = '20px';
      img.style.height = '20px';
      img.style.marginLeft = '5px';
      li.appendChild(img);
    }
    
    const delBtn = document.createElement('button');
    delBtn.className = 'btn btn-sm btn-danger ms-2';
    delBtn.textContent = '🗑';
    delBtn.onclick = async () => {
      await fetchJSON(`/api/user-channels/${ch.user_channel_id}`, {method: 'DELETE'});
      loadUserCategoryChannels();
    };
    
    li.appendChild(delBtn);
    list.appendChild(li);
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
    alert('✅ User angelegt');
  } catch (e) {
    alert('❌ Fehler: ' + e.message);
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
    alert('✅ Provider angelegt');
  } catch (e) {
    alert('❌ Fehler: ' + e.message);
  }
});

document.getElementById('category-form').addEventListener('submit', async e => {
  e.preventDefault();
  if (!selectedUserId) {
    alert('Bitte zuerst einen User auswählen');
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
    alert('✅ Kategorie angelegt');
  } catch (e) {
    alert('❌ Fehler: ' + e.message);
  }
});

document.getElementById('reload-providers').addEventListener('click', loadProviders);
document.getElementById('load-provider-channels').addEventListener('click', loadProviderChannels);

// Channel-Suche Event-Handler
let searchTimeout;
function setupChannelSearch() {
  const searchInput = document.getElementById('channel-search');
  searchInput.addEventListener('input', (e) => {
    clearTimeout(searchTimeout);
    searchTimeout = setTimeout(() => {
      renderProviderChannels(providerChannelsCache);
    }, 300); // 300ms Debounce
  });
}


document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('xtream-url').textContent = window.location.origin;
  document.getElementById('xtream-pass').textContent = '<Passwort wie angelegt>';
  document.getElementById('epg-url').textContent = window.location.origin + '/xmltv.php?username=<USER>&password=<PASS>';
  loadUsers();
  loadProviders();
  setupChannelSearch();
});
