// ── Storage helpers ──────────────────────────────────────────────
const load = (key, fallback) => {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
};
const save = (key, val) => localStorage.setItem(key, JSON.stringify(val));

// ── State ────────────────────────────────────────────────────────
let clients      = load('dash_clients', []);
let checkItems   = load('dash_checklist', []);
let groups       = load('dash_groups', []);
let checkState   = load('dash_check_state', {});  // { id: bool }
let groupState   = load('dash_group_state', {});  // { id: bool }
let lastCheckDay = load('dash_check_day', '');
let lastGroupDay = load('dash_group_day', '');
let clientFilter = 'all';
let editingClientId = null;

// ── Date ─────────────────────────────────────────────────────────
const todayStr = () => new Date().toISOString().slice(0, 10);

document.getElementById('today-date').textContent = new Date().toLocaleDateString('en-US', {
  weekday: 'long', month: 'long', day: 'numeric', year: 'numeric'
});

// Auto-reset check state if it's a new day
if (lastCheckDay !== todayStr()) {
  checkState = {};
  save('dash_check_state', {});
  save('dash_check_day', todayStr());
}
if (lastGroupDay !== todayStr()) {
  groupState = {};
  save('dash_group_state', {});
  save('dash_group_day', todayStr());
}

// ── ID generator ─────────────────────────────────────────────────
const uid = () => Math.random().toString(36).slice(2, 10);

// ── Tab switching ────────────────────────────────────────────────
document.querySelectorAll('.tab').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById('tab-' + btn.dataset.tab).classList.add('active');
  });
});

// ── Filter buttons ───────────────────────────────────────────────
document.querySelectorAll('.filter-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    clientFilter = btn.dataset.filter;
    renderClients();
  });
});

// ── Modal helpers ────────────────────────────────────────────────
function openModal(id) {
  document.getElementById(id).classList.add('open');
}
function closeModal(id) {
  document.getElementById(id).classList.remove('open');
}
function closeModalOnOverlay(e, id) {
  if (e.target === e.currentTarget) closeModal(id);
}

// ── CLIENTS ──────────────────────────────────────────────────────
function renderClients() {
  const grid = document.getElementById('clients-grid');
  const filtered = clientFilter === 'all' ? clients : clients.filter(c => c.status === clientFilter);

  if (filtered.length === 0) {
    grid.innerHTML = `<div class="empty-state">
      <div class="emoji">📋</div>
      <p>${clientFilter === 'all' ? 'No clients yet — add your first one!' : 'No clients with this status.'}</p>
    </div>`;
    return;
  }

  grid.innerHTML = filtered.map(c => {
    const badgeClass = 'badge-' + c.status;
    const cardClass  = 'status-' + c.status;
    const dueStr     = c.due ? `📅 ${formatDate(c.due)}` : '';
    const rateStr    = c.rate ? `💰 ${c.rate}` : '';
    return `
    <div class="client-card ${cardClass}">
      <div class="client-card-header">
        <div>
          <div class="client-name">${esc(c.name)}</div>
          ${c.platform ? `<div class="client-platform">${esc(c.platform)}${c.contentType ? ' · ' + esc(c.contentType) : ''}</div>` : ''}
        </div>
        <div class="client-actions">
          <button class="btn-icon" title="Edit" onclick="editClient('${c.id}')">✏️</button>
          <button class="btn-icon" title="Delete" onclick="deleteClient('${c.id}')">🗑️</button>
        </div>
      </div>
      <span class="status-badge ${badgeClass}">${c.status.replace('-', ' ')}</span>
      ${(dueStr || rateStr) ? `<div class="client-meta">${dueStr ? `<span>${dueStr}</span>` : ''}${rateStr ? `<span>${rateStr}</span>` : ''}</div>` : ''}
      ${c.notes ? `<div class="client-notes">${esc(c.notes)}</div>` : ''}
    </div>`;
  }).join('');
}

function saveClient(e) {
  e.preventDefault();
  const id = document.getElementById('client-id').value || uid();
  const client = {
    id,
    name:        document.getElementById('client-name').value.trim(),
    platform:    document.getElementById('client-platform').value.trim(),
    contentType: document.getElementById('client-content-type').value.trim(),
    rate:        document.getElementById('client-rate').value.trim(),
    due:         document.getElementById('client-due').value,
    status:      document.getElementById('client-status').value,
    notes:       document.getElementById('client-notes').value.trim(),
  };
  const idx = clients.findIndex(c => c.id === id);
  if (idx >= 0) clients[idx] = client; else clients.unshift(client);
  save('dash_clients', clients);
  closeModal('client-modal');
  resetClientForm();
  renderClients();
}

function editClient(id) {
  const c = clients.find(x => x.id === id);
  if (!c) return;
  document.getElementById('client-modal-title').textContent = 'Edit Client';
  document.getElementById('client-id').value           = c.id;
  document.getElementById('client-name').value         = c.name;
  document.getElementById('client-platform').value     = c.platform;
  document.getElementById('client-content-type').value = c.contentType;
  document.getElementById('client-rate').value         = c.rate;
  document.getElementById('client-due').value          = c.due;
  document.getElementById('client-status').value       = c.status;
  document.getElementById('client-notes').value        = c.notes;
  openModal('client-modal');
}

function deleteClient(id) {
  if (!confirm('Delete this client?')) return;
  clients = clients.filter(c => c.id !== id);
  save('dash_clients', clients);
  renderClients();
}

function resetClientForm() {
  document.getElementById('client-modal-title').textContent = 'Add Client';
  document.getElementById('client-form').reset();
  document.getElementById('client-id').value = '';
}

document.getElementById('client-modal').addEventListener('click', e => {
  if (e.target.id === 'client-modal') { closeModal('client-modal'); resetClientForm(); }
});

// ── CHECKLIST ────────────────────────────────────────────────────
function renderChecklist() {
  const list = document.getElementById('checklist-list');
  if (checkItems.length === 0) {
    list.innerHTML = `<li class="empty-state"><div class="emoji">✅</div><p>No tasks yet — add your daily posting routine!</p></li>`;
    updateCheckProgress();
    return;
  }
  list.innerHTML = checkItems.map(item => {
    const done = !!checkState[item.id];
    return `
    <li class="checklist-item ${done ? 'done' : ''}">
      <input type="checkbox" ${done ? 'checked' : ''} onchange="toggleCheck('${item.id}', this.checked)" />
      <div class="checklist-item-text">
        <div class="checklist-item-name">${esc(item.name)}</div>
        ${item.category ? `<div class="checklist-item-category"><span class="cat-pill">${esc(item.category)}</span></div>` : ''}
      </div>
      <button class="btn-icon" title="Delete" onclick="deleteCheckItem('${item.id}')">🗑️</button>
    </li>`;
  }).join('');
  updateCheckProgress();
}

function toggleCheck(id, checked) {
  checkState[id] = checked;
  save('dash_check_state', checkState);
  save('dash_check_day', todayStr());
  document.querySelector(`.checklist-item input[onchange*="${id}"]`)
    ?.closest('.checklist-item')?.classList.toggle('done', checked);
  updateCheckProgress();
}

function updateCheckProgress() {
  const total = checkItems.length;
  const done  = checkItems.filter(i => checkState[i.id]).length;
  const pct   = total ? (done / total) * 100 : 0;
  document.getElementById('progress-fill').style.width = pct + '%';
  document.getElementById('progress-label').textContent = `${done} / ${total} done`;
}

function saveChecklistItem(e) {
  e.preventDefault();
  const name     = document.getElementById('checklist-task-name').value.trim();
  const category = document.getElementById('checklist-category').value.trim();
  checkItems.push({ id: uid(), name, category });
  save('dash_checklist', checkItems);
  closeModal('checklist-modal');
  document.getElementById('checklist-form').reset();
  renderChecklist();
}

function deleteCheckItem(id) {
  checkItems = checkItems.filter(i => i.id !== id);
  delete checkState[id];
  save('dash_checklist', checkItems);
  save('dash_check_state', checkState);
  renderChecklist();
}

function resetChecklist() {
  checkState = {};
  save('dash_check_state', {});
  save('dash_check_day', todayStr());
  renderChecklist();
}

// ── FACEBOOK GROUPS ──────────────────────────────────────────────
function renderGroups() {
  const list = document.getElementById('groups-list');
  if (groups.length === 0) {
    list.innerHTML = `<div class="empty-state"><div class="emoji">👥</div><p>No groups yet — add your Facebook posting groups!</p></div>`;
    updateGroupProgress();
    return;
  }
  list.innerHTML = groups.map(g => {
    const posted = !!groupState[g.id];
    return `
    <div class="group-item ${posted ? 'posted' : ''}">
      <input type="checkbox" ${posted ? 'checked' : ''} onchange="toggleGroup('${g.id}', this.checked)" />
      <div class="group-info">
        <div class="group-name">${esc(g.name)}</div>
        <div class="group-meta">
          ${g.postType ? `<span>📝 ${esc(g.postType)}</span>` : ''}
          ${g.notes ? `<span>💡 ${esc(g.notes)}</span>` : ''}
          ${g.link ? `<a href="${esc(g.link)}" target="_blank" rel="noopener" class="group-link-btn">Open Group ↗</a>` : ''}
        </div>
      </div>
      <button class="btn-icon" title="Delete" onclick="deleteGroup('${g.id}')">🗑️</button>
    </div>`;
  }).join('');
  updateGroupProgress();
}

function toggleGroup(id, checked) {
  groupState[id] = checked;
  save('dash_group_state', groupState);
  save('dash_group_day', todayStr());
  document.querySelector(`.group-item input[onchange*="${id}"]`)
    ?.closest('.group-item')?.classList.toggle('posted', checked);
  updateGroupProgress();
}

function updateGroupProgress() {
  const total  = groups.length;
  const posted = groups.filter(g => groupState[g.id]).length;
  const pct    = total ? (posted / total) * 100 : 0;
  document.getElementById('groups-progress-fill').style.width = pct + '%';
  document.getElementById('groups-progress-label').textContent = `${posted} / ${total} posted`;
}

function saveGroup(e) {
  e.preventDefault();
  const g = {
    id:       uid(),
    name:     document.getElementById('group-name').value.trim(),
    link:     document.getElementById('group-link').value.trim(),
    postType: document.getElementById('group-post-type').value.trim(),
    notes:    document.getElementById('group-notes').value.trim(),
  };
  groups.push(g);
  save('dash_groups', groups);
  closeModal('group-modal');
  document.getElementById('group-form').reset();
  renderGroups();
}

function deleteGroup(id) {
  groups = groups.filter(g => g.id !== id);
  delete groupState[id];
  save('dash_groups', groups);
  save('dash_group_state', groupState);
  renderGroups();
}

function resetGroups() {
  groupState = {};
  save('dash_group_state', {});
  save('dash_group_day', todayStr());
  renderGroups();
}

// ── Utils ────────────────────────────────────────────────────────
function esc(str) {
  return String(str ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function formatDate(str) {
  if (!str) return '';
  const [y, m, d] = str.split('-');
  return new Date(y, m - 1, d).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

// ── Init ─────────────────────────────────────────────────────────
renderClients();
renderChecklist();
renderGroups();
