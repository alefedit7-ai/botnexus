'use strict';
const crypto = require('crypto');
const { promisify } = require('util');
const config = require('./config');

const scrypt = promisify(crypto.scrypt);
const SCRYPT = { N: 16384, r: 8, p: 1 };
const KEY = Buffer.from(crypto.hkdfSync('sha256', config.APP_SECRET, 'botnexus-salt', 'botnexus-token-encryption', 32));
const FAKE_HASH = 'scrypt$' + '00'.repeat(16) + '$' + '00'.repeat(64);

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password, salt, 64, SCRYPT);
  return `scrypt$${salt.toString('hex')}$${key.toString('hex')}`;
}

async function verifyPassword(password, stored) {
  try {
    const [alg, saltHex, hashHex] = String(stored || FAKE_HASH).split('$');
    if (alg !== 'scrypt') return false;
    const expected = Buffer.from(hashHex, 'hex');
    const key = await scrypt(password, Buffer.from(saltHex, 'hex'), expected.length, SCRYPT);
    return key.length === expected.length && crypto.timingSafeEqual(key, expected);
  } catch { return false; }
}

function encrypt(plain) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const ct = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  return ['v1', iv.toString('base64url'), c.getAuthTag().toString('base64url'), ct.toString('base64url')].join('.');
}

function decrypt(payload) {
  const [v, iv, tag, ct] = String(payload).split('.');
  if (v !== 'v1') throw new Error('Formato de dado criptografado inválido.');
  const d = crypto.createDecipheriv('aes-256-gcm', KEY, Buffer.from(iv, 'base64url'));
  d.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([d.update(Buffer.from(ct, 'base64url')), d.final()]).toString('utf8');
}

const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');
const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

module.exports = { hashPassword, verifyPassword, encrypt, decrypt, randomToken, sha256 };
