'use strict';
const nodemailer = require('nodemailer');
const config = require('./config');
const { esc } = require('./util');

const transporter = config.SMTP.host
  ? nodemailer.createTransport({
      host: config.SMTP.host,
      port: config.SMTP.port,
      secure: config.SMTP.port === 465,
      auth: config.SMTP.user ? { user: config.SMTP.user, pass: config.SMTP.pass } : undefined,
    })
  : null;

function layout(title, bodyHtml, button) {
  const btn = button
    ? `<p style="margin:24px 0"><a href="${esc(button.url)}" style="background:#8b5cf6;color:#fff;padding:12px 22px;border-radius:8px;text-decoration:none;font-weight:600">${esc(button.label)}</a></p>`
    : '';
  return `<div style="font-family:system-ui,Arial,sans-serif;background:#0b0b12;padding:28px">
  <div style="max-width:520px;margin:auto;background:#14141f;border:1px solid #26263a;border-radius:12px;padding:28px;color:#e8e8f4">
    <h2 style="margin:0 0 14px;color:#fff">${esc(title)}</h2>${bodyHtml}${btn}
    <p style="color:#8b8ba7;font-size:12px;margin-top:28px">BotNexus · ${esc(config.APP_URL)}</p>
  </div></div>`;
}

async function sendMail({ to, subject, html, text }) {
  if (!transporter) {
    console.log(`\n[e-mail em modo teste] Para: ${to}\nAssunto: ${subject}\n${text}\n`);
    return { dev: true };
  }
  try { await transporter.sendMail({ from: config.SMTP.from, to, subject, html, text }); return { ok: true }; }
  catch (e) { console.error('[e-mail] falhou:', e.message); return { ok: false }; }
}

const first = (n) => String(n || '').split(' ')[0] || 'olá';

const sendWelcome = (u) => sendMail({
  to: u.email, subject: 'Bem-vindo ao BotNexus',
  html: layout(`Olá, ${first(u.name)}!`, '<p>Sua conta foi criada. Envie seu primeiro bot e coloque ele no ar.</p>', { label: 'Abrir o painel', url: config.APP_URL }),
  text: `Olá, ${first(u.name)}! Sua conta foi criada. Acesse: ${config.APP_URL}`,
});

const sendReset = (u, link) => sendMail({
  to: u.email, subject: 'Redefinir sua senha - BotNexus',
  html: layout('Redefinir senha', '<p>Recebemos um pedido para redefinir sua senha. O link vale por 1 hora. Se não foi você, ignore este e-mail.</p>', { label: 'Criar nova senha', url: link }),
  text: `Para criar uma nova senha (vale 1 hora): ${link}\nSe não foi você, ignore este e-mail.`,
});

const sendPaymentConfirmed = (u, plan, expiresAt) => sendMail({
  to: u.email, subject: `Pagamento confirmado - plano ${plan.name}`,
  html: layout('Pagamento confirmado', `<p>Seu plano <b>${esc(plan.name)}</b> está ativo até <b>${new Date(expiresAt).toLocaleDateString('pt-BR')}</b>.</p>`, { label: 'Ver meus bots', url: `${config.APP_URL}/#/bots` }),
  text: `Pagamento confirmado. Plano ${plan.name} ativo até ${new Date(expiresAt).toLocaleDateString('pt-BR')}.`,
});

const sendBotCrashed = (u, bot, reason) => sendMail({
  to: u.email, subject: `Seu bot "${bot.name}" caiu`,
  html: layout('Seu bot caiu', `<p>O bot <b>${esc(bot.name)}</b> parou de funcionar.</p><p style="color:#ffb4c0">${esc(reason)}</p>`, { label: 'Ver o console', url: `${config.APP_URL}/#/bot/${bot.id}` }),
  text: `O bot "${bot.name}" caiu: ${reason}\n${config.APP_URL}/#/bot/${bot.id}`,
});

const sendPlanExpired = (u, plan) => sendMail({
  to: u.email, subject: 'Seu plano BotNexus venceu',
  html: layout('Seu plano venceu', `<p>O plano <b>${esc(plan.name)}</b> chegou ao fim e sua conta voltou para o plano Grátis. Bots além do limite foram desligados.</p>`, { label: 'Renovar plano', url: `${config.APP_URL}/#/planos` }),
  text: `Seu plano ${plan.name} venceu. Renove em ${config.APP_URL}/#/planos`,
});

const sendAdminAlert = (subject, text) => config.ADMIN_EMAIL
  ? sendMail({ to: config.ADMIN_EMAIL, subject: `[BotNexus] ${subject}`, html: layout(subject, `<p>${esc(text)}</p>`), text })
  : Promise.resolve();

module.exports = { sendMail, sendWelcome, sendReset, sendPaymentConfirmed, sendBotCrashed, sendPlanExpired, sendAdminAlert };
