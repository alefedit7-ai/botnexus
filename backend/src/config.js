'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

function loadEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (line.trim().startsWith('#')) continue;
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (process.env[m[1]] === undefined) process.env[m[1]] = v;
  }
}
loadEnv(path.join(ROOT, '.env'));

const env = (k, d = '') => (process.env[k] !== undefined && process.env[k] !== '' ? process.env[k] : d);
const APP_URL = env('APP_URL', 'http://localhost:3000').replace(/\/+$/, '');

const config = {
  ROOT,
  PORT: Number(env('PORT', '3000')),
  HOST: env('HOST', '0.0.0.0'),
  APP_URL,
  IS_HTTPS: APP_URL.startsWith('https://'),
  APP_SECRET: env('APP_SECRET'),
  ADMIN_EMAIL: env('ADMIN_EMAIL').trim().toLowerCase(),
  ALLOW_REGISTER: env('ALLOW_REGISTER', 'true') !== 'false',
  TRUST_PROXY: env('TRUST_PROXY', 'false') === 'true',
  BOT_SANDBOX: env('BOT_SANDBOX', 'auto'),
  DATA_DIR: path.resolve(ROOT, env('DATA_DIR', './data')),
  FRONTEND_DIR: path.resolve(ROOT, '..', 'frontend'),
  SMTP: {
    host: env('SMTP_HOST'),
    port: Number(env('SMTP_PORT', '587')),
    user: env('SMTP_USER'),
    pass: env('SMTP_PASS'),
    from: env('SMTP_FROM', 'BotNexus <nao-responda@localhost>'),
  },
  PAYMENT_PROVIDER: env('PAYMENT_PROVIDER').toLowerCase(),
  ABACATEPAY_API_KEY: env('ABACATEPAY_API_KEY'),
  ABACATEPAY_WEBHOOK_SECRET: env('ABACATEPAY_WEBHOOK_SECRET'),
  ABACATEPAY_API_URL: env('ABACATEPAY_API_URL', 'https://api.abacatepay.com/v2').replace(/\/+$/, ''),
  MP_ACCESS_TOKEN: env('MP_ACCESS_TOKEN'),
  MP_WEBHOOK_SECRET: env('MP_WEBHOOK_SECRET'),
  PIX_MANUAL_KEY: env('PIX_MANUAL_KEY'),
  PIX_MANUAL_NAME: env('PIX_MANUAL_NAME'),
  MAX_UNZIPPED_MB: 150,
};

if (!config.APP_SECRET || config.APP_SECRET.length < 32) {
  console.error('\n[BotNexus] APP_SECRET ausente ou curto demais.\nRode:  npm run setup   (ele cria o .env com uma chave segura)\n');
  process.exit(1);
}

module.exports = config;
