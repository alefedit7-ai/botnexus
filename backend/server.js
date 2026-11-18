'use strict';
if (Number(process.versions.node.split('.')[0]) < 22) {
  console.error('\n[BotNexus] Precisa do Node.js 22 ou mais novo (você tem ' + process.version + ').\nNo Termux:  pkg upgrade nodejs\n');
  process.exit(1);
}

const http = require('http');
const express = require('express');
const { Server } = require('socket.io');
const config = require('./src/config');
const { db } = require('./src/db');
const auth = require('./src/auth');
const runner = require('./src/botRunner');
const monitor = require('./src/monitor');
const { securityHeaders, csrfGuard, originMatchesHost } = require('./src/security');

const app = express();
app.set('trust proxy', config.TRUST_PROXY);
app.disable('x-powered-by');
app.use(securityHeaders);

app.get('/api/health', (req, res) => {
  let dbOk = true;
  try { db.prepare('SELECT 1').get(); } catch { dbOk = false; }
  res.status(dbOk ? 200 : 503).json({ ok: dbOk, uptimeSec: Math.floor(process.uptime()), botsRunning: runner.runningCount() });
});

app.use('/api', express.json({ limit: '100kb' }));
app.use('/api', csrfGuard);
app.use('/api', auth.router);
app.use('/api', require('./src/routes/account'));
app.use('/api/bots', require('./src/routes/bots'));
app.use('/api/billing', require('./src/routes/billing').router);
app.use('/api/admin', require('./src/routes/admin'));
app.use('/api', (req, res) => res.status(404).json({ error: 'Rota não encontrada.' }));

// Volta do Mercado Pago para o painel.
app.get('/pagamento/retorno', (req, res) => {
  const s = ['success', 'pending', 'failure'].includes(req.query.status) ? req.query.status : 'pending';
  res.redirect(`/#/planos?pagamento=${s}`);
});

app.use(express.static(config.FRONTEND_DIR, { maxAge: 0, etag: true }));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Dados inválidos.' });
  if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Dados grandes demais.' });
  if (err.status && err.status < 500) return res.status(err.status).json({ error: err.message });
  if (err.name === 'MulterError') return res.status(400).json({ error: 'Falha no envio do arquivo.' });
  console.error('[erro]', err);
  res.status(err.status || 500).json({ error: 'Erro interno. Tente de novo.' });
});

/* ---------- tempo real (logs e status) ---------- */
const server = http.createServer(app);
const io = new Server(server, {
  serveClient: true,
  allowRequest: (req, cb) => cb(null, !req.headers.origin || originMatchesHost(req.headers.origin, req.headers.host)),
});

io.use((socket, next) => {
  const user = auth.userFromCookieHeader(socket.handshake.headers.cookie);
  if (!user) return next(new Error('unauthorized'));
  socket.data.userId = user.id;
  next();
});

io.on('connection', (socket) => {
  socket.join(`user:${socket.data.userId}`);
  socket.on('subscribe', (botId) => {
    const bot = db.prepare('SELECT id FROM bots WHERE id = ? AND user_id = ?').get(Number(botId), socket.data.userId);
    if (bot) socket.join(`bot:${bot.id}`);
  });
  socket.on('unsubscribe', (botId) => socket.leave(`bot:${Number(botId)}`));
});

runner.events.on('log', (id, line) => io.to(`bot:${id}`).emit('log', { botId: id, ...line }));
runner.events.on('status', (id, userId, bot) => io.to(`user:${userId}`).emit('status', bot));

setInterval(() => {
  for (const [room] of io.sockets.adapter.rooms) {
    if (!room.startsWith('bot:')) continue;
    const row = runner.getBot(Number(room.slice(4)));
    if (row && runner.isRunning(row.id)) io.to(room).emit('stats', runner.describe(row));
  }
}, 3000).unref();

/* ---------- iniciar e encerrar ---------- */
server.listen(config.PORT, config.HOST, () => {
  console.log(`\n[BotNexus] no ar em ${config.APP_URL}  (porta ${config.PORT})`);
  console.log(`[BotNexus] isolamento dos bots: ${runner.sandboxOn() ? 'LIGADO (modo seguro do Node)' : 'DESLIGADO'}`);
  const PROV = { abacatepay: 'AbacatePay (Pix com QR Code)', mercadopago: 'Mercado Pago', manual: 'Pix manual (aprovação no painel Admin)' };
  console.log(`[BotNexus] pagamentos: ${PROV[require('./src/routes/billing').providerName()]}`);
  console.log(`[BotNexus] e-mails: ${config.SMTP.host ? 'SMTP configurado' : 'modo teste (aparecem aqui no console)'}\n`);
  monitor.start();
  runner.restoreOnBoot().catch((e) => console.error('[boot]', e));
});

let closing = false;
async function shutdown(sig) {
  if (closing) return;
  closing = true;
  console.log(`\n[BotNexus] ${sig} recebido. Parando os bots e fechando…`);
  try { await runner.stopAll(); } catch {}
  io.close();
  server.close(() => { try { db.close(); } catch {} process.exit(0); });
  setTimeout(() => process.exit(0), 8000).unref();
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('unhandledRejection', (e) => console.error('[erro não tratado]', e));
process.on('uncaughtException', (e) => console.error('[exceção]', e));
