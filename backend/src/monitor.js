'use strict';
// Vigia o servidor: planos vencidos, limites de memória, alertas e backups.
const fs = require('fs');
const os = require('os');
const path = require('path');
const config = require('./config');
const { db, now } = require('./db');
const { PLANS, planOf } = require('./plans');
const runner = require('./botRunner');
const mailer = require('./mailer');

const BACKUP_DIR = path.join(config.DATA_DIR, 'backups');
const KEEP_BACKUPS = 7;
let lastMemAlert = 0;
const timers = [];

function listBackups() {
  try {
    return fs.readdirSync(BACKUP_DIR).filter((f) => f.endsWith('.db')).map((f) => {
      const st = fs.statSync(path.join(BACKUP_DIR, f));
      return { file: f, sizeKB: Math.round(st.size / 1024), createdAt: st.mtimeMs };
    }).sort((a, b) => b.createdAt - a.createdAt);
  } catch { return []; }
}

function backupNow() {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const d = new Date();
  const p2 = (n) => String(n).padStart(2, '0');
  const stamp = `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}`;
  const file = path.join(BACKUP_DIR, `botnexus-${stamp}.db`);
  db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
  for (const old of listBackups().slice(KEEP_BACKUPS)) fs.rmSync(path.join(BACKUP_DIR, old.file), { force: true });
  console.log(`[backup] criado ${path.basename(file)}`);
  return listBackups()[0];
}

async function expirePlans() {
  const rows = db.prepare("SELECT * FROM users WHERE plan != 'free' AND plan_expires_at IS NOT NULL AND plan_expires_at < ?").all(now());
  for (const u of rows) {
    const old = PLANS[u.plan] || PLANS.free;
    db.prepare("UPDATE users SET plan = 'free', plan_expires_at = NULL WHERE id = ?").run(u.id);
    const free = planOf({ plan: 'free' });
    const bots = db.prepare('SELECT id FROM bots WHERE user_id = ? ORDER BY id').all(u.id);
    for (const b of bots.slice(free.maxBots)) await runner.stop(b.id);
    mailer.sendPlanExpired(u, old);
    console.log(`[planos] plano de ${u.email} venceu; voltou para Grátis`);
  }
}

function cleanup() {
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(now());
  db.prepare('DELETE FROM reset_tokens WHERE expires_at < ? OR used = 1').run(now());
}

function checkServer() {
  const free = os.freemem() / os.totalmem();
  if (free < 0.08 && Date.now() - lastMemAlert > 3600_000) {
    lastMemAlert = Date.now();
    mailer.sendAdminAlert('Pouca memória no servidor', `Só ${Math.round(free * 100)}% da memória está livre (${Math.round(os.freemem() / 1048576)} MB).`);
  }
}

function start() {
  const every = (ms, fn) => { const t = setInterval(() => Promise.resolve(fn()).catch((e) => console.error('[monitor]', e.message)), ms); t.unref(); timers.push(t); };
  every(10_000, runner.checkLimits);
  every(60_000, async () => { await expirePlans(); cleanup(); checkServer(); });
  every(24 * 3600_000, backupNow);
  const last = listBackups()[0];
  if (!last || Date.now() - last.createdAt > 24 * 3600_000) { try { backupNow(); } catch (e) { console.error('[backup] falhou:', e.message); } }
  expirePlans().catch(() => {});
}

module.exports = { start, backupNow, listBackups };
