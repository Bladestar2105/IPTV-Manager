async function fetchJSON(url, options = {}) {
  const res = await fetch(url, options);
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return res.json();
}

let selectedUser = null;
let selectedUserId = null;  // ← NEU: explizit für API
let selectedCategoryId = null;

// User
async function loadUsers() {
  const users = await fetchJSON('/api/users');
  const list = document.getElementById('user-list');
  list.innerHTML = '';
  users.forEach(u => {
    const li = document.createElement('li');
    li.className =
      'list-group-item d-flex justify-content-between align-items-center';
    li.textContent = `${u.username} (id=${u.id})`;
    li.style.cursor = 'pointer';
    li.onclick = () => {
      selectedUser = u;
      selectedUserId = u.id;  // ← KORRIGIERT
      document.getElementById(
        'selected-user-label'
      ).textContent = `User: ${u.username} (id=${u.id})`;
      document.getElementById('xtream-user').textContent = u.username;
      document.getElementById('xtream-pass').textContent = '<dein Passwort>';
      loadUserCategories();
    };
    list.appendChild(li);
  });
}

// Provider
async function loadProviders() {
  const providers = await fetchJSON('/api/providers');
  const list = document.getElementById('provider-list');
  const select = document.getElementById('channel-provider-select');
  list.innerHTML = '';
  select.innerHTML = '';

  providers.forEach(p => {
    const li = document.createElement('li');
    li.className =
      'list-group-item d-flex justify-content-between align-items-center';
    li.textContent = `${p.name} (${p.url})`;

    const btn = document.createElement('button');
    btn.className = 'btn btn-sm btn-outline-primary';
    btn.textContent = 'Sync Live';
    btn.onclick = async () => {
      btn.disabled = true;
      btn.textContent = 'Sync...';
      try {
        const res = await fetchJSON(`/api/providers/${p.id}/sync`, {
          method: 'POST'
        });
        alert(`Synced: ${res.synced} Kanäle`);
      } catch (e) {
        alert('Fehler: ' + e.message);
      } finally {
        btn.disabled = false;
        btn.textContent = 'Sync Live';
      }
    };

    li.appendChild(btn);
    list.appendChild(li);

    const opt = document.createElement('option');
    opt.value = p.id;
    opt.textContent = p.name;
    select.appendChild(opt);
  });
}

// User-Kategorien
async function loadUserCategories() {
  if (!selectedUserId) return;
  const cats = await fetchJSON(`/api/users/${selectedUserId}/categories`);
  const list = document.getElementById('category-list');
  list.innerHTML = '';
  selectedCategoryId = null;

  cats.forEach(c => {
    const li = document.createElement('li');
    li.className = 'list-group-item';
    li.textContent = c.name;
    li.style.cursor = 'pointer';
    li.onclick = () => {
      [...list.children].forEach(el => el.classList.remove('active'));
      li.classList.add('active');
      selectedCategoryId = c.id;
      loadUserCategoryChannels();
    };
    list.appendChild(li);
  });
}

async function loadProviderChannels() {
  const select = document.getElementById('channel-provider-select');
  const providerId = select.value;
  if (!providerId) return;
  const chans = await fetchJSON(`/api/providers/${providerId}/channels`);
  const list = document.getElementById('provider-channel-list');
  list.innerHTML = '';
  chans.forEach(ch => {
    const li = document.createElement('li');
    li.className =
      'list-group-item d-flex justify-content-between align-items-center';
    li.innerHTML = `
      <span>${ch.name}</span>
      ${ch.logo ? `<img src="${ch.logo}" style="width:20px;height:20px;margin-left:5px;">` : ''}
    `;
    const btn = document.createElement('button');
    btn.className = 'btn btn-sm btn-outline-success ms-2';
    btn.textContent = '+';
    btn.onclick = async () => {
      if (!selectedUserId || !selectedCategoryId) {
        alert('Bitte User und Kategorie wählen');
        return;
      }
      try {
        await fetchJSON(`/api/user-categories/${selectedCategoryId}/channels`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ provider_channel_id: ch.id })
        });
        loadUserCategoryChannels();
        alert('Kanal hinzugefügt');
      } catch (e) {
        alert('Fehler: ' + e.message);
      }
    };
    li.appendChild(btn);
    list.appendChild(li);
  });
}

async function loadUserCategoryChannels() {
  if (!selectedCategoryId) return;
  const chans = await fetchJSON(
    `/api/user-categories/${selectedCategoryId}/channels`
  );
  const list = document.getElementById('user-channel-list');
  list.innerHTML = '';
  chans.forEach(ch => {
    const li = document.createElement('li');
    li.className = 'list-group-item';
    li.innerHTML = `
      <span>${ch.name}</span>
      ${ch.logo ? `<img src="${ch.logo}" style="width:20px;height:20px;margin-left:5px;">` : ''}
    `;
    list.appendChild(li);
  });
}

// Form-Handler
document
  .getElementById('user-form')
  .addEventListener('submit', async e => {
    e.preventDefault();
    const f = e.target;
    try {
      await fetchJSON('/api/users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: f.username.value,
          password: f.password.value
        })
      });
      f.reset();
      loadUsers();
      alert('User angelegt');
    } catch (e) {
      alert('Fehler: ' + e.message);
    }
  });

document
  .getElementById('provider-form')
  .addEventListener('submit', async e => {
    e.preventDefault();
    const f = e.target;
    try {
      await fetchJSON('/api/providers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
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
      alert('Provider angelegt');
    } catch (e) {
      alert('Fehler: ' + e.message);
    }
  });

document
  .getElementById('category-form')
  .addEventListener('submit', async e => {
    e.preventDefault();
    if (!selectedUserId) {
      alert('Bitte zuerst einen User auswählen');
      return;
    }
    const f = e.target;
    try {
      await fetchJSON(`/api/users/${selectedUserId}/categories`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: f.name.value })
      });
      f.reset();
      loadUserCategories();
      alert('Kategorie angelegt');
    } catch (e) {
      alert('Fehler: ' + e.message);
    }
  });

document
  .getElementById('reload-providers')
  .addEventListener('click', loadProviders);

document
  .getElementById('load-provider-channels')
  .addEventListener('click', loadProviderChannels);

document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('xtream-url').textContent = window.location.origin;
  document.getElementById('xtream-pass').textContent = '<Passwort wie angelegt>';
  document.getElementById('epg-url').textContent =
    window.location.origin + '/xmltv.php?username=<USER>&password=<PASS>';
  loadUsers();
  loadProviders();
});
