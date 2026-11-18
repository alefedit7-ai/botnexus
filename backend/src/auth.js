'use strict';
const express = require('express');
const config = require('./config');
const { db, now } = require('./db');
const { hashPassword, verifyPassword, randomToken, sha256 } = require('./crypto');
const { planOf, PLANS } = require('./plans');
const { rateLimit } = require('./security');
const { httpError, wrap, EMAIL_RE } = require('./util');
const mailer = require('./mailer');

const COOKIE = 'bn_session';
const SESSION_MS = 30 * 24 * 3600 * 1000;

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) { try { out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); } catch {} }
  }
  return out;
}

function cookieAttrs(maxAgeSec) {
  return `Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${config.IS_HTTPS ? '; Secure' : ''}`;
}

function startSession(res, userId) {
  const token = randomToken(32);
  db.prepare('INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
    .run(sha256(token), userId, now(), now() + SESSION_MS);
  res.setHeader('Set-Cookie', `${COOKIE}=${token}; ${cookieAttrs(SESSION_MS / 1000)}`);
}

function userFromCookieHeader(header) {
  const token = parseCookies(header)[COOKIE];
  if (!token) return null;
  return db.prepare('SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ? AND s.expires_at > ?')
    .get(sha256(token), now()) || null;
}

function requireAuth(req, res, next) {
  const u = userFromCookieHeader(req.headers.cookie);
  if (!u) return res.status(401).json({ error: 'Faça login para continuar.' });
  req.user = u;
  next();
}

function requireAdmin(req, res, next) {
  if (req.user?.role !== 'admin') return res.status(403).json({ error: 'Acesso restrito ao administrador.' });
  next();
}

function publicUser(u) {
  const eff = planOf(u);
  return {
    id: u.id, name: u.name, email: u.email, role: u.role,
    plan: eff.id, planName: eff.name,
    planExpiresAt: eff.id === 'free' ? null : u.plan_expires_at,
    limits: { maxBots: eff.maxBots, memMB: eff.memMB, zipMB: eff.zipMB },
    createdAt: u.created_at,
  };
}

const cleanName = (s) => String(s || '').replace(/\s+/g, ' ').trim();
function checkPassword(p) {
  if (typeof p !== 'string' || p.length < 8) throw httpError(400, 'A senha precisa ter pelo menos 8 caracteres.');
  if (p.length > 200) throw httpError(400, 'Senha muito longa.');
}

const router = express.Router();

router.post('/auth/register', rateLimit('register', 6, 3600_000), wrap(async (req, res) => {
  if (!config.ALLOW_REGISTER) throw httpError(403, 'Os cadastros estão fechados no momento.');
  const name = cleanName(req.body?.name);
  const email = String(req.body?.email || '').trim().toLowerCase();
  if (name.length < 2 || name.length > 60) throw httpError(400, 'Informe seu nome (2 a 60 letras).');
  if (!EMAIL_RE.test(email) || email.length > 120) throw httpError(400, 'E-mail inválido.');
  checkPassword(req.body?.password);
  if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) throw httpError(409, 'Este e-mail já está cadastrado. Tente entrar.');
  const role = config.ADMIN_EMAIL && email === config.ADMIN_EMAIL ? 'admin' : 'user';
  const r = db.prepare('INSERT INTO users (name, email, pass_hash, role, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(name, email, await hashPassword(req.body.password), role, now());
  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(Number(r.lastInsertRowid));
  startSession(res, user.id);
  mailer.sendWelcome(user);
  res.status(201).json({ user: publicUser(user) });
}));

router.post('/auth/login', rateLimit('login', 12, 900_000, (req) => String(req.body?.email || '').toLowerCase()), wrap(async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  const ok = await verifyPassword(String(req.body?.password || ''), user?.pass_hash);
  if (!user || !ok) throw httpError(401, 'E-mail ou senha incorretos.');
  if (config.ADMIN_EMAIL && email === config.ADMIN_EMAIL && user.role !== 'admin') {
    db.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(user.id);
    user.role = 'admin';
  }
  startSession(res, user.id);
  res.json({ user: publicUser(user) });
}));

router.post('/auth/logout', (req, res) => {
  const token = parseCookies(req.headers.cookie)[COOKIE];
  if (token) db.prepare('DELETE FROM sessions WHERE id = ?').run(sha256(token));
  res.setHeader('Set-Cookie', `${COOKIE}=; ${cookieAttrs(0)}`);
  res.json({ ok: true });
});

router.post('/auth/forgot', rateLimit('forgot', 5, 3600_000, (req) => String(req.body?.email || '').toLowerCase()), wrap(async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (user) {
    const token = randomToken(32);
    db.prepare('INSERT INTO reset_tokens (id, user_id, expires_at) VALUES (?, ?, ?)').run(sha256(token), user.id, now() + 3600_000);
    mailer.sendReset(user, `${config.APP_URL}/#/redefinir?token=${token}`);
  }
  res.json({ ok: true, message: 'Se o e-mail existir, enviamos um link para criar uma nova senha.' });
}));

router.post('/auth/reset', rateLimit('reset', 10, 3600_000), wrap(async (req, res) => {
  checkPassword(req.body?.password);
  const row = db.prepare('SELECT * FROM reset_tokens WHERE id = ? AND used = 0 AND expires_at > ?').get(sha256(String(req.body?.token || '')), now());
  if (!row) throw httpError(400, 'Link inválido ou expirado. Peça um novo.');
  db.prepare('UPDATE users SET pass_hash = ? WHERE id = ?').run(await hashPassword(req.body.password), row.user_id);
  db.prepare('UPDATE reset_tokens SET used = 1 WHERE id = ?').run(row.id);
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(row.user_id);
  res.json({ ok: true });
}));

router.get('/me', requireAuth, (req, res) => res.json({ user: publicUser(req.user) }));

router.patch('/me', requireAuth, (req, res) => {
  const name = cleanName(req.body?.name);
  if (name.length < 2 || name.length > 60) throw httpError(400, 'Informe seu nome (2 a 60 letras).');
  db.prepare('UPDATE users SET name = ? WHERE id = ?').run(name, req.user.id);
  res.json({ user: publicUser({ ...req.user, name }) });
});

router.post('/me/password', requireAuth, rateLimit('chpw', 8, 900_000), wrap(async (req, res) => {
  if (!(await verifyPassword(String(req.body?.current || ''), req.user.pass_hash))) throw httpError(400, 'A senha atual está incorreta.');
  checkPassword(req.body?.password);
  db.prepare('UPDATE users SET pass_hash = ? WHERE id = ?').run(await hashPassword(req.body.password), req.user.id);
  const keep = sha256(parseCookies(req.headers.cookie)[COOKIE] || '');
  db.prepare('DELETE FROM sessions WHERE user_id = ? AND id != ?').run(req.user.id, keep);
  res.json({ ok: true });
}));

module.exports = { router, requireAuth, requireAdmin, publicUser, userFromCookieHeader, parseCookies, PLANS };
