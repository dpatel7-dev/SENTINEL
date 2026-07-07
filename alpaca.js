// ============================================================================
//  ALPACA PAPER BROKER — Sentinel's execution arm
//  ---------------------------------------------------------------------------
//  Talks to Alpaca's official trading API using your PAPER account keys.
//
//  SAFETY INTERLOCK: the base URL below is hardcoded to the paper environment.
//  Real-money trading lives at a different URL (api.alpaca.markets) and is
//  deliberately NOT wired in. If the day ever comes to go live, that is a
//  decision to make with your parents — not a typo away.
// ============================================================================

const BASE = 'https://paper-api.alpaca.markets';   // paper only, on purpose

const KEY = (process.env.ALPACA_API_KEY || '').trim();
const SECRET = (process.env.ALPACA_SECRET_KEY || '').trim();

function configured() { return Boolean(KEY && SECRET); }

async function alpaca(method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      'APCA-API-KEY-ID': KEY,
      'APCA-API-SECRET-KEY': SECRET,
      'Content-Type': 'application/json'
    },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await res.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  if (!res.ok) throw new Error(data.message || `Alpaca ${path} HTTP ${res.status}`);
  return data;
}

// --- account & market clock -------------------------------------------------

async function getAccount() {
  const a = await alpaca('GET', '/v2/account');
  return {
    status: a.status,
    equity: parseFloat(a.equity),           // total account value now
    lastEquity: parseFloat(a.last_equity),  // value at yesterday's close
    cash: parseFloat(a.cash),
    buyingPower: parseFloat(a.buying_power)
  };
}

async function getClock() {
  const c = await alpaca('GET', '/v2/clock');
  return { open: !!c.is_open, nextOpen: c.next_open, nextClose: c.next_close };
}

// --- positions & orders -------------------------------------------------------

async function getPositions() {
  const list = await alpaca('GET', '/v2/positions');
  return list.map(p => ({
    symbol: p.symbol,
    qty: parseFloat(p.qty),
    avg: parseFloat(p.avg_entry_price),
    price: parseFloat(p.current_price),
    marketValue: parseFloat(p.market_value),
    pl: parseFloat(p.unrealized_pl),
    plPct: parseFloat(p.unrealized_plpc) * 100
  }));
}

async function getOrders(limit = 12) {
  const list = await alpaca('GET', `/v2/orders?status=all&limit=${limit}&direction=desc`);
  return list.map(o => ({
    id: o.id,
    symbol: o.symbol,
    side: o.side,
    status: o.status,                                            // filled / accepted / rejected...
    dollars: o.notional ? parseFloat(o.notional) : null,
    fillPrice: o.filled_avg_price ? parseFloat(o.filled_avg_price) : null,
    at: o.submitted_at
  }));
}

// Buy a dollar amount (fractional shares) at market. Regular hours only.
async function buyDollars(symbol, dollars) {
  return alpaca('POST', '/v2/orders', {
    symbol,
    notional: dollars.toFixed(2),
    side: 'buy',
    type: 'market',
    time_in_force: 'day'
  });
}

// Sell an entire position at market.
async function closePosition(symbol) { return alpaca('DELETE', `/v2/positions/${symbol}`); }

// Flatten everything — the big red button.
async function closeAll() { return alpaca('DELETE', '/v2/positions'); }

module.exports = { configured, getAccount, getClock, getPositions, getOrders, buyDollars, closePosition, closeAll };
