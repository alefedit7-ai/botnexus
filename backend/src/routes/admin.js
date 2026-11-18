'use strict';
const express = require('express');
const fs = require('fs');
const { db, now } = require('../db');
const { requireAuth, requireAdmin } = require('../auth');
const { PLANS, PLAN_DAYS } = require('../plans');
const { httpError, wrap } = require('../util');
const runner = require('../botRunner');
const monitor = require('../monitor');
const { activatePlan } = require('./billing');
const os = require('os');

const router = express.Router();
router.use(requireAuth, requireAdmin);

router.get('/stats', (req, res) => {
  const one = (sql) => db.prepare(sql).get();
  res.json({
    users: one('SELECT COUNT(*) AS n FROM users').n,
    paidUsers: one("SELECT COUNT(*) AS n FROM users WHERE plan != 'free' AND plan_expires_at > " + now()).n,
    bots: one('SELECT COUNT(*) AS n FROM bots').n,
    botsRunning: runner.runningCount(),
    revenueCents: one("SELECT COALESCE(SUM(amount_cents), 0) AS n FROM payments WHERE status = 'approved'").n,
    pendingPayments: one("SELECT COUNT(*) AS n FROM payments WHERE status = 'pending' AND provider = 'manual'").n,
    server: {
      uptimeSec: Math.floor(process.uptime()),
      freeMemMB: Math.round(os.freemem() / 1048576),
      totalMemMB: Math.round(os.totalmem() / 1048576),
      load: os.loadavg()[0].toFixed(2),
      node: process.version,
      sandbox: runner.sandboxOn(),
    },
    lastBackup: monitor.listBackups()[0] || null,
  });
});

router.get('/users', (req, res) => {
  const rows = db.prepare(`SELECT u.id, u.name, u.email, u.role, u.plan, u.plan_expires_at, u.created_at,
    (SELECT COUNT(*) FROM bots b WHERE b.user_id = u.id) AS bots FROM users u ORDER BY u.id DESC LIMIT 200`).all();
  res.json({ users: rows });
});

router.post('/users/:id/plan', (req, res) => {
  const plan = PLANS[String(req.body?.plan)];
  if (!plan) throw httpError(400, 'Plano inválido.');
  const days = plan.id === 'free' ? 0 : Math.min(Math.max(Number(req.body?.days) || PLAN_DAYS, 1), 3650);
  const exp = plan.id === 'free' ? null : now() + days * 24 * 3600 * 1000;
  const r = db.prepare('UPDATE users SET plan = ?, plan_expires_at = ? WHERE id = ?').run(plan.id, exp, Number(req.params.id));
  if (!r.changes) throw httpError(404, 'Usuário não encontrado.');
  res.json({ ok: true });
});

router.get('/payments', (req, res) => {
  const rows = db.prepare(`SELECT p.id, p.plan, p.amount_cents, p.provider, p.status, p.external_ref, p.created_at, u.email
    FROM payments p JOIN users u ON u.id = p.user_id ORDER BY (p.status = 'pending') DESC, p.id DESC LIMIT 60`).all();
  res.json({ payments: rows.map((p) => ({ ...p, reference: p.external_ref.slice(0, 8).toUpperCase(), external_ref: undefined })) });
});

router.post('/payments/:id/approve', (req, res) => {
  const p = db.prepare("SELECT * FROM payments WHERE id = ? AND provider = 'manual'").get(Number(req.params.id));
  if (!p) throw httpError(404, 'Pagamento manual não encontrado.');
  if (p.status === 'approved') throw httpError(409, 'Este pagamento já foi aprovado.');
  activatePlan(p.id);
  res.json({ ok: true });
});

router.post('/payments/:id/reject', (req, res) => {
  const r = db.prepare("UPDATE payments SET status = 'rejected' WHERE id = ? AND provider = 'manual' AND status = 'pending'").run(Number(req.params.id));
  if (!r.changes) throw httpError(404, 'Pagamento pendente não encontrado.');
  res.json({ ok: true });
});

router.get('/backups', (req, res) => res.json({ backups: monitor.listBackups() }));
router.post('/backups', wrap(async (req, res) => res.json({ backup: monitor.backupNow() })));

module.exports = router;
