(() => {
'use strict';

/* ============ utilidades ============ */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ICONS = {
  home: '<path d="M3 11.5 12 4l9 7.5"/><path d="M5 10v10h5v-6h4v6h5V10"/>',
  bot: '<rect x="4" y="8" width="16" height="11" rx="3"/><path d="M12 8V5"/><circle cx="12" cy="4" r="1"/><circle cx="9" cy="13.5" r="1"/><circle cx="15" cy="13.5" r="1"/>',
  upload: '<path d="M12 16V4"/><path d="m7 9 5-5 5 5"/><path d="M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3"/>',
  terminal: '<path d="m5 8 4 4-4 4"/><path d="M12 17h7"/>',
  card: '<rect x="3" y="6" width="18" height="12" rx="2"/><path d="M3 10h18"/>',
  gear: '<path d="M4 6h10M18 6h2"/><circle cx="16" cy="6" r="2"/><path d="M4 12h2M10 12h10"/><circle cx="8" cy="12" r="2"/><path d="M4 18h12M20 18h0"/><circle cx="18" cy="18" r="2"/>',
  help: '<circle cx="12" cy="12" r="9"/><path d="M9.5 9.6a2.6 2.6 0 1 1 3.6 2.4c-.7.4-1.1.9-1.1 1.8"/><path d="M12 17h.01"/>',
  shield: '<path d="M12 3 5 6v6c0 4.5 3 7.5 7 9 4-1.5 7-4.5 7-9V6z"/>',
  menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
  logout: '<path d="M9 4H5a1 1 0 0 0-1 1v14a1 1 0 0 0 1 1h4"/><path d="m16 8 4 4-4 4"/><path d="M20 12H9"/>',
  play: '<path d="M7 5v14l12-7z"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="1.5"/>',
  refresh: '<path d="M20 11a8 8 0 0 0-14.5-4M4 4v4h4"/><path d="M4 13a8 8 0 0 0 14.5 4M20 20v-4h-4"/>',
  trash: '<path d="M4 7h16"/><path d="M9 7V4h6v3"/><path d="M6 7l1 13h10l1-13"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  x: '<path d="M6 6l12 12M18 6 6 18"/>',
};
const icon = (n) => `<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[n]}</svg>`;
const logo = () => `<span class="logo"><svg viewBox="0 0 32 32" aria-hidden="true"><path d="M16 3l11 6.5v13L16 29 5 22.5v-13z" fill="none" stroke="#a15cff" stroke-width="2.4" stroke-linejoin="round"/><circle cx="16" cy="16" r="3.4" fill="#2eaaff"/></svg>BotNexus</span>`;

const fmtMoney = (c) => (c / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
const fmtDate = (ms) => (ms ? new Date(ms).toLocaleDateString('pt-BR') : '—');
const fmtDateTime = (ms) => (ms ? new Date(ms).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }) : '—');
const fmtTime = (ms) => new Date(ms).toLocaleTimeString('pt-BR');
function fmtUptime(s) {
  if (!s || s < 1) return '—';
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}min`;
  if (m) return `${m}min`;
  return `${s}s`;
}
const daysLeft = (ms) => Math.ceil((ms - Date.now()) / 86400000);

const STATUS = {
  running: ['Online', 'ok'], stopped: ['Parado', ''], crashed: ['Caiu', 'bad'],
  installing: ['Instalando', 'warn'], error: ['Erro', 'bad'], new: ['Sem código', ''],
};
const statusOf = (b) => STATUS[b.status] || ['—', ''];
const chip = (b) => { const [t, c] = statusOf(b); return `<span class="chip ${c}">${esc(t)}</span>`; };

/* ============ estado ============ */
const state = { user: undefined, bots: [], socket: null, cleanups: [], handlers: { status: new Set(), log: new Set(), stats: new Set() } };
const onLeave = (fn) => state.cleanups.push(fn);
function listen(kind, fn) { state.handlers[kind].add(fn); onLeave(() => state.handlers[kind].delete(fn)); }

/* ============ API ============ */
async function api(path, { method = 'GET', body, form } = {}) {
  const opts = { method, headers: { 'X-Requested-With': 'botnexus' }, credentials: 'same-origin' };
  if (form) opts.body = form;
  else if (body !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
  let r;
  try { r = await fetch('/api' + path, opts); }
  catch { throw new Error('Sem conexão com o servidor. Verifique sua internet.'); }
  let data = null;
  try { data = await r.json(); } catch {}
  if (!r.ok) {
    const err = new Error(data?.error || 'Algo deu errado. Tente de novo.');
    err.status = r.status;
    if (r.status === 401 && state.user) { state.user = null; location.hash = '#/entrar'; }
    throw err;
  }
  return data;
}

function uploadZip(botId, file, clean, onProgress) {
  return new Promise((resolve, reject) => {
    const x = new XMLHttpRequest();
    x.open('POST', `/api/bots/${botId}/deploy`);
    x.setRequestHeader('X-Requested-With', 'botnexus');
    x.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100)); };
    x.onerror = () => reject(new Error('Falha de conexão durante o envio.'));
    x.onload = () => {
      let d = null;
      try { d = JSON.parse(x.responseText); } catch {}
      x.status >= 200 && x.status < 300 ? resolve(d) : reject(new Error(d?.error || 'Não foi possível enviar o ZIP.'));
    };
    const f = new FormData();
    f.append('file', file);
    f.append('clean', clean ? '1' : '0');
    x.send(f);
  });
}

/* ============ avisos e janelas ============ */
function toast(msg, kind = '') {
  const t = document.createElement('div');
  t.className = `toast ${kind}`;
  t.textContent = msg;
  $('#toasts').append(t);
  setTimeout(() => t.remove(), kind === 'bad' ? 6500 : 3800);
}

function openDialog(html) { const d = $('#dlg'); d.innerHTML = html; if (!d.open) d.showModal(); return d; }
const closeDialog = () => { const d = $('#dlg'); if (d.open) d.close(); };

function confirmBox({ title, text, ok = 'Confirmar', danger = false }) {
  return new Promise((resolve) => {
    const d = openDialog(`<h2>${esc(title)}</h2><p class="muted">${esc(text)}</p>
      <div class="foot"><button class="btn ghost" data-r="0">Cancelar</button><button class="btn ${danger ? 'danger' : 'primary'}" data-r="1">${esc(ok)}</button></div>`);
    d.onclose = () => resolve(false);
    $$('[data-r]', d).forEach((b) => { b.onclick = () => { d.onclose = null; closeDialog(); resolve(b.dataset.r === '1'); }; });
  });
}

function promptBox({ title, label, placeholder = '', ok = 'Salvar', type = 'text', value = '', hint = '' }) {
  return new Promise((resolve) => {
    const d = openDialog(`<form><h2>${esc(title)}</h2>
      <label class="field"><span>${esc(label)}</span><input name="v" type="${type}" placeholder="${esc(placeholder)}" value="${esc(value)}" autocomplete="off" required>${hint ? `<div class="hint">${esc(hint)}</div>` : ''}</label>
      <div class="foot"><button type="button" class="btn ghost" data-r="0">Cancelar</button><button class="btn primary">${esc(ok)}</button></div></form>`);
    d.onclose = () => resolve(null);
    $('input', d).focus();
    $('[data-r]', d).onclick = () => closeDialog();
    $('form', d).onsubmit = (e) => { e.preventDefault(); const v = $('input', d).value.trim(); d.onclose = null; closeDialog(); resolve(v); };
  });
}

async function busy(btn, fn) {
  const old = btn?.innerHTML;
  if (btn) { btn.disabled = true; btn.innerHTML = '<span class="spinner"></span>'; }
  try { return await fn(); }
  finally { if (btn) { btn.disabled = false; btn.innerHTML = old; } }
}

/* ============ tempo real ============ */
function connectSocket() {
  if (state.socket) return;
  const s = io({ transports: ['websocket', 'polling'] });
  state.socket = s;
  s.on('status', (b) => { mergeBot(b); state.handlers.status.forEach((h) => h(b)); });
  s.on('stats', (b) => { mergeBot(b); state.handlers.stats.forEach((h) => h(b)); });
  s.on('log', (l) => state.handlers.log.forEach((h) => h(l)));
  s.on('connect_error', () => {});
}
function disconnectSocket() { if (state.socket) { state.socket.disconnect(); state.socket = null; } }
function mergeBot(b) {
  const i = state.bots.findIndex((x) => x.id === b.id);
  if (i >= 0) state.bots[i] = { ...state.bots[i], ...b };
}

/* ============ console ============ */
function appendLine(el, l) {
  const stick = el.scrollHeight - el.scrollTop - el.clientHeight < 50;
  const empty = $('.empty-log', el);
  if (empty) empty.remove();
  const d = document.createElement('div');
  d.className = `ln ${l.s}`;
  const t = document.createElement('span');
  t.className = 'ts';
  t.textContent = fmtTime(l.t);
  const m = document.createElement('span');
  m.textContent = l.m;
  d.append(t, m);
  el.append(d);
  while (el.childElementCount > 600) el.firstChild.remove();
  if (stick) el.scrollTop = el.scrollHeight;
}

async function mountConsole(el, botId) {
  const seen = new Set();
  const key = (l) => `${l.t}|${l.s}|${l.m}`;
  let ready = false;
  const queue = [];
  listen('log', (l) => {
    if (l.botId !== botId) return;
    if (!ready) { queue.push(l); return; }
    if (!seen.has(key(l))) { seen.add(key(l)); appendLine(el, l); }
  });
  state.socket?.emit('subscribe', botId);
  onLeave(() => state.socket?.emit('unsubscribe', botId));
  el.innerHTML = '';
  try {
    const { logs } = await api(`/bots/${botId}/logs?tail=300`);
    if (!logs.length) el.innerHTML = '<div class="empty-log">Nada por aqui ainda. Quando o bot iniciar, as mensagens dele aparecem neste console.</div>';
    for (const l of logs) { seen.add(key(l)); appendLine(el, l); }
  } catch (e) { el.textContent = e.message; }
  for (const l of queue) if (!seen.has(key(l))) { seen.add(key(l)); appendLine(el, l); }
  ready = true;
  el.scrollTop = el.scrollHeight;
}

/* ============ roteamento ============ */
const ROUTES = [
  { re: /^\/entrar$/, view: viewLogin, pub: true },
  { re: /^\/cadastro$/, view: viewRegister, pub: true },
  { re: /^\/esqueci$/, view: viewForgot, pub: true },
  { re: /^\/redefinir$/, view: viewReset, pub: true, allowAuthed: true },
  { re: /^\/$/, view: viewDashboard, nav: '/' },
  { re: /^\/bots$/, view: viewBots, nav: '/bots' },
  { re: /^\/bot\/(\d+)$/, view: viewBot, nav: '/bots' },
  { re: /^\/deploy$/, view: viewDeploy, nav: '/deploy' },
  { re: /^\/logs$/, view: viewLogs, nav: '/logs' },
  { re: /^\/planos$/, view: viewPlans, nav: '/planos' },
  { re: /^\/config$/, view: viewSettings, nav: '/config' },
  { re: /^\/ajuda$/, view: viewHelp, nav: '/ajuda' },
  { re: /^\/admin$/, view: viewAdmin, nav: '/admin', admin: true },
];

function parseHash() {
  const h = location.hash.replace(/^#/, '') || '/';
  const [path, query] = h.split('?');
  return { path, params: new URLSearchParams(query || '') };
}

async function loadMe() {
  try { state.user = (await api('/me')).user; } catch { state.user = null; }
}

let routing = 0;
async function route() {
  const token = ++routing;
  state.cleanups.splice(0).forEach((fn) => { try { fn(); } catch {} });
  closeDialog();
  const { path, params } = parseHash();
  if (state.user === undefined) await loadMe();
  if (token !== routing) return;

  const r = ROUTES.find((x) => x.re.test(path));
  if (!r) { location.hash = '#/'; return; }
  if (!r.pub && !state.user) { disconnectSocket(); location.hash = '#/entrar'; return; }
  if (r.pub && state.user && !r.allowAuthed) { location.hash = '#/'; return; }
  if (r.admin && state.user.role !== 'admin') { location.hash = '#/'; return; }
  const match = path.match(r.re);
  const ctx = { params, args: match.slice(1), token };

  if (r.pub) {
    $('#app').innerHTML = `<div class="auth"><div class="auth-card" id="authbox"></div></div>`;
    r.view($('#authbox'), ctx);
  } else {
    connectSocket();
    $('#app').innerHTML = shell(r.nav);
    window.scrollTo(0, 0);
    try { await r.view($('#content'), ctx); }
    catch (e) { if (token === routing) $('#content').innerHTML = `<div class="panel"><h2>Ops</h2><p class="muted">${esc(e.message)}</p></div>`; }
  }
}

function shell(active) {
  const u = state.user;
  const nav = [['/', 'home', 'Painel'], ['/bots', 'bot', 'Meus bots'], ['/deploy', 'upload', 'Deploy'], ['/logs', 'terminal', 'Logs'],
    ['/planos', 'card', 'Planos'], ['/config', 'gear', 'Configurações'], ['/ajuda', 'help', 'Ajuda']];
  if (u.role === 'admin') nav.push(['/admin', 'shield', 'Admin']);
  return `<div class="shell" id="shell">
    <header class="topbar"><button class="icon-btn" data-action="menu" aria-label="Abrir menu">${icon('menu')}</button>${logo()}<span class="plan-pill">${esc(u.planName)}</span></header>
    <div class="scrim" data-action="menu"></div>
    <aside class="side">
      <div class="brand">${logo()}</div>
      <nav>${nav.map(([p, ic, t]) => `<a href="#${p}" class="${p === active ? 'active' : ''}">${icon(ic)}${t}</a>`).join('')}</nav>
      <div class="side-foot">
        <div class="who"><strong>${esc(u.name)}</strong><span>${esc(u.email)}</span></div>
        <button class="btn ghost sm" data-action="logout">${icon('logout')} Sair</button>
      </div>
    </aside>
    <main class="content" id="content"></main>
  </div>`;
}

async function refreshBots() { state.bots = (await api('/bots')).bots; return state.bots; }
async function refreshMe() { await loadMe(); }

/* ============ ações globais (delegação de eventos) ============ */
const actions = {
  menu() { $('#shell')?.classList.toggle('open'); },
  async logout() { try { await api('/auth/logout', { method: 'POST' }); } catch {} state.user = null; disconnectSocket(); location.hash = '#/entrar'; },
};
document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-action]');
  if (!el) return;
  const fn = actions[el.dataset.action];
  if (fn) { e.preventDefault(); fn(el, e); }
});
const forms = {};
document.addEventListener('submit', (e) => {
  const f = e.target.closest('form[data-form]');
  if (!f || !forms[f.dataset.form]) return;
  e.preventDefault();
  forms[f.dataset.form](f, new FormData(f));
});
window.addEventListener('hashchange', route);

function setError(form, msg) {
  let box = $('.form-error', form);
  if (!msg) { box?.remove(); return; }
  if (!box) { box = document.createElement('div'); box.className = 'form-error'; form.prepend(box); }
  box.textContent = msg;
}

/* ============ telas de entrada ============ */
function viewLogin(box) {
  box.innerHTML = `${logo()}<h1>Entrar</h1><p class="sub">Acesse o painel dos seus bots.</p>
    <form data-form="login" novalidate>
      <label class="field"><span>E-mail</span><input name="email" type="email" autocomplete="email" required></label>
      <label class="field"><span>Senha</span><input name="password" type="password" autocomplete="current-password" required></label>
      <button class="btn primary block">Entrar</button>
    </form>
    <div class="auth-links"><a href="#/esqueci">Esqueci a senha</a><a href="#/cadastro">Criar conta</a></div>`;
}
forms.login = async (f, fd) => {
  setError(f);
  try {
    await busy($('button', f), async () => { state.user = (await api('/auth/login', { method: 'POST', body: { email: fd.get('email'), password: fd.get('password') } })).user; });
    location.hash = '#/';
  } catch (e) { setError(f, e.message); }
};

function viewRegister(box) {
  box.innerHTML = `${logo()}<h1>Criar conta</h1><p class="sub">Grátis para começar. Seu primeiro bot fica no ar em minutos.</p>
    <form data-form="register" novalidate>
      <label class="field"><span>Seu nome</span><input name="name" type="text" autocomplete="name" required></label>
      <label class="field"><span>E-mail</span><input name="email" type="email" autocomplete="email" required></label>
      <label class="field"><span>Senha</span><input name="password" type="password" autocomplete="new-password" required><div class="hint">Mínimo de 8 caracteres.</div></label>
      <button class="btn primary block">Criar conta</button>
    </form>
    <div class="auth-links"><span class="muted">Já tem conta?</span><a href="#/entrar">Entrar</a></div>`;
}
forms.register = async (f, fd) => {
  setError(f);
  try {
    await busy($('button', f), async () => { state.user = (await api('/auth/register', { method: 'POST', body: { name: fd.get('name'), email: fd.get('email'), password: fd.get('password') } })).user; });
    location.hash = '#/';
  } catch (e) { setError(f, e.message); }
};

function viewForgot(box) {
  box.innerHTML = `${logo()}<h1>Esqueci a senha</h1><p class="sub">Informe seu e-mail e enviaremos um link para criar uma nova senha.</p>
    <form data-form="forgot" novalidate>
      <label class="field"><span>E-mail</span><input name="email" type="email" autocomplete="email" required></label>
      <button class="btn primary block">Enviar link</button>
    </form>
    <div class="auth-links"><a href="#/entrar">Voltar para entrar</a></div>`;
}
forms.forgot = async (f, fd) => {
  setError(f);
  try {
    const r = await busy($('button', f), () => api('/auth/forgot', { method: 'POST', body: { email: fd.get('email') } }));
    f.innerHTML = `<div class="banner ok" style="margin:0">${esc(r.message)}</div>`;
  } catch (e) { setError(f, e.message); }
};

function viewReset(box, ctx) {
  const token = ctx.params.get('token') || '';
  box.innerHTML = `${logo()}<h1>Nova senha</h1><p class="sub">Escolha uma senha nova para sua conta.</p>
    <form data-form="reset" novalidate>
      <input type="hidden" name="token" value="${esc(token)}">
      <label class="field"><span>Nova senha</span><input name="password" type="password" autocomplete="new-password" required><div class="hint">Mínimo de 8 caracteres.</div></label>
      <button class="btn primary block">Salvar nova senha</button>
    </form>`;
}
forms.reset = async (f, fd) => {
  setError(f);
  try {
    await busy($('button', f), () => api('/auth/reset', { method: 'POST', body: { token: fd.get('token'), password: fd.get('password') } }));
    state.user = null;
    disconnectSocket();
    toast('Senha alterada. Entre com a nova senha.', 'ok');
    location.hash = '#/entrar';
  } catch (e) { setError(f, e.message); }
};

/* ============ painel ============ */
function botMeta(b) {
  if (b.status === 'running') return `Online há ${fmtUptime(b.uptimeSec)} · ${b.memMB} MB`;
  if (b.status === 'installing') return 'Instalando dependências…';
  if (!b.hasCode) return 'Falta enviar o código (ZIP)';
  if (!b.hasToken) return 'Falta salvar o token';
  return b.lastExit || 'Pronto para iniciar';
}
function botButtons(b, small = true) {
  const s = small ? ' sm' : '';
  if (b.status === 'installing') return '';
  if (b.status === 'running') return `<button class="btn${s}" data-action="bot-restart" data-id="${b.id}">${icon('refresh')} Reiniciar</button><button class="btn${s}" data-action="bot-stop" data-id="${b.id}">${icon('stop')} Parar</button>`;
  return `<button class="btn primary${s}" data-action="bot-start" data-id="${b.id}">${icon('play')} Iniciar</button>`;
}
function botRow(b) {
  const [, c] = statusOf(b);
  return `<div class="bot-row ${b.status === 'crashed' ? 'crashed' : ''}">
    <span class="dot ${c}"></span>
    <div style="min-width:0"><div class="nm"><a href="#/bot/${b.id}">${esc(b.name)}</a></div><div class="meta">${esc(botMeta(b))}</div></div>
    <div class="actions">${botButtons(b)}<a class="btn ghost sm" href="#/bot/${b.id}">Abrir</a></div>
  </div>`;
}

function emitLocal(bot) { mergeBot(bot); state.handlers.status.forEach((h) => h(bot)); }
const botAction = (verb, okMsg) => async (el) => {
  const id = Number(el.dataset.id);
  await busy(el, async () => {
    try { const r = await api(`/bots/${id}/${verb}`, { method: 'POST' }); if (r.bot) emitLocal(r.bot); if (okMsg) toast(okMsg, 'ok'); }
    catch (e) { toast(e.message, 'bad'); }
  });
};
actions['bot-start'] = botAction('start', 'Bot iniciado.');
actions['bot-stop'] = botAction('stop', 'Bot parado.');
actions['bot-restart'] = botAction('restart', 'Bot reiniciado.');
actions['bot-delete'] = async (el) => {
  const id = Number(el.dataset.id);
  if (!(await confirmBox({ title: 'Excluir este bot?', text: 'O código, o token e o histórico de logs serão apagados de vez. Não dá para desfazer.', ok: 'Excluir bot', danger: true }))) return;
  try { await api(`/bots/${id}`, { method: 'DELETE' }); toast('Bot excluído.', 'ok'); location.hash = '#/bots'; }
  catch (e) { toast(e.message, 'bad'); }
};
actions['bot-new'] = async () => {
  const name = await promptBox({ title: 'Novo bot', label: 'Nome do bot', placeholder: 'Ex.: Bot de tickets', ok: 'Criar bot' });
  if (!name) return;
  try { const r = await api('/bots', { method: 'POST', body: { name } }); toast('Bot criado. Agora envie o código e o token.', 'ok'); location.hash = `#/bot/${r.bot.id}`; }
  catch (e) { toast(e.message, 'bad'); }
};

async function viewDashboard(el) {
  await Promise.all([refreshBots(), refreshMe()]);
  const draw = () => {
    const u = state.user;
    const bots = state.bots;
    const online = bots.filter((b) => b.status === 'running').length;
    const mem = bots.reduce((a, b) => a + (b.memMB || 0), 0);
    const crashed = bots.filter((b) => b.status === 'crashed' || b.status === 'error');
    const exp = u.planExpiresAt ? daysLeft(u.planExpiresAt) : null;
    el.innerHTML = `
      <div class="page-head"><div><h1>Olá, ${esc(u.name.split(' ')[0])}</h1><p>Resumo dos seus bots.</p></div>
        <div class="actions"><button class="btn primary" data-action="bot-new">${icon('plus')} Novo bot</button></div></div>
      ${crashed.map((b) => `<div class="banner bad"><span><b>${esc(b.name)}</b> ${b.status === 'crashed' ? 'caiu' : 'está com erro'}: ${esc(b.lastExit || 'veja o console')}</span><a class="btn sm" href="#/bot/${b.id}">Ver console</a></div>`).join('')}
      ${exp !== null && exp <= 5 ? `<div class="banner"><span>Seu plano ${esc(u.planName)} vence ${exp <= 0 ? 'hoje' : `em ${exp} dia${exp > 1 ? 's' : ''}`}.</span><a class="btn sm" href="#/planos">Renovar</a></div>` : ''}
      <div class="stats">
        <div class="stat"><div class="v">${online}<small> / ${bots.length}</small></div><div class="l">Bots online</div></div>
        <div class="stat"><div class="v">${bots.length}<small> / ${u.limits.maxBots}</small></div><div class="l">Bots criados</div></div>
        <div class="stat"><div class="v">${esc(u.planName)}</div><div class="l">${u.planExpiresAt ? `Vence em ${fmtDate(u.planExpiresAt)}` : 'Plano atual'}</div></div>
        <div class="stat"><div class="v">${mem}<small> MB</small></div><div class="l">Memória em uso</div></div>
      </div>
      ${bots.length ? `<section class="panel flat">${bots.map(botRow).join('')}</section>` : `
        <section class="panel empty"><h2>Coloque seu primeiro bot no ar</h2>
          <p>Crie o bot, envie o projeto em ZIP e cole o token. O BotNexus cuida do resto.</p>
          <button class="btn primary" data-action="bot-new">${icon('plus')} Criar meu primeiro bot</button>
          <div class="steps"><div><b>1. Crie o bot</b>Dê um nome e abra a página dele.</div><div><b>2. Envie o código</b>Um ZIP com seu projeto Node.js e o token do Discord.</div><div><b>3. Inicie</b>Acompanhe tudo pelo console, ao vivo.</div></div>
        </section>`}`;
  };
  draw();
  listen('status', draw);
}

async function viewBots(el) {
  await refreshBots();
  const draw = () => {
    const u = state.user;
    el.innerHTML = `
      <div class="page-head"><div><h1>Meus bots</h1><p>${state.bots.length} de ${u.limits.maxBots} bots no plano ${esc(u.planName)}.</p></div>
        <div class="actions"><button class="btn primary" data-action="bot-new">${icon('plus')} Novo bot</button></div></div>
      ${state.bots.length ? `<section class="panel flat">${state.bots.map(botRow).join('')}</section>`
        : `<section class="panel empty"><h2>Nenhum bot ainda</h2><p>Crie seu primeiro bot para começar.</p><button class="btn primary" data-action="bot-new">${icon('plus')} Novo bot</button></section>`}`;
  };
  draw();
  listen('status', draw);
}

/* ============ página do bot ============ */
function deployPanel(b) {
  const lim = state.user.limits.zipMB;
  return `<section class="panel"><h2>Código do bot</h2><p class="sub" id="codeInfo"></p>
    <form data-form="deploy" data-id="${b.id}" novalidate>
      <label class="field"><span>Arquivo ZIP do projeto (até ${lim} MB)</span><input type="file" name="file" accept=".zip,application/zip" required></label>
      <label class="check"><input type="checkbox" name="clean"> Apagar os arquivos antigos antes de enviar</label>
      <div class="hint">Marque só se quiser zerar também os dados que o bot salvou em arquivos. Pastas <code>node_modules</code>, <code>.git</code> e arquivos <code>.env</code> são ignorados.</div>
      <progress class="hide" max="100" value="0"></progress>
      <div style="margin-top:1rem"><button class="btn primary">${icon('upload')} Enviar código</button></div>
    </form></section>`;
}
forms.deploy = async (f, fd) => {
  const id = Number(f.dataset.id);
  const file = fd.get('file');
  setError(f);
  if (!file || !file.size) return setError(f, 'Escolha um arquivo .zip.');
  if (!/\.zip$/i.test(file.name)) return setError(f, 'O arquivo precisa ser um .zip.');
  if (file.size > state.user.limits.zipMB * 1048576) return setError(f, `O ZIP passa de ${state.user.limits.zipMB} MB, o limite do seu plano.`);
  const bar = $('progress', f);
  bar.classList.remove('hide');
  bar.value = 0;
  try {
    const r = await busy($('button', f), () => uploadZip(id, file, fd.get('clean') === 'on', (p) => { bar.value = p; }));
    toast(r.installing ? 'Código enviado. Instalando dependências…' : 'Código enviado.', 'ok');
    f.reset();
    const fresh = (await api(`/bots/${id}`)).bot;
    emitLocal(fresh);
  } catch (e) { setError(f, e.message); }
  finally { bar.classList.add('hide'); }
};

async function viewBot(el, ctx) {
  const id = Number(ctx.args[0]);
  let bot;
  try { bot = (await api(`/bots/${id}`)).bot; }
  catch { el.innerHTML = '<div class="panel empty"><h2>Bot não encontrado</h2><p>Ele pode ter sido excluído.</p><a class="btn" href="#/bots">Voltar</a></div>'; return; }
  const lim = state.user.limits;
  let envKeys = bot.envKeys || [];
  const removed = new Set();

  el.innerHTML = `
    <div class="page-head"><div><a href="#/bots" class="muted">← Meus bots</a><h1 id="botName" style="margin-top:.3rem"></h1></div><div class="actions" id="botActions"></div></div>
    <div id="live"></div>
    ${deployPanel(bot)}
    <section class="panel"><h2>Token e variáveis</h2><p class="sub">Guardados criptografados. Nunca aparecem no navegador nem nos logs.</p>
      <form data-form="token" data-id="${id}" novalidate>
        <label class="field"><span>Token do bot <span id="tokenState"></span></span><input type="password" name="token" placeholder="Cole aqui o token do Discord" autocomplete="off" required></label>
        <button class="btn">Salvar token</button>
      </form>
      <hr style="border:0;border-top:1px solid var(--line-soft);margin:1.3rem 0">
      <h3 style="margin-bottom:.2rem">Variáveis de ambiente</h3>
      <p class="muted" style="font-size:.88rem">Use no código como <code>process.env.NOME</code>. O token já chega como <code>DISCORD_TOKEN</code>, <code>TOKEN</code> e <code>BOT_TOKEN</code>.</p>
      <form data-form="env" data-id="${id}" novalidate>
        <div id="envRows"></div>
        <div class="actions" style="margin-top:.6rem"><button type="button" class="btn ghost sm" data-action="env-add">${icon('plus')} Adicionar variável</button><button class="btn sm">Salvar variáveis</button></div>
      </form>
    </section>
    <section class="panel"><h2>Opções</h2>
      <form data-form="opts" data-id="${id}" novalidate>
        <div class="row2">
          <label class="field"><span>Nome do bot</span><input type="text" name="name" maxlength="40" required></label>
          <label class="field"><span>Arquivo principal</span><input type="text" name="entry" placeholder="index.js"></label>
        </div>
        <label class="switch"><span><b>Reiniciar sozinho se cair</b><div class="hint" style="margin:0">Até 5 tentativas em 10 minutos, com espera crescente.</div></span><input type="checkbox" name="auto" style="width:20px;height:20px;accent-color:var(--purple)"></label>
        <div style="margin-top:.8rem"><button class="btn">Salvar opções</button></div>
      </form>
    </section>
    <section class="panel"><div class="console-bar"><h2>Console</h2><span class="muted" style="font-size:.84rem">Ao vivo · últimas linhas</span></div><div class="console" id="console" role="log" aria-live="off"></div></section>
    <section class="panel danger-zone"><h2>Excluir bot</h2><p class="sub">Apaga código, token e logs deste bot.</p><button class="btn danger" data-action="bot-delete" data-id="${id}">${icon('trash')} Excluir este bot</button></section>`;

  const renderEnv = () => {
    const rows = envKeys.filter((k) => !removed.has(k)).map((k) => `<div class="kv" data-existing="${esc(k)}"><input type="text" value="${esc(k)}" readonly aria-label="Nome"><input type="password" placeholder="salva — digite para trocar" autocomplete="off" aria-label="Valor de ${esc(k)}"><button type="button" class="icon-btn" data-action="env-del" aria-label="Remover ${esc(k)}">${icon('x')}</button></div>`).join('');
    $('#envRows').innerHTML = rows || '<div class="muted" style="font-size:.88rem;margin-bottom:.5rem">Nenhuma variável definida.</div>';
  };
  const renderLive = () => {
    const [, c] = statusOf(bot);
    $('#botName').textContent = bot.name;
    $('#botActions').innerHTML = `${chip(bot)}${botButtons(bot, false)}`;
    const missing = [];
    if (!bot.hasCode) missing.push('enviar o código (ZIP)');
    if (!bot.hasToken) missing.push('salvar o token');
    $('#live').innerHTML = `
      ${(bot.status === 'crashed' || bot.status === 'error') && bot.lastExit ? `<div class="banner bad"><span>${esc(bot.lastExit)}</span></div>` : ''}
      ${missing.length && bot.status !== 'running' ? `<div class="banner info"><span>Para iniciar, falta ${missing.join(' e ')}.</span></div>` : ''}
      <div class="stats">
        <div class="stat"><div class="v">${bot.status === 'running' ? esc(fmtUptime(bot.uptimeSec)) : '—'}</div><div class="l">Tempo online</div></div>
        <div class="stat"><div class="v">${bot.status === 'running' ? bot.memMB : '—'}<small> / ${lim.memMB} MB</small></div><div class="l">Memória</div></div>
        <div class="stat"><div class="v">${bot.status === 'running' ? bot.cpu : '—'}<small>%</small></div><div class="l">CPU</div></div>
        <div class="stat"><div class="v">${bot.restarts}</div><div class="l">Reinícios automáticos</div></div>
      </div>`;
    $('#codeInfo').textContent = bot.hasCode ? `Arquivo principal: ${bot.entryFile} · último envio em ${fmtDateTime(bot.deployedAt)}` : 'Nenhum código enviado ainda. Envie um ZIP com seu projeto.';
    $('#tokenState').innerHTML = bot.hasToken ? '<span class="chip ok">salvo</span>' : '<span class="chip">não definido</span>';
    const opts = $('form[data-form="opts"]');
    if (opts && !opts.dataset.filled) {
      opts.elements.name.value = bot.name;
      opts.elements.entry.value = bot.entryFile || '';
      opts.elements.auto.checked = bot.autoRestart;
      opts.dataset.filled = '1';
    }
    void c;
  };
  renderEnv();
  renderLive();

  const upd = (b) => { if (b.id === id) { bot = { ...bot, ...b }; renderLive(); } };
  listen('status', upd);
  listen('stats', upd);

  actions['env-add'] = () => {
    const d = document.createElement('div');
    d.className = 'kv';
    d.dataset.new = '1';
    d.innerHTML = `<input type="text" placeholder="NOME_DA_VARIAVEL" autocomplete="off" aria-label="Nome" maxlength="64"><input type="password" placeholder="valor" autocomplete="off" aria-label="Valor"><button type="button" class="icon-btn" data-action="env-del" aria-label="Remover">${icon('x')}</button>`;
    const rows = $('#envRows');
    if (!$('.kv', rows)) rows.innerHTML = '';
    rows.append(d);
    $('input', d).focus();
  };
  actions['env-del'] = (btn) => {
    const row = btn.closest('.kv');
    if (row.dataset.existing) removed.add(row.dataset.existing);
    row.remove();
  };
  forms.token = async (f, fd) => {
    setError(f);
    try {
      await busy($('button', f), () => api(`/bots/${id}/token`, { method: 'PUT', body: { token: fd.get('token') } }));
      f.reset();
      toast('Token salvo com segurança.', 'ok');
      emitLocal((await api(`/bots/${id}`)).bot);
    } catch (e) { setError(f, e.message); }
  };
  forms.env = async (f) => {
    setError(f);
    const set = {};
    for (const row of $$('.kv', f)) {
      const [k, v] = $$('input', row);
      const key = (row.dataset.existing || k.value).trim();
      if (v.value && key) set[key] = v.value;
      else if (row.dataset.new && key && !v.value) return setError(f, `Informe o valor de ${key}.`);
    }
    try {
      const r = await busy($('button.btn.sm:not(.ghost)', f), () => api(`/bots/${id}/env`, { method: 'PUT', body: { set, remove: [...removed] } }));
      envKeys = r.envKeys;
      removed.clear();
      renderEnv();
      toast('Variáveis salvas.', 'ok');
      if (bot.status === 'running') toast('Reinicie o bot para aplicar.');
    } catch (e) { setError(f, e.message); }
  };
  forms.opts = async (f, fd) => {
    setError(f);
    const body = { name: fd.get('name'), autoRestart: f.elements.auto.checked };
    if (String(fd.get('entry') || '').trim()) body.entryFile = String(fd.get('entry')).trim();
    try {
      const r = await busy($('button', f), () => api(`/bots/${id}`, { method: 'PATCH', body }));
      emitLocal(r.bot);
      toast('Opções salvas.', 'ok');
    } catch (e) { setError(f, e.message); }
  };

  await mountConsole($('#console'), id);
}

/* ============ deploy e logs (escolhendo o bot) ============ */
function botSelect(selectedId) {
  return `<label class="field" style="max-width:360px"><span>Bot</span><select data-action="pick-bot">${state.bots.map((b) => `<option value="${b.id}" ${b.id === selectedId ? 'selected' : ''}>${esc(b.name)}</option>`).join('')}</select></label>`;
}
document.addEventListener('change', (e) => {
  const sel = e.target.closest('select[data-action="pick-bot"]');
  if (sel) location.hash = `${parseHash().path === '/logs' ? '#/logs' : '#/deploy'}?bot=${sel.value}`;
});
const noBots = (msg) => `<section class="panel empty"><h2>Crie um bot primeiro</h2><p>${msg}</p><button class="btn primary" data-action="bot-new">${icon('plus')} Novo bot</button></section>`;

async function viewDeploy(el, ctx) {
  await refreshBots();
  if (!state.bots.length) { el.innerHTML = `<div class="page-head"><h1>Deploy</h1></div>${noBots('Para enviar código, primeiro crie um bot.')}`; return; }
  const id = Number(ctx.params.get('bot')) || state.bots[0].id;
  const bot = state.bots.find((b) => b.id === id) || state.bots[0];
  el.innerHTML = `<div class="page-head"><div><h1>Deploy</h1><p>Envie o ZIP do projeto. Se o bot estiver ligado, ele reinicia sozinho com o código novo.</p></div></div>
    ${botSelect(bot.id)}${deployPanel(bot)}
    <section class="panel"><div class="console-bar"><h2>Console</h2><a href="#/bot/${bot.id}" class="muted" style="font-size:.88rem">Token e opções do bot</a></div><div class="console" id="console"></div></section>`;
  const info = () => {
    const b = state.bots.find((x) => x.id === bot.id);
    $('#codeInfo').textContent = b?.hasCode ? `Arquivo principal: ${b.entryFile} · status: ${statusOf(b)[0]}` : 'Nenhum código enviado ainda.';
  };
  info();
  listen('status', (b) => { if (b.id === bot.id) info(); });
  await mountConsole($('#console'), bot.id);
}

async function viewLogs(el, ctx) {
  await refreshBots();
  if (!state.bots.length) { el.innerHTML = `<div class="page-head"><h1>Logs</h1></div>${noBots('Os logs aparecem depois que você criar e iniciar um bot.')}`; return; }
  const id = Number(ctx.params.get('bot')) || state.bots[0].id;
  const bot = state.bots.find((b) => b.id === id) || state.bots[0];
  el.innerHTML = `<div class="page-head"><div><h1>Logs</h1><p>Saída do console em tempo real.</p></div>${chip(bot)}</div>
    ${botSelect(bot.id)}
    <section class="panel"><div class="console" id="console" style="height:min(62vh,560px)"></div></section>`;
  await mountConsole($('#console'), bot.id);
}

/* ============ planos ============ */
async function viewPlans(el, ctx) {
  const pg = ctx.params.get('pagamento');
  let activated = false;
  if (pg === 'success' || pg === 'pending') {
    try { activated = (await api('/billing/sync', { method: 'POST' })).activated; } catch {}
  }
  await refreshMe();
  const [{ plans, days, provider }, { payments }] = await Promise.all([api('/billing/plans'), api('/billing/history')]);
  const u = state.user;
  const PAY = { approved: ['Pago', 'ok'], pending: ['Aguardando', 'warn'], rejected: ['Recusado', 'bad'], failed: ['Falhou', 'bad'], expired: ['Expirado', ''] };
  const feats = (p) => [`${p.maxBots} bot${p.maxBots > 1 ? 's' : ''}`, `${p.memMB} MB de memória por bot`, `ZIP de até ${p.zipMB} MB`, 'Console ao vivo e reinício automático'];

  el.innerHTML = `
    <div class="page-head"><div><h1>Planos</h1><p>Cada pagamento libera ${days} dias. Pagando de novo antes do fim, o tempo é somado.</p></div></div>
    ${pg === 'failure' ? '<div class="banner bad"><span>O pagamento não foi concluído. Você pode tentar de novo.</span></div>' : ''}
    ${activated ? '<div class="banner ok"><span>Pagamento confirmado! Seu plano já está ativo.</span></div>' : ''}
    ${pg === 'pending' && !activated ? '<div class="banner info"><span>Estamos aguardando a confirmação do pagamento. Assim que chegar, o plano é ativado.</span><button class="btn sm" data-action="sync-pay">Já paguei, verificar</button></div>' : ''}
    <div class="plans">${plans.map((p) => {
      const cur = u.plan === p.id;
      return `<div class="plan ${cur ? 'current' : ''}">
        <div><h2>${esc(p.name)}</h2>${cur && u.planExpiresAt ? `<div class="muted" style="font-size:.84rem">até ${fmtDate(u.planExpiresAt)}</div>` : ''}</div>
        <div class="price">${p.priceCents ? fmtMoney(p.priceCents) : 'R$ 0'}${p.priceCents ? `<small> / ${days} dias</small>` : ''}</div>
        <ul>${feats(p).map((f) => `<li>${esc(f)}</li>`).join('')}</ul>
        ${p.id === 'free' ? `<button class="btn" disabled>${cur ? 'Plano atual' : 'Incluído em todas as contas'}</button>`
          : `<button class="btn ${cur ? '' : 'primary'}" data-action="checkout" data-plan="${p.id}">${cur ? `Renovar +${days} dias` : `Assinar ${esc(p.name)}`}</button>`}
      </div>`;
    }).join('')}</div>
    <p class="muted" style="font-size:.86rem">${provider === 'abacatepay' ? 'Pagamento por Pix: escaneie o QR Code e o plano é ativado em segundos.' : provider === 'mercadopago' ? 'Pagamento seguro pelo Mercado Pago (Pix, cartão e boleto).' : 'Pagamento por Pix: depois de pagar, o administrador confirma e o plano é ativado.'} Ao trocar de plano, os ${days} dias começam a contar do pagamento. Se o plano vencer, a conta volta para o Grátis e os bots acima do limite são desligados.</p>
    <section class="panel flat" style="margin-top:1.2rem"><div style="padding:1rem 1.2rem .2rem"><h2>Histórico de pagamentos</h2></div>
      ${payments.length ? `<div class="table-wrap"><table><thead><tr><th>Data</th><th>Plano</th><th>Valor</th><th>Situação</th><th></th></tr></thead><tbody>${payments.map((p) => `<tr><td>${fmtDateTime(p.createdAt)}</td><td>${esc(p.planName)}</td><td class="num">${fmtMoney(p.amountCents)}</td><td><span class="chip ${(PAY[p.status] || ['', ''])[1]}">${esc((PAY[p.status] || [p.status])[0])}</span></td><td>${p.status === 'pending' && p.provider === 'abacatepay' && p.expiresAt > Date.now() ? `<button class="btn sm" data-action="pix-open" data-id="${p.id}">Ver Pix</button>` : ''}</td></tr>`).join('')}</tbody></table></div>`
        : '<p class="muted" style="padding:0 1.2rem 1.2rem">Nenhum pagamento ainda.</p>'}
    </section>`;
}
actions.checkout = async (el) => {
  await busy(el, async () => {
    try {
      const r = await api('/billing/checkout', { method: 'POST', body: { plan: el.dataset.plan } });
      if (r.mode === 'mercadopago') { location.href = r.url; return; }
      if (r.mode === 'pix') { showPixDialog(r); return; }
      openDialog(`<h2>Pagar com Pix</h2>
        <p class="muted">Valor: <b style="color:var(--text)">${fmtMoney(r.amountCents)}</b></p>
        ${r.pixKey ? `<p class="muted" style="margin:0">Chave Pix${r.pixName ? ` (${esc(r.pixName)})` : ''}:</p><div class="pix">${esc(r.pixKey)}</div>`
          : '<div class="banner bad">O administrador ainda não configurou a chave Pix. Fale com o suporte.</div>'}
        <p class="muted" style="margin:0">No campo de mensagem do Pix, escreva o código:</p><div class="pix">${esc(r.reference)}</div>
        <p class="muted" style="font-size:.88rem">Depois de pagar, o administrador confirma e seu plano é ativado. Você recebe um e-mail.</p>
        <div class="foot"><button class="btn primary" data-action="dlg-close">Entendi</button></div>`);
      state.handlers.status.forEach(() => {});
    } catch (e) { toast(e.message, 'bad'); }
  });
};
/* Pix com QR Code (AbacatePay): mostra o código e confere o pagamento a cada poucos segundos. */
let pixTimer = null;
const stopPixPolling = () => { clearTimeout(pixTimer); pixTimer = null; };
function showPixDialog(p) {
  stopPixPolling();
  const d = openDialog(`<h2>Pague com Pix</h2>
    <p class="muted" style="margin-bottom:.8rem">Valor: <b style="color:var(--text)">${fmtMoney(p.amountCents)}</b>. Abra o app do seu banco e escaneie o QR Code, ou use o código copia e cola.</p>
    ${p.qr ? `<div style="background:#fff;border-radius:10px;padding:10px;width:fit-content;margin:0 auto .8rem"><img src="${esc(p.qr)}" alt="QR Code do Pix" width="210" height="210" style="display:block"></div>` : ''}
    <div class="pix" id="pixcode">${esc(p.brCode)}</div>
    <button class="btn block" data-action="pix-copy" data-code="${esc(p.brCode)}">Copiar código Pix</button>
    <p class="muted" id="pixstate" style="margin:.9rem 0 0;font-size:.9rem"><span class="spinner"></span> Aguardando o pagamento…</p>
    <div class="foot"><button class="btn ghost" data-action="pix-close">Fechar</button></div>`);
  d.onclose = stopPixPolling;
  const tick = async () => {
    try {
      const r = await api(`/billing/pay/${p.paymentId || p.id}`);
      if (r.status === 'approved') {
        stopPixPolling(); d.onclose = null; closeDialog();
        toast('Pagamento confirmado! Seu plano já está ativo.', 'ok');
        await refreshMe(); route();
        return;
      }
      if (r.status !== 'pending') {
        stopPixPolling();
        const st = $('#pixstate');
        if (st) st.textContent = 'Este Pix expirou. Feche e gere um novo.';
        return;
      }
    } catch {}
    pixTimer = setTimeout(tick, 4000);
  };
  pixTimer = setTimeout(tick, 3000);
}
actions['pix-copy'] = async (el) => {
  const code = el.dataset.code;
  try { await navigator.clipboard.writeText(code); toast('Código copiado.', 'ok'); }
  catch {
    const r = document.createRange(); r.selectNodeContents($('#pixcode'));
    const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r);
    toast('Segure sobre o código para copiar.');
  }
};
actions['pix-close'] = () => { closeDialog(); if (parseHash().path === '/planos') route(); };
actions['pix-open'] = async (el) => {
  await busy(el, async () => {
    try {
      const r = await api(`/billing/pay/${el.dataset.id}`);
      if (r.status === 'approved') { toast('Esse pagamento já foi confirmado.', 'ok'); route(); return; }
      if (r.status !== 'pending' || !r.brCode) { toast('Esse Pix não está mais disponível. Gere um novo.'); route(); return; }
      showPixDialog({ id: r.id, amountCents: r.amountCents, brCode: r.brCode, qr: r.qr });
    } catch (e) { toast(e.message, 'bad'); }
  });
};
actions['dlg-close'] = () => { closeDialog(); if (parseHash().path === '/planos') route(); };
actions['sync-pay'] = async (el) => {
  await busy(el, async () => {
    try { const r = await api('/billing/sync', { method: 'POST' }); toast(r.activated ? 'Pagamento confirmado!' : 'Ainda não confirmado. Tente de novo em instantes.', r.activated ? 'ok' : ''); if (r.activated) route(); }
    catch (e) { toast(e.message, 'bad'); }
  });
};

/* ============ configurações ============ */
async function viewSettings(el) {
  await refreshMe();
  const u = state.user;
  el.innerHTML = `
    <div class="page-head"><div><h1>Configurações</h1><p>Sua conta no BotNexus.</p></div></div>
    <section class="panel"><h2>Perfil</h2><p class="sub">${esc(u.email)} · plano ${esc(u.planName)}${u.planExpiresAt ? ` até ${fmtDate(u.planExpiresAt)}` : ''}</p>
      <form data-form="profile" novalidate><label class="field" style="max-width:360px"><span>Nome</span><input name="name" type="text" value="${esc(u.name)}" maxlength="60" required></label><button class="btn">Salvar nome</button></form></section>
    <section class="panel"><h2>Trocar senha</h2><p class="sub">Você continua logado neste aparelho; os outros são desconectados.</p>
      <form data-form="password" novalidate>
        <div class="row2"><label class="field"><span>Senha atual</span><input name="current" type="password" autocomplete="current-password" required></label>
        <label class="field"><span>Nova senha</span><input name="password" type="password" autocomplete="new-password" required></label></div>
        <button class="btn">Trocar senha</button></form></section>
    <section class="panel danger-zone"><h2>Excluir minha conta</h2><p class="sub">Apaga sua conta, todos os seus bots e arquivos. Não dá para desfazer.</p>
      <form data-form="delete-account" novalidate><label class="field" style="max-width:360px"><span>Confirme com sua senha</span><input name="password" type="password" autocomplete="current-password" required></label>
      <button class="btn danger">${icon('trash')} Excluir conta</button></form></section>`;
}
forms.profile = async (f, fd) => {
  setError(f);
  try { state.user = (await busy($('button', f), () => api('/me', { method: 'PATCH', body: { name: fd.get('name') } }))).user; toast('Nome atualizado.', 'ok'); }
  catch (e) { setError(f, e.message); }
};
forms.password = async (f, fd) => {
  setError(f);
  try { await busy($('button', f), () => api('/me/password', { method: 'POST', body: { current: fd.get('current'), password: fd.get('password') } })); f.reset(); toast('Senha alterada.', 'ok'); }
  catch (e) { setError(f, e.message); }
};
forms['delete-account'] = async (f, fd) => {
  setError(f);
  if (!(await confirmBox({ title: 'Excluir a conta de vez?', text: 'Seus bots, códigos e tokens serão apagados agora.', ok: 'Excluir tudo', danger: true }))) return;
  try {
    await busy($('button', f), () => api('/me', { method: 'DELETE', body: { password: fd.get('password') } }));
    state.user = null; disconnectSocket(); toast('Conta excluída.'); location.hash = '#/entrar';
  } catch (e) { setError(f, e.message); }
};

/* ============ ajuda ============ */
function viewHelp(el) {
  el.innerHTML = `
    <div class="page-head"><div><h1>Ajuda</h1><p>O essencial para colocar seu bot no ar.</p></div></div>
    <section class="panel">
      <details open><summary>Como pegar o token do bot</summary><ol>
        <li>Abra o Portal de Desenvolvedores do Discord e crie uma aplicação.</li>
        <li>Na aba <b>Bot</b>, clique em <b>Reset Token</b> e copie o valor.</li>
        <li>Cole na página do seu bot, em <b>Token e variáveis</b>. Nunca coloque o token dentro do código.</li></ol></details>
      <details><summary>Como montar o ZIP do projeto</summary>
        <p>Compacte a pasta do bot com o <code>package.json</code> e o arquivo principal (<code>index.js</code>, <code>bot.js</code>…). Não precisa incluir <code>node_modules</code>: o BotNexus instala as dependências sozinho. Use <code>process.env.DISCORD_TOKEN</code> para ler o token.</p></details>
      <details><summary>O que é o modo seguro?</summary>
        <p>Cada bot roda em um processo separado, que só enxerga a própria pasta. Por isso, bots que abrem outros programas (<code>child_process</code>) ou usam módulos nativos compilados não funcionam aqui. Bots comuns com discord.js funcionam normalmente.</p></details>
      <details><summary>Meu bot caiu. E agora?</summary>
        <p>Abra o console do bot e leia a última mensagem de erro. Se o reinício automático estiver ligado, ele tenta voltar sozinho até 5 vezes em 10 minutos. Erros comuns: token errado, <i>intents</i> não ativadas no portal do Discord, arquivo principal incorreto.</p></details>
      <details><summary>Limites dos planos</summary>
        <p>Cada plano define quantos bots você pode ter, a memória de cada um e o tamanho do ZIP. Se um bot passar muito do limite de memória, ele é reiniciado. Veja os valores na página <a href="#/planos">Planos</a>.</p></details>
      <details><summary>O que acontece se meu plano vencer?</summary>
        <p>A conta volta para o plano Grátis e os bots acima do limite são desligados. Seus dados continuam guardados: ao renovar, é só iniciar de novo.</p></details>
    </section>`;
}

/* ============ administração ============ */
async function viewAdmin(el) {
  const [stats, { users }, { payments }, { backups }] = await Promise.all([api('/admin/stats'), api('/admin/users'), api('/admin/payments'), api('/admin/backups')]);
  const s = stats.server;
  const PAY = { approved: ['Pago', 'ok'], pending: ['Pendente', 'warn'], rejected: ['Recusado', 'bad'], failed: ['Falhou', 'bad'], expired: ['Expirado', ''] };
  el.innerHTML = `
    <div class="page-head"><div><h1>Administração</h1><p>Visão geral do servidor.</p></div></div>
    <div class="stats">
      <div class="stat"><div class="v">${stats.users}</div><div class="l">Usuários (${stats.paidUsers} pagantes)</div></div>
      <div class="stat"><div class="v">${stats.botsRunning}<small> / ${stats.bots}</small></div><div class="l">Bots online</div></div>
      <div class="stat"><div class="v">${fmtMoney(stats.revenueCents)}</div><div class="l">Receita confirmada</div></div>
      <div class="stat"><div class="v">${s.freeMemMB}<small> MB</small></div><div class="l">Memória livre de ${s.totalMemMB} MB</div></div>
    </div>
    <p class="muted" style="font-size:.86rem">Servidor ligado há ${esc(fmtUptime(s.uptimeSec))} · carga ${esc(s.load)} · Node ${esc(s.node)} · isolamento dos bots ${s.sandbox ? 'ligado' : 'desligado'}</p>

    <section class="panel flat"><div style="padding:1rem 1.2rem .2rem"><h2>Pagamentos</h2></div>
      ${payments.length ? `<div class="table-wrap"><table><thead><tr><th>Data</th><th>Usuário</th><th>Plano</th><th>Valor</th><th>Código</th><th>Situação</th><th></th></tr></thead><tbody>${payments.map((p) => `<tr>
        <td>${fmtDateTime(p.created_at)}</td><td>${esc(p.email)}</td><td>${esc(p.plan)}</td><td class="num">${fmtMoney(p.amount_cents)}</td><td class="mono">${esc(p.reference)}</td>
        <td><span class="chip ${(PAY[p.status] || ['', ''])[1]}">${esc((PAY[p.status] || [p.status])[0])}</span></td>
        <td>${p.status === 'pending' && p.provider === 'manual' ? `<div class="actions"><button class="btn primary sm" data-action="adm-approve" data-id="${p.id}">Aprovar</button><button class="btn sm" data-action="adm-reject" data-id="${p.id}">Recusar</button></div>` : ''}</td></tr>`).join('')}</tbody></table></div>`
        : '<p class="muted" style="padding:0 1.2rem 1.2rem">Nenhum pagamento ainda.</p>'}
    </section>

    <section class="panel flat" style="margin-top:1.1rem"><div style="padding:1rem 1.2rem .2rem"><h2>Usuários</h2></div>
      <div class="table-wrap"><table><thead><tr><th>Nome</th><th>E-mail</th><th>Bots</th><th>Plano atual</th><th>Alterar plano</th></tr></thead><tbody>${users.map((u) => `<tr>
        <td>${esc(u.name)}${u.role === 'admin' ? ' <span class="chip">admin</span>' : ''}</td><td>${esc(u.email)}</td><td class="num">${u.bots}</td>
        <td>${esc(u.plan)}${u.plan !== 'free' && u.plan_expires_at ? ` até ${fmtDate(u.plan_expires_at)}` : ''}</td>
        <td><form data-form="adm-plan" data-id="${u.id}" class="actions" style="flex-wrap:nowrap"><select name="plan" style="width:110px;min-height:34px;padding:.3rem .5rem"><option value="free">free</option><option value="pro">pro</option><option value="premium">premium</option></select><input name="days" type="number" min="1" max="3650" value="30" style="width:78px;min-height:34px;padding:.3rem .5rem" aria-label="Dias"><button class="btn sm">Aplicar</button></form></td></tr>`).join('')}</tbody></table></div>
    </section>

    <section class="panel" style="margin-top:1.1rem"><div class="console-bar"><div><h2>Backups do banco</h2><p class="muted" style="margin:.2rem 0 0;font-size:.88rem">Automático a cada 24 h, guardando os 7 mais recentes em <code>backend/data/backups</code>.</p></div><button class="btn" data-action="adm-backup">Fazer backup agora</button></div>
      ${backups.length ? `<div class="table-wrap"><table><tbody>${backups.map((b) => `<tr><td class="mono">${esc(b.file)}</td><td class="num">${b.sizeKB} KB</td><td>${fmtDateTime(b.createdAt)}</td></tr>`).join('')}</tbody></table></div>` : '<p class="muted">Nenhum backup ainda.</p>'}
    </section>`;
  $$('form[data-form="adm-plan"]', el).forEach((f, i) => { f.elements.plan.value = users[i].plan; });
}
const admAct = (path, msg) => async (el) => {
  await busy(el, async () => { try { await api(path(el), { method: 'POST' }); toast(msg, 'ok'); route(); } catch (e) { toast(e.message, 'bad'); } });
};
actions['adm-approve'] = admAct((el) => `/admin/payments/${el.dataset.id}/approve`, 'Pagamento aprovado e plano ativado.');
actions['adm-reject'] = admAct((el) => `/admin/payments/${el.dataset.id}/reject`, 'Pagamento recusado.');
actions['adm-backup'] = admAct(() => '/admin/backups', 'Backup criado.');
forms['adm-plan'] = async (f, fd) => {
  try { await api(`/admin/users/${f.dataset.id}/plan`, { method: 'POST', body: { plan: fd.get('plan'), days: Number(fd.get('days')) } }); toast('Plano atualizado.', 'ok'); route(); }
  catch (e) { toast(e.message, 'bad'); }
};

/* ============ início ============ */
route();
})();
