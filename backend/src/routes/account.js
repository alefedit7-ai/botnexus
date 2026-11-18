'use strict';
const express = require('express');
const { db } = require('../db');
const { requireAuth, parseCookies } = require('../auth');
const { verifyPassword } = require('../crypto');
const { httpError, wrap } = require('../util');
const runner = require('../botRunner');

const router = express.Router();

// Exclui a conta e tudo dela (bots, arquivos, pagamentos).
router.delete('/me', requireAuth, wrap(async (req, res) => {
  if (!(await verifyPassword(String(req.body?.password || ''), req.user.pass_hash))) throw httpError(400, 'Senha incorreta.');
  if (req.user.role === 'admin' && db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin'").get().n <= 1) {
    throw httpError(400, 'Você é o único administrador. Crie outro antes de excluir esta conta.');
  }
  await runner.removeAllOfUser(req.user.id);
  db.prepare('DELETE FROM users WHERE id = ?').run(req.user.id);
  res.setHeader('Set-Cookie', 'bn_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');
  res.json({ ok: true });
}));

module.exports = router;
