const elements = {
  loginView: document.querySelector('#login-view'),
  adminView: document.querySelector('#admin-view'),
  loginForm: document.querySelector('#login-form'),
  adminKey: document.querySelector('#admin-key'),
  loginError: document.querySelector('#login-error'),
  globalError: document.querySelector('#global-error'),
  range: document.querySelector('#range-select'),
  refresh: document.querySelector('#refresh-button'),
  logout: document.querySelector('#logout-button'),
  metrics: document.querySelector('#metric-grid'),
  chart: document.querySelector('#traffic-chart'),
  networks: document.querySelector('#network-rows'),
  userSearch: document.querySelector('#user-search'),
  userRows: document.querySelector('#user-rows'),
  userSummary: document.querySelector('#user-summary'),
  prevPage: document.querySelector('#prev-page'),
  nextPage: document.querySelector('#next-page'),
  dialog: document.querySelector('#user-dialog'),
  detailName: document.querySelector('#detail-name'),
  userDetail: document.querySelector('#user-detail'),
  deleteUser: document.querySelector('#delete-user'),
  closeDialog: document.querySelector('#close-dialog'),
  closeDialogFooter: document.querySelector('#close-dialog-footer'),
};

const state = {
  page: 1,
  pageSize: 25,
  totalPages: 1,
  query: '',
  selectedUser: null,
  series: [],
  refreshTimer: null,
};

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>'"]/gu, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;',
  })[character]);
}

function number(value, digits = 0) {
  return new Intl.NumberFormat('zh-CN', { maximumFractionDigits: digits }).format(Number(value) || 0);
}

function dateTime(value) {
  if (!value) return '—';
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit',
  }).format(new Date(value));
}

function duration(value) {
  const milliseconds = Number(value) || 0;
  if (!milliseconds) return '—';
  const seconds = Math.round(milliseconds / 1000);
  const minutes = Math.floor(seconds / 60);
  return `${minutes}:${String(seconds % 60).padStart(2, '0')}`;
}

async function api(path, options = {}) {
  const init = { credentials: 'same-origin', ...options };
  if (options.body !== undefined) {
    init.headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
    init.body = JSON.stringify(options.body);
  }
  const response = await fetch(path, init);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(body.error?.message || `请求失败（${response.status}）`);
    error.status = response.status;
    error.code = body.error?.code;
    if (response.status === 401) showLogin();
    throw error;
  }
  return body;
}

function showLogin() {
  clearInterval(state.refreshTimer);
  state.refreshTimer = null;
  elements.adminView.hidden = true;
  elements.loginView.hidden = false;
  elements.adminKey.focus();
}

function showAdmin() {
  elements.loginView.hidden = true;
  elements.adminView.hidden = false;
  clearInterval(state.refreshTimer);
  state.refreshTimer = setInterval(() => {
    void loadDashboard(false).catch(() => {});
  }, 30_000);
}

function setError(message = '') {
  elements.globalError.textContent = message;
}

function renderMetrics(dashboard) {
  const cards = [
    ['累计 PV', number(dashboard.traffic.totalPageViews)],
    ['今日 PV', number(dashboard.traffic.todayPageViews)],
    ['今日 UV', number(dashboard.traffic.todayUniqueVisitors)],
    ['当前在线', number(dashboard.traffic.currentOnline)],
    ['历史在线峰值', number(dashboard.traffic.peakOnline)],
    ['范围在线峰值', number(dashboard.traffic.rangePeakOnline)],
    ['累计比赛', number(dashboard.races.total)],
    ['平均每场人数', number(dashboard.races.averagePlayers, 1)],
    ['平均比赛时间', duration(dashboard.races.averageDurationMs)],
    ['用户总数', number(dashboard.users.total)],
  ];
  elements.metrics.innerHTML = cards.map(([label, value]) => `
    <article class="metric-card"><div class="metric-label">${label}</div><div class="metric-value">${value}</div></article>
  `).join('');
}

function drawChart() {
  const canvas = elements.chart;
  const width = Math.max(300, Math.floor(canvas.getBoundingClientRect().width));
  const height = 260;
  const ratio = window.devicePixelRatio || 1;
  canvas.width = width * ratio;
  canvas.height = height * ratio;
  const context = canvas.getContext('2d');
  context.scale(ratio, ratio);
  context.clearRect(0, 0, width, height);
  const data = state.series;
  if (!data.length) {
    context.fillStyle = '#8fa9bb';
    context.font = '13px system-ui';
    context.textAlign = 'center';
    context.fillText('暂无趋势数据', width / 2, height / 2);
    return;
  }
  const padding = { left: 34, right: 18, top: 16, bottom: 28 };
  const chartWidth = width - padding.left - padding.right;
  const chartHeight = height - padding.top - padding.bottom;
  const maxPv = Math.max(1, ...data.map((item) => item.pageViews));
  const maxOnline = Math.max(1, ...data.map((item) => item.peakOnline));
  context.strokeStyle = 'rgba(148,190,218,.14)';
  context.lineWidth = 1;
  for (let index = 0; index <= 4; index++) {
    const y = padding.top + chartHeight * index / 4;
    context.beginPath();
    context.moveTo(padding.left, y);
    context.lineTo(width - padding.right, y);
    context.stroke();
  }
  const x = (index) => padding.left + (data.length === 1 ? chartWidth / 2 : chartWidth * index / (data.length - 1));
  const drawLine = (field, max, color) => {
    context.beginPath();
    data.forEach((item, index) => {
      const y = padding.top + chartHeight - chartHeight * item[field] / max;
      if (index === 0) context.moveTo(x(index), y);
      else context.lineTo(x(index), y);
    });
    context.strokeStyle = color;
    context.lineWidth = 2;
    context.stroke();
  };
  drawLine('pageViews', maxPv, '#31d7ff');
  drawLine('peakOnline', maxOnline, '#ff9d3f');
  context.fillStyle = '#8fa9bb';
  context.font = '11px system-ui';
  context.textAlign = 'left';
  context.fillText(dateTime(data[0].at), padding.left, height - 7);
  context.textAlign = 'right';
  context.fillText(dateTime(data.at(-1).at), width - padding.right, height - 7);
}

function renderNetworks(networks) {
  elements.networks.innerHTML = networks.length ? networks.map((item) => `
    <tr><td>${escapeHtml(item.network)}</td><td>${number(item.pageViews)}</td><td>${number(item.share * 100, 1)}%</td></tr>
  `).join('') : '<tr><td colspan="3" class="muted">暂无数据</td></tr>';
}

async function loadDashboard(showErrors = true) {
  try {
    const dashboard = await api(`/api/admin/dashboard?range=${encodeURIComponent(elements.range.value)}`);
    showAdmin();
    setError();
    renderMetrics(dashboard);
    state.series = dashboard.traffic.series;
    drawChart();
    renderNetworks(dashboard.traffic.networks);
  } catch (error) {
    if (error.status !== 401 && showErrors) setError(error.message);
    throw error;
  }
}

function renderUsers(result) {
  state.page = result.page;
  state.totalPages = result.totalPages;
  elements.userRows.innerHTML = result.items.length ? result.items.map((user) => `
    <tr data-user-id="${escapeHtml(user.userId)}">
      <td><strong>${escapeHtml(user.displayName)}</strong><br><span class="muted detail-id">${escapeHtml(user.userId)}</span></td>
      <td>${number(user.level)}</td><td>${number(user.rating)}</td><td>${number(user.races)}</td>
      <td>${dateTime(user.lastSeenAt)}</td>
      <td><span class="status ${user.active ? 'online' : ''}">${user.active ? '活跃' : '离线'}</span></td>
    </tr>
  `).join('') : '<tr><td colspan="6" class="muted">没有匹配的用户</td></tr>';
  elements.userSummary.textContent = `共 ${number(result.total)} 名用户 · 第 ${result.page}/${result.totalPages} 页`;
  elements.prevPage.disabled = result.page <= 1;
  elements.nextPage.disabled = result.page >= result.totalPages;
}

async function loadUsers() {
  const path = `/api/admin/users?q=${encodeURIComponent(state.query)}&page=${state.page}&pageSize=${state.pageSize}`;
  try {
    renderUsers(await api(path));
    setError();
  } catch (error) {
    if (error.status !== 401) setError(error.message);
  }
}

function detailItem(label, value, className = '') {
  return `<div class="detail-item"><span>${label}</span><strong class="${className}">${escapeHtml(value)}</strong></div>`;
}

function renderUserDetail(user) {
  const stats = user.stats;
  elements.detailName.textContent = user.displayName;
  elements.deleteUser.disabled = user.active;
  elements.deleteUser.title = user.active ? '活跃用户暂时不能删除' : '';
  const races = user.recentRaces.length ? user.recentRaces.map((race) => `
    <div class="race-row">
      <span>${escapeHtml(race.trackId)}</span><span>${dateTime(race.startedAt)}</span>
      <span>${race.officialRank ? `第 ${race.officialRank} 名` : '未结算'}</span>
      <span>${race.finishTimeMs ? duration(race.finishTimeMs) : race.escaped ? '逃跑' : 'DNF'}</span>
    </div>
  `).join('') : '<p class="muted">暂无比赛记录</p>';
  const records = user.trackBestTimes.map((record) => `
    <div class="race-row"><span>${escapeHtml(record.trackId)}</span><span>${duration(record.finishTimeMs)}</span></div>
  `).join('');
  elements.userDetail.innerHTML = `
    <div class="detail-grid">
      ${detailItem('用户 ID', user.userId, 'detail-id')}
      ${detailItem('状态', user.active ? '活跃' : '离线')}
      ${detailItem('最近上线', dateTime(user.sessions.lastSeenAt))}
      ${detailItem('等级', number(user.level))}
      ${detailItem('XP', number(user.xp))}
      ${detailItem('Rating', number(user.rating))}
      ${detailItem('比赛', number(stats.races))}
      ${detailItem('完赛', number(stats.finishes))}
      ${detailItem('逃跑', number(stats.escapes))}
      ${detailItem('冠军', number(stats.firsts))}
      ${detailItem('亚军', number(stats.seconds))}
      ${detailItem('季军', number(stats.thirds))}
    </div>
    <section class="detail-section"><h3>地图纪录</h3><div class="race-list">${records}</div></section>
    <section class="detail-section"><h3>最近比赛</h3><div class="race-list">${races}</div></section>
  `;
}

async function openUser(userId) {
  try {
    state.selectedUser = await api(`/api/admin/users/${encodeURIComponent(userId)}`);
    renderUserDetail(state.selectedUser);
    elements.dialog.showModal();
  } catch (error) {
    if (error.status !== 401) setError(error.message);
  }
}

elements.loginForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  elements.loginError.textContent = '';
  try {
    await api('/api/admin/login', { method: 'POST', body: { key: elements.adminKey.value } });
    elements.adminKey.value = '';
    showAdmin();
    await Promise.all([loadDashboard(), loadUsers()]);
  } catch (error) {
    elements.loginError.textContent = error.message;
  }
});

elements.logout.addEventListener('click', async () => {
  try { await api('/api/admin/logout', { method: 'POST', body: {} }); } catch {}
  showLogin();
});
elements.refresh.addEventListener('click', () => {
  void Promise.all([loadDashboard(), loadUsers()]).catch(() => {});
});
elements.range.addEventListener('change', () => {
  void loadDashboard().catch(() => {});
});
let searchTimer;
elements.userSearch.addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    state.query = elements.userSearch.value.trim();
    state.page = 1;
    void loadUsers();
  }, 250);
});
elements.prevPage.addEventListener('click', () => { state.page--; void loadUsers(); });
elements.nextPage.addEventListener('click', () => { state.page++; void loadUsers(); });
elements.userRows.addEventListener('click', (event) => {
  const row = event.target.closest('tr[data-user-id]');
  if (row) void openUser(row.dataset.userId);
});
const closeDialog = () => elements.dialog.close();
elements.closeDialog.addEventListener('click', closeDialog);
elements.closeDialogFooter.addEventListener('click', closeDialog);
elements.deleteUser.addEventListener('click', async () => {
  const user = state.selectedUser;
  if (!user || user.active) return;
  if (!window.confirm(`确定永久删除用户“${user.displayName}”吗？此操作不可撤销。`)) return;
  try {
    await api(`/api/admin/users/${encodeURIComponent(user.userId)}`, { method: 'DELETE', body: {} });
    elements.dialog.close();
    state.selectedUser = null;
    await Promise.all([loadDashboard(), loadUsers()]);
  } catch (error) {
    if (error.status !== 401) setError(error.message);
  }
});
window.addEventListener('resize', drawChart);

Promise.all([loadDashboard(false), loadUsers()]).catch((error) => {
  if (error.status !== 401) elements.loginError.textContent = error.message;
});
