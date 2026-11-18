'use strict';
const express = require('express');
const crypto = require('crypto');
const config = require('../config');
const { db, tx, now } = require('../db');
const { requireAuth } = require('../auth');
const { PLANS, PLAN_DAYS } = require('../plans');
const { rateLimit } = require('../security');
const { httpError, wrap } = require('../util');
const mailer = require('../mailer');

const router = express.Router();
const MP = 'https://api.mercadopago.com';
const mpHeaders = () => ({ Authorization: `Bearer ${config.MP_ACCESS_TOKEN}`, 'Content-Type': 'application/json' });

/* Qual meio de pagamento está valendo agora. */
function providerName() {
  const want = config.PAYMENT_PROVIDER;
  if (want === 'manual') return 'manual';
  if (want === 'abacatepay' && config.ABACATEPAY_API_KEY) return 'abacatepay';
  if (want === 'mercadopago' && config.MP_ACCESS_TOKEN) return 'mercadopago';
  if (config.ABACATEPAY_API_KEY) return 'abacatepay';
  if (config.MP_ACCESS_TOKEN) return 'mercadopago';
  return 'manual';
}

/* Ativa (ou renova) o plano de forma idempotente. */
function activatePlan(paymentId) {
  const result = tx(() => {
    const p = db.prepare('SELECT * FROM payments WHERE id = ?').get(paymentId);
    if (!p || p.status === 'approved') return null;
    const u = db.prepare('SELECT * FROM users WHERE id = ?').get(p.user_id);
    if (!u) return null;
    const base = u.plan === p.plan && u.plan_expires_at > now() ? u.plan_expires_at : now();
    const expires = base + PLAN_DAYS * 24 * 3600 * 1000;
    db.prepare('UPDATE users SET plan = ?, plan_expires_at = ? WHERE id = ?').run(p.plan, expires, u.id);
    db.prepare("UPDATE payments SET status = 'approved', paid_at = ? WHERE id = ?").run(now(), p.id);
    return { user: u, plan: PLANS[p.plan], expires };
  });
  if (result) mailer.sendPaymentConfirmed(result.user, result.plan, result.expires);
  return result;
}

const safeEqual = (a, b) => {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

/* ---------- AbacatePay ---------- */
async function abacate(pathname, { method = 'GET', body } = {}) {
  const resp = await fetch(config.ABACATEPAY_API_URL + pathname, {
    method,
    headers: { Authorization: `Bearer ${config.ABACATEPAY_API_KEY}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15000),
  });
  let json = null;
  try { json = await resp.json(); } catch {}
  if (!resp.ok || !json || json.success === false || (json.error && typeof json.error === 'string')) {
    throw new Error(`AbacatePay respondeu ${resp.status}: ${String(json?.error || '').slice(0, 200)}`);
  }
  return json.data;
}

async function abacateApply(p) {
  const d = await abacate(`/transparents/check?id=${encodeURIComponent(p.provider_ref)}`);
  if (d.status === 'PAID') { activatePlan(p.id); return 'approved'; }
  if ((d.status === 'EXPIRED' || d.status === 'CANCELLED') && p.status === 'pending') {
    db.prepare("UPDATE payments SET status = 'expired' WHERE id = ? AND status = 'pending'").run(p.id);
    return 'expired';
  }
  return p.status;
}

/* ---------- Mercado Pago ---------- */
async function approveFromMpPayment(mp) {
  if (mp.status !== 'approved') return false;
  const row = db.prepare('SELECT * FROM payments WHERE external_ref = ?').get(String(mp.external_reference || ''));
  if (!row) return false;
  if (mp.currency_id && mp.currency_id !== 'BRL') return false;
  if (Math.round(Number(mp.transaction_amount) * 100) < row.amount_cents) return false;
  activatePlan(row.id);
  return true;
}

function verifyMpSignature(req, dataId) {
  if (!config.MP_WEBHOOK_SECRET) return true;
  const sig = String(req.headers['x-signature'] || '');
  const ts = /ts=([^,]+)/.exec(sig)?.[1];
  const v1 = /v1=([^,]+)/.exec(sig)?.[1];
  if (!ts || !v1) return false;
  const id = /^[A-Za-z0-9]+$/.test(String(dataId)) ? String(dataId).toLowerCase() : String(dataId);
  const manifest = `id:${id};request-id:${req.headers['x-request-id'] || ''};ts:${ts};`;
  return safeEqual(crypto.createHmac('sha256', config.MP_WEBHOOK_SECRET).update(manifest).digest('hex'), v1);
}

/* ---------- rotas ---------- */
router.get('/plans', (req, res) => {
  res.json({ plans: Object.values(PLANS), days: PLAN_DAYS, provider: providerName() });
});

router.post('/checkout', requireAuth, rateLimit('checkout', 10, 3600_000), wrap(async (req, res) => {
  const plan = PLANS[String(req.body?.plan)];
  if (!plan || plan.id === 'free') throw httpError(400, 'Escolha um plano pago.');
  const provider = providerName();
  const ext = crypto.randomUUID();
  const r = db.prepare('INSERT INTO payments (user_id, plan, amount_cents, provider, external_ref, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(req.user.id, plan.id, plan.priceCents, provider, ext, now());
  const paymentId = Number(r.lastInsertRowid);

  if (provider === 'manual') {
    return res.json({ mode: 'manual', paymentId, amountCents: plan.priceCents, pixKey: config.PIX_MANUAL_KEY, pixName: config.PIX_MANUAL_NAME, reference: ext.slice(0, 8).toUpperCase() });
  }

  if (provider === 'abacatepay') {
    let d;
    try {
      d = await abacate('/transparents/create', {
        method: 'POST',
        body: { method: 'PIX', data: { amount: plan.priceCents, description: `BotNexus ${plan.name} (${PLAN_DAYS} dias)`, expiresIn: 3600, externalId: ext, metadata: { paymentId: String(paymentId), plano: plan.id } } },
      });
      if (!d?.id || !d.brCode) throw new Error('Resposta sem QR Code.');
    } catch (e) {
      console.error('[pagamento] AbacatePay falhou ao criar cobrança:', e.message);
      db.prepare("UPDATE payments SET status = 'failed' WHERE id = ?").run(paymentId);
      throw httpError(502, 'Não foi possível gerar o Pix agora. Tente de novo em instantes.');
    }
    const expiresAt = d.expiresAt ? Date.parse(d.expiresAt) || now() + 3600_000 : now() + 3600_000;
    db.prepare('UPDATE payments SET provider_ref = ?, pix_code = ?, pix_qr = ?, expires_at = ? WHERE id = ?')
      .run(String(d.id), String(d.brCode), d.brCodeBase64 ? String(d.brCodeBase64) : null, expiresAt, paymentId);
    return res.json({ mode: 'pix', paymentId, amountCents: plan.priceCents, brCode: d.brCode, qr: d.brCodeBase64 || null, expiresAt });
  }

  const body = {
    items: [{ title: `BotNexus ${plan.name} (${PLAN_DAYS} dias)`, quantity: 1, unit_price: plan.priceCents / 100, currency_id: 'BRL' }],
    external_reference: ext,
    payer: { email: req.user.email },
    back_urls: ['success', 'pending', 'failure'].reduce((o, k) => ({ ...o, [k]: `${config.APP_URL}/pagamento/retorno?status=${k}` }), {}),
    statement_descriptor: 'BOTNEXUS',
  };
  if (config.IS_HTTPS) { body.notification_url = `${config.APP_URL}/api/billing/webhook`; body.auto_return = 'approved'; }
  let pref;
  try {
    const resp = await fetch(`${MP}/checkout/preferences`, { method: 'POST', headers: mpHeaders(), body: JSON.stringify(body), signal: AbortSignal.timeout(15000) });
    if (!resp.ok) throw new Error(`Mercado Pago respondeu ${resp.status}`);
    pref = await resp.json();
  } catch (e) {
    console.error('[pagamento] falha ao criar cobrança:', e.message);
    db.prepare("UPDATE payments SET status = 'failed' WHERE id = ?").run(paymentId);
    throw httpError(502, 'Não foi possível criar o pagamento agora. Tente de novo em instantes.');
  }
  db.prepare('UPDATE payments SET provider_ref = ? WHERE id = ?').run(String(pref.id), paymentId);
  res.json({ mode: 'mercadopago', paymentId, url: pref.init_point });
}));

/* Situação de um pagamento (o painel consulta a cada poucos segundos enquanto o QR Code está aberto). */
router.get('/pay/:id', requireAuth, rateLimit('paypoll', 90, 60_000), wrap(async (req, res) => {
  const load = () => db.prepare('SELECT * FROM payments WHERE id = ? AND user_id = ?').get(Number(req.params.id), req.user.id);
  let p = load();
  if (!p) throw httpError(404, 'Pagamento não encontrado.');
  if (p.status === 'pending' && p.provider === 'abacatepay' && p.provider_ref) {
    try { await abacateApply(p); p = load(); } catch (e) { console.error('[abacatepay] consulta falhou:', e.message); }
  }
  const open = p.status === 'pending';
  res.json({ id: p.id, status: p.status, plan: p.plan, amountCents: p.amount_cents, brCode: open ? p.pix_code : null, qr: open ? p.pix_qr : null, expiresAt: p.expires_at });
}));

/* Webhook do AbacatePay: o aviso só diz QUAL cobrança mudou; a confirmação vem da consulta direta à API. */
router.post('/webhook/abacatepay', wrap(async (req, res) => {
  if (!config.ABACATEPAY_API_KEY) return res.sendStatus(200);
  const given = String(req.query.webhookSecret || req.headers['x-webhook-secret'] || '');
  if (config.ABACATEPAY_WEBHOOK_SECRET && !safeEqual(given, config.ABACATEPAY_WEBHOOK_SECRET)) return res.sendStatus(401);
  const id = req.body?.data?.transparent?.id;
  if (req.body?.event === 'transparent.completed' && id) {
    const p = db.prepare("SELECT * FROM payments WHERE provider = 'abacatepay' AND provider_ref = ?").get(String(id));
    if (p) {
      try { await abacateApply(p); } catch (e) { console.error('[abacatepay] webhook:', e.message); return res.sendStatus(500); }
    }
  }
  res.sendStatus(200);
}));

/* Webhook do Mercado Pago: sempre confirma o pagamento direto na API deles. */
router.post('/webhook', wrap(async (req, res) => {
  const type = req.body?.type || req.query.type || req.query.topic;
  const dataId = req.body?.data?.id || req.query['data.id'] || req.query.id;
  if (type !== 'payment' || !dataId || !config.MP_ACCESS_TOKEN) return res.sendStatus(200);
  if (!verifyMpSignature(req, dataId)) return res.sendStatus(401);
  const resp = await fetch(`${MP}/v1/payments/${encodeURIComponent(dataId)}`, { headers: mpHeaders(), signal: AbortSignal.timeout(15000) });
  if (!resp.ok) return res.sendStatus(500);
  await approveFromMpPayment(await resp.json());
  res.sendStatus(200);
}));

/* Botão "Já paguei": consulta o provedor (útil sem domínio/https). */
router.post('/sync', requireAuth, rateLimit('sync', 20, 3600_000), wrap(async (req, res) => {
  const pend = db.prepare("SELECT * FROM payments WHERE user_id = ? AND status = 'pending' AND provider IN ('mercadopago', 'abacatepay') ORDER BY id DESC LIMIT 5").all(req.user.id);
  let activated = false;
  for (const p of pend) {
    try {
      if (p.provider === 'abacatepay' && config.ABACATEPAY_API_KEY && p.provider_ref) {
        if ((await abacateApply(p)) === 'approved') activated = true;
      } else if (p.provider === 'mercadopago' && config.MP_ACCESS_TOKEN) {
        const resp = await fetch(`${MP}/v1/payments/search?external_reference=${encodeURIComponent(p.external_ref)}&sort=date_created&criteria=desc`, { headers: mpHeaders(), signal: AbortSignal.timeout(15000) });
        if (!resp.ok) continue;
        for (const mp of (await resp.json()).results || []) { if (await approveFromMpPayment(mp)) { activated = true; break; } }
      }
    } catch (e) { console.error('[pagamento] sync:', e.message); }
  }
  res.json({ activated, manual: providerName() === 'manual' });
}));

router.get('/history', requireAuth, (req, res) => {
  const rows = db.prepare('SELECT id, plan, amount_cents, provider, status, created_at, paid_at, expires_at FROM payments WHERE user_id = ? ORDER BY id DESC LIMIT 20').all(req.user.id);
  res.json({ payments: rows.map((p) => ({ id: p.id, plan: p.plan, planName: PLANS[p.plan]?.name || p.plan, amountCents: p.amount_cents, provider: p.provider, status: p.status, createdAt: p.created_at, paidAt: p.paid_at, expiresAt: p.expires_at })) });
});

module.exports = { router, activatePlan, providerName };
