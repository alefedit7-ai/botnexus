'use strict';
const express = require('express');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const crypto = require('crypto');
const config = require('../config');
const { db, now } = require('../db');
const { requireAuth } = require('../auth');
const { planOf } = require('../plans');
const { rateLimit } = require('../security');
const { httpError, wrap } = require('../util');
const runner = require('../botRunner');

const router = express.Router();
router.use(requireAuth);

const TMP = path.join(config.DATA_DIR, 'tmp');
fs.mkdirSync(TMP, { recursive: true });

function loadBot(req, res, next) {
  const bot = db.prepare('SELECT * FROM bots WHERE id = ? AND user_id = ?').get(Number(req.params.id), req.user.id);
  if (!bot) return res.status(404).json({ error: 'Bot não encontrado.' });
  req.bot = bot;
  next();
}

const cleanName = (s) => String(s || '').replace(/\s+/g, ' ').trim();
const validName = (n) => { if (n.length < 2 || n.length > 40) throw httpError(400, 'O nome do bot precisa ter de 2 a 40 caracteres.'); };

router.get('/', (req, res) => {
  const rows = db.prepare('SELECT * FROM bots WHERE user_id = ? ORDER BY id').all(req.user.id);
  res.json({ bots: rows.map(runner.describe) });
});

router.post('/', wrap(async (req, res) => {
  const name = cleanName(req.body?.name);
  validName(name);
  const plan = planOf(req.user);
  const count = db.prepare('SELECT COUNT(*) AS n FROM bots WHERE user_id = ?').get(req.user.id).n;
  if (count >= plan.maxBots) throw httpError(403, `Seu plano ${plan.name} permite ${plan.maxBots} bot(s). Faça upgrade para criar mais.`);
  const r = db.prepare('INSERT INTO bots (user_id, name, created_at) VALUES (?, ?, ?)').run(req.user.id, name, now());
  const bot = runner.getBot(Number(r.lastInsertRowid));
  res.status(201).json({ bot: runner.describe(bot) });
}));

router.get('/:id', loadBot, (req, res) => {
  res.json({ bot: { ...runner.describe(req.bot), envKeys: Object.keys(runner.loadEnvVars(req.bot)) } });
});

router.patch('/:id', loadBot, wrap(async (req, res) => {
  const b = req.body || {};
  if (b.name !== undefined) { const n = cleanName(b.name); validName(n); db.prepare('UPDATE bots SET name = ? WHERE id = ?').run(n, req.bot.id); }
  if (b.autoRestart !== undefined) db.prepare('UPDATE bots SET auto_restart = ? WHERE id = ?').run(b.autoRestart ? 1 : 0, req.bot.id);
  if (b.entryFile !== undefined) runner.setEntry(req.bot.id, b.entryFile);
  res.json({ bot: runner.describe(runner.getBot(req.bot.id)) });
}));

router.put('/:id/token', loadBot, wrap(async (req, res) => {
  runner.saveToken(req.bot.id, req.body?.token);
  res.json({ ok: true, hasToken: true });
}));

// Aceita { vars } (substitui tudo) ou { set, remove } (altera só o que mudou).
router.put('/:id/env', loadBot, wrap(async (req, res) => {
  const b = req.body || {};
  if (b.vars !== undefined) runner.saveEnvVars(req.bot.id, b.vars);
  else {
    const cur = runner.loadEnvVars(req.bot);
    for (const k of Array.isArray(b.remove) ? b.remove : []) delete cur[String(k)];
    Object.assign(cur, b.set && typeof b.set === 'object' && !Array.isArray(b.set) ? b.set : {});
    runner.saveEnvVars(req.bot.id, cur);
  }
  res.json({ ok: true, envKeys: Object.keys(runner.loadEnvVars(runner.getBot(req.bot.id))) });
}));

router.post('/:id/start', loadBot, wrap(async (req, res) => res.json({ bot: await runner.start(req.bot.id) })));
router.post('/:id/stop', loadBot, wrap(async (req, res) => { await runner.stop(req.bot.id); res.json({ bot: runner.describe(runner.getBot(req.bot.id)) }); }));
router.post('/:id/restart', loadBot, wrap(async (req, res) => res.json({ bot: await runner.restart(req.bot.id) })));

router.delete('/:id', loadBot, wrap(async (req, res) => { await runner.remove(req.bot.id); res.json({ ok: true }); }));

router.get('/:id/logs', loadBot, (req, res) => {
  const n = Math.min(Math.max(Number(req.query.tail) || 300, 1), 1000);
  res.json({ logs: runner.readLogs(req.bot.id, n) });
});

router.post('/:id/deploy', loadBot, rateLimit('deploy', 15, 3600_000), (req, res, next) => {
  const plan = planOf(req.user);
  const upload = multer({
    storage: multer.diskStorage({ destination: TMP, filename: (r, f, cb) => cb(null, crypto.randomBytes(12).toString('hex') + '.zip') }),
    limits: { fileSize: plan.zipMB * 1024 * 1024, files: 1 },
    fileFilter: (r, file, cb) => (/\.zip$/i.test(file.originalname) ? cb(null, true) : cb(httpError(400, 'Envie um arquivo .zip.'))),
  }).single('file');
  upload(req, res, (err) => {
    if (err) {
      if (err.code === 'LIMIT_FILE_SIZE') return next(httpError(413, `O ZIP passa do limite de ${plan.zipMB} MB do plano ${plan.name}.`));
      return next(err);
    }
    next();
  });
}, wrap(async (req, res) => {
  if (!req.file) throw httpError(400, 'Selecione um arquivo .zip.');
  try {
    const clean = req.body?.clean === '1' || req.body?.clean === 'true';
    const result = await runner.deploy(req.bot, req.file.path, { clean });
    res.status(202).json({ ok: true, ...result });
  } finally {
    fs.rm(req.file.path, { force: true }, () => {});
  }
}));

module.exports = router;
