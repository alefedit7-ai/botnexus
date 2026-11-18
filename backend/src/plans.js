'use strict';
// Valores de exemplo: edite preços e limites aqui.
const PLAN_DAYS = 30;

const PLANS = {
  free: { id: 'free', name: 'Grátis', priceCents: 0, maxBots: 1, memMB: 128, zipMB: 5 },
  pro: { id: 'pro', name: 'Pro', priceCents: 1490, maxBots: 3, memMB: 256, zipMB: 20 },
  premium: { id: 'premium', name: 'Premium', priceCents: 2990, maxBots: 10, memMB: 512, zipMB: 50 },
};

// Plano realmente válido agora (se venceu, vale o grátis).
function planOf(user) {
  const p = PLANS[user.plan] || PLANS.free;
  if (p.id !== 'free' && (!user.plan_expires_at || user.plan_expires_at < Date.now())) return PLANS.free;
  return p;
}

module.exports = { PLANS, PLAN_DAYS, planOf };
