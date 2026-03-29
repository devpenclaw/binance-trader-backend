const express = require('express');
const cors = require('cors');
const { WebSocketServer } = require('ws');
const axios = require('axios');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());

// Load config
const CONFIG_PATH = path.join(__dirname, 'config.json');
let config = {
  mode: 'sandbox',
  apiKey: '',
  apiSecret: '',
  testnet: true,
  pairs: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT'],
  initialCapital: 100,
  tradeAmountPercent: 10,
  stopLossPercent: 2,
  takeProfitPercent: 3,
  strategy: 'rsi_macd'
};

if (fs.existsSync(CONFIG_PATH)) {
  config = { ...config, ...JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')) };
}

// State
let positions = {};
let tradeHistory = [];
let capital = config.initialCapital;
let equity = capital;
let isRunning = false;
let lastAnalysis = {};
let wsClients = new Set();

// Binance API
const BINANCE_BASE = config.testnet 
  ? 'https://testnet.binancefuture.com'
  : 'https://fapi.binance.com';

async function apiRequest(endpoint, params = {}) {
  const timestamp = Date.now();
  const query = new URLSearchParams({ ...params, timestamp }).toString();
  let url = `${BINANCE_BASE}${endpoint}?${query}`;
  
  if (config.mode === 'live' && config.apiSecret) {
    const signature = crypto.createHmac('sha256', config.apiSecret)
      .update(query)
      .digest('hex');
    url += `&signature=${signature}`;
  }
  
  try {
    const res = await axios.get(url, {
      headers: { 'X-MBX-APIKEY': config.apiKey || '' }
    });
    return res.data;
  } catch (e) {
    console.error('API Error:', e.response?.data?.message || e.message);
    return null;
  }
}

// Indicators
const indicators = {
  RSI(prices, period = 14) {
    if (prices.length < period + 1) return null;
    const closes = prices.slice(-(period + 1));
    let gains = 0, losses = 0;
    for (let i = 1; i < closes.length; i++) {
      const diff = closes[i] - closes[i - 1];
      if (diff > 0) gains += diff;
      else losses += Math.abs(diff);
    }
    if (losses === 0) return 100;
    return 100 - (100 / (1 + gains / losses));
  },

  SMA(prices, period) {
    if (prices.length < period) return null;
    return prices.slice(-period).reduce((a, b) => a + b, 0) / period;
  },

  EMA(prices, period) {
    if (prices.length < period) return null;
    const multiplier = 2 / (period + 1);
    let ema = prices.slice(0, period).reduce((a, b) => a + b, 0) / period;
    for (let i = period; i < prices.length; i++) {
      ema = (prices[i] - ema) * multiplier + ema;
    }
    return ema;
  },

  MACD(prices) {
    if (prices.length < 26) return null;
    const ema12 = indicators.EMA(prices, 12);
    const ema26 = indicators.EMA(prices, 26);
    if (!ema12 || !ema26) return null;
    return { value: ema12 - ema26, signal: ema12 - ema26 * 0.9 };
  },

  BollingerBands(prices, period = 20) {
    if (prices.length < period) return null;
    const sma = indicators.SMA(prices, period);
    const slice = prices.slice(-period);
    const variance = slice.reduce((sum, val) => sum + Math.pow(val - sma, 2), 0) / period;
    const std = Math.sqrt(variance);
    return { upper: sma + 2 * std, middle: sma, lower: sma - 2 * std };
  }
};

// Get market data
async function getKlines(symbol, interval = '1m', limit = 100) {
  const data = await apiRequest('/fapi/v1/klines', { symbol, interval, limit });
  if (!data) return null;
  return data.map(k => ({
    open: parseFloat(k[1]),
    high: parseFloat(k[2]),
    low: parseFloat(k[3]),
    close: parseFloat(k[4]),
    volume: parseFloat(k[5]),
    time: parseInt(k[0])
  }));
}

async function getPrice(symbol) {
  const data = await apiRequest('/fapi/v1/ticker/price', { symbol });
  return data ? parseFloat(data.price) : null;
}

// Analyze market
async function analyzeMarket(pair) {
  const klines = await getKlines(pair, '1m', 50);
  if (!klines) return null;
  
  const closes = klines.map(k => k.close);
  const currentPrice = closes[closes.length - 1];
  
  const rsi = indicators.RSI(closes, 14);
  const macd = indicators.MACD(closes);
  const bb = indicators.BollingerBands(closes, 20);
  const sma20 = indicators.SMA(closes, 20);
  const sma50 = indicators.SMA(closes, 50);
  
  // Determine signal
  let signal = 'HOLD';
  let confidence = 0;
  let reasons = [];
  
  // RSI signals
  if (rsi < 30) {
    signal = 'BUY';
    confidence += 35;
    reasons.push(`RSI oversold (${rsi.toFixed(1)})`);
  } else if (rsi > 70) {
    signal = 'SELL';
    confidence += 35;
    reasons.push(`RSI overbought (${rsi.toFixed(1)})`);
  }
  
  // MACD signals
  if (macd && macd.value > macd.signal) {
    if (signal === 'BUY') confidence += 25;
    reasons.push('MACD bullish');
  } else if (macd && macd.value < macd.signal) {
    if (signal === 'SELL') confidence += 25;
    reasons.push('MACD bearish');
  }
  
  // Trend
  if (currentPrice > sma20 && sma20 > sma50) {
    if (signal === 'BUY') confidence += 20;
    reasons.push('Uptrend');
  } else if (currentPrice < sma20 && sma20 < sma50) {
    if (signal === 'SELL') confidence += 20;
    reasons.push('Downtrend');
  }
  
  // Bollinger
  if (bb) {
    if (currentPrice < bb.lower) {
      if (signal === 'BUY') confidence += 15;
      reasons.push('Near lower BB');
    } else if (currentPrice > bb.upper) {
      if (signal === 'SELL') confidence += 15;
      reasons.push('Near upper BB');
    }
  }
  
  return {
    pair,
    price: currentPrice,
    rsi,
    macd: macd?.value,
    bb,
    sma20,
    sma50,
    signal,
    confidence,
    reasons
  };
}

// Trading logic
async function checkAndTrade(pair) {
  const analysis = await analyzeMarket(pair);
  if (!analysis) return;
  
  lastAnalysis[pair] = analysis;
  const pos = positions[pair];
  const currentPrice = analysis.price;
  
  if (pos) {
    // Check exit conditions
    const pnlPercent = pos.type === 'LONG'
      ? ((currentPrice - pos.entryPrice) / pos.entryPrice) * 100
      : ((pos.entryPrice - currentPrice) / pos.entryPrice) * 100;
    
    pos.pnlPercent = pnlPercent;
    pos.currentPrice = currentPrice;
    
    // Stop loss
    if (pnlPercent <= -config.stopLossPercent) {
      await closePosition(pair, currentPrice, 'STOP_LOSS');
      return;
    }
    
    // Take profit
    if (pnlPercent >= config.takeProfitPercent) {
      await closePosition(pair, currentPrice, 'TAKE_PROFIT');
      return;
    }
  } else {
    // Entry conditions
    if (analysis.signal === 'BUY' && analysis.confidence >= 60) {
      await openPosition(pair, 'LONG', currentPrice);
    } else if (analysis.signal === 'SELL' && analysis.confidence >= 60) {
      await openPosition(pair, 'SHORT', currentPrice);
    }
  }
  
  broadcastUpdate();
}

async function openPosition(pair, type, price) {
  const tradeAmount = (capital * config.tradeAmountPercent / 100);
  const quantity = tradeAmount / price;
  
  const position = {
    type,
    entryPrice: price,
    quantity,
    entryTime: Date.now()
  };
  
  positions[pair] = position;
  
  const trade = {
    pair,
    type,
    side: type === 'LONG' ? 'BUY' : 'SELL',
    entryPrice: price,
    quantity,
    entryTime: Date.now(),
    mode: config.mode
  };
  
  tradeHistory.push(trade);
  capital -= price * quantity;
  saveState();
  
  console.log(`📝 ${type} position opened: ${pair} @ $${price}`);
  broadcastUpdate();
}

async function closePosition(pair, currentPrice, reason = 'MANUAL') {
  const pos = positions[pair];
  if (!pos) return;
  
  const pnl = pos.type === 'LONG'
    ? (currentPrice - pos.entryPrice) * pos.quantity
    : (pos.entryPrice - currentPrice) * pos.quantity;
  
  const pnlPercent = pos.type === 'LONG'
    ? ((currentPrice - pos.entryPrice) / pos.entryPrice) * 100
    : ((pos.entryPrice - currentPrice) / pos.entryPrice) * 100;
  
  // Update capital
  if (pos.type === 'LONG') {
    capital += pos.entryPrice * pos.quantity + pnl;
  } else {
    capital -= pos.entryPrice * pos.quantity - pnl;
  }
  
  const trade = tradeHistory.find(t => 
    t.pair === pair && t.entryTime === pos.entryTime && !t.exitTime
  );
  if (trade) {
    trade.exitPrice = currentPrice;
    trade.exitTime = Date.now();
    trade.pnl = pnl;
    trade.pnlPercent = pnlPercent;
    trade.reason = reason;
  }
  
  delete positions[pair];
  saveState();
  
  console.log(`📊 Position closed: ${pair} ${reason} | PnL: $${pnl.toFixed(2)} (${pnlPercent.toFixed(2)}%)`);
  broadcastUpdate();
}

// Broadcast to WebSocket clients
function broadcastUpdate() {
  const data = getStatus();
  wsClients.forEach(ws => {
    try {
      ws.send(JSON.stringify(data));
    } catch (e) {
      wsClients.delete(ws);
    }
  });
}

function getStatus() {
  const totalEquity = capital + Object.values(positions).reduce((sum, pos) => {
    const posValue = pos.quantity * (pos.currentPrice || pos.entryPrice);
    return sum + posValue;
  }, 0);
  
  const pnl = totalEquity - config.initialCapital;
  const pnlPercent = ((totalEquity / config.initialCapital) - 1) * 100;
  
  const closedTrades = tradeHistory.filter(t => t.exitTime);
  const wins = closedTrades.filter(t => t.pnl > 0).length;
  const winRate = closedTrades.length > 0 ? (wins / closedTrades.length * 100) : 0;
  
  return {
    status: 'ok',
    isRunning,
    mode: config.mode,
    pairs: config.pairs,
    capital,
    equity: totalEquity,
    pnl,
    pnlPercent,
    positions: Object.entries(positions).map(([pair, pos]) => ({
      pair,
      ...pos
    })),
    analysis: lastAnalysis,
    stats: {
      totalTrades: closedTrades.length,
      wins,
      losses: closedTrades.length - wins,
      winRate
    },
    recentTrades: tradeHistory.slice(-10).reverse(),
    config
  };
}

// Trading loop
let tradingInterval = null;

function startTrading() {
  if (isRunning) return;
  isRunning = true;
  console.log('🚀 Trading started');
  
  tradingInterval = setInterval(async () => {
    for (const pair of config.pairs) {
      await checkAndTrade(pair);
      await new Promise(r => setTimeout(r, 1000));
    }
  }, 30000); // Check every 30 seconds
  
  broadcastUpdate();
}

function stopTrading() {
  isRunning = false;
  if (tradingInterval) {
    clearInterval(tradingInterval);
    tradingInterval = null;
  }
  console.log('⏹️ Trading stopped');
  broadcastUpdate();
}

// Save/load state
function saveState() {
  const state = {
    positions,
    tradeHistory: tradeHistory.slice(-100),
    capital,
    savedAt: Date.now()
  };
  fs.writeFileSync(path.join(__dirname, 'state.json'), JSON.stringify(state));
}

function loadState() {
  const statePath = path.join(__dirname, 'state.json');
  if (fs.existsSync(statePath)) {
    const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    positions = state.positions || {};
    tradeHistory = state.tradeHistory || [];
    capital = state.capital || config.initialCapital;
    console.log(`📂 State loaded: $${capital.toFixed(2)}`);
  }
}

// Routes
app.get('/api/status', (req, res) => {
  res.json(getStatus());
});

app.get('/api/config', (req, res) => {
  res.json(config);
});

app.post('/api/config', (req, res) => {
  const newConfig = req.body;
  config = { ...config, ...newConfig };
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
  res.json({ success: true, config });
});

app.post('/api/trading/start', (req, res) => {
  startTrading();
  res.json({ success: true, isRunning: true });
});

app.post('/api/trading/stop', (req, res) => {
  stopTrading();
  res.json({ success: true, isRunning: false });
});

app.post('/api/positions/:pair/close', async (req, res) => {
  const { pair } = req.params;
  const price = await getPrice(pair);
  if (price) {
    await closePosition(pair, price, 'MANUAL');
  }
  res.json({ success: true });
});

app.get('/api/history', (req, res) => {
  res.json(tradeHistory.filter(t => t.exitTime));
});

app.post('/api/reset', (req, res) => {
  stopTrading();
  positions = {};
  tradeHistory = [];
  capital = config.initialCapital;
  saveState();
  res.json({ success: true });
});

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: Date.now() });
});

// Start server
const PORT = process.env.PORT || 3001;
const server = app.listen(PORT, () => {
  console.log(`🚀 Backend running on port ${PORT}`);
  loadState();
  
  // Auto-start trading if config says so
  if (config.autoStart) {
    startTrading();
  }
});

// WebSocket
const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  wsClients.add(ws);
  ws.send(JSON.stringify(getStatus()));
  
  ws.on('close', () => {
    wsClients.delete(ws);
  });
});

// Graceful shutdown
process.on('SIGTERM', () => {
  stopTrading();
  saveState();
  server.close();
  process.exit(0);
});
