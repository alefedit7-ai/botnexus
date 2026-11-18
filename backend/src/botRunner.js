'use strict';
// Executa cada bot em um processo separado do Node, com pasta própria,
// ambiente limpo, limite de memória e (quando disponível) sandbox de arquivos.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const EventEmitter = require('events');
const AdmZip = require('adm-zip');
const config = require('./config');
const { db } = require('./db');
const { encrypt, decrypt } = require('./crypto');
const { planOf } = require('./plans');
const { httpError } = require('./util');
const mailer = require('./mailer');

const events = new EventEmitter();
const BOTS_DIR = path.join(config.DATA_DIR, 'bots');
fs.mkdirSync(BOTS_DIR, { recursive: true });

const procs = new Map();          // botId -> estado do processo em execução
const restartTimers = new Map();
const restartInfo = new Map();    // botId -> { n, since }
const crashMailAt = new Map();
const logStreams = new Map();
const busy = new Set();           // bots com deploy em andamento
let installChain = Promise.resolve();

const botDir = (id) => path.join(BOTS_DIR, String(id));
const appDir = (id) => path.join(botDir(id), 'app');
const logPath = (id) => path.join(botDir(id), 'bot.log');
const pidPath = (id) => path.join(botDir(id), 'pid');

const sandboxSupported = process.allowedNodeEnvironmentFlags.has('--permission');
const sandboxOn = () => config.BOT_SANDBOX !== 'off' && sandboxSupported;

/* ---------- utilidades ---------- */
const ANSI_RE = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;
const DISCORD_TOKEN_RE = /[MNO][A-Za-z\d_-]{23,27}\.[\w-]{6}\.[\w-]{27,}/g;

function maskSecrets(text, secrets) {
  let out = text.replace(ANSI_RE, '').replace(DISCORD_TOKEN_RE, '[token oculto]');
  for (const s of secrets) if (s && s.length >= 6) out = out.split(s).join('[oculto]');
  return out;
}

function normalizeRel(p) {
  const n = path.posix.normalize(String(p || '').replace(/\\/g, '/').replace(/^\.\//, ''));
  if (!n || n === '.' || n.startsWith('..') || path.posix.isAbsolute(n) || n.includes('\0')) return null;
  return n;
}

function safeEnv(extra) {
  const keep = ['PATH', 'TMPDIR', 'PREFIX', 'LANG', 'LC_ALL', 'TZ', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS'];
  const env = {};
  for (const k of keep) if (process.env[k] !== undefined) env[k] = process.env[k];
  return Object.assign(env, extra);
}

const getBot = (id) => db.prepare('SELECT * FROM bots WHERE id = ?').get(id);

function emitStatus(id) {
  const row = getBot(id);
  if (row) events.emit('status', id, row.user_id, describe(row));
}

function setStatus(id, status, fields = {}) {
  const sets = ['status = ?'];
  const vals = [status];
  for (const [k, v] of Object.entries(fields)) { sets.push(`${k} = ?`); vals.push(v); }
  db.prepare(`UPDATE bots SET ${sets.join(', ')} WHERE id = ?`).run(...vals, id);
  emitStatus(id);
}

/* ---------- logs ---------- */
function stream(id) {
  let s = logStreams.get(id);
  if (!s) {
    fs.mkdirSync(botDir(id), { recursive: true });
    s = fs.createWriteStream(logPath(id), { flags: 'a' });
    s.on('error', () => {});
    logStreams.set(id, s);
  }
  return s;
}

function writeLog(id, kind, text, secrets = []) {
  const clean = maskSecrets(String(text), secrets);
  for (const raw of clean.split(/\r?\n/)) {
    const m = raw.trimEnd();
    if (!m) continue;
    const line = { t: Date.now(), s: kind, m: m.slice(0, 2000) };
    stream(id).write(JSON.stringify(line) + '\n');
    events.emit('log', id, line);
  }
}

function lineReader(onChunk) {
  let buf = '';
  let timer = null;
  const flush = () => { if (buf) { onChunk(buf); buf = ''; } };
  const feed = (data) => {
    buf += data.toString('utf8');
    const parts = buf.split('\n');
    buf = parts.pop();
    if (parts.length) onChunk(parts.join('\n'));
    clearTimeout(timer);
    if (buf) timer = setTimeout(flush, 200);
  };
  feed.flush = () => { clearTimeout(timer); flush(); };
  return feed;
}

function readLogs(id, n = 300) {
  try {
    const f = logPath(id);
    const st = fs.statSync(f);
    const size = Math.min(st.size, 131072);
    const fd = fs.openSync(f, 'r');
    const buf = Buffer.alloc(size);
    fs.readSync(fd, buf, 0, size, st.size - size);
    fs.closeSync(fd);
    const lines = buf.toString('utf8').split('\n');
    if (st.size > size) lines.shift();
    const out = [];
    for (const l of lines) { if (!l) continue; try { out.push(JSON.parse(l)); } catch {} }
    return out.slice(-n);
  } catch { return []; }
}

function rotateLog(id) {
  try {
    const st = fs.statSync(logPath(id));
    if (st.size < 2 * 1024 * 1024) return;
    const old = logStreams.get(id);
    if (old) { old.end(); logStreams.delete(id); }
    const keep = 512 * 1024;
    const fd = fs.openSync(logPath(id), 'r');
    const buf = Buffer.alloc(keep);
    fs.readSync(fd, buf, 0, keep, st.size - keep);
    fs.closeSync(fd);
    const text = buf.toString('utf8');
    fs.writeFileSync(logPath(id), text.slice(text.indexOf('\n') + 1));
  } catch {}
}

/* ---------- estatísticas ---------- */
function readProc(pid) {
  try {
    const status = fs.readFileSync(`/proc/${pid}/status`, 'utf8');
    const m = status.match(/VmRSS:\s+(\d+)\s*kB/);
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const rest = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    return { rssMB: m ? Number(m[1]) / 1024 : 0, ticks: Number(rest[11]) + Number(rest[12]) };
  } catch { return null; }
}

function sample(id, st) {
  const s = readProc(st.proc.pid);
  if (!s) return;
  const t = Date.now();
  if (st.cpuAt) st.cpuPct = Math.max(0, Math.round(((s.ticks - st.cpuTicks) / 100 / ((t - st.cpuAt) / 1000)) * 100));
  st.cpuTicks = s.ticks;
  st.cpuAt = t;
  st.memMB = s.rssMB;
  st.sampledAt = t;
}

function describe(row) {
  const st = procs.get(row.id);
  if (st && Date.now() - (st.sampledAt || 0) > 2000) sample(row.id, st);
  return {
    id: row.id, name: row.name, status: row.status, desired: row.desired,
    hasToken: !!row.token_enc, hasCode: !!row.entry_file, entryFile: row.entry_file,
    autoRestart: !!row.auto_restart, restarts: row.restarts, lastExit: row.last_exit,
    uptimeSec: st ? Math.floor((Date.now() - st.startedAt) / 1000) : 0,
    memMB: st ? Math.round(st.memMB) : 0, cpu: st ? st.cpuPct : 0, memLimitMB: st ? st.memLimitMB : null,
    deployedAt: row.deployed_at, createdAt: row.created_at,
  };
}

/* ---------- deploy (ZIP) ---------- */
function extractZip(zipPath, dir, plan) {
  const head = Buffer.alloc(4);
  const fd = fs.openSync(zipPath, 'r');
  fs.readSync(fd, head, 0, 4, 0);
  fs.closeSync(fd);
  if (head[0] !== 0x50 || head[1] !== 0x4b) throw httpError(400, 'O arquivo enviado não é um ZIP válido.');

  let zip;
  try { zip = new AdmZip(zipPath); } catch { throw httpError(400, 'Não consegui abrir o ZIP. Ele pode estar corrompido.'); }
  const entries = zip.getEntries();
  if (entries.length > 5000) throw httpError(400, 'ZIP com arquivos demais (limite: 5000).');

  const limit = config.MAX_UNZIPPED_MB * 1024 * 1024;
  let total = 0;
  const files = [];
  for (const e of entries) {
    if (e.isDirectory) continue;
    const name = e.entryName.replace(/\\/g, '/');
    const parts = name.split('/');
    if (name.startsWith('/') || /^[A-Za-z]:/.test(name) || parts.includes('..') || name.includes('\0')) {
      throw httpError(400, 'ZIP recusado: contém caminhos inseguros.');
    }
    total += e.header.size;
    if (total > limit) throw httpError(400, `ZIP descompactado passa de ${config.MAX_UNZIPPED_MB} MB.`);
    files.push({ entry: e, parts });
  }
  if (!files.length) throw httpError(400, 'O ZIP está vazio.');

  const skip = (parts) => {
    const base = parts[parts.length - 1];
    return parts.includes('node_modules') || parts.includes('.git') || parts[0] === '__MACOSX' ||
      base === '.DS_Store' || base === '.env' || base.startsWith('.env.');
  };
  const kept = files.filter((f) => !skip(f.parts));
  if (!kept.length) throw httpError(400, 'O ZIP não tem arquivos de código utilizáveis.');

  // Se tudo estiver dentro de uma única pasta, remove essa pasta.
  const top = new Set(kept.map((f) => f.parts[0]));
  const strip = top.size === 1 && kept.every((f) => f.parts.length > 1) ? 1 : 0;

  const root = path.resolve(dir);
  let written = 0;
  for (const f of kept) {
    const rel = f.parts.slice(strip).join('/');
    const dest = path.resolve(root, rel);
    if (dest !== root && !dest.startsWith(root + path.sep)) throw httpError(400, 'ZIP recusado: caminho fora da pasta do bot.');
    const data = f.entry.getData();
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, data, { mode: 0o644 });
    written += 1;
  }
  return { written, skipped: files.length - kept.length };
}

function detectEntry(dir) {
  const cands = [];
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    if (typeof pkg.main === 'string') cands.push(pkg.main);
    const st = pkg.scripts && pkg.scripts.start;
    if (typeof st === 'string') {
      const m = st.match(/node(?:\s+--?[\w-]+(?:=\S+)?)*\s+([^\s&|;]+\.(?:c|m)?js)/);
      if (m) cands.push(m[1]);
    }
  } catch {}
  cands.push('index.js', 'bot.js', 'main.js', 'app.js', 'src/index.js', 'src/bot.js', 'src/main.js', 'index.mjs', 'bot.mjs');
  for (const c of cands) {
    const rel = normalizeRel(c);
    if (!rel) continue;
    try { if (fs.statSync(path.join(dir, rel)).isFile()) return rel; } catch {}
  }
  return null;
}

function needsInstall(dir) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    return Object.keys(pkg.dependencies || {}).length > 0;
  } catch { return false; }
}

function runInstall(id) {
  const job = installChain.then(() => new Promise((resolve, reject) => {
    writeLog(id, 'sys', 'Instalando dependências (npm install)…');
    const child = spawn(process.platform === 'win32' ? 'npm.cmd' : 'npm',
      ['install', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', '--loglevel=error'],
      {
        cwd: appDir(id), stdio: ['ignore', 'pipe', 'pipe'],
        env: safeEnv({
          HOME: botDir(id), NODE_ENV: 'production',
          npm_config_cache: path.join(config.DATA_DIR, 'npm-cache'),
          npm_config_update_notifier: 'false',
        }),
      });
    const out = lineReader((t) => writeLog(id, 'sys', t));
    child.stdout.on('data', out);
    child.stderr.on('data', out);
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('npm install demorou mais de 5 minutos.')); }, 300_000);
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => {
      clearTimeout(timer); out.flush();
      code === 0 ? resolve() : reject(new Error(`npm install falhou (código ${code}).`));
    });
  }));
  installChain = job.catch(() => {});
  return job;
}

async function deploy(bot, zipPath, { clean = false } = {}) {
  const id = bot.id;
  if (busy.has(id)) throw httpError(409, 'Já existe um deploy em andamento para este bot.');
  const owner = db.prepare('SELECT * FROM users WHERE id = ?').get(bot.user_id);
  const plan = planOf(owner);
  busy.add(id);
  try {
    const wasRunning = procs.has(id) || bot.desired === 'running';
    await stop(id, { keepDesired: true });
    const dir = appDir(id);
    if (clean) fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    const info = extractZip(zipPath, dir, plan);

    let entry = bot.entry_file && fs.existsSync(path.join(dir, bot.entry_file)) ? bot.entry_file : detectEntry(dir);
    writeLog(id, 'sys', `Deploy recebido: ${info.written} arquivos${info.skipped ? ` (${info.skipped} ignorados: node_modules, .git, .env)` : ''}.`);
    if (!entry) {
      setStatus(id, 'error', { last_exit: 'Arquivo principal não encontrado.', deployed_at: Date.now() });
      writeLog(id, 'sys', 'Não achei o arquivo principal (index.js, bot.js, main.js…). Defina-o nas opções do bot.');
      busy.delete(id);
      return { installing: false, entry: null };
    }
    db.prepare('UPDATE bots SET entry_file = ?, deployed_at = ? WHERE id = ?').run(entry, Date.now(), id);

    if (needsInstall(dir)) {
      setStatus(id, 'installing', { last_exit: null });
      runInstall(id)
        .then(() => { writeLog(id, 'sys', 'Dependências instaladas.'); setStatus(id, 'stopped'); })
        .catch((e) => { writeLog(id, 'sys', `Erro: ${e.message}`); setStatus(id, 'error', { last_exit: e.message }); })
        .finally(async () => {
          busy.delete(id);
          const fresh = getBot(id);
          if (fresh && fresh.status === 'stopped' && wasRunning && fresh.token_enc) {
            try { await start(id); } catch (e) { writeLog(id, 'sys', e.message); }
          }
        });
      return { installing: true, entry };
    }

    setStatus(id, 'stopped', { last_exit: null });
    busy.delete(id);
    if (wasRunning && bot.token_enc) { try { await start(id); } catch (e) { writeLog(id, 'sys', e.message); } }
    return { installing: false, entry };
  } catch (e) {
    busy.delete(id);
    throw e;
  }
}

/* ---------- iniciar / parar ---------- */
async function start(id) {
  const bot = getBot(id);
  if (!bot) throw httpError(404, 'Bot não encontrado.');
  if (procs.has(id)) return describe(bot);
  if (busy.has(id) || bot.status === 'installing') throw httpError(409, 'Aguarde: o deploy ainda está em andamento.');
  const owner = db.prepare('SELECT * FROM users WHERE id = ?').get(bot.user_id);
  const plan = planOf(owner);

  let runningOfOwner = 0;
  for (const bid of procs.keys()) if (getBot(bid)?.user_id === owner.id) runningOfOwner += 1;
  if (runningOfOwner >= plan.maxBots) throw httpError(403, `Seu plano ${plan.name} permite ${plan.maxBots} bot(s) ligado(s) ao mesmo tempo.`);

  if (!bot.entry_file || !fs.existsSync(path.join(appDir(id), bot.entry_file))) throw httpError(400, 'Envie o código (ZIP) antes de iniciar.');
  if (!bot.token_enc) throw httpError(400, 'Salve o token do bot antes de iniciar.');
  if (config.BOT_SANDBOX === 'on' && !sandboxSupported) throw httpError(500, 'BOT_SANDBOX=on, mas este Node não suporta --permission. Atualize o Node.');

  const token = decrypt(bot.token_enc);
  let userEnv = {};
  try { userEnv = bot.env_enc ? JSON.parse(decrypt(bot.env_enc)) : {}; } catch {}

  clearTimeout(restartTimers.get(id));
  restartTimers.delete(id);
  rotateLog(id);

  const env = safeEnv({ DISCORD_TOKEN: token, TOKEN: token, BOT_TOKEN: token, NODE_ENV: 'production', ...userEnv, HOME: botDir(id) });
  const memLimitMB = plan.memMB;
  const args = [];
  if (sandboxOn()) args.push('--permission', `--allow-fs-read=${appDir(id)}`, `--allow-fs-write=${appDir(id)}`);
  args.push(`--max-old-space-size=${Math.max(48, Math.floor(memLimitMB * 0.75))}`, bot.entry_file);

  const secrets = [token, ...Object.values(userEnv).map(String)];
  const proc = spawn(process.execPath, args, { cwd: appDir(id), env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  const st = { proc, startedAt: Date.now(), stopping: false, killReason: null, memMB: 0, cpuPct: 0, cpuTicks: 0, cpuAt: 0, memLimitMB };
  procs.set(id, st);

  const out = lineReader((t) => writeLog(id, 'out', t, secrets));
  const err = lineReader((t) => writeLog(id, 'err', t, secrets));
  proc.stdout.on('data', out);
  proc.stderr.on('data', err);
  proc.on('error', (e) => writeLog(id, 'sys', `Falha ao iniciar o processo: ${e.message}`));
  if (proc.pid) { try { fs.writeFileSync(pidPath(id), String(proc.pid)); } catch {} }

  writeLog(id, 'sys', `Bot iniciado (arquivo ${bot.entry_file}${sandboxOn() ? ', modo seguro ligado' : ''}).`);
  setStatus(id, 'running', { desired: 'running', started_at: st.startedAt, last_exit: null });

  proc.on('exit', (code, signal) => {
    out.flush(); err.flush();
    procs.delete(id);
    try { fs.unlinkSync(pidPath(id)); } catch {}
    const ranFor = Date.now() - st.startedAt;
    const fresh = getBot(id);
    if (!fresh) return;

    if (st.stopping) {
      writeLog(id, 'sys', 'Bot parado.');
      setStatus(id, 'stopped', { last_exit: null });
      return;
    }
    if (code === 0 && !st.killReason) {
      writeLog(id, 'sys', 'O bot terminou sozinho (código 0).');
      setStatus(id, 'stopped', { desired: 'stopped', last_exit: 'Terminou sozinho (código 0).' });
      return;
    }
    const reason = st.killReason || (signal ? `Encerrado pelo sistema (${signal}).` : `Caiu com código ${code}.`);
    writeLog(id, 'sys', reason);
    setStatus(id, 'crashed', { last_exit: reason });
    handleCrash(id, fresh, owner, reason, ranFor);
  });

  return describe(getBot(id));
}

function handleCrash(id, bot, owner, reason, ranFor) {
  const last = crashMailAt.get(id) || 0;
  if (Date.now() - last > 30 * 60_000) { crashMailAt.set(id, Date.now()); mailer.sendBotCrashed(owner, bot, reason); }

  if (!bot.auto_restart || bot.desired !== 'running') return;
  let info = restartInfo.get(id);
  if (!info || ranFor > 10 * 60_000 || Date.now() - info.since > 10 * 60_000) info = { n: 0, since: Date.now() };
  info.n += 1;
  restartInfo.set(id, info);
  if (info.n > 5) {
    writeLog(id, 'sys', 'Muitas falhas seguidas. Reinício automático desativado. Corrija o erro e inicie de novo.');
    db.prepare("UPDATE bots SET desired = 'stopped' WHERE id = ?").run(id);
    emitStatus(id);
    return;
  }
  const delay = [5, 15, 30, 60, 120][info.n - 1] * 1000;
  writeLog(id, 'sys', `Reiniciando automaticamente em ${delay / 1000}s (tentativa ${info.n}/5)…`);
  restartTimers.set(id, setTimeout(async () => {
    restartTimers.delete(id);
    try {
      db.prepare('UPDATE bots SET restarts = restarts + 1 WHERE id = ?').run(id);
      await start(id);
    } catch (e) { writeLog(id, 'sys', `Não foi possível reiniciar: ${e.message}`); }
  }, delay));
}

async function stop(id, { keepDesired = false } = {}) {
  clearTimeout(restartTimers.get(id));
  restartTimers.delete(id);
  if (!keepDesired) db.prepare("UPDATE bots SET desired = 'stopped' WHERE id = ?").run(id);
  const st = procs.get(id);
  if (!st) {
    const b = getBot(id);
    if (b && (b.status === 'running' || b.status === 'crashed')) setStatus(id, 'stopped');
    return;
  }
  st.stopping = true;
  await new Promise((resolve) => {
    const kill = setTimeout(() => { try { st.proc.kill('SIGKILL'); } catch {} }, 5000);
    const giveUp = setTimeout(resolve, 9000);
    st.proc.once('exit', () => { clearTimeout(kill); clearTimeout(giveUp); resolve(); });
    try { st.proc.kill('SIGTERM'); } catch { resolve(); }
  });
}

async function restart(id) {
  await stop(id, { keepDesired: true });
  return start(id);
}

async function remove(id) {
  await stop(id);
  const s = logStreams.get(id);
  if (s) { s.end(); logStreams.delete(id); }
  restartInfo.delete(id);
  crashMailAt.delete(id);
  fs.rmSync(botDir(id), { recursive: true, force: true });
  db.prepare('DELETE FROM bots WHERE id = ?').run(id);
}

async function removeAllOfUser(userId) {
  for (const b of db.prepare('SELECT id FROM bots WHERE user_id = ?').all(userId)) await remove(b.id);
}

/* ---------- configuração do bot ---------- */
const RESERVED_ENV = /^(PATH|HOME|NODE_OPTIONS|NODE_PATH|NODE_EXTRA_CA_CERTS|LD_.*|DYLD_.*|npm_.*|UV_.*|TMPDIR|PREFIX)$/i;

function saveToken(id, token) {
  const t = String(token || '').trim();
  if (t.length < 20 || t.length > 200 || /\s/.test(t)) throw httpError(400, 'Token inválido. Copie o token completo do Portal de Desenvolvedores do Discord.');
  db.prepare('UPDATE bots SET token_enc = ? WHERE id = ?').run(encrypt(t), id);
}

function loadEnvVars(bot) {
  try { return bot.env_enc ? JSON.parse(decrypt(bot.env_enc)) : {}; } catch { return {}; }
}

function saveEnvVars(id, vars) {
  if (!vars || typeof vars !== 'object' || Array.isArray(vars)) throw httpError(400, 'Formato inválido.');
  const out = {};
  const entries = Object.entries(vars);
  if (entries.length > 30) throw httpError(400, 'Máximo de 30 variáveis.');
  for (const [k, v] of entries) {
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(k)) throw httpError(400, `Nome de variável inválido: ${k}`);
    if (RESERVED_ENV.test(k)) throw httpError(400, `O nome ${k} é reservado pelo sistema.`);
    if (typeof v !== 'string' || v.length > 2000) throw httpError(400, `Valor inválido em ${k}.`);
    out[k] = v;
  }
  db.prepare('UPDATE bots SET env_enc = ? WHERE id = ?').run(Object.keys(out).length ? encrypt(JSON.stringify(out)) : null, id);
}

function setEntry(id, file) {
  const rel = normalizeRel(file);
  if (!rel || !/\.(c|m)?js$/.test(rel)) throw httpError(400, 'Informe um arquivo .js válido (ex.: index.js).');
  if (!fs.existsSync(path.join(appDir(id), rel))) throw httpError(400, 'Esse arquivo não existe no código enviado.');
  db.prepare('UPDATE bots SET entry_file = ? WHERE id = ?').run(rel, id);
}

/* ---------- monitoramento / ciclo de vida ---------- */
function checkLimits() {
  for (const [id, st] of procs) {
    sample(id, st);
    if (!st.stopping && st.memMB > st.memLimitMB * 1.3 + 32) {
      st.killReason = `Passou do limite de memória do plano (${Math.round(st.memMB)} MB de ${st.memLimitMB} MB).`;
      try { st.proc.kill('SIGKILL'); } catch {}
    }
  }
}

function reapOrphans() {
  let dirs = [];
  try { dirs = fs.readdirSync(BOTS_DIR); } catch {}
  for (const d of dirs) {
    const f = path.join(BOTS_DIR, d, 'pid');
    try {
      const pid = Number(fs.readFileSync(f, 'utf8'));
      if (pid > 1) {
        let cmd = '';
        try { cmd = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8'); } catch {}
        if (cmd.includes(path.join(BOTS_DIR, d))) { try { process.kill(pid, 'SIGKILL'); } catch {} }
      }
      fs.unlinkSync(f);
    } catch {}
  }
}

async function restoreOnBoot() {
  reapOrphans();
  db.prepare("UPDATE bots SET status = 'stopped' WHERE status IN ('running', 'installing', 'crashed')").run();
  const rows = db.prepare("SELECT id FROM bots WHERE desired = 'running'").all();
  for (const r of rows) {
    try { await start(r.id); writeLog(r.id, 'sys', 'Bot religado automaticamente após reinício do servidor.'); }
    catch (e) { writeLog(r.id, 'sys', `Não foi possível religar: ${e.message}`); }
    await new Promise((res) => setTimeout(res, 1500));
  }
}

async function stopAll() {
  await Promise.all([...procs.keys()].map((id) => stop(id, { keepDesired: true })));
}

const runningCount = () => procs.size;
const isRunning = (id) => procs.has(id);

module.exports = {
  events, describe, getBot, deploy, start, stop, restart, remove, removeAllOfUser,
  saveToken, saveEnvVars, loadEnvVars, setEntry, readLogs, writeLog,
  checkLimits, restoreOnBoot, stopAll, runningCount, isRunning, sandboxOn, sandboxSupported, BOTS_DIR,
};
