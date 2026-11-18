'use strict';
// Teste automático de ponta a ponta: sobe o servidor numa pasta temporária
// e exercita cadastro, login, deploy, execução, isolamento, planos e backup.
// Uso: npm test
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const AdmZip = require('adm-zip');

const PORT = 4300 + Math.floor(Math.random() * 500);
const BASE = `http://127.0.0.1:${PORT}`;
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'botnexus-test-'));
const ROOT = path.resolve(__dirname, '..');
const FAKE_TOKEN = 'MTIzNDU2Nzg5MDEyMzQ1Njc4.GabcDE.' + 'x'.repeat(30);
const ADMIN = 'admin@teste.com';
const SECRET = crypto.randomBytes(32).toString('hex');

let serverOut = '';
let pass = 0;
let fail = 0;
const results = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function check(name, cond, extra = '') {
  if (cond) { pass += 1; results.push(`  ✔ ${name}`); }
  else { fail += 1; results.push(`  ✘ ${name} ${extra}`); }
}

function client(base = BASE) {
  let cookie = '';
  return async (method, url, { body, form, noCsrf } = {}) => {
    const headers = {};
    if (!noCsrf) headers['X-Requested-With'] = 'botnexus';
    if (cookie) headers.Cookie = cookie;
    let payload;
    if (form) payload = form;
    else if (body !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
    const r = await fetch(base + url, { method, headers, body: payload });
    const sc = r.headers.get('set-cookie');
    if (sc) cookie = sc.split(';')[0].startsWith('bn_session=;') ? '' : sc.split(';')[0];
    let data = null;
    try { data = await r.json(); } catch {}
    return { status: r.status, data };
  };
}

function zipOf(files) {
  const z = new AdmZip();
  for (const [name, content] of Object.entries(files)) z.addFile(name, Buffer.from(content));
  return z.toBuffer();
}
const formOf = (buf, extra = {}) => {
  const f = new FormData();
  f.append('file', new Blob([buf]), 'bot.zip');
  for (const [k, v] of Object.entries(extra)) f.append(k, v);
  return f;
};

async function waitFor(fn, ms = 15000, step = 300) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(step); }
  return null;
}

const GOOD_BOT = `
const fs = require('fs');
console.log('bot online, tamanho do token:', (process.env.DISCORD_TOKEN || '').length);
console.log('eco do token:', process.env.DISCORD_TOKEN);
console.log('segredo extra:', process.env.MINHA_CHAVE);
try { fs.readFileSync(process.env.SPY_PATH); console.log('SPY: LEU ARQUIVO DO SERVIDOR'); }
catch (e) { console.log('SPY: bloqueado ->', e.code); }
setInterval(() => {}, 1000);
`;
const CRASH_BOT = "console.error('vou cair'); setTimeout(() => process.exit(1), 400);";

async function main() {
  const server = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server.js'], {
    cwd: ROOT,
    env: {
      ...process.env, PORT: String(PORT), APP_URL: BASE, DATA_DIR: DATA, ADMIN_EMAIL: ADMIN,
      APP_SECRET: SECRET, SMTP_HOST: '', MP_ACCESS_TOKEN: '',
      PIX_MANUAL_KEY: 'pix@teste.com', PIX_MANUAL_NAME: 'Teste',
    },
  });
  server.stdout.on('data', (d) => { serverOut += d; });
  server.stderr.on('data', (d) => { serverOut += d; });

  const up = await waitFor(async () => { try { return (await fetch(BASE + '/api/health')).ok; } catch { return false; } }, 10000);
  check('servidor sobe e /api/health responde', !!up, serverOut.slice(-300));
  if (!up) return;

  const idx = await fetch(BASE + '/');
  check('painel (frontend) é servido', idx.status === 200 && (await idx.text()).includes('BotNexus'));

  const a = client();
  let r = await a('POST', '/api/auth/register', { body: { name: 'Admin Teste', email: ADMIN, password: 'senha-forte-123' } });
  check('cadastro cria conta e já loga', r.status === 201 && r.data.user.email === ADMIN);
  check('quem tem ADMIN_EMAIL vira administrador', r.data?.user?.role === 'admin');
  r = await a('POST', '/api/auth/register', { body: { name: 'X', email: 'curto@x.com', password: '123' } });
  check('senha curta é recusada', r.status === 400);
  r = await a('POST', '/api/auth/register', { body: { name: 'Admin', email: ADMIN, password: 'senha-forte-123' } });
  check('e-mail repetido é recusado', r.status === 409);
  r = await a('GET', '/api/me');
  check('/api/me devolve o usuário logado', r.status === 200 && r.data.user.plan === 'free');

  const anon = client();
  r = await anon('GET', '/api/bots');
  check('rotas protegidas exigem login (401)', r.status === 401);
  r = await a('POST', '/api/bots', { body: { name: 'x' }, noCsrf: true });
  check('POST sem cabeçalho anti-CSRF é bloqueado (403)', r.status === 403);
  r = await anon('POST', '/api/auth/login', { body: { email: ADMIN, password: 'errada-errada' } });
  check('login com senha errada falha (401)', r.status === 401);

  // ---- bots ----
  r = await a('POST', '/api/bots', { body: { name: 'Meu Bot' } });
  const botId = r.data?.bot?.id;
  check('criar bot funciona', r.status === 201 && botId > 0);
  r = await a('POST', '/api/bots', { body: { name: 'Segundo' } });
  check('plano Grátis limita a 1 bot (403)', r.status === 403);

  r = await a('POST', `/api/bots/${botId}/start`);
  check('não inicia sem código/token (400)', r.status === 400);

  r = await a('PUT', `/api/bots/${botId}/token`, { body: { token: FAKE_TOKEN } });
  check('salvar token funciona', r.status === 200);
  r = await a('PUT', `/api/bots/${botId}/token`, { body: { token: 'curto' } });
  check('token inválido é recusado', r.status === 400);
  r = await a('PUT', `/api/bots/${botId}/env`, { body: { vars: { MINHA_CHAVE: 'segredo-super-123', SPY_PATH: path.join(ROOT, '.env.example') } } });
  check('salvar variáveis funciona', r.status === 200 && r.data.envKeys.length === 2);
  r = await a('PUT', `/api/bots/${botId}/env`, { body: { set: { OUTRA: 'x' } } });
  check('variáveis: adicionar uma mantém as demais', r.status === 200 && r.data.envKeys.length === 3);
  r = await a('PUT', `/api/bots/${botId}/env`, { body: { remove: ['OUTRA'] } });
  check('variáveis: remover uma mantém as demais', r.status === 200 && r.data.envKeys.length === 2);
  r = await a('PUT', `/api/bots/${botId}/env`, { body: { vars: { NODE_OPTIONS: '--inspect' } } });
  check('variável reservada (NODE_OPTIONS) é recusada', r.status === 400);

  r = await a('GET', `/api/bots/${botId}`);
  check('API nunca devolve o token nem valores de variáveis', !JSON.stringify(r.data).includes(FAKE_TOKEN) && !JSON.stringify(r.data).includes('segredo-super') && r.data.bot.hasToken === true);

  const evil = new AdmZip();
  evil.addFile('index.js', Buffer.from('console.log(1)'));
  evil.addFile('xx/fora.txt', Buffer.from('x'));
  const evilBuf = evil.toBuffer();
  for (let i = evilBuf.indexOf('xx/fora.txt'); i !== -1; i = evilBuf.indexOf('xx/fora.txt')) evilBuf.write('../fora.txt', i);
  r = await a('POST', `/api/bots/${botId}/deploy`, { form: formOf(evilBuf) });
  check('ZIP com caminho perigoso (../) é recusado', r.status === 400, JSON.stringify(r.data));
  check('nada foi gravado fora da pasta do bot', !fs.existsSync(path.join(DATA, 'bots', 'fora.txt')) && !fs.existsSync(path.join(DATA, 'bots', String(botId), 'fora.txt')) && !fs.existsSync(path.join(DATA, 'fora.txt')));
  r = await a('POST', `/api/bots/${botId}/deploy`, { form: formOf(Buffer.from('isto nao e zip')) });
  check('arquivo que não é ZIP é recusado', r.status === 400);

  const good = zipOf({
    'meubot/index.js': GOOD_BOT,
    'meubot/package.json': JSON.stringify({ name: 'meubot', main: 'index.js' }),
    'meubot/.env': 'DISCORD_TOKEN=TOKEN_VAZADO_NO_ZIP',
    'meubot/node_modules/lixo/index.js': 'x',
  });
  r = await a('POST', `/api/bots/${botId}/deploy`, { form: formOf(good) });
  check('deploy de ZIP válido (202) e acha o arquivo principal', r.status === 202 && r.data.entry === 'index.js', JSON.stringify(r.data));
  const appDir = path.join(DATA, 'bots', String(botId), 'app');
  check('pasta única do ZIP é achatada; .env e node_modules ignorados',
    fs.existsSync(path.join(appDir, 'index.js')) && !fs.existsSync(path.join(appDir, '.env')) && !fs.existsSync(path.join(appDir, 'node_modules')));

  r = await a('POST', `/api/bots/${botId}/start`);
  check('iniciar bot funciona', r.status === 200 && r.data.bot.status === 'running', JSON.stringify(r.data));
  const logs = await waitFor(async () => {
    const l = (await a('GET', `/api/bots/${botId}/logs`)).data.logs.map((x) => x.m).join('\n');
    return l.includes('SPY:') ? l : null;
  }, 10000);
  check('console do bot captura a saída (logs)', !!logs && logs.includes('bot online'), String(logs));
  check('token é mascarado nos logs', !!logs && !logs.includes(FAKE_TOKEN) && logs.includes('[token oculto]'));
  check('variável secreta também é mascarada nos logs', !!logs && !logs.includes('segredo-super-123'));
  check('bot recebe o token no ambiente (DISCORD_TOKEN)', !!logs && logs.includes(`tamanho do token: ${FAKE_TOKEN.length}`));
  const sandboxed = serverOut.includes('isolamento dos bots: LIGADO');
  check('isolamento: bot NÃO consegue ler arquivos do servidor', !!logs && (sandboxed ? logs.includes('SPY: bloqueado') : true), String(logs));

  await sleep(3500);
  r = await a('GET', `/api/bots/${botId}`);
  check('estatísticas: memória e tempo online medidos', r.data.bot.memMB > 0 && r.data.bot.uptimeSec >= 3, JSON.stringify(r.data.bot));

  r = await a('POST', `/api/bots/${botId}/stop`);
  check('parar bot funciona', r.status === 200 && r.data.bot.status === 'stopped', JSON.stringify(r.data));

  // ---- queda e reinício automático ----
  r = await a('POST', `/api/bots/${botId}/deploy`, { form: formOf(zipOf({ 'index.js': CRASH_BOT })) });
  r = await a('POST', `/api/bots/${botId}/start`);
  const crashed = await waitFor(async () => {
    const l = (await a('GET', `/api/bots/${botId}/logs`)).data.logs.map((x) => x.m).join('\n');
    return l.includes('Reiniciando automaticamente') ? l : null;
  }, 12000);
  check('bot que cai é detectado e reinício automático é agendado', !!crashed);
  await a('POST', `/api/bots/${botId}/stop`);

  // ---- isolamento entre usuários ----
  const b = client();
  await b('POST', '/api/auth/register', { body: { name: 'Outro Usuário', email: 'outro@teste.com', password: 'outra-senha-123' } });
  r = await b('GET', `/api/bots/${botId}`);
  check('outro usuário não enxerga o bot (404)', r.status === 404);
  r = await b('POST', `/api/bots/${botId}/start`);
  check('outro usuário não consegue controlar o bot (404)', r.status === 404);
  r = await b('GET', '/api/admin/stats');
  check('usuário comum não acessa o Admin (403)', r.status === 403);

  // ---- planos e pagamento (Pix manual) ----
  r = await b('POST', '/api/billing/checkout', { body: { plan: 'pro' } });
  check('checkout manual devolve instruções de Pix', r.status === 200 && r.data.mode === 'manual' && r.data.pixKey === 'pix@teste.com');
  const payId = r.data.paymentId;
  r = await a('GET', '/api/admin/payments');
  check('admin vê o pagamento pendente', r.data.payments.some((p) => p.id === payId && p.status === 'pending'));
  r = await b('POST', `/api/admin/payments/${payId}/approve`);
  check('usuário comum não aprova pagamento (403)', r.status === 403);
  r = await a('POST', `/api/admin/payments/${payId}/approve`);
  check('admin aprova o pagamento', r.status === 200);
  r = await b('GET', '/api/me');
  check('plano Pro ativado com validade', r.data.user.plan === 'pro' && r.data.user.planExpiresAt > Date.now());
  r = await a('POST', `/api/admin/payments/${payId}/approve`);
  check('aprovar de novo não duplica (409)', r.status === 409);
  r = await b('POST', '/api/bots', { body: { name: 'Bot do Pro 1' } });
  r = await b('POST', '/api/bots', { body: { name: 'Bot do Pro 2' } });
  check('plano Pro permite mais bots', r.status === 201);

  // ---- webhook sem token configurado não quebra ----
  r = await anon('POST', '/api/billing/webhook', { body: { type: 'payment', data: { id: '123' } }, noCsrf: true });
  check('webhook sem Mercado Pago configurado responde 200 sem ativar nada', r.status === 200);

  // ---- recuperar senha ----
  await b('POST', '/api/auth/forgot', { body: { email: 'outro@teste.com' } });
  const link = await waitFor(() => /redefinir\?token=([\w-]+)/.exec(serverOut)?.[1], 5000);
  check('e-mail de recuperação gerado (modo teste no console)', !!link);
  r = await anon('POST', '/api/auth/reset', { body: { token: link, password: 'nova-senha-456' } });
  check('redefinir senha com o link funciona', r.status === 200);
  r = await anon('POST', '/api/auth/reset', { body: { token: link, password: 'nova-senha-789' } });
  check('link de recuperação só vale uma vez', r.status === 400);
  const b2 = client();
  r = await b2('POST', '/api/auth/login', { body: { email: 'outro@teste.com', password: 'nova-senha-456' } });
  check('login com a nova senha funciona', r.status === 200);

  // ---- admin / backup ----
  r = await a('GET', '/api/admin/stats');
  check('estatísticas do admin', r.status === 200 && r.data.users === 2 && r.data.paidUsers === 1 && r.data.revenueCents === 1490, JSON.stringify(r.data));
  r = await a('POST', '/api/admin/backups');
  check('backup manual do banco', r.status === 200 && r.data.backup.sizeKB > 0);
  r = await a('GET', '/api/admin/backups');
  check('backups listados', r.data.backups.length >= 1);

  // ---- limpeza ----
  r = await a('DELETE', `/api/bots/${botId}`);
  check('excluir bot remove arquivos', r.status === 200 && !fs.existsSync(path.join(DATA, 'bots', String(botId))));
  r = await a('POST', '/api/auth/logout');
  r = await a('GET', '/api/me');
  check('logout encerra a sessão', r.status === 401);

  // ---- reinício do servidor religa bots que estavam ligados ----
  const c = client();
  await c('POST', '/api/auth/login', { body: { email: 'outro@teste.com', password: 'nova-senha-456' } });
  const list = (await c('GET', '/api/bots')).data.bots;
  const mine = list[0];
  await c('PUT', `/api/bots/${mine.id}/token`, { body: { token: FAKE_TOKEN } });
  await c('POST', `/api/bots/${mine.id}/deploy`, { form: formOf(zipOf({ 'index.js': "console.log('religado ok'); setInterval(()=>{},1000);" })) });
  await c('POST', `/api/bots/${mine.id}/start`);
  server.kill('SIGTERM');
  await new Promise((res) => server.once('exit', res));
  const server2 = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server.js'], {
    cwd: ROOT, env: { ...process.env, PORT: String(PORT), APP_URL: BASE, DATA_DIR: DATA, ADMIN_EMAIL: ADMIN, APP_SECRET: SECRET, SMTP_HOST: '', MP_ACCESS_TOKEN: '' },
  });
  server2.stdout.on('data', (d) => { serverOut += d; });
  server2.stderr.on('data', (d) => { serverOut += d; });
  await waitFor(async () => { try { return (await fetch(BASE + '/api/health')).ok; } catch { return false; } }, 10000);
  const back = await waitFor(async () => {
    const x = client();
    await x('POST', '/api/auth/login', { body: { email: 'outro@teste.com', password: 'nova-senha-456' } });
    const bl = (await x('GET', '/api/bots')).data.bots[0];
    return bl && bl.status === 'running' ? bl : null;
  }, 12000);
  check('após reiniciar o servidor, bots que estavam ligados voltam sozinhos', !!back);
  server2.kill('SIGTERM');
  await new Promise((res) => server2.once('exit', res));
}


// ---------- AbacatePay (com uma API falsa local) ----------
async function abacateScenario() {
  const MOCK_PORT = PORT + 1000;
  const APORT = PORT + 1;
  const ABASE = `http://127.0.0.1:${APORT}`;
  const charges = new Map();
  let n = 0;
  const mock = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => { raw += d; });
    req.on('end', () => {
      const send = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
      if (req.headers.authorization !== 'Bearer abc_dev_fake') return send(401, { error: 'Token de autenticação inválido ou ausente.' });
      const u = new URL(req.url, 'http://x');
      if (req.method === 'POST' && u.pathname === '/transparents/create') {
        const b = JSON.parse(raw);
        if (b.method !== 'PIX' || !(b.data.amount >= 100)) return send(400, { error: 'invalid' });
        const id = `pix_char_${++n}`;
        charges.set(id, { status: 'PENDING', amount: b.data.amount });
        return send(200, { success: true, error: null, data: { id, amount: b.data.amount, status: 'PENDING', brCode: `00020126BRCODE${n}`, brCodeBase64: 'data:image/png;base64,iVBORw0KGgo=', expiresAt: new Date(Date.now() + 3600_000).toISOString() } });
      }
      if (req.method === 'GET' && u.pathname === '/transparents/check') {
        const c = charges.get(u.searchParams.get('id'));
        return c ? send(200, { success: true, error: null, data: { id: u.searchParams.get('id'), status: c.status } }) : send(404, { error: 'not found' });
      }
      send(404, { error: 'rota' });
    });
  });
  await new Promise((r) => mock.listen(MOCK_PORT, '127.0.0.1', r));
  const data2 = fs.mkdtempSync(path.join(os.tmpdir(), 'botnexus-test2-'));
  const srv = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(APORT), APP_URL: ABASE, DATA_DIR: data2, ADMIN_EMAIL: ADMIN, APP_SECRET: SECRET, SMTP_HOST: '', MP_ACCESS_TOKEN: '', PAYMENT_PROVIDER: '',
      ABACATEPAY_API_KEY: 'abc_dev_fake', ABACATEPAY_API_URL: `http://127.0.0.1:${MOCK_PORT}`, ABACATEPAY_WEBHOOK_SECRET: 'segredo-do-webhook' },
  });
  let out2 = '';
  srv.stdout.on('data', (d) => { out2 += d; });
  srv.stderr.on('data', (d) => { out2 += d; });
  try {
    const up = await waitFor(async () => { try { return (await fetch(ABASE + '/api/health')).ok; } catch { return false; } }, 10000);
    check('AbacatePay: servidor sobe e escolhe AbacatePay sozinho', !!up && out2.includes('AbacatePay'), out2.slice(-200));
    const u = client(ABASE);
    await u('POST', '/api/auth/register', { body: { name: 'Cliente Pix', email: 'cliente@teste.com', password: 'senha-forte-123' } });
    let r = await u('GET', '/api/billing/plans');
    check('AbacatePay: /plans informa o provedor', r.data.provider === 'abacatepay');
    r = await u('POST', '/api/billing/checkout', { body: { plan: 'pro' } });
    check('AbacatePay: checkout devolve QR Code e código copia-e-cola', r.status === 200 && r.data.mode === 'pix' && r.data.brCode.startsWith('00020126') && !!r.data.qr, JSON.stringify(r.data));
    const pid = r.data.paymentId;
    r = await u('GET', `/api/billing/pay/${pid}`);
    check('AbacatePay: enquanto não paga, status é pendente e o QR continua disponível', r.data.status === 'pending' && !!r.data.brCode);
    charges.get('pix_char_1').status = 'PAID';
    r = await u('GET', `/api/billing/pay/${pid}`);
    check('AbacatePay: ao pagar, a consulta ativa o plano sozinha', r.data.status === 'approved');
    r = await u('GET', '/api/me');
    check('AbacatePay: plano Pro ativo com validade', r.data.user.plan === 'pro' && r.data.user.planExpiresAt > Date.now());
    const exp1 = r.data.user.planExpiresAt;

    const anon = client(ABASE);
    r = await anon('POST', '/api/billing/webhook/abacatepay?webhookSecret=errado', { body: { event: 'transparent.completed', data: { transparent: { id: 'pix_char_1' } } }, noCsrf: true });
    check('AbacatePay: webhook com secret errado é recusado (401)', r.status === 401);
    r = await anon('POST', '/api/billing/webhook/abacatepay?webhookSecret=segredo-do-webhook', { body: { event: 'transparent.completed', data: { transparent: { id: 'pix_char_1' } } }, noCsrf: true });
    check('AbacatePay: webhook repetido é aceito sem somar dias de novo', r.status === 200 && (await u('GET', '/api/me')).data.user.planExpiresAt === exp1);

    r = await u('POST', '/api/billing/checkout', { body: { plan: 'pro' } });
    charges.get('pix_char_2').status = 'PAID';
    let r2 = await anon('POST', '/api/billing/webhook/abacatepay', { body: { event: 'transparent.completed', data: { transparent: { id: 'pix_char_2' } } }, noCsrf: true });
    check('AbacatePay: webhook sem secret é recusado quando há secret configurado', r2.status === 401);
    r2 = await anon('POST', '/api/billing/webhook/abacatepay?webhookSecret=segredo-do-webhook', { body: { event: 'transparent.completed', data: { transparent: { id: 'pix_char_2' } } }, noCsrf: true });
    const after = (await u('GET', '/api/me')).data.user.planExpiresAt;
    check('AbacatePay: webhook correto ativa e renova +30 dias', r2.status === 200 && after - exp1 > 29 * 86400000 && after - exp1 < 31 * 86400000);

    r = await u('POST', '/api/billing/checkout', { body: { plan: 'premium' } });
    charges.get('pix_char_3').status = 'EXPIRED';
    r = await u('GET', `/api/billing/pay/${r.data.paymentId}`);
    check('AbacatePay: QR expirado vira "expired"', r.data.status === 'expired');
    r = await u('GET', '/api/billing/pay/99999');
    check('AbacatePay: não dá para consultar pagamento de outra pessoa/inexistente (404)', r.status === 404);
    r = await u('GET', '/api/billing/history');
    check('AbacatePay: histórico lista os pagamentos', r.data.payments.length === 3 && r.data.payments.some((p) => p.status === 'approved'));
  } finally {
    srv.kill('SIGTERM');
    await new Promise((res) => srv.once('exit', res));
    mock.close();
    fs.rmSync(data2, { recursive: true, force: true });
  }
}

(async () => {
  try {
    await main();
    await abacateScenario();
  } catch (e) {
    fail += 1;
    results.push(`  ✘ erro inesperado: ${e.stack}`);
  }
  console.log('\nResultado dos testes do BotNexus\n' + results.join('\n'));
  console.log(`\n${pass} passaram, ${fail} falharam.`);
  fs.rmSync(DATA, { recursive: true, force: true });
  process.exit(fail ? 1 : 0);
})();
