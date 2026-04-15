'use strict';
require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const crypto  = require('crypto');
const https   = require('https');

const app = express();
app.use(cors({ origin: ['http://localhost:3000', 'http://127.0.0.1:3000', 'null', '*'] }));
app.use(express.json());

// ── Config ──────────────────────────────────────────────────────────────────
const BINANCE_BASE  = 'https://api.binance.com';
const API_KEY       = process.env.BINANCE_API_KEY    || '';
const API_SECRET    = process.env.BINANCE_API_SECRET || '';
const SERVER_PORT   = parseInt(process.env.PORT || '3001', 10);

// Daily loss guard (configurable via env, defaults to $100)
const MAX_DAILY_LOSS_USD = parseFloat(process.env.MAX_DAILY_LOSS_USD || '100');

// Simple in-memory daily loss tracker (resets on server restart / new day)
let dailyLossUSD  = 0;
let dailyLossDate = new Date().toDateString();

function checkDailyLossReset() {
  const today = new Date().toDateString();
  if (today !== dailyLossDate) { dailyLossUSD = 0; dailyLossDate = today; }
}

// ── HMAC-SHA256 signing (Binance requirement) ────────────────────────────────
function sign(params) {
  const qs = new URLSearchParams(params).toString();
  return crypto.createHmac('sha256', API_SECRET).update(qs).digest('hex');
}

// ── Low-level Binance fetch (uses built-in https, zero extra deps) ───────────
function binanceFetch(method, path, params = {}) {
  return new Promise((resolve, reject) => {
    const ts = Date.now();
    const signed = { ...params, timestamp: ts };
    signed.signature = sign(signed);

    const qs = new URLSearchParams(signed).toString();

    let urlPath;
    let body = null;
    if (method === 'GET' || method === 'DELETE') {
      urlPath = `${path}?${qs}`;
    } else {
      urlPath = path;
      body = qs;
    }

    const opts = {
      hostname: 'api.binance.com',
      path: urlPath,
      method,
      headers: {
        'X-MBX-APIKEY': API_KEY,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
    };
    if (body) opts.headers['Content-Length'] = Buffer.byteLength(body);

    const req = https.request(opts, (res) => {
      let data = '';
      res.on('data', chunk => (data += chunk));
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (res.statusCode >= 400) reject(new Error(json.msg || JSON.stringify(json)));
          else resolve(json);
        } catch (e) {
          reject(new Error('Non-JSON response: ' + data.slice(0, 200)));
        }
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

// Public (no-auth) Binance fetch
function binancePublic(path) {
  return new Promise((resolve, reject) => {
    https.get(`https://api.binance.com${path}`, (res) => {
      let data = '';
      res.on('data', c => (data += c));
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error('Non-JSON: ' + data.slice(0, 200))); }
      });
    }).on('error', reject);
  });
}

// ── Coin → Binance symbol map ────────────────────────────────────────────────
const SYMBOL_MAP = {
  bitcoin:     'BTCUSDT',
  ethereum:    'ETHUSDT',
  solana:      'SOLUSDT',
  binancecoin: 'BNBUSDT',
  ripple:      'XRPUSDT',
  dogecoin:    'DOGEUSDT',
};

// ── Guards ───────────────────────────────────────────────────────────────────
function requireKeys(res) {
  if (!API_KEY || !API_SECRET) {
    res.status(500).json({ error: 'API keys not configured. Add BINANCE_API_KEY and BINANCE_API_SECRET to your .env file.' });
    return false;
  }
  return true;
}

// ── Routes ───────────────────────────────────────────────────────────────────

// Health / status check
app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    exchange: 'binance',
    keysLoaded: !!(API_KEY && API_SECRET),
    dailyLoss: dailyLossUSD,
    maxDailyLoss: MAX_DAILY_LOSS_USD,
    serverTime: new Date().toISOString(),
  });
});

// Live price (public, no auth)
app.get('/api/price/:coinId', async (req, res) => {
  try {
    const sym = SYMBOL_MAP[req.params.coinId] || req.params.coinId.toUpperCase();
    const data = await binancePublic(`/api/v3/ticker/24hr?symbol=${sym}`);
    res.json({
      symbol: sym,
      price: parseFloat(data.lastPrice),
      change24h: parseFloat(data.priceChangePercent),
      high24h: parseFloat(data.highPrice),
      low24h: parseFloat(data.lowPrice),
      volume24h: parseFloat(data.volume),
    });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Exchange info — lot size / min notional for a symbol
app.get('/api/info/:coinId', async (req, res) => {
  try {
    const sym = SYMBOL_MAP[req.params.coinId] || req.params.coinId.toUpperCase();
    const data = await binancePublic(`/api/v3/exchangeInfo?symbol=${sym}`);
    const info = data.symbols?.[0];
    if (!info) return res.status(404).json({ error: 'Symbol not found' });
    const filters = {};
    (info.filters || []).forEach(f => { filters[f.filterType] = f; });
    res.json({
      symbol: sym,
      baseAsset: info.baseAsset,
      quoteAsset: info.quoteAsset,
      stepSize: filters.LOT_SIZE?.stepSize,
      minQty: filters.LOT_SIZE?.minQty,
      minNotional: filters.MIN_NOTIONAL?.minNotional || filters.NOTIONAL?.minNotional,
    });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Account balances
app.get('/api/balance', async (req, res) => {
  if (!requireKeys(res)) return;
  try {
    const data = await binanceFetch('GET', '/api/v3/account');
    const balances = data.balances
      .filter(b => parseFloat(b.free) > 0 || parseFloat(b.locked) > 0)
      .map(b => ({ asset: b.asset, free: parseFloat(b.free), locked: parseFloat(b.locked) }));
    res.json({ balances });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Open orders
app.get('/api/orders', async (req, res) => {
  if (!requireKeys(res)) return;
  try {
    const params = {};
    if (req.query.symbol) params.symbol = req.query.symbol;
    const data = await binanceFetch('GET', '/api/v3/openOrders', params);
    res.json(data);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Place MARKET order
// body: { coinId, side: 'BUY'|'SELL', quoteQty?, qty? }
//   quoteQty = spend this many USDT (for BUY)
//   qty      = sell this many coins (for SELL)
app.post('/api/order', async (req, res) => {
  if (!requireKeys(res)) return;

  checkDailyLossReset();
  if (dailyLossUSD >= MAX_DAILY_LOSS_USD) {
    return res.status(403).json({
      error: `Daily loss limit hit ($${MAX_DAILY_LOSS_USD}). Server will not place more orders today. Reset limit in .env or restart server.`
    });
  }

  const { coinId, side, quoteQty, qty } = req.body;
  if (!coinId || !side) return res.status(400).json({ error: 'coinId and side are required' });

  const upperSide = side.toUpperCase();
  if (upperSide !== 'BUY' && upperSide !== 'SELL') {
    return res.status(400).json({ error: 'side must be BUY or SELL' });
  }

  const symbol = SYMBOL_MAP[coinId] || coinId.toUpperCase();
  const params = { symbol, side: upperSide, type: 'MARKET' };

  if (upperSide === 'BUY') {
    if (!quoteQty || parseFloat(quoteQty) <= 0) {
      return res.status(400).json({ error: 'quoteQty (USDT amount to spend) required for BUY' });
    }
    params.quoteOrderQty = parseFloat(quoteQty).toFixed(2);
  } else {
    if (!qty || parseFloat(qty) <= 0) {
      return res.status(400).json({ error: 'qty (coin amount to sell) required for SELL' });
    }
    params.quantity = parseFloat(qty).toFixed(8).replace(/0+$/, '').replace(/\.$/, '');
  }

  try {
    const data = await binanceFetch('POST', '/api/v3/order', params);

    // Track realised loss from sells
    if (upperSide === 'SELL') {
      const fills = data.fills || [];
      const proceeds = fills.reduce((s, f) => s + parseFloat(f.price) * parseFloat(f.qty), 0);
      // We don't know entry price server-side, so track via the caller reporting pnl
      // The client sends pnl in the body if available
      if (req.body.pnl && parseFloat(req.body.pnl) < 0) {
        dailyLossUSD += Math.abs(parseFloat(req.body.pnl));
      }
    }

    res.json({
      orderId: data.orderId,
      symbol: data.symbol,
      side: data.side,
      status: data.status,
      executedQty: parseFloat(data.executedQty),
      cummulativeQuoteQty: parseFloat(data.cummulativeQuoteQty),
      fills: (data.fills || []).map(f => ({
        price: parseFloat(f.price),
        qty: parseFloat(f.qty),
        commission: parseFloat(f.commission),
        commissionAsset: f.commissionAsset,
      })),
    });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Cancel open order
app.delete('/api/order', async (req, res) => {
  if (!requireKeys(res)) return;
  const { symbol, orderId } = req.query;
  if (!symbol || !orderId) return res.status(400).json({ error: 'symbol and orderId required' });
  try {
    const data = await binanceFetch('DELETE', '/api/v3/order', { symbol, orderId });
    res.json(data);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Daily loss stats (for UI display)
app.get('/api/stats', (req, res) => {
  checkDailyLossReset();
  res.json({ dailyLoss: dailyLossUSD, maxDailyLoss: MAX_DAILY_LOSS_USD });
});

// ── Start ────────────────────────────────────────────────────────────────────
app.listen(SERVER_PORT, '127.0.0.1', () => {
  console.log('\n╔══════════════════════════════════════════╗');
  console.log('║        ContentDrop Trading Server        ║');
  console.log('╠══════════════════════════════════════════╣');
  console.log(`║  URL:       http://127.0.0.1:${SERVER_PORT}        ║`);
  console.log(`║  Exchange:  Binance                      ║`);
  console.log(`║  API Key:   ${API_KEY ? '✓ loaded (' + API_KEY.slice(0,8) + '...)' : '✗ NOT SET — edit .env'}    ║`);
  console.log(`║  Max loss:  $${MAX_DAILY_LOSS_USD}/day                   ║`);
  console.log('╚══════════════════════════════════════════╝\n');

  if (!API_KEY || !API_SECRET) {
    console.warn('⚠  No API keys found. Copy .env.example → .env and fill in your Binance keys.\n');
  }
});
