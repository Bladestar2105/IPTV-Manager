/**
 * Author: Bladestar2105
 * License: MIT
 */

window.onerror = function(msg, url, line, col, error) {
   let stack = error ? error.stack : '';
   if (!stack) {
       stack = `URL: ${url}\nLine: ${line}\nCol: ${col}`;
   }
   logToBackend('error', msg, stack);
};

window.onunhandledrejection = function(event) {
   logToBackend('error', 'Unhandled Rejection: ' + event.reason, '');
};

async function logToBackend(level, message, stack) {
   try {
      if (message.includes('Failed to log')) return;

      const token = localStorage.getItem('jwt_token');
      const headers = {'Content-Type': 'application/json'};
      if (token) headers['Authorization'] = `Bearer ${token}`;

      // Enrich stack with current page URL for context
      const enhancedStack = `${stack || ''}\nLocation: ${window.location.href}`;

      await fetch('/api/client-logs', {
         method: 'POST',
         headers: headers,
         body: JSON.stringify({
            level,
            message,
            stack: enhancedStack,
            user_agent: navigator.userAgent
         })
      });
   } catch(e) { console.error('Failed to log to backend', e); }
}

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

function getProxiedUrl(url) {
  if (!url) return '';

  // Check if URL is already relative (local)
  if (url.startsWith('/')) return url;

  // Always proxy external URLs (HTTP/HTTPS) to leverage caching and avoid mixed content
  if (url.startsWith('http://') || url.startsWith('https://')) {
    const token = getToken();
    if (token) {
      return `/api/proxy/image?url=${encodeURIComponent(url)}&token=${token}`;
    }
  }
  return url;
}

let currentUser = null;
let selectedUser = null;
let selectedUserId = null;
let selectedCategoryId = null;
let categorySortable = null;
let channelSortable = null;
let globalSelectedChannels = new Set();
let editingShareToken = null;

// Pagination State
let channelPage = 1;
let channelLimit = 50;
let channelSearch = '';
let channelTotal = 0;
let isLoadingChannels = false;

// Utility: Debounce
function debounce(func, wait) {
  let timeout;
  return function(...args) {
    const context = this;
    clearTimeout(timeout);
    timeout = setTimeout(() => func.apply(context, args), wait);
  };
}

// Utility: Accessibility Helper
function makeAccessible(element, clickHandler) {
  element.tabIndex = 0;
  element.role = 'button';
  element.onclick = clickHandler;
  element.onkeydown = (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      clickHandler(e);
    }
  };
}

// Utility: XSS Protection
function escapeHtml(unsafe) {
    if (unsafe === null || unsafe === undefined) return '';
    return String(unsafe)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}

// Utility: Loading State Helper
function setLoadingState(btn, isLoading, textKey = 'loading', showText = true) {
  if (!btn) return;
  if (isLoading) {
    btn.disabled = true;
    if (!btn.dataset.originalText) {
      btn.dataset.originalText = btn.innerHTML;
    }
    const spinner = `<span class="spinner-border spinner-border-sm" role="status" aria-hidden="true"></span>`;
    if (showText) {
      const text = escapeHtml(t(textKey) || 'Loading...');
      btn.innerHTML = `${spinner} ${text}`;
    } else {
      btn.innerHTML = spinner;
    }
  } else {
    btn.disabled = false;
    if (btn.dataset.originalText) {
      btn.innerHTML = btn.dataset.originalText;
      delete btn.dataset.originalText;
    }
  }
}

// Utility: List/Table Loading State Helpers
function renderLoadingList(elementId, textKey = 'loading') {
  const list = document.getElementById(elementId);
  if (list) {
    list.innerHTML = `<li class="list-group-item text-center text-muted py-3">
      <span class="spinner-border spinner-border-sm me-2" role="status" aria-hidden="true"></span>
      ${t(textKey)}
    </li>`;
  }
}

function renderLoadingTable(tbodyId, colSpan = 5, textKey = 'loading') {
  const tbody = document.getElementById(tbodyId);
  if (tbody) {
    tbody.innerHTML = `<tr><td colspan="${colSpan}" class="text-center p-4 text-muted">
      <span class="spinner-border spinner-border-sm me-2" role="status" aria-hidden="true"></span>
      ${t(textKey)}
    </td></tr>`;
  }
}

// Utility: Clearable Input Helper
function initClearableInput(inputId) {
  const input = document.getElementById(inputId);
  if (!input) return;

  const clearBtn = document.getElementById(inputId + '-clear');
  if (!clearBtn) return;

  const updateVisibility = () => {
    if (input.value) clearBtn.classList.remove('d-none');
    else clearBtn.classList.add('d-none');
  };

  input.addEventListener('input', updateVisibility);

  // Initial check
  updateVisibility();

  clearBtn.addEventListener('click', () => {
    input.value = '';
    input.focus();
    updateVisibility();
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

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

  // ARIA Labels übersetzen
  document.querySelectorAll('[data-i18n-label]').forEach(el => {
    const key = el.getAttribute('data-i18n-label');
    el.setAttribute('aria-label', t(key));
  });

  // Tooltips (title) übersetzen
  document.querySelectorAll('[data-i18n-title]').forEach(el => {
    const key = el.getAttribute('data-i18n-title');
    el.title = t(key);
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

function updateStatsCounters(type, value) {
    const el = document.getElementById(`stats-${type}`);
    if (el) el.textContent = value;
}

// === User Management ===
function generateUser() {
    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
    let user = '';
    let pass = '';
    for (let i = 0; i < 9; i++) {
        user += chars.charAt(Math.floor(Math.random() * chars.length));
        pass += chars.charAt(Math.floor(Math.random() * chars.length));
    }

    // Ensure user starts with letter
    const letters = 'abcdefghijklmnopqrstuvwxyz';
    user = letters.charAt(Math.floor(Math.random() * letters.length)) + user;
    pass = letters.charAt(Math.floor(Math.random() * letters.length)) + pass;

    const form = document.getElementById('user-form');
    if (form) {
        form.username.value = user;
        form.password.value = pass;
    }
}

function copyToClipboard(text, btnElement) {
    if (!text) return;

    const handleSuccess = () => {
        if (btnElement) {
            const originalHtml = btnElement.innerHTML;
            const originalClass = btnElement.className;
            const originalTitle = btnElement.getAttribute('title');
            const originalAriaLabel = btnElement.getAttribute('aria-label');

            // Disable button to prevent rapid clicks and state corruption
            btnElement.disabled = true;

            // Visual feedback
            const isSmallBtn = btnElement.textContent.trim().length <= 2;
            const successText = t('copied') || 'Copied!';

            if (isSmallBtn) {
                btnElement.innerHTML = '✅';
                btnElement.className = 'btn btn-success ' + btnElement.className.replace('btn-outline-secondary', '');
            } else {
                const width = btnElement.offsetWidth;
                btnElement.style.width = width + 'px'; // Fix width
                btnElement.innerHTML = `✅ ${successText}`;
                btnElement.className = 'btn btn-success w-100';
            }

            // Accessibility: Update title and aria-label
            btnElement.setAttribute('title', successText);
            btnElement.setAttribute('aria-label', successText);

            setTimeout(() => {
                btnElement.innerHTML = originalHtml;
                btnElement.className = originalClass;
                btnElement.style.width = '';
                btnElement.disabled = false;

                // Restore attributes
                if (originalTitle) btnElement.setAttribute('title', originalTitle);
                else btnElement.removeAttribute('title');

                if (originalAriaLabel) btnElement.setAttribute('aria-label', originalAriaLabel);
                else btnElement.removeAttribute('aria-label');
            }, 2000);
        }

        // UX: Show Toast
        showToast(t('copiedToClipboard') || 'Copied to clipboard', 'success');
    };

    if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(handleSuccess).catch(err => {
            console.error('Clipboard API failed', err);
            fallbackCopyTextToClipboard(text, btnElement, handleSuccess);
        });
    } else {
        fallbackCopyTextToClipboard(text, btnElement, handleSuccess);
    }
}

function fallbackCopyTextToClipboard(text, btnElement, successCallback) {
    const textArea = document.createElement("textarea");
    textArea.value = text;

    // Avoid scrolling to bottom
    textArea.style.top = "0";
    textArea.style.left = "0";
    textArea.style.position = "fixed";

    document.body.appendChild(textArea);
    textArea.focus();
    textArea.select();

    try {
        const successful = document.execCommand('copy');
        if (successful && successCallback) successCallback();
    } catch (err) {
        console.error('Fallback: Oops, unable to copy', err);
    }

    document.body.removeChild(textArea);
}

function togglePasswordVisibility(inputId, btn) {
    const input = document.getElementById(inputId);
    if (!input) return;

    const isPassword = input.type === 'password';
    input.type = isPassword ? 'text' : 'password';

    // Update Button
    btn.innerHTML = isPassword ? '🙈' : '👁️';

    // Update ARIA and Title
    const labelKey = isPassword ? 'hide_password' : 'show_password';
    const label = t(labelKey);
    btn.setAttribute('aria-label', label);
    btn.title = label;
}

function copyAllXtreamCredentials(btnElement) {
    const url = document.getElementById('xtream-url').value;
    const user = document.getElementById('xtream-user').value;
    const pass = document.getElementById('xtream-pass').value;
    const epg = document.getElementById('epg-url').value;
    const m3u = document.getElementById('m3u-link').value;

    const text = `### ${t('credentialsFor', {name: user})} ###\n` +
                 `${t('url') || 'URL'}: ${url}\n` +
                 `${t('usernameCaps')}: ${user}\n` +
                 `${t('passwordCaps')}: ${pass}\n` +
                 `${t('epgUrlCaps')}: ${epg}\n` +
                 `${t('m3uUrlCaps')}: ${m3u}\n` +
                 `######`;

    copyToClipboard(text, btnElement);
}

function renderUserDetails(u) {
    if (selectedUserId !== u.id) {
        globalSelectedChannels.clear();
    }
    selectedUser = u;
    selectedUserId = u.id;
    const label = document.getElementById('selected-user-label');
    if (label) label.textContent = `${u.username} (id=${u.id})`;

    const playBtn = document.getElementById('header-play-btn');
    if (playBtn) {
        playBtn.classList.remove('d-none');
        playBtn.onclick = async () => {
            const newWindow = window.open('', '_blank');
            if (newWindow) {
                newWindow.document.write('Loading player...');
            } else {
                alert(t('popupBlocked'));
                return;
            }

            try {
                playBtn.disabled = true;
                const res = await fetchJSON('/api/player/token', {
                    method: 'POST',
                    headers: {'Content-Type': 'application/json'},
                    body: JSON.stringify({user_id: u.id})
                });
                newWindow.location.href = `player.html?token=${encodeURIComponent(res.token)}`;
            } catch(e) {
                newWindow.close();
                alert(t('errorPrefix') + ' ' + e.message);
            } finally {
                playBtn.disabled = false;
            }
        };
    }

    const sharesBtn = document.getElementById('header-shares-btn');
    if (sharesBtn) {
        // Show for admins or self-management
        // Allow if admin OR if viewing own profile
        const canManage = (currentUser && currentUser.is_admin) || (currentUser && currentUser.id === u.id);
        if (canManage) sharesBtn.classList.remove('d-none');
        else sharesBtn.classList.add('d-none');
        sharesBtn.onclick = showSharesList;
    }

    // Show Share Button in Channel List
    const shareBtn = document.getElementById('chan-bulk-share-btn');
    if (shareBtn) {
        shareBtn.classList.remove('d-none');
        shareBtn.onclick = openShareModal;
    }

    const baseUrl = window.location.origin;
    const pass = u.plain_password || '********';

    const elUrl = document.getElementById('xtream-url');
    if(elUrl) elUrl.value = baseUrl;
    const elUser = document.getElementById('xtream-user');
    if(elUser) elUser.value = u.username;
    const elPass = document.getElementById('xtream-pass');
    if(elPass) elPass.value = pass;
    const elEpg = document.getElementById('epg-url');
    if(elEpg) elEpg.value = `${baseUrl}/xmltv.php?username=${encodeURIComponent(u.username)}&password=${encodeURIComponent(pass)}`;

    // Update M3U Link
    const m3uLinkEl = document.getElementById('m3u-link');
    if (m3uLinkEl) {
        m3uLinkEl.value = `${baseUrl}/get.php?username=${encodeURIComponent(u.username)}&password=${encodeURIComponent(pass)}&type=m3u_plus&output=ts`;
    }

    // Update HDHomeRun Tab
    const hdhrEnabledSection = document.getElementById('hdhr-enabled-section');
    const hdhrDisabledSection = document.getElementById('hdhr-disabled-section');
    const hdhrUrlInput = document.getElementById('hdhr-url');

    if (hdhrEnabledSection && hdhrDisabledSection) {
        if (u.hdhr_enabled) {
            hdhrEnabledSection.classList.remove('d-none');
            hdhrDisabledSection.classList.add('d-none');
            const protocol = window.location.protocol;
            const host = window.location.host;
            // u.hdhr_token is returned by GET /api/users
            if (hdhrUrlInput) hdhrUrlInput.value = `${protocol}//${host}/hdhr/${u.hdhr_token}/discover.json`;
        } else {
            hdhrEnabledSection.classList.add('d-none');
            hdhrDisabledSection.classList.remove('d-none');
            if (hdhrUrlInput) hdhrUrlInput.value = '';
        }
    }

    loadUserCategories();
    loadProviders(u.id); // Refresh providers

    // Update provider form user select if not editing
    const provForm = document.getElementById('provider-form');
    if (provForm && !provForm.provider_id.value) {
        if(provForm.user_id) provForm.user_id.value = u.id;
    }
}

async function loadUsers() {
  if (!currentUser || !currentUser.is_admin) {
      // If user, fake load themselves as selected
      // Note: for non-admins, API currently doesn't return hdhr_token in /verify-token response
      // We might need to fetch it or ensure verify-token returns it.
      // However, /api/verify-token DOES return the user object.
      // Let's assume verify-token returns necessary fields.
      const user = currentUser;

      renderUserDetails(user);

      // Hide user list and management
      document.getElementById('user-list').innerHTML = `<li class="list-group-item text-muted">${t('managed_by_admin')}</li>`;

      // Update dummy export select
      updateExportUserSelect([user]);
      return;
  }

  renderLoadingList('user-list');
  const users = await fetchJSON('/api/users');
  updateStatsCounters('users', users.length);
  const list = document.getElementById('user-list');
  list.innerHTML = '';
  
  users.forEach(u => {
    const li = document.createElement('li');
    li.className = 'list-group-item d-flex justify-content-between align-items-center';
    
    const span = document.createElement('span');
    span.textContent = `${u.username} (id=${u.id})`;
    span.style.cursor = 'pointer';
    makeAccessible(span, () => {
      renderUserDetails(u);
    });
    
    const btnGroup = document.createElement('div');

    const playBtn = document.createElement('button');
    playBtn.className = 'btn btn-sm btn-outline-success me-1';
    playBtn.innerHTML = '▶️'; // Play icon
    playBtn.title = t('openWebPlayer') || 'Open Web Player';
    playBtn.setAttribute('aria-label', t('openWebPlayer') || 'Open Web Player');
    playBtn.onclick = async () => {
        // Open window immediately to bypass popup blockers (especially on iOS/Safari)
        const newWindow = window.open('', '_blank');
        if (newWindow) {
            newWindow.document.write('Loading player...');
        } else {
            alert(t('popupBlocked'));
            return;
        }

        try {
            playBtn.disabled = true;
            const res = await fetchJSON('/api/player/token', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({user_id: u.id})
            });
            newWindow.location.href = `player.html?token=${encodeURIComponent(res.token)}`;
        } catch(e) {
            newWindow.close();
            alert(t('errorPrefix') + ' ' + e.message);
        } finally {
            playBtn.disabled = false;
        }
    };

    const editBtn = document.createElement('button');
    editBtn.className = 'btn btn-sm btn-outline-secondary me-1';
    editBtn.innerHTML = '✏️'; // Edit icon
    editBtn.setAttribute('aria-label', t('editUser') || t('edit'));
    editBtn.title = t('editUser') || t('edit');
    editBtn.onclick = () => showEditUserModal(u);

    const delBtn = document.createElement('button');
    delBtn.className = 'btn btn-sm btn-danger';
    delBtn.textContent = t('delete');
    delBtn.setAttribute('aria-label', t('deleteAction'));
    delBtn.title = t('deleteAction');
    delBtn.onclick = async () => {
      if (!confirm(t('deleteUserConfirm', {name: u.username}))) return;
      await fetchJSON(`/api/users/${u.id}`, {method: 'DELETE'});

      // Clear state if deleted user was selected
      if (selectedUserId === u.id) {
          selectedUser = null;
          selectedUserId = null;
          selectedCategoryId = null;
          document.getElementById('selected-user-label').innerHTML = `<em data-i18n="noUserSelected">${t('noUserSelected')}</em>`;
          document.getElementById('category-list').innerHTML = '';
          document.getElementById('user-channel-list').innerHTML = '';

          // Reset headers
          const availHeader = document.getElementById('available-channels-header');
          if (availHeader) availHeader.textContent = t('available', {count: 0});
          const assignedHeader = document.getElementById('assigned-channels-header');
          if (assignedHeader) assignedHeader.textContent = t('assigned', {count: 0});

          if (categorySortable) { categorySortable.destroy(); categorySortable = null; }
          if (channelSortable) { channelSortable.destroy(); channelSortable = null; }
      }

      loadUsers();
    };
    
    btnGroup.appendChild(playBtn);
    if (currentUser && currentUser.is_admin) {
        btnGroup.appendChild(editBtn);
        btnGroup.appendChild(delBtn);
    }
    li.appendChild(span);
    li.appendChild(btnGroup);
    list.appendChild(li);
  });

  // Populate provider user select
  updateProviderUserSelect(users);
  updateExportUserSelect(users);
  updateCopyUserSelect(users);
}

function updateExportUserSelect(users) {
  const select = document.getElementById('export-user-select');
  if (!select) return;
  const currentVal = select.value;
  // Keep the 'all' option and clear others
  select.innerHTML = `<option value="all" data-i18n="allUsers">${t('allUsers')}</option>`;

  users.forEach(u => {
    const opt = document.createElement('option');
    opt.value = u.id;
    opt.textContent = u.username;
    select.appendChild(opt);
  });
  if (currentVal && (currentVal === 'all' || users.find(u => u.id == currentVal))) {
      select.value = currentVal;
  }
}

function updateCopyUserSelect(users) {
  const select = document.getElementById('copy-user-select');
  if (!select) return;
  const currentVal = select.value;

  select.innerHTML = `<option value="" data-i18n="copyFromUser">${t('copyFromUser') || 'Copy from...'}</option>`;

  users.forEach(u => {
    const opt = document.createElement('option');
    opt.value = u.id;
    opt.textContent = u.username;
    select.appendChild(opt);
  });

  if (currentVal) select.value = currentVal;
}

function updateProviderUserSelect(users) {
  const select = document.getElementById('provider-user-select');
  if (!select) return;
  const currentVal = select.value;
  select.innerHTML = `<option value="">${t('selectUserPlaceholder')}</option>`;
  users.forEach(u => {
    const opt = document.createElement('option');
    opt.value = u.id;
    opt.textContent = u.username;
    select.appendChild(opt);
  });
  if (currentVal) select.value = currentVal;
}

function showEditUserModal(user) {
  const modal = new bootstrap.Modal(document.getElementById('edit-user-modal'));
  document.getElementById('edit-user-id').value = user.id;
  document.getElementById('edit-user-username').value = user.username;
  document.getElementById('edit-user-password').value = '';
  document.getElementById('edit-user-max-connections').value = user.max_connections || 0;
  // Checkbox handling: default to true if undefined/null (legacy users), else use value
  const webuiAccess = user.webui_access !== undefined ? user.webui_access === 1 : true;
  document.getElementById('edit-user-webui-access').checked = webuiAccess;
  document.getElementById('edit-user-hdhr-enabled').checked = (user.hdhr_enabled === 1);
  modal.show();
}

document.getElementById('edit-user-form').addEventListener('submit', async e => {
  e.preventDefault();
  const btn = e.target.querySelector('button[type="submit"]');
  setLoadingState(btn, true, 'saving');

  const id = document.getElementById('edit-user-id').value;
  const username = document.getElementById('edit-user-username').value;
  const password = document.getElementById('edit-user-password').value;
  const maxConnections = document.getElementById('edit-user-max-connections').value;
  const webuiAccess = document.getElementById('edit-user-webui-access').checked;
  const hdhrEnabled = document.getElementById('edit-user-hdhr-enabled').checked;

  const body = {
      username,
      webui_access: webuiAccess,
      hdhr_enabled: hdhrEnabled,
      max_connections: maxConnections
  };
  if (password) body.password = password;

  try {
    await fetchJSON(`/api/users/${id}`, {
      method: 'PUT',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify(body)
    });
    bootstrap.Modal.getInstance(document.getElementById('edit-user-modal')).hide();
    loadUsers();
    showToast(t('userUpdated'), 'success');
  } catch (e) {
    alert(t('errorPrefix') + ' ' + (e.message || 'Error'));
  } finally {
    setLoadingState(btn, false);
  }
});

// === Provider Management ===
async function loadProviders(filterUserId = null) {
  const providers = await fetchJSON('/api/providers');
  updateStatsCounters('providers', providers.length);

  const list = document.getElementById('provider-list');
  list.innerHTML = '';

  updateChannelProviderSelect(providers);

  const targetUserId = filterUserId || selectedUserId;
  const section = document.getElementById('provider-section');
  if (section) {
      if (targetUserId) section.classList.remove('d-none');
      else section.classList.add('d-none');
  }

  // Hide "Add Provider" button for non-admins
  const addProviderBtn = document.getElementById('add-provider-btn');
  if (addProviderBtn) {
      addProviderBtn.style.display = (currentUser && currentUser.is_admin) ? 'block' : 'none';
  }

  // Filter for display
  const providersToRender = targetUserId
      ? providers.filter(p => p.user_id == targetUserId)
      : [];

  if (providersToRender.length === 0) {
      list.innerHTML = `<li class="list-group-item text-muted small text-center py-3">${t('noProviders')}</li>`;
  }

  providersToRender.forEach(p => {
    const li = document.createElement('li');
    li.className = 'list-group-item';
    
    const epgStatus = p.epg_enabled ? '✅' : '❌';
    const lastUpdate = p.epg_last_updated ? new Date(p.epg_last_updated * 1000).toLocaleString() : t('never');
    const epgInfo = p.epg_url ? `<br><small class="text-muted">EPG: ${epgStatus} (${p.epg_update_interval/3600}h) | ${t('lastEpgUpdate')}: ${lastUpdate}</small>` : '';
    const ownerInfo = p.owner_name ? `<br><small class="text-primary">${t('owner')}: ${p.owner_name}</small>` : '';

    let expiryInfo = '';
    if (p.expiry_date) {
        const expDate = new Date(p.expiry_date * 1000);
        const now = new Date();
        const diffDays = Math.ceil((expDate - now) / (1000 * 60 * 60 * 24));
        let colorClass = 'text-muted';
        if (diffDays < 0) colorClass = 'text-danger fw-bold';
        else if (diffDays < 7) colorClass = 'text-warning fw-bold';
        else colorClass = 'text-success';

        expiryInfo = `<br><small class="${colorClass}">${t('expiryDate') || 'Expires'}: ${expDate.toLocaleDateString()} (${diffDays} ${t('days')})</small>`;
    }

    const row = document.createElement('div');
    row.className = 'd-flex justify-content-between align-items-center';
    row.innerHTML = `<div><strong>${escapeHtml(p.name)}</strong> <small>(${escapeHtml(p.url)})</small>${ownerInfo}${expiryInfo}${epgInfo}</div>`;
    
    const btnGroup = document.createElement('div');
    const isAdmin = currentUser && currentUser.is_admin;
    
    if (isAdmin) {
        const editBtn = document.createElement('button');
        editBtn.className = 'btn btn-sm btn-outline-secondary me-1';
        editBtn.innerHTML = '✏️';
        editBtn.setAttribute('aria-label', t('edit'));
        editBtn.title = t('edit');
        editBtn.onclick = () => prepareEditProvider(p);
        btnGroup.appendChild(editBtn);

        const syncBtn = document.createElement('button');
        syncBtn.className = 'btn btn-sm btn-outline-primary me-1';
        syncBtn.textContent = t('sync');
        syncBtn.onclick = async () => {
          if (!selectedUserId) {
            alert(t('pleaseSelectUserFirst'));
            return;
          }
          setLoadingState(syncBtn, true, 'syncing');
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
            setLoadingState(syncBtn, false);
          }
        };
        btnGroup.appendChild(syncBtn);

        const configBtn = document.createElement('button');
        configBtn.className = 'btn btn-sm btn-outline-secondary me-1';
        configBtn.innerHTML = '⚙️';
        configBtn.title = t('syncConfig');
        configBtn.setAttribute('aria-label', t('syncConfig'));
        configBtn.onclick = () => showSyncConfigModal(p.id);
        btnGroup.appendChild(configBtn);

        const logsBtn = document.createElement('button');
        logsBtn.className = 'btn btn-sm btn-outline-info me-1';
        logsBtn.innerHTML = '📊';
        logsBtn.title = t('syncLogs');
        logsBtn.setAttribute('aria-label', t('syncLogs'));
        logsBtn.onclick = () => showSyncLogs(p.id);
        btnGroup.appendChild(logsBtn);
    }
    
    if (isAdmin) {
        const delBtn = document.createElement('button');
        delBtn.className = 'btn btn-sm btn-danger';
        delBtn.textContent = t('delete');
        delBtn.setAttribute('aria-label', t('deleteAction'));
        delBtn.title = t('deleteAction');
        delBtn.onclick = async () => {
          if (!confirm(t('deleteProviderConfirm', {name: p.name}))) return;
          await fetchJSON(`/api/providers/${p.id}`, {method: 'DELETE'});
          loadProviders();
        };
        btnGroup.appendChild(delBtn);
    }
    row.appendChild(btnGroup);
    li.appendChild(row);
    list.appendChild(li);
  });
}

function updateChannelProviderSelect(providers) {
  const select = document.getElementById('channel-provider-select');
  if (!select) return;

  select.innerHTML = `<option value="">${t('selectProviderPlaceholder')}</option>`;

  const filtered = selectedUserId
    ? providers.filter(p => p.user_id == selectedUserId)
    : [];

  filtered.forEach(p => {
    const opt = document.createElement('option');
    opt.value = p.id;
    opt.textContent = p.name;
    select.appendChild(opt);
  });
}

function prepareEditProvider(p) {
  const form = document.getElementById('provider-form');
  form.provider_id.value = p.id;
  form.name.value = p.name;
  form.url.value = p.url;
  form.username.value = p.username;
  form.password.value = p.plain_password || '********';
  form.epg_url.value = p.epg_url || '';
  form.user_agent.value = p.user_agent || '';
  form.user_id.value = p.user_id || '';
  form.epg_update_interval.value = p.epg_update_interval || 86400;
  form.epg_enabled.checked = p.epg_enabled !== 0;
  form.max_connections.value = p.max_connections || 0;

  const backupInput = document.getElementById('provider-backup-urls');
  if (backupInput) {
      backupInput.value = (p.backup_urls || []).join('\n');
  }

  const expiryInput = document.getElementById('provider-expiry-date');
  if (expiryInput) {
      if (p.expiry_date) {
          const date = new Date(p.expiry_date * 1000);
          expiryInput.value = date.toLocaleDateString() + ' ' + date.toLocaleTimeString();
      } else {
          expiryInput.value = '';
      }
  }

  document.getElementById('save-provider-btn').textContent = t('saveChanges') || 'Save';

  // Show Modal
  const modalEl = document.getElementById('add-provider-modal');
  const modal = new bootstrap.Modal(modalEl);
  modal.show();
}

function showAddProviderModal() {
    const modal = new bootstrap.Modal(document.getElementById('add-provider-modal'));
    resetProviderForm();
    modal.show();
}

function resetProviderForm() {
  const form = document.getElementById('provider-form');
  form.reset();
  form.provider_id.value = '';
  document.getElementById('save-provider-btn').textContent = t('addProvider');
  if (selectedUserId && form.user_id) form.user_id.value = selectedUserId;

  const expiryInput = document.getElementById('provider-expiry-date');
  if (expiryInput) expiryInput.value = '';
}

// === Category Management ===
async function loadUserCategories() {
  if (!selectedUserId) return;
  renderLoadingList('category-list');
  const cats = await fetchJSON(`/api/users/${selectedUserId}/categories`);
  const list = document.getElementById('category-list');
  list.innerHTML = '';
  selectedCategoryId = null;

  // Reset Assigned List
  const userChanList = document.getElementById('user-channel-list');
  if (userChanList) userChanList.innerHTML = '';

  const assignedHeader = document.getElementById('assigned-channels-header');
  if (assignedHeader) assignedHeader.textContent = t('assigned', {count: 0});

  const chanSelectAll = document.getElementById('chan-select-all-toggle');
  if (chanSelectAll) chanSelectAll.checked = false;
  updateChanBulkDeleteBtn();

  const typeRadio = document.querySelector('.category-type-filter:checked');
  const type = typeRadio ? typeRadio.value : 'live';

  // Filter categories by type (and handle legacy ones defaulting to 'live' if null, though backend sets default)
  const filtered = cats.filter(c => (c.type || 'live') === type);

  if (filtered.length === 0) {
      list.innerHTML = `<li class="list-group-item text-muted small">${t('noResults', {search: ''})}</li>`;
      return;
  }

  filtered.forEach(c => {
    const li = document.createElement('li');
    li.className = 'list-group-item d-flex justify-content-between align-items-center';
    li.dataset.id = c.id;
    
    // Adult-Kennzeichnung
    if (c.is_adult) {
      li.style.borderLeft = '4px solid #dc3545';
    }
    
    // Checkbox
    const checkDiv = document.createElement('div');
    checkDiv.className = 'form-check d-flex align-items-center me-2 mb-0';
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.className = 'form-check-input user-cat-check';
    checkbox.value = c.id;
    checkbox.onclick = (e) => { e.stopPropagation(); updateCatBulkDeleteBtn(); };
    checkDiv.appendChild(checkbox);
    li.appendChild(checkDiv);

    // Drag Handle
    const dragHandle = document.createElement('span');
    dragHandle.className = 'drag-handle me-2';
    dragHandle.innerHTML = '⋮⋮';
    dragHandle.title = t('dragToSort');
    li.appendChild(dragHandle);
    
    const span = document.createElement('span');
    span.textContent = c.is_adult ? `🔞 ${c.name}` : c.name; // textContent is safe
    span.style.cursor = 'pointer';
    span.style.flex = '1';
    makeAccessible(span, () => {
      [...list.children].forEach(el => el.classList.remove('active'));
      li.classList.add('active');
      selectedCategoryId = c.id;
      loadUserCategoryChannels();
    });
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
    delBtn.setAttribute('aria-label', t('deleteAction'));
    delBtn.title = t('deleteAction');
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
  
  try {
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
  } catch(e) { console.warn('Sortable init error', e); }
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

  const typeRadio = document.querySelector('.import-type-radio:checked');
  const type = typeRadio ? typeRadio.value : 'live';

  const modalEl = document.getElementById('importCategoryModal');
  const list = document.getElementById('provider-categories-list');
  list.innerHTML = `<li class="list-group-item text-muted">${t('loadingCategories')}</li>`;
  
  if (!modalEl.classList.contains('show')) {
      const modal = new bootstrap.Modal(modalEl);
      modal.show();
  }

  try {
    providerCategories = await fetchJSON(`/api/providers/${providerId}/categories?type=${type}`);
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
  updateSelectedCount();
  
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
    li.className = 'list-group-item d-flex align-items-center';
    
    if (cat.is_adult) {
      li.style.borderLeft = '4px solid #dc3545';
    }

    // Checkbox
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.className = 'form-check-input me-3 cat-checkbox';
    checkbox.value = cat.category_id;
    checkbox.dataset.name = cat.category_name;
    checkbox.onchange = updateSelectedCount;
    li.appendChild(checkbox);

    const contentDiv = document.createElement('div');
    contentDiv.className = 'flex-grow-1';
    
    const row = document.createElement('div');
    row.className = 'd-flex justify-content-between align-items-center';
    
    const info = document.createElement('div');
    const catNameDisplay = cat.is_adult ? `🔞 ${cat.category_name}` : cat.category_name;
    info.innerHTML = `
      <strong>${escapeHtml(catNameDisplay)}</strong><br>
      <small class="text-muted">${cat.channel_count} ${escapeHtml(t('channels'))}</small>
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
    
    contentDiv.appendChild(row);
    li.appendChild(contentDiv);
    list.appendChild(li);
  });
}

function updateSelectedCount() {
    const count = document.querySelectorAll('.cat-checkbox:checked').length;
    const badge = document.getElementById('cat-selected-count');
    if(badge) badge.textContent = count;
}

async function importSelectedCategories(withChannels) {
  if (!selectedUserId) {
    alert(t('pleaseSelectUserFirst'));
    return;
  }

  const select = document.getElementById('channel-provider-select');
  const providerId = select.value;

  const checkboxes = document.querySelectorAll('.cat-checkbox:checked');
  if (checkboxes.length === 0) {
    alert(t('noSelection'));
    return;
  }

  const typeRadio = document.querySelector('.import-type-radio:checked');
  const type = typeRadio ? typeRadio.value : 'live';

  const categories = Array.from(checkboxes).map(cb => ({
    id: cb.value,
    name: cb.dataset.name,
    import_channels: withChannels,
    type: type
  }));

  if (!confirm(t('importCategories') + ` (${categories.length})?`)) return;

  const btnId = withChannels ? 'btn-import-selected-channels' : 'btn-import-selected';
  const btn = document.getElementById(btnId);
  if(btn) setLoadingState(btn, true, 'loading');

  try {
    const result = await fetchJSON(`/api/providers/${providerId}/import-categories`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({
        user_id: selectedUserId,
        categories: categories
      })
    });

    let msg = t('categoriesImported', {count: result.categories_imported});
    if (result.channels_imported > 0) {
        msg += `, ${result.channels_imported} ${t('channels')}`;
    }
    alert(msg);

    // Refresh user categories in background
    loadUserCategories();

    // Uncheck all
    checkboxes.forEach(cb => cb.checked = false);
    updateSelectedCount();

  } catch (e) {
    console.error('❌ Import error:', e);
    alert(t('errorPrefix') + ' ' + e.message);
  } finally {
      if(btn) setLoadingState(btn, false);
  }
}

async function importCategory(cat, withChannels) {
  if (!selectedUserId) {
    alert(t('pleaseSelectUserFirst'));
    return;
  }

  const select = document.getElementById('channel-provider-select');
  const providerId = select.value;

  const typeRadio = document.querySelector('.import-type-radio:checked');
  const type = typeRadio ? typeRadio.value : 'live';

  try {
    const result = await fetchJSON(`/api/providers/${providerId}/import-category`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({
        user_id: selectedUserId,
        category_id: cat.category_id,
        category_name: cat.category_name,
        import_channels: withChannels,
        type: type
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
async function loadProviderChannels(reset = true) {
  const select = document.getElementById('channel-provider-select');
  const providerId = select.value;
  const searchInput = document.getElementById('channel-search');
  const list = document.getElementById('provider-channel-list');
  
  if (!providerId) {
    list.innerHTML = `<li class="list-group-item text-muted">${t('pleaseSelectProvider')}</li>`;
    searchInput.disabled = true;
    searchInput.value = '';
    return;
  }

  if (reset) {
    channelPage = 1;
    // Keep search if it was triggered by search input logic, but if called from provider change, search is usually cleared?
    // Let's assume the caller handles setting channelSearch global if needed.
    // If we want to clear search on provider change:
    if (!searchInput.value) channelSearch = '';

    renderLoadingList('provider-channel-list', 'loadingChannels');
  }

  searchInput.disabled = false;
  await fetchProviderChannels(reset);
}

async function fetchProviderChannels(reset) {
  const select = document.getElementById('channel-provider-select');
  const providerId = select.value;
  const list = document.getElementById('provider-channel-list');
  
  const typeRadio = document.querySelector('.channel-type-filter:checked');
  const type = typeRadio ? typeRadio.value : 'live';

  isLoadingChannels = true;
  
  try {
    const url = `/api/providers/${providerId}/channels?type=${type}&page=${channelPage}&limit=${channelLimit}&search=${encodeURIComponent(channelSearch)}`;
    const res = await fetchJSON(url);

    isLoadingChannels = false;

    // Handle Response (supports new object structure and legacy array)
    let channels = [];
    if (Array.isArray(res)) {
        channels = res;
        channelTotal = res.length;
    } else {
        channels = res.channels;
        channelTotal = res.total;
    }

    if (reset) list.innerHTML = '';
    renderProviderChannels(channels);

  } catch(e) {
    isLoadingChannels = false;
    if (reset) {
        list.innerHTML = `<li class="list-group-item text-danger">${t('loadingError')}</li>`;
    }
    console.error('Channel load error:', e);
  }
}

function renderProviderChannels(channels) {
  const list = document.getElementById('provider-channel-list');
  
  // Update Header
  const availHeader = document.getElementById('available-channels-header');
  if (availHeader) availHeader.textContent = t('available', {count: channelTotal});

  // Remove existing "Load More" or "Loading" indicators if appending
  const oldLoadMore = document.getElementById('btn-load-more-channels');
  if (oldLoadMore) oldLoadMore.parentElement.remove();

  if (channels.length === 0 && list.children.length === 0) {
    list.innerHTML = `<li class="list-group-item text-muted">${t('noResults', {search: channelSearch})}</li>`;
    return;
  }
  
  channels.forEach(ch => {
    const li = document.createElement('li');
    li.className = 'list-group-item d-flex justify-content-between align-items-center';
    
    const nameSpan = document.createElement('span');
    nameSpan.textContent = ch.name; // textContent is safe
    nameSpan.title = ch.name; // Tooltip for full name
    nameSpan.style.flex = '1';
    nameSpan.style.overflow = 'hidden';
    nameSpan.style.textOverflow = 'ellipsis';
    li.appendChild(nameSpan);
    
    if (ch.logo) {
      const img = document.createElement('img');
      img.src = getProxiedUrl(ch.logo); // URL is attribute, relatively safe if protocol checked, but src should be fine
      img.alt = ch.name; // Accessible alt text
      img.style.width = '20px';
      img.style.height = '20px';
      img.style.marginLeft = '5px';
      img.onerror = () => img.style.display = 'none';
      li.appendChild(img);
    }
    
    const btn = document.createElement('button');
    btn.className = 'btn btn-sm btn-success ms-2';
    btn.textContent = t('add');
    btn.setAttribute('aria-label', `${t('add')} ${ch.name}`); // Accessible label
    btn.onclick = async () => {
      if (!selectedUserId || !selectedCategoryId) {
        alert(t('selectUserAndCategory'));
        return;
      }

      const originalText = btn.textContent;
      const originalClass = btn.className;
      setLoadingState(btn, true, 'loading', false);

      try {
        await fetchJSON(`/api/user-categories/${selectedCategoryId}/channels`, {
          method: 'POST',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({provider_channel_id: ch.id})
        });

        loadUserCategoryChannels();

        // Success state
        btn.disabled = true; // Keep disabled during success message
        btn.innerHTML = `✅ ${t('added')}`;
        btn.className = 'btn btn-sm btn-outline-success ms-2';

        setTimeout(() => {
             // Only restore if the button is still in the DOM (though garbage collection handles it, but good practice)
             btn.className = originalClass;
             btn.textContent = originalText;
             btn.disabled = false;
        }, 1500);

      } catch (e) {
        alert(t('errorPrefix') + ' ' + e.message);
        setLoadingState(btn, false);
        btn.textContent = originalText;
      }
    };
    
    li.appendChild(btn);
    list.appendChild(li);
  });
  
  // Check if we need "Load More" button
  const currentCount = list.children.length; // Approximate
  if (currentCount < channelTotal) {
      const li = document.createElement('li');
      li.className = 'list-group-item text-center p-2';

      const btn = document.createElement('button');
      btn.id = 'btn-load-more-channels';
      btn.className = 'btn btn-sm btn-outline-primary w-100';
      btn.textContent = t('loadMore');
      btn.onclick = async function() {
          setLoadingState(this, true, 'loading');

          channelPage++;
          await loadProviderChannels(false);

          if (document.body.contains(this)) {
              setLoadingState(this, false);
          }
      };

      li.appendChild(btn);
      list.appendChild(li);
  }
}

async function loadUserCategoryChannels() {
  if (!selectedCategoryId) return;
  renderLoadingList('user-channel-list');
  const chans = await fetchJSON(`/api/user-categories/${selectedCategoryId}/channels`);
  const list = document.getElementById('user-channel-list');
  list.innerHTML = '';

  // Update Assigned Header
  const assignedHeader = document.getElementById('assigned-channels-header');
  if (assignedHeader) assignedHeader.textContent = t('assigned', {count: chans.length});
  
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
    
    // Checkbox
    const checkDiv = document.createElement('div');
    checkDiv.className = 'form-check d-flex align-items-center me-2 mb-0';
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.className = 'form-check-input user-chan-check';
    checkbox.value = ch.user_channel_id;
    if (globalSelectedChannels.has(ch.user_channel_id)) {
        checkbox.checked = true;
    }
    checkbox.onclick = (e) => {
        e.stopPropagation();
        const val = Number(checkbox.value);
        if (checkbox.checked) {
            globalSelectedChannels.add(val);
        } else {
            globalSelectedChannels.delete(val);
        }
        updateChanBulkDeleteBtn();
    };
    checkDiv.appendChild(checkbox);
    li.appendChild(checkDiv);

    // Drag Handle
    const dragHandle = document.createElement('span');
    dragHandle.className = 'drag-handle me-2';
    dragHandle.innerHTML = '⋮⋮';
    dragHandle.title = t('dragToSort');
    li.appendChild(dragHandle);
    
    const nameSpan = document.createElement('span');
    nameSpan.textContent = ch.name; // textContent is safe
    nameSpan.title = ch.name; // Tooltip for full name
    nameSpan.style.flex = '1';
    li.appendChild(nameSpan);
    
    if (ch.logo) {
      const img = document.createElement('img');
      img.src = getProxiedUrl(ch.logo);
      img.alt = ch.name; // Accessible alt text
      img.style.width = '20px';
      img.style.height = '20px';
      img.style.marginLeft = '5px';
      img.onerror = () => img.style.display = 'none';
      li.appendChild(img);
    }
    
    const delBtn = document.createElement('button');
    delBtn.className = 'btn btn-sm btn-danger ms-2';
    delBtn.textContent = t('delete');
    delBtn.setAttribute('aria-label', `${t('deleteAction')} ${ch.name}`); // Accessible label
    delBtn.title = t('deleteAction');
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
  
  try {
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
  } catch(e) { console.warn('Sortable init error', e); }
}

// === Form Handlers ===
document.getElementById('user-form').addEventListener('submit', async e => {
  e.preventDefault();
  const f = e.target;
  const btn = f.querySelector('button[type="submit"]');
  setLoadingState(btn, true, 'saving');

  try {
    const body = {
        username: f.username.value,
        password: f.password.value,
        max_connections: f.max_connections ? f.max_connections.value : 0
    };
    if (f.copy_from_user_id && f.copy_from_user_id.value) {
        body.copy_from_user_id = f.copy_from_user_id.value;
    }

    await fetchJSON('/api/users', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify(body)
    });
    f.reset();
    loadUsers();
    showToast(t('userCreated'), 'success');
  } catch (e) {
    // Show user-friendly error message
    const errorData = e.response || {};
    const errorMessage = errorData.message || e.message || 'Unknown error';
    showToast(errorMessage, 'danger');
  } finally {
    setLoadingState(btn, false);
  }
});

document.getElementById('provider-form').addEventListener('submit', async e => {
  e.preventDefault();
  const f = e.target;
  const btn = document.getElementById('save-provider-btn');
  setLoadingState(btn, true, 'saving');

  const id = f.provider_id.value;

  let backupUrls = [];
  const backupInput = document.getElementById('provider-backup-urls');
  if (backupInput && backupInput.value.trim()) {
      backupUrls = backupInput.value.split('\n').map(u => u.trim()).filter(u => u);
  }

  const body = {
    name: f.name.value,
    url: f.url.value,
    username: f.username.value,
    password: f.password.value,
    epg_url: f.epg_url.value || null,
    user_agent: f.user_agent.value || null,
    user_id: f.user_id.value || null,
    epg_update_interval: f.epg_update_interval.value,
    epg_enabled: f.epg_enabled.checked,
    backup_urls: backupUrls,
    max_connections: f.max_connections.value || 0
  };

  try {
    if (id) {
      await fetchJSON(`/api/providers/${id}`, {
        method: 'PUT',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify(body)
      });
      showToast(t('providerUpdated'), 'success');
      resetProviderForm();
    } else {
      await fetchJSON('/api/providers', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify(body)
      });
      f.reset();
      // Keep selected user if any
      if (selectedUserId) f.user_id.value = selectedUserId;
      showToast(t('providerCreated'), 'success');
    }

    // Close Modal
    const modalEl = document.getElementById('add-provider-modal');
    const modal = bootstrap.Modal.getInstance(modalEl);
    if (modal) modal.hide();

    loadProviders(selectedUserId);
  } catch (e) {
    showToast(e.message, 'danger');
  } finally {
    setLoadingState(btn, false);
  }
});

document.getElementById('category-form').addEventListener('submit', async e => {
  e.preventDefault();
  if (!selectedUserId) {
    alert(t('pleaseSelectUserFirst'));
    return;
  }
  const f = e.target;
  const btn = f.querySelector('button[type="submit"]');
  setLoadingState(btn, true, null, false);

  const typeRadio = document.querySelector('.category-type-filter:checked');
  const type = typeRadio ? typeRadio.value : 'live';

  try {
    await fetchJSON(`/api/users/${selectedUserId}/categories`, {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({name: f.name.value, type: type})
    });
    f.reset();
    loadUserCategories();
    showToast(t('categoryCreated'), 'success');
  } catch (e) {
    showToast(e.message, 'danger');
  } finally {
    setLoadingState(btn, false);
  }
});

// === Event Handlers ===
document.getElementById('channel-provider-select').addEventListener('change', loadProviderChannels);
document.getElementById('channel-search').addEventListener('input', debounce((e) => {
  channelSearch = e.target.value.trim();
  loadProviderChannels(true);
}, 500));

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
    lastSyncInfo.classList.remove('d-none');
  } else {
    lastSyncInfo.classList.add('d-none');
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
  if (!currentUser || !currentUser.is_admin) return;

  try {
    const sources = await fetchJSON('/api/epg-sources');
    updateStatsCounters('epg', sources.length);
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
        <strong>${escapeHtml(source.name)}</strong>
        <br><small class="text-muted">${escapeHtml(source.url)}</small>
        <br><small>${enabledStatus} | ${t('updateInterval')}: ${source.update_interval / 3600}h | ${t('lastEpgUpdate')}: ${lastUpdate} ${isUpdating}</small>
      `;
      
      const btnGroup = document.createElement('div');
      btnGroup.className = 'd-flex gap-1';
      
      // Update button
      const updateBtn = document.createElement('button');
      updateBtn.className = 'btn btn-sm btn-outline-info';
      updateBtn.innerHTML = '🔄';
      updateBtn.title = t('updateNow');
      updateBtn.setAttribute('aria-label', t('updateNow'));
      updateBtn.disabled = source.is_updating;
      updateBtn.onclick = async () => {
        setLoadingState(updateBtn, true, null, false);
        try {
          await fetchJSON(`/api/epg-sources/${source.id}/update`, {method: 'POST'});
          alert(t('epgUpdateSuccess'));
          loadEpgSources();
        } catch (e) {
          alert(t('errorPrefix') + ' ' + e.message);
        } finally {
          setLoadingState(updateBtn, false);
        }
      };
      
      btnGroup.appendChild(updateBtn);
      
      // Only show edit/toggle/delete for non-provider sources
      if (!isProvider) {
        const editBtn = document.createElement('button');
        editBtn.className = 'btn btn-sm btn-outline-secondary';
        editBtn.innerHTML = '✏️';
        editBtn.title = t('edit');
        editBtn.setAttribute('aria-label', t('edit'));
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
        delBtn.setAttribute('aria-label', t('deleteAction'));
        delBtn.title = t('deleteAction');
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
      <strong>${escapeHtml(source.name)}</strong>
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

// === Import/Export Handlers ===
async function handleExport(e) {
    e.preventDefault();
    const f = e.target;
    const userId = f.user_id.value;
    const password = f.password.value;

    if (!password || password.length < 8) {
        alert(t('password_too_short'));
        return;
    }

    const btn = document.getElementById('export-btn');
    setLoadingState(btn, true, 'processing');

    try {
        const token = getToken();
        // Construct URL
        const url = `/api/export`;

        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ user_id: userId, password: password })
        });

        if (!response.ok) {
            const err = await response.json();
            throw new Error(err.error || 'Export failed');
        }

        const blob = await response.blob();
        const downloadUrl = window.URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = downloadUrl;
        // Use filename from header or default
        const contentDisp = response.headers.get('Content-Disposition');
        let filename = `iptv_export_${Date.now()}.bin`;
        if (contentDisp && contentDisp.indexOf('filename="') !== -1) {
            filename = contentDisp.split('filename="')[1].split('"')[0];
        }
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        a.remove();

        alert(t('exportSuccess'));
        f.reset();
    } catch(e) {
        alert(t('errorPrefix') + ' ' + e.message);
    } finally {
        setLoadingState(btn, false);
    }
}

async function handleImport(e) {
    e.preventDefault();
    const f = e.target;
    const file = f.file.files[0];
    const password = f.password.value;

    if (!file) return;

    if (!confirm(t('confirmImport'))) {
        return;
    }

    const btn = document.getElementById('import-btn');
    setLoadingState(btn, true, 'processing');

    const formData = new FormData();
    formData.append('file', file);
    formData.append('password', password);

    try {
        const token = getToken();
        const response = await fetch('/api/import', {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${token}` },
            body: formData
        });

        const res = await response.json();
        if (!response.ok) throw new Error(res.error || 'Import failed');

        const stats = res.stats;
        alert(`${t('importSuccess')}\n\n${t('totalUsers')}: ${stats.users_imported} (${t('skipped')}: ${stats.users_skipped})\n${t('providers')}: ${stats.providers}\n${t('categories')}: ${stats.categories}\n${t('channels')}: ${stats.channels}`);

        f.reset();
        loadUsers();
        loadProviders();
    } catch(e) {
        alert(t('errorPrefix') + ' ' + e.message);
    } finally {
        setLoadingState(btn, false);
    }
}

// === Init ===
document.addEventListener('DOMContentLoaded', () => {
  // Make dashboard stats cards interactive
  const cardActions = {
    'stats-users': () => {
      const el = document.getElementById('user-form');
      if (el) {
        el.scrollIntoView({behavior: 'smooth'});
        if (el.username) el.username.focus();
      }
    },
    'stats-providers': () => {
      const section = document.getElementById('provider-section');
      if (section && section.style.display !== 'none') {
        section.scrollIntoView({behavior: 'smooth'});
      } else {
        const el = document.getElementById('user-form');
        if (el) {
          el.scrollIntoView({behavior: 'smooth'});
          if (el.username) el.username.focus();
        }
      }
    },
    'stats-streams': () => switchView('statistics'),
    'stats-epg': () => {
      const el = document.getElementById('epg-sources-card');
      if (el) el.scrollIntoView({behavior: 'smooth'});
    }
  };

  for (const [id, action] of Object.entries(cardActions)) {
    const el = document.getElementById(id);
    if (el) {
      const card = el.closest('.card');
      if (card) {
        makeAccessible(card, action);
        card.style.cursor = 'pointer';
      }
    }
  }

  // Fix for tab switching issues (overlapping content)
  const triggerTabList = [].slice.call(document.querySelectorAll('#user-tabs button'));
  triggerTabList.forEach(function (triggerEl) {
    triggerEl.addEventListener('shown.bs.tab', function (event) {
      const targetId = triggerEl.getAttribute('data-bs-target');
      document.querySelectorAll('#user-tab-content .tab-pane').forEach(pane => {
          if ('#' + pane.id !== targetId) {
              pane.classList.remove('show', 'active');
          }
      });
    });
  });

  // Seite übersetzen
  translatePage();
  
  document.getElementById('xtream-url').value = window.location.origin;
  document.getElementById('xtream-user').value = '-';
  document.getElementById('xtream-pass').value = t('passwordPlaceholder');
  document.getElementById('epg-url').value = window.location.origin + '/xmltv.php?username=<USER>&password=<PASS>';

  const m3uLinkEl = document.getElementById('m3u-link');
  if (m3uLinkEl) {
      const baseUrl = window.location.origin;
      m3uLinkEl.value = `${baseUrl}/get.php?username=DUMMY&password=DUMMY&type=m3u_plus&output=ts`;
  }
  
  const importBtn = document.getElementById('import-categories-btn');
  if (importBtn) {
    importBtn.addEventListener('click', loadProviderCategories);
  }
  
  const catSearch = document.getElementById('category-import-search');
  if (catSearch) {
    catSearch.addEventListener('input', renderProviderCategories);
  }

  document.querySelectorAll('.import-type-radio').forEach(el => {
      el.addEventListener('change', loadProviderCategories);
  });

  document.querySelectorAll('.channel-type-filter').forEach(el => {
      el.addEventListener('change', (e) => {
          loadProviderChannels();
          // Sync category filter
          const type = e.target.value;
          const categoryRadio = document.querySelector(`.category-type-filter[value="${type}"]`);
          if (categoryRadio && !categoryRadio.checked) {
              categoryRadio.checked = true;
              loadUserCategories();
          }
      });
  });

  document.querySelectorAll('.category-type-filter').forEach(el => {
      el.addEventListener('change', (e) => {
          loadUserCategories();
          // Sync channel filter
          const type = e.target.value;
          const channelRadio = document.querySelector(`.channel-type-filter[value="${type}"]`);
          if (channelRadio) {
              channelRadio.checked = true;
              loadProviderChannels();
          }
      });
  });

  // Bulk Import Events
  const btnSelectAll = document.getElementById('cat-select-all');
  if (btnSelectAll) {
      btnSelectAll.addEventListener('click', () => {
          document.querySelectorAll('.cat-checkbox').forEach(cb => cb.checked = true);
          updateSelectedCount();
      });
  }
  const btnDeselectAll = document.getElementById('cat-deselect-all');
  if (btnDeselectAll) {
      btnDeselectAll.addEventListener('click', () => {
          document.querySelectorAll('.cat-checkbox').forEach(cb => cb.checked = false);
          updateSelectedCount();
      });
  }
  const btnImportSelected = document.getElementById('btn-import-selected');
  if (btnImportSelected) {
      btnImportSelected.addEventListener('click', () => importSelectedCategories(false));
  }
  const btnImportSelectedChannels = document.getElementById('btn-import-selected-channels');
  if (btnImportSelectedChannels) {
      btnImportSelectedChannels.addEventListener('click', () => importSelectedCategories(true));
  }

  const resetStatsBtn = document.getElementById('reset-stats-btn');
  if (resetStatsBtn) {
      resetStatsBtn.addEventListener('click', resetStatistics);
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
      setLoadingState(updateAllEpgBtn, true, 'updating');
      try {
        const result = await fetchJSON('/api/epg-sources/update-all', {method: 'POST'});
        const success = result.results.filter(r => r.success).length;
        const failed = result.results.filter(r => !r.success).length;
        alert(t('epgUpdateAllSuccess', {success: success, failed: failed}));
        loadEpgSources();
      } catch (e) {
        alert(t('errorPrefix') + ' ' + e.message);
      } finally {
        setLoadingState(updateAllEpgBtn, false);
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

  const epgMappingCategorySelect = document.getElementById('epg-mapping-category-select');
  if (epgMappingCategorySelect) {
      epgMappingCategorySelect.addEventListener('change', loadEpgMappingChannels);
  }

  // Mode Switcher Events
  document.querySelectorAll('input[name="epg-mode"]').forEach(radio => {
      radio.addEventListener('change', (e) => {
          epgMappingMode = e.target.value;
          renderEpgMappingControls();
      });
  });

  const autoMapBtn = document.getElementById('auto-map-btn');
  if (autoMapBtn) {
    autoMapBtn.addEventListener('click', handleAutoMap);
  }

  const resetMapBtn = document.getElementById('reset-map-btn');
  if (resetMapBtn) {
    resetMapBtn.addEventListener('click', handleResetMapping);
  }

  const epgMappingSearch = document.getElementById('epg-mapping-search');
  if (epgMappingSearch) {
    epgMappingSearch.addEventListener('input', renderEpgMappingChannels);
  }

  const epgSelectSearch = document.getElementById('epg-select-search');
  if (epgSelectSearch) {
    epgSelectSearch.addEventListener('input', filterEpgSelectionList);
  }

  // Bulk Delete Listeners - Categories
  const catSelectAll = document.getElementById('cat-select-all-toggle');
  if (catSelectAll) {
    catSelectAll.addEventListener('change', (e) => {
      document.querySelectorAll('.user-cat-check').forEach(cb => cb.checked = e.target.checked);
      updateCatBulkDeleteBtn();
    });
  }

  const catBulkDeleteBtn = document.getElementById('cat-bulk-delete-btn');
  if (catBulkDeleteBtn) {
    catBulkDeleteBtn.addEventListener('click', async () => {
       const selected = Array.from(document.querySelectorAll('.user-cat-check:checked')).map(cb => Number(cb.value));
       if (selected.length === 0) return;

       if (!confirm(t('deleteCategoryConfirm', {name: `${selected.length} items`}))) return;

       try {
         await fetchJSON('/api/user-categories/bulk-delete', {
           method: 'POST',
           headers: {'Content-Type': 'application/json'},
           body: JSON.stringify({ids: selected})
         });
         loadUserCategories();
         if (catSelectAll) catSelectAll.checked = false;
         updateCatBulkDeleteBtn();
       } catch (e) {
         alert(t('errorPrefix') + ' ' + e.message);
       }
    });
  }

  // Bulk Delete Listeners - Channels
  const chanSelectAll = document.getElementById('chan-select-all-toggle');
  if (chanSelectAll) {
    chanSelectAll.addEventListener('change', (e) => {
      document.querySelectorAll('.user-chan-check').forEach(cb => {
          cb.checked = e.target.checked;
          const val = Number(cb.value);
          if (e.target.checked) globalSelectedChannels.add(val);
          else globalSelectedChannels.delete(val);
      });
      updateChanBulkDeleteBtn();
    });
  }

  const chanBulkDeleteBtn = document.getElementById('chan-bulk-delete-btn');
  if (chanBulkDeleteBtn) {
    chanBulkDeleteBtn.addEventListener('click', async () => {
       const selected = Array.from(globalSelectedChannels);
       if (selected.length === 0) return;

       if (!confirm(t('deleteChannelConfirm', {count: selected.length}))) return;

       try {
         await fetchJSON('/api/user-channels/bulk-delete', {
           method: 'POST',
           headers: {'Content-Type': 'application/json'},
           body: JSON.stringify({ids: selected})
         });
         globalSelectedChannels.clear();
         loadUserCategoryChannels();
         if (chanSelectAll) chanSelectAll.checked = false;
         updateChanBulkDeleteBtn();
       } catch (e) {
         alert(t('errorPrefix') + ' ' + e.message);
       }
    });
  }

  // Security Forms
  const blockForm = document.getElementById('block-ip-form');
  if (blockForm) {
      blockForm.addEventListener('submit', async (e) => {
          e.preventDefault();
          const ip = blockForm.ip.value;
          const reason = blockForm.reason.value;
          let duration = blockForm.duration.value;

          if (duration === 'manual') {
             const mins = prompt(t('minutes'), '60');
             if (!mins) return;
             duration = Number(mins) * 60;
          } else {
             duration = Number(duration);
          }

          try {
              await fetchJSON('/api/security/block', {
                  method: 'POST',
                  headers: {'Content-Type': 'application/json'},
                  body: JSON.stringify({ip, reason, duration})
              });
              blockForm.reset();
              // Reset select default
              if(blockForm.duration) blockForm.duration.value = '3600';
              loadSecurity();
          } catch(e) { alert(e.message); }
      });
  }

  const settingsForm = document.getElementById('security-settings-form');
  if (settingsForm) {
      settingsForm.addEventListener('submit', async (e) => {
          e.preventDefault();
          try {
              const body = {
                  admin_block_threshold: document.getElementById('setting-admin-threshold').value,
                  iptv_block_threshold: document.getElementById('setting-iptv-threshold').value,
                  admin_block_duration: document.getElementById('setting-admin-duration').value,
                  iptv_block_duration: document.getElementById('setting-iptv-duration').value
              };

              await fetchJSON('/api/settings', {
                  method: 'POST',
                  headers: {'Content-Type': 'application/json'},
                  body: JSON.stringify(body)
              });
              alert(t('settingsSaved'));
          } catch(e) { alert(e.message); }
      });
  }

  const whitelistForm = document.getElementById('whitelist-ip-form');
  if (whitelistForm) {
      whitelistForm.addEventListener('submit', async (e) => {
          e.preventDefault();
          const ip = whitelistForm.ip.value;
          const description = whitelistForm.description.value;
          try {
              await fetchJSON('/api/security/whitelist', {
                  method: 'POST',
                  headers: {'Content-Type': 'application/json'},
                  body: JSON.stringify({ip, description: description || 'Manual'})
              });
              whitelistForm.reset();
              loadSecurity();
          } catch(e) { alert(e.message); }
      });
  }

  // Import/Export Forms
  const exportForm = document.getElementById('export-form');
  if (exportForm) {
      exportForm.addEventListener('submit', handleExport);
  }

  const importForm = document.getElementById('import-form');
  if (importForm) {
      importForm.addEventListener('submit', handleImport);
  }

  const loginForm = document.getElementById('login-form');
  if (loginForm) {
      loginForm.addEventListener('submit', handleLogin);
  }

  const changePasswordForm = document.getElementById('change-password-form');
  if (changePasswordForm) {
      changePasswordForm.addEventListener('submit', handleChangePassword);
  }

  // Check authentication on page load
  checkAuthentication();

  // Init Headers
  const availHeader = document.getElementById('available-channels-header');
  if (availHeader) availHeader.textContent = t('available', {count: 0});
  const assignedHeader = document.getElementById('assigned-channels-header');
  if (assignedHeader) assignedHeader.textContent = t('assigned', {count: 0});
  
  // Initialize clearable inputs
  ['channel-search', 'epg-mapping-search', 'category-import-search', 'epg-browse-search', 'epg-select-search'].forEach(id => {
      initClearableInput(id);
  });

  // Global Error Handler for Images (Delegation)
  document.addEventListener('error', (e) => {
      if (e.target.tagName === 'IMG' && e.target.dataset.onError === 'hide') {
          e.target.style.display = 'none';
      }
  }, true);

  // Global Keyboard Shortcuts
  document.addEventListener('keydown', (e) => {
    // '/' to focus search
    // Ensure no modifier keys are pressed and we are not in an input/editable field
    if (e.key === '/' &&
        !e.ctrlKey && !e.metaKey && !e.altKey &&
        !['INPUT', 'TEXTAREA'].includes(document.activeElement.tagName) &&
        !document.activeElement.isContentEditable) {

      e.preventDefault();

      const candidates = [
        // Modals (Higher priority)
        'category-import-search',
        'epg-browse-search',
        'epg-select-search',
        // Views
        'channel-search',
        'epg-mapping-search'
      ];

      for (const id of candidates) {
        const el = document.getElementById(id);
        // Check if element exists, is visible (has dimensions), and not disabled
        if (el && (el.offsetWidth > 0 || el.offsetHeight > 0) && !el.disabled) {
          el.focus();
          // Select text if any
          if (el.value) el.select();
          break;
        }
      }
    }
  });

  // Global Click Handlers (Delegation)
  document.addEventListener('click', (e) => {
    // 1. switchView links
    const viewBtn = e.target.closest('[data-view]');
    if (viewBtn) {
        e.preventDefault();
        switchView(viewBtn.dataset.view);
        return;
    }

    // 2. copyToClipboard buttons
    const copyBtn = e.target.closest('[data-copy-target]');
    if (copyBtn) {
        const targetId = copyBtn.dataset.copyTarget;
        const targetEl = document.getElementById(targetId);
        if (targetEl) {
            copyToClipboard(targetEl.value || targetEl.textContent, copyBtn);
        }
        return;
    }
    const copyTextBtn = e.target.closest('[data-copy-text]');
    if (copyTextBtn) {
        copyToClipboard(copyTextBtn.dataset.copyText, copyTextBtn);
        return;
    }

    // 3. togglePasswordVisibility buttons
    const togglePassBtn = e.target.closest('[data-toggle-password]');
    if (togglePassBtn) {
        togglePasswordVisibility(togglePassBtn.dataset.togglePassword, togglePassBtn);
        return;
    }

    // 4. Simple action buttons (no args)
    const actionMap = {
        'action-logout': handleLogout,
        'action-show-change-password': showChangePasswordModal,
        'action-show-otp': showOtpModal,
        'action-generate-user': generateUser,
        'action-add-provider': showAddProviderModal,
        'action-copy-all-xtream': () => copyAllXtreamCredentials(e.target.closest('[data-action]')),
        'action-clear-security-logs': clearSecurityLogs,
        'action-clear-client-logs': clearClientLogs,
        'action-prune-picons': prunePiconCache,
        'action-disable-otp': disableOtp,
        'action-verify-otp': verifyAndEnableOtp
    };

    const actionBtn = e.target.closest('[data-action]');
    if (actionBtn) {
        const action = actionBtn.dataset.action;
        if (actionMap[action]) {
            actionMap[action]();
            return;
        }

        // Actions with parameters (via data attributes)
        if (action === 'action-edit-share') {
            try {
                const data = JSON.parse(actionBtn.dataset.share);
                editShare(data);
            } catch(e) { console.error('Failed to parse share data', e); }
            return;
        }
        if (action === 'action-delete-share') {
            deleteShare(actionBtn.dataset.token);
            return;
        }
    }
  });

  // Global Modal Autofocus
  document.addEventListener('shown.bs.modal', function (event) {
    const modal = event.target;
    // Prioritize [autofocus], then first visible input
    const input = modal.querySelector('[autofocus]') ||
                  modal.querySelector('input:not([type="hidden"]):not([disabled]), textarea:not([disabled]), select:not([disabled])');
    if (input) {
      input.focus();
      // Select text if it's a text input
      if (input.tagName === 'INPUT' && (input.type === 'text' || input.type === 'password' || input.type === 'number')) {
          input.select();
      }
    }
  });

  console.log('✅ IPTV-Manager loaded with i18n & local assets');
});

// === View Management ===
let statsInterval = null;
let globalStatsInterval = null;

async function updateDashboardCounters() {
    // Only update if statistics tab is NOT active (to avoid double fetching)
    if (document.getElementById('view-statistics') && !document.getElementById('view-statistics').classList.contains('d-none')) {
        return;
    }

    if (!currentUser || !currentUser.is_admin) return;

    try {
        const data = await fetchJSON('/api/statistics');
        updateStatsCounters('streams', data.active_streams.length);
    } catch(e) {
        console.error('Failed to update dashboard counters', e);
    }
}

function switchView(viewName) {
  // Hide all views
  document.getElementById('view-dashboard').classList.add('d-none');
  document.getElementById('view-epg-mapping').classList.add('d-none');
  document.getElementById('view-statistics').classList.add('d-none');
  document.getElementById('view-security').classList.add('d-none');
  document.getElementById('view-import-export').classList.add('d-none');

  // Stop stats interval if running
  if (statsInterval) {
      clearInterval(statsInterval);
      statsInterval = null;
  }

  // Update nav active state
  document.querySelectorAll('.nav-link').forEach(el => el.classList.remove('active'));

  // Show selected view
  if (viewName === 'dashboard') {
    document.getElementById('view-dashboard').classList.remove('d-none');
    document.getElementById('nav-dashboard').classList.add('active');
  } else if (viewName === 'epg-mapping') {
    document.getElementById('view-epg-mapping').classList.remove('d-none');
    document.getElementById('nav-epg-mapping').classList.add('active');
    renderEpgMappingControls();
  } else if (viewName === 'statistics') {
    document.getElementById('view-statistics').classList.remove('d-none');
    document.getElementById('nav-statistics').classList.add('active');
    loadStatistics();
    statsInterval = setInterval(loadStatistics, 5000);
  } else if (viewName === 'security') {
    document.getElementById('view-security').classList.remove('d-none');
    document.getElementById('nav-security').classList.add('active');
    loadSecurity();
  } else if (viewName === 'import-export') {
    document.getElementById('view-import-export').classList.remove('d-none');
    document.getElementById('nav-import-export').classList.add('active');
    loadUsers(); // Ensure dropdown is populated
  }
}

async function loadSecurity() {
  try {
    const [logs, blocked, whitelist, settings, clientLogs] = await Promise.all([
      fetchJSON('/api/security/logs'),
      fetchJSON('/api/security/blocked'),
      fetchJSON('/api/security/whitelist'),
      fetchJSON('/api/settings'),
      fetchJSON('/api/client-logs')
    ]);

    // Render Settings
    if (document.getElementById('setting-admin-threshold')) {
        document.getElementById('setting-admin-threshold').value = settings.admin_block_threshold || '5';
    }
    if (document.getElementById('setting-iptv-threshold')) {
        document.getElementById('setting-iptv-threshold').value = settings.iptv_block_threshold || '10';
    }
    if (document.getElementById('setting-admin-duration')) {
        document.getElementById('setting-admin-duration').value = settings.admin_block_duration || '3600';
    }
    if (document.getElementById('setting-iptv-duration')) {
        document.getElementById('setting-iptv-duration').value = settings.iptv_block_duration || '3600';
    }

    // Render Logs
    const logBody = document.getElementById('security-logs-tbody');
    logBody.innerHTML = '';
    if (logs.length === 0) {
        logBody.innerHTML = `<tr><td colspan="4" class="text-center text-muted">${t('noLogs')}</td></tr>`;
    } else {
        logs.forEach(log => {
            const tr = document.createElement('tr');

            const tdDate = document.createElement('td');
            tdDate.textContent = new Date(log.timestamp * 1000).toLocaleString();

            const tdIp = document.createElement('td');
            tdIp.textContent = log.ip;

            const tdAction = document.createElement('td');
            tdAction.textContent = log.action;

            const tdDetails = document.createElement('td');
            tdDetails.textContent = log.details || '';

            tr.appendChild(tdDate);
            tr.appendChild(tdIp);
            tr.appendChild(tdAction);
            tr.appendChild(tdDetails);

            logBody.appendChild(tr);
        });
    }

    // Render Blocked
    const blockedList = document.getElementById('blocked-ip-list');
    blockedList.innerHTML = '';
    if (blocked.length === 0) {
        const li = document.createElement('li');
        li.className = 'list-group-item text-muted';
        li.textContent = t('none');
        blockedList.appendChild(li);
    }
    blocked.forEach(b => {
        const li = document.createElement('li');
        li.className = 'list-group-item d-flex justify-content-between align-items-center';

        const div = document.createElement('div');
        const strong = document.createElement('strong');
        strong.textContent = b.ip;
        const br = document.createElement('br');
        const small = document.createElement('small');
        small.textContent = `${b.reason || ''} (Exp: ${new Date(b.expires_at * 1000).toLocaleString()})`;

        div.appendChild(strong);
        div.appendChild(br);
        div.appendChild(small);

        const btn = document.createElement('button');
        btn.className = 'btn btn-sm btn-outline-danger py-0';
        btn.textContent = t('unblock');
        btn.onclick = () => unblockIp(b.id);

        li.appendChild(div);
        li.appendChild(btn);
        blockedList.appendChild(li);
    });

    // Render Whitelist
    const whitelistList = document.getElementById('whitelisted-ip-list');
    whitelistList.innerHTML = '';
    if (whitelist.length === 0) {
        const li = document.createElement('li');
        li.className = 'list-group-item text-muted';
        li.textContent = t('none');
        whitelistList.appendChild(li);
    }
    whitelist.forEach(w => {
        const li = document.createElement('li');
        li.className = 'list-group-item d-flex justify-content-between align-items-center';

        const div = document.createElement('div');
        const strong = document.createElement('strong');
        strong.textContent = w.ip;
        const br = document.createElement('br');
        const small = document.createElement('small');
        small.textContent = w.description || '';

        div.appendChild(strong);
        div.appendChild(br);
        div.appendChild(small);

        const btn = document.createElement('button');
        btn.className = 'btn btn-sm btn-outline-danger py-0';
        btn.textContent = t('remove');
        btn.onclick = () => removeWhitelist(w.id);

        li.appendChild(div);
        li.appendChild(btn);
        whitelistList.appendChild(li);
    });

    // Render Client Logs
    const clientLogBody = document.getElementById('client-logs-tbody');
    clientLogBody.innerHTML = '';
    if (clientLogs.length === 0) {
        clientLogBody.innerHTML = `<tr><td colspan="4" class="text-center text-muted">${t('noLogs')}</td></tr>`;
    } else {
        clientLogs.forEach(log => {
            const tr = document.createElement('tr');
            tr.className = log.level === 'error' ? 'table-danger' : '';

            const tdDate = document.createElement('td');
            tdDate.textContent = new Date(log.timestamp * 1000).toLocaleString();

            const tdLevel = document.createElement('td');
            tdLevel.textContent = log.level;

            const tdMessage = document.createElement('td');
            tdMessage.textContent = log.message;

            const tdStack = document.createElement('td');
            const small = document.createElement('small');
            small.textContent = log.stack || log.user_agent || '';
            tdStack.appendChild(small);

            tr.appendChild(tdDate);
            tr.appendChild(tdLevel);
            tr.appendChild(tdMessage);
            tr.appendChild(tdStack);

            clientLogBody.appendChild(tr);
        });
    }

  } catch(e) {
    console.error('Security load error:', e);
  }
}

async function clearSecurityLogs() {
    if(!confirm(t('confirmClearLogs'))) return;
    try {
        await fetchJSON('/api/security/logs', {method: 'DELETE'});
        loadSecurity();
    } catch(e) { alert(e.message); }
}

async function clearClientLogs() {
    if(!confirm(t('confirmClearLogs'))) return;
    try {
        await fetchJSON('/api/client-logs', {method: 'DELETE'});
        loadSecurity();
    } catch(e) { alert(e.message); }
}

async function unblockIp(id) {
    if(!confirm(t('confirmUnblock'))) return;
    try {
        await fetchJSON(`/api/security/block/${id}`, {method: 'DELETE'});
        loadSecurity();
    } catch(e) { alert(e.message); }
}

async function removeWhitelist(id) {
    if(!confirm(t('confirmRemoveWhitelist'))) return;
    try {
        await fetchJSON(`/api/security/whitelist/${id}`, {method: 'DELETE'});
        loadSecurity();
    } catch(e) { alert(e.message); }
}

async function prunePiconCache() {
    if (!confirm(t('confirmPrunePicons'))) return;
    try {
        const res = await fetchJSON('/api/proxy/picons', { method: 'DELETE' });
        alert(t('piconsPrunedSuccess', {count: res.deleted}));
    } catch (e) {
        alert(t('errorPrefix') + ' ' + e.message);
    }
}

async function loadStatistics() {
  try {
    const data = await fetchJSON('/api/statistics');
    updateStatsCounters('streams', data.active_streams.length);

    // Active Streams
    const activeTbody = document.getElementById('active-streams-tbody');
    const badge = document.getElementById('active-stream-count');
    if(badge) badge.textContent = data.active_streams.length;

    activeTbody.innerHTML = '';
    if (data.active_streams.length === 0) {
        activeTbody.innerHTML = `<tr><td colspan="4" class="text-center text-muted">${t('noResults', {search: ''})}</td></tr>`;
    } else {
        data.active_streams.forEach(s => {
            const tr = document.createElement('tr');
            tr.innerHTML = `
                <td>${escapeHtml(s.username)}</td>
                <td>${escapeHtml(s.channel_name)}</td>
                <td>${formatDuration(s.duration)}</td>
                <td>${escapeHtml(s.ip || '-')}</td>
            `;
            activeTbody.appendChild(tr);
        });
    }

    // Top Channels
    const topTbody = document.getElementById('top-channels-tbody');
    topTbody.innerHTML = '';

    if (data.top_channels.length === 0) {
        topTbody.innerHTML = `<tr><td colspan="4" class="text-center text-muted">${t('noResults', {search: ''})}</td></tr>`;
    } else {
        data.top_channels.forEach((ch, idx) => {
            const tr = document.createElement('tr');
            const lastDate = ch.last_viewed ? new Date(ch.last_viewed * 1000).toLocaleString() : '-';

            const tdIndex = document.createElement('td');
            tdIndex.textContent = idx + 1;

            const tdName = document.createElement('td');
            if (ch.logo) {
                const img = document.createElement('img');
                img.src = getProxiedUrl(ch.logo);
                img.alt = ch.name;
                img.width = 20;
                img.className = 'me-1';
                img.dataset.onError = 'hide'; // Handled by global listener
                tdName.appendChild(img);
            }
            const nameSpan = document.createElement('span');
            nameSpan.textContent = ch.name;
            nameSpan.title = ch.name;
            tdName.appendChild(nameSpan);

            const tdViews = document.createElement('td');
            tdViews.textContent = ch.views;

            const tdDate = document.createElement('td');
            tdDate.textContent = lastDate;

            tr.appendChild(tdIndex);
            tr.appendChild(tdName);
            tr.appendChild(tdViews);
            tr.appendChild(tdDate);

            topTbody.appendChild(tr);
        });
    }
  } catch(e) {
    console.error('Stats error:', e);
  }
}

async function resetStatistics() {
    if (!confirm(t('confirmResetStats') || 'Reset all statistics?')) return;

    const btn = document.getElementById('reset-stats-btn');
    if(btn) setLoadingState(btn, true, 'resetting');

    try {
        await fetchJSON('/api/statistics/reset', { method: 'POST' });
        loadStatistics();
        showToast(t('statsResetSuccess') || 'Statistics reset successfully', 'success');
    } catch(e) {
        alert(t('errorPrefix') + ' ' + e.message);
    } finally {
        if(btn) setLoadingState(btn, false);
    }
}

function formatDuration(sec) {
    if (!sec) return `0${t('time_s')}`;
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = Math.floor(sec % 60);
    if (h > 0) return `${h}${t('time_h')} ${m}${t('time_m')}`;
    return `${m}${t('time_m')} ${s}${t('time_s')}`;
}

// === EPG Mapping Logic ===
let epgMappingChannels = [];
let availableEpgChannels = [];
let isLoadingEpgChannels = false;
let epgMappingMode = 'provider'; // 'provider' or 'category'

function renderEpgMappingControls() {
    const isAdmin = currentUser && currentUser.is_admin;
    const providerContainer = document.getElementById('epg-mapping-provider-container');
    const categoryContainer = document.getElementById('epg-mapping-category-container');
    const switcher = document.getElementById('epg-mode-switcher');

    // Switcher Visibility
    if (switcher) {
        if (isAdmin) switcher.classList.remove('d-none');
        else switcher.classList.add('d-none');
    }

    // Force mode for non-admin
    if (!isAdmin) epgMappingMode = 'category';

    // Show/Hide Containers
    if (epgMappingMode === 'provider') {
        if (providerContainer) providerContainer.classList.remove('d-none');
        if (categoryContainer) categoryContainer.classList.add('d-none');
        loadEpgMappingProviders();
    } else {
        if (providerContainer) providerContainer.classList.add('d-none');
        if (categoryContainer) categoryContainer.classList.remove('d-none');

        // User Select Visibility (Admin only)
        const userSelectContainer = document.getElementById('epg-category-user-select-container');
        if (userSelectContainer) userSelectContainer.style.display = isAdmin ? 'block' : 'none';

        loadEpgMappingUsersAndCategories();
    }

    // Clear table
    document.getElementById('epg-mapping-tbody').innerHTML = `<tr><td colspan="5" class="text-center p-4 text-muted">${t('select_options_to_load')}</td></tr>`;
    epgMappingChannels = [];
    updateMappingStats();
}

async function loadEpgMappingProviders() {
  const providers = await fetchJSON('/api/providers');
  const select = document.getElementById('epg-mapping-provider-select');
  if(!select) return;
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

async function loadEpgMappingUsersAndCategories() {
    const userSelect = document.getElementById('epg-mapping-user-select');
    const catSelect = document.getElementById('epg-mapping-category-select');
    const isAdmin = currentUser && currentUser.is_admin;

    // Populate Users if Admin
    if (isAdmin && userSelect && userSelect.children.length === 0) {
        const users = await fetchJSON('/api/users');
        userSelect.innerHTML = `<option value="">${t('selectUserPlaceholder')}</option>`;
        users.forEach(u => {
            const opt = document.createElement('option');
            opt.value = u.id;
            opt.textContent = u.username;
            userSelect.appendChild(opt);
        });

        // Auto-select first user or current selection logic if needed
        // For now, let admin select manually.
        userSelect.onchange = () => loadEpgCategoriesForMapping(userSelect.value);
    } else if (!isAdmin) {
        // Non-admin: Load categories for self immediately
        loadEpgCategoriesForMapping(currentUser.id);
    }
}

async function loadEpgCategoriesForMapping(userId) {
    const catSelect = document.getElementById('epg-mapping-category-select');
    if (!catSelect) return;

    catSelect.innerHTML = `<option value="">${t('loading')}</option>`;

    if (!userId) {
        catSelect.innerHTML = `<option value="">${t('selectUserFirst')}</option>`;
        return;
    }

    try {
        const cats = await fetchJSON(`/api/users/${userId}/categories`);
        catSelect.innerHTML = `<option value="">${t('selectCategoryPlaceholder')}</option>`;

        const liveCats = cats.filter(c => !c.type || c.type === 'live');

        liveCats.forEach(c => {
            const opt = document.createElement('option');
            opt.value = c.id;
            opt.textContent = c.name;
            catSelect.appendChild(opt);
        });
    } catch(e) {
        catSelect.innerHTML = `<option value="">${t('error')}</option>`;
    }
}

async function loadEpgMappingChannels() {
  const tbody = document.getElementById('epg-mapping-tbody');
  const autoMapBtn = document.getElementById('auto-map-btn');
  const resetMapBtn = document.getElementById('reset-map-btn');

  // Determine source based on mode
  if (epgMappingMode === 'provider') {
      const providerId = document.getElementById('epg-mapping-provider-select').value;
      if (!providerId) return; // Wait for selection

      renderLoadingTable('epg-mapping-tbody', 5);
      if(autoMapBtn) autoMapBtn.disabled = true;
      if(resetMapBtn) resetMapBtn.disabled = true;

      try {
        const [channels, mappings] = await Promise.all([
          fetchJSON(`/api/providers/${providerId}/channels?type=live`),
          fetchJSON(`/api/mapping/${providerId}`)
        ]);

        epgMappingChannels = channels.map(ch => ({
          ...ch,
          current_epg_id: ch.epg_channel_id,
          manual_epg_id: mappings[ch.id] || null
        }));

        finishLoadingMapping();
      } catch (e) {
        tbody.innerHTML = `<tr><td colspan="5" class="text-center p-4 text-danger">${t('errorPrefix')} ${e.message}</td></tr>`;
      }
  } else {
      // Category Mode
      const catSelect = document.getElementById('epg-mapping-category-select');
      const catId = catSelect.value;
      if (!catId) return;

      renderLoadingTable('epg-mapping-tbody', 5);

      // Disable buttons while loading
      if(autoMapBtn) autoMapBtn.disabled = true;
      if(resetMapBtn) resetMapBtn.disabled = true;

      try {
          const channels = await fetchJSON(`/api/user-categories/${catId}/channels`);
          epgMappingChannels = channels.map(ch => ({
              id: ch.id,
              name: ch.name,
              logo: ch.logo,
              current_epg_id: ch.epg_channel_id,
              manual_epg_id: ch.manual_epg_id || null
          }));

          finishLoadingMapping();
      } catch(e) {
          tbody.innerHTML = `<tr><td colspan="5" class="text-center p-4 text-danger">${t('errorPrefix')} ${e.message}</td></tr>`;
      }
  }
}

function finishLoadingMapping() {
    renderEpgMappingChannels();
    updateMappingStats();
    loadAvailableEpgChannels();

    const autoMapBtn = document.getElementById('auto-map-btn');
    const resetMapBtn = document.getElementById('reset-map-btn');

    // Enable buttons if we have a valid selection (provider or category)
    if (autoMapBtn) {
        autoMapBtn.disabled = false;
        autoMapBtn.classList.remove('d-none');
    }
    if (resetMapBtn) {
        resetMapBtn.disabled = false;
        resetMapBtn.classList.remove('d-none');
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

    // Escape all user data
    const safeName = escapeHtml(ch.name);
    const safeManualId = ch.manual_epg_id ? escapeHtml(ch.manual_epg_id) : null;
    const safeCurrentId = ch.current_epg_id ? escapeHtml(ch.current_epg_id) : null;

    const displayEpgId = safeManualId || safeCurrentId || '<span class="text-muted">-</span>';
    const manualDisplay = safeManualId ? `<b>${safeManualId}</b>` : '<span class="text-muted">-</span>';

    tr.innerHTML = `
      <td>${idx + 1}</td>
      <td>
        <div class="d-flex align-items-center">
          ${ch.logo ? `<img src="${getProxiedUrl(ch.logo)}" alt="${safeName}" width="24" height="24" class="me-2" data-on-error="hide">` : ''}
          <span title="${safeName}">${safeName}</span>
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
    stats.textContent = t('mappingStats', {
        total: total,
        mapped: mapped,
        percent: total > 0 ? Math.round(mapped/total*100) : 0,
        manual: manual
    });
  }
}

async function loadAvailableEpgChannels() {
  if (isLoadingEpgChannels) return;
  isLoadingEpgChannels = true;
  try {
    availableEpgChannels = await fetchJSON('/api/epg/channels');
  } catch (e) {
    console.error('Failed to load EPG channels', e);
    showToast(t('errorPrefix') + ' ' + e.message, 'danger');
  } finally {
    isLoadingEpgChannels = false;
    // If modal is open, refresh the list
    const modalEl = document.getElementById('epg-select-modal');
    if (modalEl && modalEl.classList.contains('show')) {
        filterEpgSelectionList();
    }
  }
}

// === Auto Mapping ===
async function handleAutoMap() {
  let providerId, categoryId;
  if (epgMappingMode === 'provider') {
      providerId = document.getElementById('epg-mapping-provider-select').value;
      if (!providerId) return;
  } else {
      categoryId = document.getElementById('epg-mapping-category-select').value;
      if (!categoryId) return;
  }

  if (!confirm(t('autoMapConfirm'))) return;

  const btn = document.getElementById('auto-map-btn');
  setLoadingState(btn, true, 'autoMap');

  const onlyUsed = document.getElementById('epg-only-used') ? document.getElementById('epg-only-used').checked : false;

  try {
    const res = await fetchJSON('/api/mapping/auto', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({
          provider_id: providerId,
          category_id: categoryId,
          only_used: onlyUsed
      })
    });

    alert(t('autoMapSuccess', {count: res.matched}));
    loadEpgMappingChannels();
  } catch (e) {
    alert(t('errorPrefix') + ' ' + e.message);
  } finally {
    setLoadingState(btn, false);
  }
}

async function handleResetMapping() {
  let providerId, categoryId;
  if (epgMappingMode === 'provider') {
      providerId = document.getElementById('epg-mapping-provider-select').value;
      if (!providerId) return;
  } else {
      categoryId = document.getElementById('epg-mapping-category-select').value;
      if (!categoryId) return;
  }

  if (!confirm(t('resetMappingConfirm'))) return;

  const btn = document.getElementById('reset-map-btn');
  setLoadingState(btn, true, 'resetMapping');

  try {
    await fetchJSON('/api/mapping/reset', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({
          provider_id: providerId,
          category_id: categoryId
      })
    });

    alert(t('resetMappingSuccess'));
    await loadEpgMappingChannels();
  } catch (e) {
    alert(t('errorPrefix') + ' ' + e.message);
  } finally {
    setLoadingState(btn, false);
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

  if (isLoadingEpgChannels) {
    list.innerHTML = `<li class="list-group-item text-center text-muted py-3">
      <span class="spinner-border spinner-border-sm me-2" role="status" aria-hidden="true"></span>
      ${t('loading')}
    </li>`;
    return;
  }

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
    const safeName = escapeHtml(epg.name);
    const safeId = escapeHtml(epg.id);
    const safeSource = epg.source_type ? `<span class="badge bg-secondary ms-2">${escapeHtml(epg.source_type)}</span>` : '';

    li.innerHTML = `
      <div class="d-flex justify-content-between align-items-center">
        <div>
          <strong>${safeName}</strong> ${safeSource} <br>
          <small class="text-muted">${safeId}</small>
        </div>
        ${epg.logo ? `<img src="${getProxiedUrl(epg.logo)}" alt="${safeName}" height="30" data-on-error="hide">` : ''}
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
    const res = await fetchJSON('/api/verify-token');
    currentUser = res.user;
    
    // Apply role-based UI
    if (currentUser.force_password_change) {
        showChangePasswordModal();
        alert(t('force_password_change') || 'You must change your password immediately.');
        // Do NOT show main UI
        return true;
    }

    applyPermissions();

    // Show the main UI if token is valid
    document.getElementById('main-navbar').classList.remove('d-none');
    document.getElementById('main-content').classList.remove('d-none');
    
    loadUsers();
    loadProviders();
    loadEpgSources();

    if (globalStatsInterval) clearInterval(globalStatsInterval);
    globalStatsInterval = setInterval(updateDashboardCounters, 15000);
    updateDashboardCounters();

    return true;
  } catch {
    removeToken();
    showLoginModal();
    return false;
  }
}

function applyPermissions() {
    if (!currentUser) return;
    const isAdmin = currentUser.is_admin;

    // Hide EPG "Only used" checkbox for non-admins
    const onlyUsedContainer = document.getElementById('only-used-container');
    if (onlyUsedContainer) {
        if (isAdmin) onlyUsedContainer.classList.remove('d-none');
        else onlyUsedContainer.classList.add('d-none');
    }

    // Hide Add User form
    const userForm = document.getElementById('user-form');
    if (userForm) {
        userForm.style.display = isAdmin ? 'flex' : 'none';
    }

    // Hide Navigation Items
    const idsToHide = ['nav-statistics', 'nav-security', 'nav-import-export'];
    idsToHide.forEach(id => {
        const el = document.getElementById(id);
        if (el) el.parentElement.style.display = isAdmin ? 'block' : 'none';
    });

    // Hide Stats Bar
    const statsBar = document.getElementById('dashboard-stats-bar');
    if (statsBar) {
        statsBar.style.display = isAdmin ? 'flex' : 'none';
    }

    // Hide EPG Sources Card
    const epgCard = document.getElementById('epg-sources-card');
    if (epgCard) {
        epgCard.style.display = isAdmin ? 'block' : 'none';
    }
}

async function handleLogin(event) {
  event.preventDefault();
  
  const username = document.getElementById('login-username').value;
  const password = document.getElementById('login-password').value;
  const otpCode = document.getElementById('login-otp').value;
  const loginBtn = document.getElementById('login-btn');
  const errorDiv = document.getElementById('login-error');
  const otpGroup = document.getElementById('login-otp-group');
  
  if (!username || !password) {
    errorDiv.textContent = t('missing_credentials');
    errorDiv.classList.remove('d-none');
    return;
  }
  
  setLoadingState(loginBtn, true, 'logging_in');
  errorDiv.classList.add('d-none');
  
  try {
    const body = { username, password };
    if (otpCode) body.otp_code = otpCode;

    const response = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    
    const data = await response.json();

    if (response.status === 401 && data.require_otp) {
        // Show OTP field
        otpGroup.classList.remove('d-none');
        document.getElementById('login-otp').focus();
        // Hide error if any previous
        errorDiv.classList.add('d-none');
        // Allow retry
        throw new Error('otp_required'); // Custom error to stop flow but keep UI open
    }

    if (!response.ok) {
      throw new Error(data.error || 'login_failed');
    }
    
    setToken(data.token);
    currentUser = data.user;
    
    hideLoginModal();

    if (currentUser.force_password_change) {
        showChangePasswordModal();
        // Force the modal to be non-closable or just persistent
        alert(t('force_password_change') || 'You must change your password immediately.');
        return;
    }

    applyPermissions();
    
    // Show the main UI after successful login
    document.getElementById('main-navbar').classList.remove('d-none');
    document.getElementById('main-content').classList.remove('d-none');
    
    loadUsers();
    loadProviders();
    loadEpgSources();
    
    if (globalStatsInterval) clearInterval(globalStatsInterval);
    globalStatsInterval = setInterval(updateDashboardCounters, 15000);
    updateDashboardCounters();

    // Clear form
    document.getElementById('login-username').value = '';
    document.getElementById('login-password').value = '';
    document.getElementById('login-otp').value = '';
    otpGroup.classList.add('d-none');
    
  } catch (error) {
    if (error.message === 'otp_required') {
       // Just stop, UI is updated
    } else {
       errorDiv.textContent = t(error.message) || t('login_failed');
       errorDiv.classList.remove('d-none');
    }
  } finally {
    setLoadingState(loginBtn, false);
  }
}

// === OTP Functions ===
async function showOtpModal() {
    const modal = new bootstrap.Modal(document.getElementById('otp-modal'));
    modal.show();

    // Reset UI
    document.getElementById('otp-setup-step-1').classList.add('d-none');
    document.getElementById('otp-status-active').classList.add('d-none');
    document.getElementById('otp-verify-input').value = '';

    if (currentUser && currentUser.otp_enabled) {
        document.getElementById('otp-status-active').classList.remove('d-none');
    } else {
        document.getElementById('otp-setup-step-1').classList.remove('d-none');
        // Generate new secret
        try {
            const res = await fetchJSON('/api/auth/otp/generate', { method: 'POST' });
            const img = document.getElementById('otp-qr-code');
            img.src = res.qrCodeUrl;
            img.classList.remove('d-none');
            document.getElementById('otp-secret-text').textContent = `Secret: ${res.secret}`;
            document.getElementById('otp-modal').dataset.secret = res.secret;
        } catch(e) {
            alert(t('errorPrefix') + ' ' + e.message);
        }
    }
}

async function verifyAndEnableOtp() {
    const token = document.getElementById('otp-verify-input').value;
    const secret = document.getElementById('otp-modal').dataset.secret;

    if (!token || !secret) return;

    try {
        await fetchJSON('/api/auth/otp/verify', {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({ token, secret })
        });

        alert(t('2fa_enabled_success') || '2FA Enabled Successfully');
        currentUser.otp_enabled = true;

        // Hide modal
        bootstrap.Modal.getInstance(document.getElementById('otp-modal')).hide();
    } catch(e) {
        alert(t('errorPrefix') + ' ' + e.message);
    }
}

async function disableOtp() {
    if (!confirm(t('confirm_disable_2fa') || 'Disable 2FA?')) return;

    try {
        await fetchJSON('/api/auth/otp/disable', { method: 'POST' });
        currentUser.otp_enabled = false;
        // Hide modal
        bootstrap.Modal.getInstance(document.getElementById('otp-modal')).hide();
        alert(t('2fa_disabled_success') || '2FA Disabled');
    } catch(e) {
        alert(t('errorPrefix') + ' ' + e.message);
    }
}

function handleLogout() {
  removeToken();
  selectedUser = null;
  selectedUserId = null;
  selectedCategoryId = null;
  
  if (globalStatsInterval) {
      clearInterval(globalStatsInterval);
      globalStatsInterval = null;
  }

  // Hide the main UI when logging out
  document.getElementById('main-navbar').classList.add('d-none');
  document.getElementById('main-content').classList.add('d-none');
  
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
    document.getElementById('change-password-error').classList.add('d-none');
    document.getElementById('change-password-success').classList.add('d-none');
    
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
  errorDiv.classList.add('d-none');
  successDiv.classList.add('d-none');
  
  // Validate passwords match
  if (newPassword !== confirmPassword) {
    errorDiv.textContent = t('passwords_dont_match');
    errorDiv.classList.remove('d-none');
    return;
  }
  
  // Validate password length
  if (newPassword.length < 8) {
    errorDiv.textContent = t('password_too_short');
    errorDiv.classList.remove('d-none');
    return;
  }
  
  setLoadingState(changePasswordBtn, true, 'changing_password');
  
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
    successDiv.classList.remove('d-none');
    
    // Clear form
    document.getElementById('old-password').value = '';
    document.getElementById('new-password').value = '';
    document.getElementById('confirm-password').value = '';
    
    // Close modal after 2 seconds
    setTimeout(() => {
      const modal = bootstrap.Modal.getInstance(document.getElementById('change-password-modal'));
      if (modal) modal.hide();

      // If this was forced, now we can show the UI
      if (currentUser && currentUser.force_password_change) {
          currentUser.force_password_change = false; // Optimistic update
          applyPermissions();
          document.getElementById('main-navbar').classList.remove('d-none');
          document.getElementById('main-content').classList.remove('d-none');
          loadUsers();
          loadProviders();
          loadEpgSources();
      }
    }, 2000);
    
  } catch (error) {
    errorDiv.textContent = t(error.message) || t('change_password_failed');
    errorDiv.classList.remove('d-none');
  } finally {
    setLoadingState(changePasswordBtn, false);
  }
}

function updateChanBulkDeleteBtn() {
    const count = globalSelectedChannels.size;
    const btn = document.getElementById('chan-bulk-delete-btn');
    const shareBtn = document.getElementById('chan-bulk-share-btn');

    if (btn) {
        if (count > 0) btn.classList.remove('d-none');
        else btn.classList.add('d-none');
        btn.textContent = `${t('deleteSelected')} (${count})`;
    }

    if (shareBtn) {
        shareBtn.textContent = editingShareToken ? t('updateShare') : t('share');
    }
}

function updateCatBulkDeleteBtn() {
    const count = document.querySelectorAll('.user-cat-check:checked').length;
    const btn = document.getElementById('cat-bulk-delete-btn');
    if (btn) {
        if (count > 0) btn.classList.remove('d-none');
        else btn.classList.add('d-none');
        btn.textContent = `${t('deleteSelected')} (${count})`;
    }
}

function showToast(message, type = 'primary') {
    const container = document.getElementById('toast-container');
    if (!container) return;

    // Map types to icons
    const icons = {
        success: '✅',
        danger: '⚠️',
        warning: '⚠️',
        info: 'ℹ️',
        primary: 'ℹ️'
    };
    const icon = icons[type] || '';

    const el = document.createElement('div');
    el.className = `toast align-items-center text-white bg-${type} border-0 shadow-lg`;
    el.setAttribute('role', 'alert');
    el.setAttribute('aria-live', 'assertive');
    el.setAttribute('aria-atomic', 'true');

    el.innerHTML = `
        <div class="d-flex">
            <div class="toast-body d-flex align-items-center gap-2">
                ${icon ? `<span class="fs-5">${icon}</span>` : ''}
                <div>${message}</div>
            </div>
            <button type="button" class="btn-close btn-close-white me-2 m-auto" data-bs-dismiss="toast" aria-label="Close"></button>
        </div>
    `;

    container.appendChild(el);
    const toast = new bootstrap.Toast(el, { delay: 5000 });
    toast.show();

    el.addEventListener('hidden.bs.toast', () => {
        el.remove();
    });
}

// === Share Logic ===
function openShareModal() {
    // If not editing, ensure there is a selection
    if (!editingShareToken && globalSelectedChannels.size === 0) {
        alert(t('noSelection'));
        return;
    }

    const modal = new bootstrap.Modal(document.getElementById('share-modal'));
    const cancelBtn = document.getElementById('cancel-share-edit-btn');

    // Set UI state based on editing mode
    if (!editingShareToken) {
        document.getElementById('share-form').reset();
        const btn = document.getElementById('create-share-btn');
        if (btn) btn.textContent = t('createLink') || 'Create Link';
        if (cancelBtn) cancelBtn.classList.add('d-none');
    } else {
        const btn = document.getElementById('create-share-btn');
        if (btn) btn.textContent = t('updateShare') || 'Update Link';
        if (cancelBtn) {
            cancelBtn.classList.remove('d-none');
            cancelBtn.onclick = cancelEditShare;
        }
    }

    const selectedCount = globalSelectedChannels.size;
    document.getElementById('share-result').classList.add('d-none');
    document.getElementById('share-channel-count').textContent = `${selectedCount} channels`;
    document.getElementById('create-share-btn').classList.remove('d-none');

    modal.show();
}

// Add event listener for create button if not exists
const createShareBtn = document.getElementById('create-share-btn');
if (createShareBtn) {
    createShareBtn.addEventListener('click', createShare);
}

// Add event listener for banner cancel button
const bannerCancelBtn = document.getElementById('banner-cancel-edit-btn');
if (bannerCancelBtn) {
    bannerCancelBtn.addEventListener('click', cancelEditShare);
}

async function createShare() {
    // Use the current global selection
    const selected = Array.from(globalSelectedChannels);
    const name = document.getElementById('share-name').value;
    const start = document.getElementById('share-start-time').value;
    const end = document.getElementById('share-end-time').value;
    const createSlug = document.getElementById('share-create-slug') ? document.getElementById('share-create-slug').checked : false;
    const btn = document.getElementById('create-share-btn');

    setLoadingState(btn, true, editingShareToken ? 'saving' : 'creating');

    try {
        // Fix timezone: Send ISO string (UTC) to backend
        let startTime = start ? new Date(start).toISOString() : null;
        let endTime = end ? new Date(end).toISOString() : null;

        const body = {
            channels: selected,
            name: name,
            start_time: startTime,
            end_time: endTime,
            create_slug: createSlug
        };
        if (selectedUserId) body.user_id = selectedUserId;

        let res;
        if (editingShareToken) {
             res = await fetchJSON(`/api/shares/${editingShareToken}`, {
                method: 'PUT',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify(body)
            });

            // Success - Reset state (which closes modal)
            cancelEditShare();

            // Re-open shares list
            setTimeout(showSharesList, 500);

        } else {
             res = await fetchJSON('/api/shares', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify(body)
            });

            document.getElementById('share-link-output').value = res.link;
            if (res.short_link) {
                // If we have a short link, append it or show it.
                // For simplicity, let's append it to the message or replace value if preferred.
                // Let's replace the value to show the short link primarily, or show both?
                // The UI has one input. Let's show the short link if available as it's nicer.
                document.getElementById('share-link-output').value = res.short_link;
            }
            document.getElementById('share-result').classList.remove('d-none');
            btn.classList.add('d-none');

            // Clear selection on success
            globalSelectedChannels.clear();
            updateChanBulkDeleteBtn();
        }

    } catch(e) {
        alert(t('errorPrefix') + ' ' + e.message);
    } finally {
        setLoadingState(btn, false);
    }
}

async function showSharesList() {
    const modal = new bootstrap.Modal(document.getElementById('shares-list-modal'));
    modal.show();
    loadSharesList();
}

async function loadSharesList() {
    const tbody = document.getElementById('shares-list-tbody');
    tbody.innerHTML = `<tr><td colspan="5" class="text-center text-muted">${t('loading')}</td></tr>`;

    try {
        let url = '/api/shares';
        if (selectedUserId) url += `?user_id=${selectedUserId}`;

        const shares = await fetchJSON(url);
        tbody.innerHTML = '';

        if (shares.length === 0) {
            tbody.innerHTML = `<tr><td colspan="5" class="text-center text-muted">${t('noResults', {search: ''})}</td></tr>`;
            return;
        }

        shares.forEach(s => {
            const tr = document.createElement('tr');
            const startStr = s.start_time ? new Date(s.start_time * 1000).toLocaleString() : 'Now';
            const endStr = s.end_time ? new Date(s.end_time * 1000).toLocaleString() : 'Never';

            tr.innerHTML = `
                <td>${s.name || '-'}</td>
                <td>${s.channel_count}</td>
                <td>${startStr}<br>↓<br>${endStr}</td>
                <td>
                    <div class="input-group input-group-sm" style="max-width: 200px;">
                       <input class="form-control" value="${s.short_link || s.link}" readonly>
                       <button class="btn btn-outline-secondary" data-copy-text="${s.short_link || s.link}" title="${t('copyToClipboardAction')}" aria-label="${t('copyToClipboardAction')}">📋</button>
                    </div>
                </td>
                <td>
                    <button class="btn btn-sm btn-outline-secondary me-1" data-action="action-edit-share" data-share='${JSON.stringify(s).replace(/'/g, "&#39;")}' title="${t('updateShare')}" aria-label="${t('updateShare')}">✏️</button>
                    <button class="btn btn-sm btn-outline-danger" data-action="action-delete-share" data-token="${s.token}" title="${t('deleteAction')}" aria-label="${t('deleteAction')}">🗑</button>
                </td>
            `;
            tbody.appendChild(tr);
        });

    } catch(e) {
        tbody.innerHTML = `<tr><td colspan="5" class="text-center text-danger">${e.message}</td></tr>`;
    }
}

window.editShare = function(s) {
    editingShareToken = s.token;
    globalSelectedChannels.clear();
    try {
        const channels = JSON.parse(s.channels || '[]');
        channels.forEach(id => globalSelectedChannels.add(id));
    } catch(e) {}

    // Fill form
    document.getElementById('share-name').value = s.name || '';

    // Date inputs expect "YYYY-MM-DDTHH:mm"
    if (s.start_time) {
        const d = new Date(s.start_time * 1000);
        d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
        document.getElementById('share-start-time').value = d.toISOString().slice(0, 16);
    } else {
        document.getElementById('share-start-time').value = '';
    }

    if (s.end_time) {
        const d = new Date(s.end_time * 1000);
        d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
        document.getElementById('share-end-time').value = d.toISOString().slice(0, 16);
    } else {
        document.getElementById('share-end-time').value = '';
    }

    // Hide list modal
    const listModal = bootstrap.Modal.getInstance(document.getElementById('shares-list-modal'));
    if (listModal) listModal.hide();

    // Show Banner
    const banner = document.getElementById('editing-share-banner');
    if (banner) {
        banner.classList.remove('d-none');
        const nameSpan = document.getElementById('editing-share-name-display');
        if (nameSpan) nameSpan.textContent = s.name || 'Untitled';
    }

    // Update Main Share Button
    const shareBtn = document.getElementById('chan-bulk-share-btn');
    if (shareBtn) {
        shareBtn.classList.remove('d-none');
    }

    updateChanBulkDeleteBtn(); // To refresh button visibility/text based on populated channels
    loadUserCategoryChannels(); // Refresh checkmarks if we are in view

    // Open share modal to show metadata
    openShareModal();
};

function cancelEditShare() {
    editingShareToken = null;
    globalSelectedChannels.clear();

    // Hide Banner
    const banner = document.getElementById('editing-share-banner');
    if (banner) banner.classList.add('d-none');

    // Reset Share Button
    const shareBtn = document.getElementById('chan-bulk-share-btn');
    if (shareBtn) shareBtn.textContent = t('share');

    // Close Share Modal if open
    const modalEl = document.getElementById('share-modal');
    const modal = bootstrap.Modal.getInstance(modalEl);
    if (modal) modal.hide();

    updateChanBulkDeleteBtn();
    loadUserCategoryChannels(); // Refresh checkmarks
}

window.deleteShare = async function(token) {
    if (!confirm(t('confirmDeleteShare'))) return;
    try {
        await fetchJSON(`/api/shares/${token}`, {method: 'DELETE'});
        loadSharesList();
    } catch(e) {
        alert(e.message);
    }
};
