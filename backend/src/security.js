'use strict';
const config = require('./config');

function securityHeaders(req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Content-Security-Policy',
    "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; " +
    "connect-src 'self' ws: wss:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
  if (config.IS_HTTPS) res.setHeader('Strict-Transport-Security', 'max-age=15552000');
  next();
}

function originMatchesHost(origin, host) {
  try { return new URL(origin).host === host; } catch { return false; }
}

// Protege contra CSRF: exige cabeçalho próprio e Origin do mesmo site.
function csrfGuard(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  if (req.path.startsWith('/billing/webhook')) return next();
  if (req.headers['x-requested-with'] !== 'botnexus') return res.status(403).json({ error: 'Requisição bloqueada.' });
  const origin = req.headers.origin;
  if (origin && !originMatchesHost(origin, req.headers.host)) return res.status(403).json({ error: 'Origem não permitida.' });
  next();
}

const buckets = new Map();
function hit(key, max, windowMs) {
  const t = Date.now();
  const b = buckets.get(key);
  if (!b || b.reset < t) { buckets.set(key, { n: 1, reset: t + windowMs }); return true; }
  b.n += 1;
  return b.n <= max;
}
setInterval(() => { const t = Date.now(); for (const [k, b] of buckets) if (b.reset < t) buckets.delete(k); }, 60_000).unref();

// Limite por IP (e opcionalmente por chave extra, como e-mail).
function rateLimit(name, max, windowMs, extraKey) {
  return (req, res, next) => {
    const keys = [`${name}:ip:${req.ip}`];
    if (extraKey) { const k = extraKey(req); if (k) keys.push(`${name}:k:${k}`); }
    if (!keys.every((k) => hit(k, max, windowMs))) {
      return res.status(429).json({ error: 'Muitas tentativas. Aguarde alguns minutos e tente de novo.' });
    }
    next();
  };
}

module.exports = { securityHeaders, csrfGuard, rateLimit, originMatchesHost };
