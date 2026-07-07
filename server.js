// ============================================================================
//  SENTINEL v2 — news-driven stock engine with PAPER AUTOTRADING
//  ---------------------------------------------------------------------------
//  What this file does, top to bottom:
//    1. CONFIG + STORAGE   — loads settings, manual tracker, alert history
//    2. NEWS BRAIN         — scores headlines, weighs sources, flags hype/bait
//    3. MARKET DATA        — Finnhub (quotes/news) & Alpha Vantage (movers)
//    4. SIGNAL ENGINE      — BUY WATCH / SELL WATCH / AVOID with reasons
//    5. TRADER             — executes on Alpaca PAPER when Auto-trade is ON
//    6. DISCORD            — webhook alerts for signals AND executed trades
//    7. SCHEDULER          — watchlist sweep + market radar on timers
//    8. API + SERVER       — feeds the dashboard in /public
//
//  Auto-trade only ever touches the Alpaca PAPER account (fake money).
//  The manual tracker still just alerts — for shares you hold elsewhere.
// ============================================================================

require('dotenv').config();
const express = require('express');
const fs = require('fs');
const path = require('path');
const broker = require('./alpaca');

const PORT = process.env.PORT || 3000;
const FINNHUB_KEY = (process.env.FINNHUB_API_KEY || '').trim();
const AV_KEY = (process.env.ALPHAVANTAGE_API_KEY || '').trim();
const WEBHOOK = (process.env.DISCORD_WEBHOOK_URL || '').trim();

// ============================================================================
// 1. CONFIG + STORAGE  (everything persists as JSON files in ./data)
// ============================================================================

const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);

function loadJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(path.join(DATA_DIR, file), 'utf8')); }
  catch { return fallback; }
}
function saveJSON(file, obj) {
  try { fs.writeFileSync(path.join(DATA_DIR, file), JSON.stringify(obj, null, 2)); }
  catch (e) { console.error('Could not save', file, e.message); }
}

// Defaults — every one of these is editable live in the dashboard's Settings.
const DEFAULT_SETTINGS = {
  watchlist: ['AAPL', 'MSFT', 'NVDA', 'AMD', 'TSLA', 'AMZN', 'GOOGL', 'META', 'NFLX', 'PLTR', 'SOFI', 'COIN'],
  scanMinutes: 5,        // how often the watchlist sweep runs
  radarMinutes: 45,      // how often the market-wide movers radar runs
  buyThreshold: 2,       // aggregate news score needed for a BUY WATCH
  sellThreshold: -2,     // aggregate news score that flags "news turned negative"
  minSources: 2,         // distinct credible outlets required before acting
  minPrice: 5,           // penny-stock floor in dollars (classic bait territory)
  minMarketCapM: 300,    // market-cap floor in $ millions
  maxChasePct: 8,        // if it already ran this much today, don't chase
  takeProfitPct: 10,     // sell/alert when a position is up this %
  stopLossPct: 5,        // sell/alert when a position is down this %
  cooldownHours: 12,     // don't repeat the same signal within this window
  // --- paper autotrading ---
  autoTrade: false,      // master switch. OFF until you flip it in the dashboard
  tradeDollars: 500,     // paper dollars per BUY signal
  maxPositions: 5,       // max open auto-positions at once
  maxDailyLossPct: 3     // circuit breaker: pause if account drops this % in a day
};
let settings = Object.assign({}, DEFAULT_SETTINGS, loadJSON('settings.json', {}));

let portfolio = loadJSON('portfolio.json', []);   // manual tracker positions
let alerts = loadJSON('alerts.json', []);         // newest first, capped at 100
let cooldowns = loadJSON('cooldowns.json', {});   // { "BUY:NVDA": timestampMs }

// Live state the dashboard reads. Rebuilt every sweep, never trusted blindly.
const state = {
  watch: [],
  radar: [],
  prices: {},
  lastScan: null,
  lastRadar: null,
  scanning: false,
  radarNote: '',
  errors: [],
  breaker: '',                        // circuit-breaker message when tripped
  broker: { connected: false, note: 'Alpaca keys not set — see README Part 2.', account: null, clock: null, positions: [], orders: [] }
};

function pushError(msg) {
  console.error('!', msg);
  state.errors.unshift(`${new Date().toLocaleTimeString()} — ${msg}`);
  state.errors = state.errors.slice(0, 5);
}

if (!FINNHUB_KEY) pushError('FINNHUB_API_KEY missing — add it to .env (see .env.example)');
if (!AV_KEY) pushError('ALPHAVANTAGE_API_KEY missing — radar disabled until added');
if (!WEBHOOK) pushError('DISCORD_WEBHOOK_URL missing — alerts will only show in the dashboard');

// ============================================================================
// 2. NEWS BRAIN — sentiment scoring, source credibility, and the Bait Shield
// ============================================================================

const TIER1 = ['reuters', 'bloomberg', 'cnbc', 'wall street journal', 'wsj', 'associated press', 'ap news',
  'marketwatch', 'barron', 'financial times', 'ft.com', 'the economist', 'axios', 'nikkei'];
const TIER2 = ['yahoo', 'forbes', 'investing.com', 'benzinga', 'seeking alpha', 'seekingalpha',
  'motley fool', 'thestreet', 'business insider', "investor's business daily", 'zacks', 'quartz', 'fortune'];

function sourceWeight(source) {
  const s = (source || '').toLowerCase();
  if (TIER1.some(t => s.includes(t))) return 1.0;
  if (TIER2.some(t => s.includes(t))) return 0.6;
  return 0.3;
}

const POSITIVE = ['beats estimates', 'beats expectations', 'tops estimates', 'exceeds expectations',
  'record revenue', 'record profit', 'raises guidance', 'raised guidance', 'raises forecast',
  'upgrade', 'upgraded', 'outperform', 'buy rating', 'price target raised', 'acquisition', 'acquires',
  'buyback', 'dividend increase', 'partnership', 'contract win', 'wins contract', 'approval', 'approves',
  'strong demand', 'profit rises', 'profit jumps', 'revenue jumps', 'revenue climbs', 'all-time high',
  'expands', 'expansion', 'breakthrough', 'better-than-expected', 'beat estimates', 'strong quarter'];

const NEGATIVE = ['misses estimates', 'misses expectations', 'falls short', 'downgrade', 'downgraded',
  'underperform', 'sell rating', 'price target cut', 'cuts guidance', 'cut guidance', 'lowers forecast',
  'lawsuit', 'sues', 'probe', 'investigation', 'sec charges', 'fraud', 'recall', 'bankruptcy', 'chapter 11',
  'plunges', 'tumbles', 'sinks', 'warns', 'warning', 'weak demand', 'delisting', 'short seller',
  'short report', 'data breach', 'resigns', 'steps down', 'halted', 'disappointing', 'worse-than-expected',
  'loss widens', 'layoffs'];

const HYPE = ['to the moon', '🚀', 'rocket', 'skyrocket', 'explode', 'explosive gains', "can't lose",
  'cant lose', 'guaranteed', 'get rich', 'millionaire', 'insane gains', 'massive gains', 'huge gains',
  '10x', '100x', 'next tesla', 'next nvidia', 'next amazon', 'hidden gem', 'must buy', 'must-buy',
  'act now', 'urgent', "don't miss", 'dont miss', "before it's too late", 'hot penny', 'penny stock',
  'short squeeze', 'moonshot', 'easy money', 'free money', 'no brainer', 'no-brainer', 'cannot lose'];

function countHits(text, list) {
  let n = 0;
  for (const w of list) if (text.includes(w)) n++;
  return n;
}

function analyzeNews(articles) {
  const nowSec = Date.now() / 1000;
  const seen = new Set();
  let sentiment = 0;
  let hypeCount = 0;
  const sources = new Set();
  const scored = [];

  for (const a of (articles || []).slice(0, 40)) {
    if (!a || !a.headline) continue;
    const key = a.headline.toLowerCase().slice(0, 80);
    if (seen.has(key)) continue;
    seen.add(key);

    const ageHrs = (nowSec - (a.datetime || 0)) / 3600;
    if (ageHrs > 48) continue;
    const recency = ageHrs < 6 ? 1.25 : ageHrs < 24 ? 1.0 : 0.6;

    const text = `${a.headline} ${a.summary || ''}`.toLowerCase();
    let raw = countHits(text, POSITIVE) - countHits(text, NEGATIVE);
    raw = Math.max(-3, Math.min(3, raw));

    const hype = countHits(text, HYPE);
    let weight = sourceWeight(a.source) * recency;
    if (hype > 0) { hypeCount++; weight *= 0.2; }

    const score = +(raw * weight).toFixed(2);
    if (raw !== 0) sources.add((a.source || 'unknown').toLowerCase());
    scored.push({ headline: a.headline, source: a.source || 'unknown', url: a.url || '', score, hype: hype > 0 });
    sentiment += score;
  }

  scored.sort((x, y) => Math.abs(y.score) - Math.abs(x.score));
  return {
    sentiment: +sentiment.toFixed(1),
    sources: [...sources],
    hypeCount,
    articleCount: scored.length,
    top: scored.slice(0, 3)
  };
}

// ============================================================================
// 3. MARKET DATA — small helpers around the free APIs
// ============================================================================

const sleep = ms => new Promise(r => setTimeout(r, ms));
const isoDaysAgo = d => new Date(Date.now() - d * 864e5).toISOString().slice(0, 10);

async function finnhub(endpoint, params) {
  const qs = new URLSearchParams({ ...params, token: FINNHUB_KEY });
  const res = await fetch(`https://finnhub.io/api/v1/${endpoint}?${qs}`);
  if (res.status === 429) throw new Error('Finnhub rate limit hit — sweep will retry next cycle');
  if (!res.ok) throw new Error(`Finnhub ${endpoint} HTTP ${res.status}`);
  return res.json();
}

const profileCache = {};
async function getProfile(symbol) {
  if (profileCache[symbol]) return profileCache[symbol];
  try {
    const p = await finnhub('stock/profile2', { symbol });
    profileCache[symbol] = { name: p.name || symbol, marketCapM: p.marketCapitalization || null };
  } catch {
    profileCache[symbol] = { name: symbol, marketCapM: null };
  }
  return profileCache[symbol];
}

// ============================================================================
// 4. SIGNAL ENGINE — the decision rules, with reasons attached
// ============================================================================

function onCooldown(key) {
  return cooldowns[key] && (Date.now() - cooldowns[key]) < settings.cooldownHours * 3600e3;
}
function setCooldown(key) {
  cooldowns[key] = Date.now();
  saveJSON('cooldowns.json', cooldowns);
}

function evaluate(entry) {
  const r = [];

  if (entry.price < settings.minPrice) {
    r.push(`Price $${entry.price.toFixed(2)} is under the $${settings.minPrice} floor — penny-stock zone, prime pump territory.`);
    return { verdict: 'AVOID', reasons: r };
  }
  if (entry.marketCapM && entry.marketCapM < settings.minMarketCapM) {
    r.push(`Market cap ~$${Math.round(entry.marketCapM)}M is under the $${settings.minMarketCapM}M floor — too easy to manipulate.`);
    return { verdict: 'AVOID', reasons: r };
  }
  if (entry.news.hypeCount > 0) {
    r.push(`${entry.news.hypeCount} article(s) use pump-style hype language — Bait Shield discounted them.`);
    return { verdict: 'CAUTION', reasons: r };
  }

  if (entry.news.sentiment >= settings.buyThreshold) {
    if (entry.news.sources.length < settings.minSources) {
      r.push(`Positive news (score ${entry.news.sentiment}) but only ${entry.news.sources.length} source — waiting for a second outlet to confirm.`);
      return { verdict: 'WATCH', reasons: r };
    }
    if (entry.changePct !== null && entry.changePct > settings.maxChasePct) {
      r.push(`Already up ${entry.changePct.toFixed(1)}% today — the move happened without you. Chasing spikes is how bots bait humans.`);
      return { verdict: 'EXTENDED', reasons: r };
    }
    r.push(`News score ${entry.news.sentiment} across ${entry.news.sources.length} credible sources, price hasn't spiked yet.`);
    return { verdict: 'BUY WATCH', reasons: r };
  }

  if (entry.news.sentiment <= settings.sellThreshold && entry.news.sources.length >= settings.minSources) {
    r.push(`Negative news pressure (score ${entry.news.sentiment}) from ${entry.news.sources.length} sources.`);
    return { verdict: 'NEGATIVE', reasons: r };
  }

  if (entry.news.articleCount === 0) r.push('No fresh news in the last 48h.');
  return { verdict: 'NEUTRAL', reasons: r };
}

// Manual tracker: alert-only, for shares you hold elsewhere (e.g. Robinhood).
function checkManualPositions() {
  for (const pos of portfolio) {
    const price = state.prices[pos.symbol];
    if (!price) continue;
    const plPct = ((price - pos.cost) / pos.cost) * 100;

    if (plPct >= settings.takeProfitPct && !onCooldown(`SELL-TP:${pos.symbol}`)) {
      setCooldown(`SELL-TP:${pos.symbol}`);
      recordAlert('SELL', pos.symbol,
        `Take-profit zone — ${pos.symbol} is up ${plPct.toFixed(1)}% (manual tracker)`,
        [`You bought at $${pos.cost.toFixed(2)}, it's now $${price.toFixed(2)}.`,
         `Your take-profit rule is +${settings.takeProfitPct}%. Consider locking in gains (or raising your target).`],
        0xf0564a);
    }
    if (plPct <= -settings.stopLossPct && !onCooldown(`SELL-SL:${pos.symbol}`)) {
      setCooldown(`SELL-SL:${pos.symbol}`);
      recordAlert('SELL', pos.symbol,
        `Stop-loss zone — ${pos.symbol} is down ${Math.abs(plPct).toFixed(1)}% (manual tracker)`,
        [`You bought at $${pos.cost.toFixed(2)}, it's now $${price.toFixed(2)}.`,
         `Your stop-loss rule is -${settings.stopLossPct}%. Small losses are cheap; big ones aren't.`],
        0xf0564a);
    }

    const row = state.watch.find(w => w.symbol === pos.symbol);
    if (row && row.verdict === 'NEGATIVE' && !onCooldown(`SELL-NEWS:${pos.symbol}`)) {
      setCooldown(`SELL-NEWS:${pos.symbol}`);
      recordAlert('SELL', pos.symbol,
        `News turned negative on ${pos.symbol} — you hold this (manual tracker)`,
        [...row.reasons, ...row.news.top.map(t => `"${t.headline}" — ${t.source}`)],
        0xf0564a);
    }
  }
}

// ============================================================================
// 5. TRADER — Alpaca paper execution with guardrails
// ============================================================================

// Pull fresh account/clock/positions/orders. Also runs the circuit breaker.
async function syncBroker() {
  if (!broker.configured()) {
    state.broker = { connected: false, note: 'Alpaca keys not set — see README Part 2.', account: null, clock: null, positions: [], orders: [] };
    return;
  }
  try {
    const [account, clock, positions, orders] = [
      await broker.getAccount(), await broker.getClock(), await broker.getPositions(), await broker.getOrders()
    ];
    state.broker = { connected: true, note: '', account, clock, positions, orders };

    // Circuit breaker: if the paper account bleeds too much in one day, stop.
    if (settings.autoTrade && account.lastEquity > 0) {
      const dayPct = ((account.equity - account.lastEquity) / account.lastEquity) * 100;
      if (dayPct <= -settings.maxDailyLossPct) {
        settings.autoTrade = false;
        saveJSON('settings.json', settings);
        state.breaker = `Circuit breaker tripped: paper account down ${Math.abs(dayPct).toFixed(1)}% today (limit ${settings.maxDailyLossPct}%). Auto-trade paused.`;
        recordAlert('SELL', 'ACCOUNT', '⛔ Circuit breaker — auto-trade paused',
          [state.breaker, 'Positions were NOT force-sold. Review the dashboard, then re-enable when ready.'],
          0xf0564a);
      }
    }
  } catch (e) {
    state.broker.connected = false;
    state.broker.note = e.message;
    pushError(`Alpaca: ${e.message}`);
  }
}

function holdsPosition(symbol) {
  return state.broker.positions.some(p => p.symbol === symbol);
}
function hasPendingBuy(symbol) {
  return state.broker.orders.some(o =>
    o.symbol === symbol && o.side === 'buy' && ['new', 'accepted', 'pending_new', 'partially_filled'].includes(o.status));
}

// Called when a BUY WATCH fires. Every guard has to pass before money moves.
async function maybeAutoBuy(symbol, price, reasons) {
  if (!settings.autoTrade || !state.broker.connected) return;
  const b = state.broker;
  if (!b.clock || !b.clock.open) return recordAlert('INFO', symbol, `Signal on ${symbol} but market is closed — no paper order placed`, reasons, 0xe8b84b);
  if (holdsPosition(symbol) || hasPendingBuy(symbol)) return;
  if (b.positions.length >= settings.maxPositions) {
    return recordAlert('INFO', symbol, `Signal on ${symbol} skipped — already at ${settings.maxPositions} open positions`, reasons, 0xe8b84b);
  }
  if (b.account.buyingPower < settings.tradeDollars) {
    return recordAlert('INFO', symbol, `Signal on ${symbol} skipped — not enough paper buying power`, reasons, 0xe8b84b);
  }

  try {
    await broker.buyDollars(symbol, settings.tradeDollars);
    recordAlert('BUY', symbol,
      `PAPER BUY — $${settings.tradeDollars} of ${symbol} @ ~$${price.toFixed(2)}`,
      [...reasons, `Exit plan: +${settings.takeProfitPct}% take-profit / -${settings.stopLossPct}% stop-loss / negative-news turn.`],
      0x3dd68c);
  } catch (e) {
    pushError(`Paper buy ${symbol} failed: ${e.message}`);
    recordAlert('INFO', symbol, `Paper buy for ${symbol} was rejected`, [e.message], 0xe8b84b);
  }
}

// Watch every open paper position; sell (or alert) when an exit rule hits.
async function manageExits() {
  if (!state.broker.connected) return;
  const marketOpen = state.broker.clock && state.broker.clock.open;

  for (const pos of state.broker.positions) {
    const row = state.watch.find(w => w.symbol === pos.symbol);
    let reason = null;
    if (pos.plPct >= settings.takeProfitPct) reason = `take-profit hit (+${pos.plPct.toFixed(1)}%)`;
    else if (pos.plPct <= -settings.stopLossPct) reason = `stop-loss hit (${pos.plPct.toFixed(1)}%)`;
    else if (row && row.verdict === 'NEGATIVE') reason = `news turned negative (score ${row.news.sentiment})`;
    if (!reason) continue;

    if (settings.autoTrade && marketOpen) {
      try {
        await broker.closePosition(pos.symbol);
        recordAlert('SELL', pos.symbol,
          `PAPER SELL — ${pos.symbol} closed: ${reason}`,
          [`P/L: ${pos.pl >= 0 ? '+' : ''}$${pos.pl.toFixed(2)} (${pos.plPct >= 0 ? '+' : ''}${pos.plPct.toFixed(1)}%) on ${pos.qty} shares @ avg $${pos.avg.toFixed(2)}.`],
          pos.pl >= 0 ? 0x3dd68c : 0xf0564a);
      } catch (e) {
        pushError(`Paper sell ${pos.symbol} failed: ${e.message}`);
      }
    } else if (!onCooldown(`PAPER-EXIT:${pos.symbol}`)) {
      setCooldown(`PAPER-EXIT:${pos.symbol}`);
      recordAlert('SELL', pos.symbol,
        `Exit signal on paper position ${pos.symbol} — ${reason}`,
        [settings.autoTrade ? 'Market is closed; will act when it opens if the rule still holds.'
                            : 'Auto-trade is OFF, so nothing was sold. Flip it on or close manually.'],
        0xf0564a);
    }
  }
}

// ============================================================================
// 6. DISCORD — webhook alerts (plus a local alert feed for the dashboard)
// ============================================================================

async function sendDiscord(title, lines, color) {
  if (!WEBHOOK) return;
  try {
    const res = await fetch(WEBHOOK, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        username: 'Sentinel',
        embeds: [{
          title,
          description: lines.join('\n'),
          color,
          footer: { text: 'Sentinel · paper trading & research — not financial advice' },
          timestamp: new Date().toISOString()
        }]
      })
    });
    if (!res.ok && res.status !== 204) pushError(`Discord webhook HTTP ${res.status}`);
  } catch (e) {
    pushError(`Discord send failed: ${e.message}`);
  }
}

function recordAlert(type, symbol, title, lines, color) {
  alerts.unshift({ t: Date.now(), type, symbol, title, lines });
  alerts = alerts.slice(0, 100);
  saveJSON('alerts.json', alerts);
  const icon = type === 'BUY' ? '🟢' : type === 'SELL' ? '🔴' : '🟡';
  sendDiscord(`${icon} ${title}`, lines, color);
  console.log(`[ALERT] ${type} ${symbol} — ${title}`);
}

// ============================================================================
// 7. SCHEDULER — the watchlist sweep and the market-wide radar
// ============================================================================

async function runSweep() {
  if (state.scanning || !FINNHUB_KEY) return;
  state.scanning = true;
  try {
    await syncBroker();   // fresh account/positions before any decisions

    const symbols = [...new Set([
      ...settings.watchlist,
      ...portfolio.map(p => p.symbol),
      ...state.broker.positions.map(p => p.symbol)
    ])];
    const results = [];

    for (const symbol of symbols) {
      try {
        const quote = await finnhub('quote', { symbol });
        await sleep(250);
        if (!quote || !quote.c) { results.push(deadRow(symbol, 'no quote data')); continue; }

        const profile = await getProfile(symbol);
        await sleep(250);
        const articles = await finnhub('company-news', { symbol, from: isoDaysAgo(2), to: isoDaysAgo(0) });
        await sleep(250);

        const entry = {
          symbol,
          name: profile.name,
          marketCapM: profile.marketCapM,
          price: quote.c,
          changePct: typeof quote.dp === 'number' ? quote.dp : null,
          news: analyzeNews(articles)
        };
        const { verdict, reasons } = evaluate(entry);
        entry.verdict = verdict;
        entry.reasons = reasons;

        state.prices[symbol] = quote.c;
        results.push(entry);

        if (verdict === 'BUY WATCH' && !onCooldown(`BUY:${symbol}`)) {
          setCooldown(`BUY:${symbol}`);
          recordAlert('BUY', symbol,
            `BUY WATCH — ${symbol} $${quote.c.toFixed(2)}`,
            [...reasons, ...entry.news.top.map(t => `"${t.headline}" — ${t.source}`)],
            0x3dd68c);
          await maybeAutoBuy(symbol, quote.c, reasons);
        }
      } catch (e) {
        pushError(`${symbol}: ${e.message}`);
        results.push(deadRow(symbol, e.message));
      }
    }

    state.watch = results;
    state.lastScan = Date.now();

    await syncBroker();        // refresh once more so exits see any new fills
    await manageExits();
    checkManualPositions();
  } finally {
    state.scanning = false;
  }
}

function deadRow(symbol, note) {
  return { symbol, name: symbol, price: null, changePct: null, marketCapM: null,
    news: { sentiment: 0, sources: [], hypeCount: 0, articleCount: 0, top: [] },
    verdict: 'NO DATA', reasons: [note] };
}

async function runRadar() {
  if (!AV_KEY) return;
  try {
    const res = await fetch(`https://www.alphavantage.co/query?function=TOP_GAINERS_LOSERS&apikey=${AV_KEY}`);
    const data = await res.json();
    if (!data.top_gainers) {
      state.radarNote = data.Information || data.Note || 'Alpha Vantage daily limit reached — radar resumes tomorrow.';
      state.lastRadar = Date.now();
      return;
    }
    state.radarNote = '';

    const candidates = data.top_gainers
      .map(g => ({ symbol: (g.ticker || '').toUpperCase(), price: parseFloat(g.price), changePct: parseFloat(g.change_percentage) }))
      .filter(g => /^[A-Z]{1,5}$/.test(g.symbol) && !isNaN(g.price))
      .slice(0, 10);

    const radar = [];
    let deepChecked = 0;

    for (const c of candidates) {
      if (c.price < settings.minPrice) {
        radar.push({ ...c, verdict: 'AVOID', note: `Under $${settings.minPrice} — penny-stock pump profile.` });
        continue;
      }
      if (c.changePct > 25) {
        radar.push({ ...c, verdict: 'AVOID', note: `Up ${c.changePct.toFixed(0)}% already — parabolic moves are the bait, not the opportunity.` });
        continue;
      }
      if (deepChecked >= 5 || !FINNHUB_KEY) {
        radar.push({ ...c, verdict: 'UNCHECKED', note: 'Passed basic filters; deep-check limit reached this cycle.' });
        continue;
      }

      deepChecked++;
      try {
        const articles = await finnhub('company-news', { symbol: c.symbol, from: isoDaysAgo(2), to: isoDaysAgo(0) });
        await sleep(250);
        const profile = await getProfile(c.symbol);
        await sleep(250);
        const entry = { symbol: c.symbol, name: profile.name, marketCapM: profile.marketCapM,
          price: c.price, changePct: c.changePct, news: analyzeNews(articles) };
        const { verdict, reasons } = evaluate(entry);
        radar.push({ ...c, name: profile.name, verdict, note: reasons[0] || 'No strong signal either way.' });

        if (verdict === 'BUY WATCH' && !onCooldown(`RADAR:${c.symbol}`)) {
          setCooldown(`RADAR:${c.symbol}`);
          recordAlert('BUY', c.symbol,
            `RADAR — ${c.symbol} passed every filter ($${c.price.toFixed(2)}, +${c.changePct.toFixed(1)}%)`,
            [...reasons, ...entry.news.top.map(t => `"${t.headline}" — ${t.source}`)],
            0x3dd68c);
          await syncBroker();
          await maybeAutoBuy(c.symbol, c.price, reasons);
        }
      } catch (e) {
        radar.push({ ...c, verdict: 'NO DATA', note: e.message });
      }
    }

    state.radar = radar;
    state.lastRadar = Date.now();
  } catch (e) {
    pushError(`Radar: ${e.message}`);
    state.lastRadar = Date.now();
  }
}

setInterval(() => {
  if (!state.lastScan || Date.now() - state.lastScan >= settings.scanMinutes * 60e3) runSweep();
  if (!state.lastRadar || Date.now() - state.lastRadar >= settings.radarMinutes * 60e3) runRadar();
}, 30e3);
setTimeout(runSweep, 2000);
setTimeout(runRadar, 15000);

// ============================================================================
// 8. API + SERVER — everything the dashboard needs
// ============================================================================

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

function marketStatus() {
  if (state.broker.connected && state.broker.clock) return state.broker.clock.open ? 'OPEN' : 'CLOSED';
  const et = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const mins = et.getHours() * 60 + et.getMinutes();
  const weekday = et.getDay() >= 1 && et.getDay() <= 5;
  return weekday && mins >= 570 && mins < 960 ? 'OPEN' : 'CLOSED';
}

app.get('/api/state', (req, res) => {
  const enriched = portfolio.map(p => {
    const price = state.prices[p.symbol] || null;
    const plPct = price ? ((price - p.cost) / p.cost) * 100 : null;
    const pl = price ? (price - p.cost) * p.shares : null;
    let status = '—';
    if (plPct !== null) {
      status = plPct >= settings.takeProfitPct ? 'TAKE-PROFIT ZONE'
        : plPct <= -settings.stopLossPct ? 'STOP-LOSS ZONE' : 'HOLDING';
    }
    return { ...p, price, pl, plPct, status };
  });
  res.json({
    settings, market: marketStatus(),
    scanning: state.scanning, lastScan: state.lastScan, lastRadar: state.lastRadar,
    watch: state.watch, radar: state.radar, radarNote: state.radarNote,
    portfolio: enriched, alerts: alerts.slice(0, 50), errors: state.errors,
    broker: state.broker, breaker: state.breaker
  });
});

const cleanSymbol = s => String(s || '').toUpperCase().trim().replace(/[^A-Z.]/g, '').slice(0, 6);

app.post('/api/watchlist', (req, res) => {
  const symbol = cleanSymbol(req.body.symbol);
  if (!symbol) return res.status(400).json({ error: 'Enter a ticker symbol, like NVDA.' });
  if (!settings.watchlist.includes(symbol)) {
    settings.watchlist.push(symbol);
    saveJSON('settings.json', settings);
    state.lastScan = null;
  }
  res.json({ ok: true });
});

app.delete('/api/watchlist/:symbol', (req, res) => {
  const symbol = cleanSymbol(req.params.symbol);
  settings.watchlist = settings.watchlist.filter(s => s !== symbol);
  saveJSON('settings.json', settings);
  state.watch = state.watch.filter(w => w.symbol !== symbol || portfolio.some(p => p.symbol === symbol));
  res.json({ ok: true });
});

app.post('/api/portfolio', (req, res) => {
  const symbol = cleanSymbol(req.body.symbol);
  const shares = parseFloat(req.body.shares);
  const cost = parseFloat(req.body.cost);
  if (!symbol || !(shares > 0) || !(cost > 0)) {
    return res.status(400).json({ error: 'Need a symbol, share count above 0, and your buy price above 0.' });
  }
  portfolio.push({ id: `${Date.now()}${Math.floor(Math.random() * 999)}`, symbol, shares, cost, addedAt: Date.now() });
  saveJSON('portfolio.json', portfolio);
  state.lastScan = null;
  res.json({ ok: true });
});

app.delete('/api/portfolio/:id', (req, res) => {
  portfolio = portfolio.filter(p => p.id !== req.params.id);
  saveJSON('portfolio.json', portfolio);
  res.json({ ok: true });
});

app.post('/api/settings', (req, res) => {
  const numeric = ['scanMinutes', 'radarMinutes', 'buyThreshold', 'sellThreshold', 'minSources',
    'minPrice', 'minMarketCapM', 'maxChasePct', 'takeProfitPct', 'stopLossPct', 'cooldownHours',
    'tradeDollars', 'maxPositions', 'maxDailyLossPct'];
  for (const k of numeric) {
    if (req.body[k] !== undefined && !isNaN(parseFloat(req.body[k]))) settings[k] = parseFloat(req.body[k]);
  }
  settings.scanMinutes = Math.max(2, settings.scanMinutes);
  settings.tradeDollars = Math.max(1, settings.tradeDollars);
  settings.maxPositions = Math.max(1, Math.round(settings.maxPositions));
  saveJSON('settings.json', settings);
  res.json({ ok: true, settings });
});

// --- paper trading routes ---------------------------------------------------

app.post('/api/autotrade', (req, res) => {
  if (!state.broker.connected && req.body.enabled) {
    return res.status(400).json({ error: 'Connect Alpaca first — add paper keys to .env and restart (README Part 2).' });
  }
  settings.autoTrade = !!req.body.enabled;
  if (settings.autoTrade) state.breaker = '';
  saveJSON('settings.json', settings);
  recordAlert('INFO', 'SYSTEM', settings.autoTrade ? '🟢 Auto-trade ON (paper account)' : '⏸ Auto-trade OFF',
    [settings.autoTrade
      ? `Sentinel may now place paper trades: $${settings.tradeDollars} per signal, max ${settings.maxPositions} positions, ${settings.maxDailyLossPct}% daily-loss breaker.`
      : 'Sentinel is back to alert-only. Open paper positions are still monitored.'],
    0xe8b84b);
  res.json({ ok: true, autoTrade: settings.autoTrade });
});

app.post('/api/paper/buy', async (req, res) => {
  if (!state.broker.connected) return res.status(400).json({ error: 'Alpaca not connected — see README Part 2.' });
  const symbol = cleanSymbol(req.body.symbol);
  const dollars = parseFloat(req.body.dollars);
  if (!symbol || !(dollars >= 1)) return res.status(400).json({ error: 'Need a ticker and at least $1.' });
  if (!state.broker.clock || !state.broker.clock.open) {
    return res.status(400).json({ error: 'Market is closed — paper orders fill 9:30–4:00 ET, Mon–Fri.' });
  }
  try {
    await broker.buyDollars(symbol, dollars);
    recordAlert('BUY', symbol, `PAPER BUY (manual) — $${dollars.toFixed(2)} of ${symbol}`, ['Placed from the dashboard ticket.'], 0x3dd68c);
    await syncBroker();
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/paper/close/:symbol', async (req, res) => {
  if (!state.broker.connected) return res.status(400).json({ error: 'Alpaca not connected.' });
  try {
    await broker.closePosition(cleanSymbol(req.params.symbol));
    recordAlert('SELL', cleanSymbol(req.params.symbol), `PAPER SELL (manual) — ${cleanSymbol(req.params.symbol)} closed`, ['Closed from the dashboard.'], 0xf0564a);
    await syncBroker();
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/paper/closeall', async (req, res) => {
  if (!state.broker.connected) return res.status(400).json({ error: 'Alpaca not connected.' });
  try {
    await broker.closeAll();
    recordAlert('SELL', 'ALL', 'PAPER SELL — all positions flattened', ['Close-all pressed on the dashboard.'], 0xf0564a);
    await syncBroker();
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.post('/api/scan', (req, res) => { state.lastScan = null; state.lastRadar = null; res.json({ ok: true }); });

app.post('/api/test', async (req, res) => {
  await sendDiscord('⚙️ Sentinel is connected', ['Webhook test successful. Alerts will land in this channel.'], 0xe8b84b);
  res.json({ ok: WEBHOOK ? true : false, error: WEBHOOK ? null : 'No DISCORD_WEBHOOK_URL in .env yet.' });
});

app.listen(PORT, () => {
  console.log('──────────────────────────────────────────────');
  console.log('  SENTINEL v2 is running');
  console.log(`  Dashboard  : http://localhost:${PORT}`);
  console.log(`  Watchlist  : ${settings.watchlist.join(', ')}`);
  console.log(`  Sweep      : every ${settings.scanMinutes} min · Radar every ${settings.radarMinutes} min`);
  console.log(`  Paper desk : ${broker.configured() ? 'keys loaded (Alpaca paper)' : 'not configured — README Part 2'}`);
  console.log(`  Auto-trade : ${settings.autoTrade ? 'ON' : 'OFF'} — trades PAPER money only, by design`);
  console.log('──────────────────────────────────────────────');
});
