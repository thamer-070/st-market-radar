require('dotenv').config();

const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const express = require('express');
const { createClient } = require('@supabase/supabase-js');

const bot = new TelegramBot(process.env.BOT_TOKEN, {
  polling: true
});

const app = express();

const RESTART_PASSWORD = process.env.RESTART_PASSWORD || '0126188';

app.use(express.json());

app.get('/', (req, res) => {
  res.send('Radar Bot is running');
});

app.post('/restart', (req, res) => {
  if (req.body?.password !== RESTART_PASSWORD) {
    return res.status(403).json({ ok: false, error: 'Forbidden' });
  }

  res.status(200).json({ ok: true, message: 'Restart command received' });

  setTimeout(() => {
    process.exit(0);
  }, 5000);
});

const RADAR_API_SECRET =
  process.env.RADAR_API_SECRET || 'ST_RADAR_2026_PRIVATE_KEY';

const PORT =
  process.env.PORT || 3000;

const API_KEY = process.env.MASSIVE_API_KEY;
const FINNHUB_API_KEY = process.env.FINNHUB_API_KEY;

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

const decisionSupabase = createClient(
  process.env.DECISION_SUPABASE_URL,
  process.env.DECISION_SUPABASE_KEY
);

const imageSupabase = createClient(
  process.env.IMAGE_SUPABASE_URL,
  process.env.IMAGE_SUPABASE_KEY
);

const hubSupabase = createClient(
  process.env.HUB_SUPABASE_URL,
  process.env.HUB_SUPABASE_KEY
);

const ADMIN_IDS = String(process.env.ADMIN_IDS || '')
  .split(',')
  .map(x => x.trim())
  .filter(Boolean);

const RADAR_DURATION_MS = 30 * 60 * 1000;
const RADAR_INTERVAL_MS = 10 * 60 * 1000;

const activeRadarSessions = new Map();
const radarPreviousStates = new Map();

const userRequestCooldowns = new Map();
const REQUEST_COOLDOWN_MS = 60 * 1000;

const stockCache = new Map();
const chainCache = new Map();

const STOCK_CACHE_MS = 30 * 1000;
const CHAIN_CACHE_MS = 3 * 60 * 1000;

// =====================
// Advanced Liquidity State
// =====================

const advancedLiquidityStates = new Map();

// =====================
// Auto Scanner Settings
// =====================

const AUTO_SCAN_ENABLED =
  String(process.env.AUTO_SCAN_ENABLED || 'false').toLowerCase() === 'true';

const AUTO_SCAN_SYMBOLS = String(
  process.env.AUTO_SCAN_SYMBOLS || 'SPY,QQQ,NVDA,TSLA,AAPL,AMD,AVGO,META,MSFT,PLTR'
)
  .split(',')
  .map(x => x.trim().toUpperCase())
  .filter(Boolean);

const AUTO_SCAN_INTERVAL_MS =
  Number(process.env.AUTO_SCAN_INTERVAL_MS || 3 * 60 * 1000);

const AUTO_SCAN_CHAT_ID =
  process.env.AUTO_SCAN_CHAT_ID || '';

const AUTO_SCAN_THREAD_ID =
  Number(process.env.AUTO_SCAN_THREAD_ID || 0);

const AUTO_ALERT_COOLDOWN_MS =
  Number(process.env.AUTO_ALERT_COOLDOWN_MS || 30 * 60 * 1000);

let autoScanIndex = 0;
const autoAlertCooldowns = new Map();

// =====================
// Admin
// =====================

function isAdmin(msg) {
  const fromId = String(msg.from?.id || '');
  const chatId = String(msg.chat?.id || '');

  return (
    ADMIN_IDS.includes(fromId) ||
    ADMIN_IDS.includes(chatId)
  );
}

// =====================
// Subscription System
// =====================

function nowIso() {
  return new Date().toISOString();
}

function addDaysIso(days) {
  const d = new Date();
  d.setDate(d.getDate() + Number(days));
  return d.toISOString();
}

function formatDate(v) {
  if (!v) return 'غير متوفر';

  return new Date(v).toLocaleString('ar-SA', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });
}

function generateCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

  let code = 'ST-';

  for (let i = 0; i < 4; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }

  code += '-';

  for (let i = 0; i < 4; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }

  return code;
}

async function createActivationCode(days = 30) {
  const code = generateCode();
  const expiresAt = addDaysIso(days);

  const { error } = await supabase
    .from('activation_codes')
    .insert({
      code,
      days: Number(days),
      used: false,
      expires_at: expiresAt
    });

  if (error) throw error;

  return {
    code,
    days,
    expiresAt
  };
}

async function getUserAccess(userId) {
  const { data, error } = await supabase
    .from('users_access')
    .select('*')
    .eq('telegram_id', String(userId))
    .single();

  if (error && error.code !== 'PGRST116') {
    throw error;
  }

  return data || null;
}

async function hasHubAccess(userId, service) {
  if (!process.env.HUB_SUPABASE_URL || !process.env.HUB_SUPABASE_KEY) {
    return false;
  }

  const { data, error } = await hubSupabase
    .from('hub_subscriptions')
    .select('services, active, expires_at')
    .eq('user_id', String(userId))
    .eq('active', true)
    .gt('expires_at', new Date().toISOString())
    .maybeSingle();

  if (error) {
    console.error('HUB ACCESS ERROR:', error.message);
    return false;
  }

  return !!data && Array.isArray(data.services) && data.services.includes(service);
}

async function hasActiveAccess(userId) {
  if (ADMIN_IDS.includes(String(userId))) {
    return true;
  }

  return await hasHubAccess(userId, 'radar');
}

async function requireAccess(msg) {
  const userId = msg.from?.id;

  const allowed = await hasActiveAccess(userId);

  if (allowed) return true;

  await bot.sendMessage(
    msg.chat.id,
`🔒 هذا البوت مخصص للمشتركين فقط.

لتفعيل اشتراكك أرسل كود التفعيل مباشرة:

مثال:
ST-ABCD-1234`,
    {
      message_thread_id: msg.message_thread_id
    }
  );

  return false;
}

async function redeemCode(msg, code) {
  const userId = String(msg.from.id);
  const username = msg.from.username || null;

  const cleanCode = String(code || '')
    .trim()
    .toUpperCase();

  const { data: activation, error } = await supabase
    .from('activation_codes')
    .select('*')
    .eq('code', cleanCode)
    .single();

  if (error || !activation) {
    return {
      ok: false,
      message: '❌ كود التفعيل غير صحيح.'
    };
  }

  if (activation.used) {
    return {
      ok: false,
      message: '⚠️ هذا الكود مستخدم مسبقًا.'
    };
  }

  if (
    activation.expires_at &&
    new Date(activation.expires_at).getTime() < Date.now()
  ) {
    return {
      ok: false,
      message: '⚠️ هذا الكود منتهي الصلاحية.'
    };
  }
    const userExpiresAt = addDaysIso(activation.days);

  const { error: updateCodeError } = await supabase
    .from('activation_codes')
    .update({
      used: true,
      used_by: userId
    })
    .eq('code', cleanCode)
    .eq('used', false);

  if (updateCodeError) throw updateCodeError;

  const { error: userError } = await supabase
    .from('users_access')
    .upsert(
      {
        telegram_id: userId,
        username,
        expires_at: userExpiresAt
      },
      {
        onConflict: 'telegram_id'
      }
    );

  if (userError) throw userError;

  return {
    ok: true,
    message:
`✅ تم تفعيل اشتراكك بنجاح.

⏳ مدة الاشتراك:
${activation.days} يوم

📅 ينتهي في:
${formatDate(userExpiresAt)}

يمكنك الآن إرسال رمز السهم مباشرة مثل:
TSLA`
  };
}

// =====================
// Save Decision Messages
// =====================

async function saveDecisionMessage(source, symbol, message) {
  try {
    const { error } = await decisionSupabase
      .from('decision_messages')
      .insert({
        source,
        symbol,
        message,
        processed: false
      });

    if (error) {
      console.error('SAVE DECISION MESSAGE ERROR:', error.message);
    } else {
      console.log(`DECISION MESSAGE SAVED: ${source} ${symbol}`);
    }
  } catch (err) {
    console.error('SAVE DECISION MESSAGE ERROR:', err.message);
  }
}

// =====================
// Save Image Snapshots
// =====================

async function saveImageSnapshot({ symbol, source, messageText }) {
  try {
    const { error } = await imageSupabase
      .from('image_snapshots')
      .insert({
        symbol: String(symbol || '').toUpperCase(),
        source,
        message_text: messageText,
        processed: false
      });

    if (error) {
      console.error('SAVE IMAGE SNAPSHOT ERROR:', error.message);
      return false;
    }

    console.log('IMAGE SNAPSHOT SAVED:', symbol, source);
    return true;
  } catch (err) {
    console.error('SAVE IMAGE SNAPSHOT CATCH:', err.message);
    return false;
  }
}

// =====================
// Helpers
// =====================

function fmt(n) {
  if (n === undefined || n === null || isNaN(Number(n))) {
    return 'غير متوفر';
  }

  return Number(n).toLocaleString('en-US');
}

function fmtPrice(n) {
  if (n === undefined || n === null || isNaN(Number(n))) {
    return 'غير متوفر';
  }

  return Number(n).toFixed(2);
}

function fmtPercent(n) {
  if (n === undefined || n === null || isNaN(Number(n))) {
    return 'غير متوفر';
  }

  return `${Number(n).toFixed(2)}%`;
}

function fmtSigned(n) {
  if (n === undefined || n === null || isNaN(Number(n))) {
    return 'غير متوفر';
  }

  const value = Number(n);

  return `${value > 0 ? '+' : ''}${fmt(value)}`;
}

function fmtCompact(n) {
  if (n === undefined || n === null || isNaN(Number(n))) {
    return 'غير متوفر';
  }

  const value = Number(n);
  const abs = Math.abs(value);
  const sign = value > 0 ? '+' : value < 0 ? '-' : '';

  if (abs >= 1_000_000_000) {
    return `${sign}${(abs / 1_000_000_000).toFixed(2)}B`;
  }

  if (abs >= 1_000_000) {
    return `${sign}${(abs / 1_000_000).toFixed(2)}M`;
  }

  if (abs >= 1_000) {
    return `${sign}${(abs / 1_000).toFixed(1)}K`;
  }

  return `${sign}${abs.toFixed(0)}`;
}

function isStockSymbol(text) {
  return /^[A-Za-z]{1,5}$/.test(
    String(text || '').trim()
  );
}

function getType(item) {
  return String(
    item?.details?.contract_type || ''
  ).toUpperCase();
}

function getStrike(item) {
  return item?.details?.strike_price;
}

function getExpiration(item) {
  return item?.details?.expiration_date || 'غير متوفر';
}

function getVolume(item) {
  return Number(item?.day?.volume || 0);
}

function getOI(item) {
  return Number(item?.open_interest || 0);
}

function getDelta(item) {
  return item?.greeks?.delta;
}

function getGamma(item) {
  return item?.greeks?.gamma;
}

function getTheta(item) {
  return item?.greeks?.theta;
}

function getIV(item) {
  return item?.implied_volatility;
}

function getBid(item) {
  return Number(
    item?.last_quote?.bid || 0
  );
}

function getAsk(item) {
  return Number(
    item?.last_quote?.ask || 0
  );
}

function getLastTradePrice(item) {
  return Number(
    item?.last_trade?.price ||
    item?.day?.close ||
    0
  );
}

function getMid(item) {
  const bid = getBid(item);
  const ask = getAsk(item);

  if (bid > 0 && ask > 0) {
    return Number(
      ((bid + ask) / 2).toFixed(2)
    );
  }

  return Number(
    item?.last_trade?.price ||
    item?.day?.close ||
    0
  );
}

function getTradeSide(item) {
  const tradePrice = getLastTradePrice(item);
  const bid = getBid(item);
  const ask = getAsk(item);

  if (!tradePrice || !bid || !ask) {
    return 'MID';
  }

  const spread = ask - bid;

  if (spread <= 0) {
    return 'MID';
  }

  const askDistance = Math.abs(ask - tradePrice);
  const bidDistance = Math.abs(tradePrice - bid);

  if (askDistance < bidDistance) {
    return 'ASK';
  }

  if (bidDistance < askDistance) {
    return 'BID';
  }

  return 'MID';
}
function distancePercent(strike, price) {
  const s = Number(strike);
  const p = Number(price);

  if (!s || !p || isNaN(s) || isNaN(p)) {
    return null;
  }

  return Math.abs(
    ((s - p) / p) * 100
  );
}

function gammaText(gamma) {
  const g = Number(gamma);

  if (isNaN(g)) return 'غير متوفر';

  if (g >= 0.08) return 'مرتفع جدًا';
  if (g >= 0.04) return 'مرتفع';
  if (g >= 0.02) return 'متوسط';

  return 'منخفض';
}

function marketDirection(change) {
  if (change > 0.20) {
    return '🟢 صاعد';
  }

  if (change < -0.20) {
    return '🔴 هابط';
  }

  return '🟡 عرضي';
}

function typeArabic(type) {
  return type === 'CALL'
    ? 'كول'
    : type === 'PUT'
      ? 'بوت'
      : type;
}

function radarStateKey(chatId, symbol) {
  return `${chatId}:${symbol}`;
}

function directionCode(direction) {
  if (String(direction).includes('صاعد')) return 'UP';
  if (String(direction).includes('هابط')) return 'DOWN';
  return 'FLAT';
}

function getReadableSide(side) {
  if (side === 'CALL') {
    return {
      arabic: 'الكول',
      typeArabic: 'كول',
      winner: 'المشترون',
      emoji: '🟢'
    };
  }

  if (side === 'PUT') {
    return {
      arabic: 'البوت',
      typeArabic: 'بوت',
      winner: 'البائعون',
      emoji: '🔴'
    };
  }

  return {
    arabic: 'غير واضح',
    typeArabic: 'غير واضح',
    winner: 'متعادل',
    emoji: '🟡'
  };
}

// =====================
// Finnhub + Massive API
// =====================

async function apiGet(url) {
  if (!API_KEY) {
    throw new Error('Missing MASSIVE_API_KEY');
  }

  const res = await axios.get(url);
  return res.data;
}

async function getFinnhubQuote(symbol) {
  if (!FINNHUB_API_KEY) {
    throw new Error('Missing FINNHUB_API_KEY');
  }

  const url =
    `https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(symbol)}&token=${FINNHUB_API_KEY}`;

  const res = await axios.get(url);
  const data = res.data || {};

  const price = Number(data.c || 0);
  const previousClose = Number(data.pc || 0);
  const open = Number(data.o || 0);
  const high = Number(data.h || 0);
  const low = Number(data.l || 0);

  if (!price || price <= 0) {
    throw new Error(`Finnhub price not available for ${symbol}`);
  }

  const change =
    previousClose > 0
      ? ((price - previousClose) / previousClose) * 100
      : 0;

  return {
    symbol,
    price,
    open,
    high,
    low,
    volume: 0,
    change
  };
}

async function isMarketOpenNow() {
  try {
    const url =
      `https://api.massive.com/v1/marketstatus/now?apiKey=${API_KEY}`;

    const data = await apiGet(url);

    return (
      data?.market === 'open' ||
      data?.exchanges?.nasdaq === 'open' ||
      data?.exchanges?.nyse === 'open'
    );
  } catch (err) {
    console.error(
      'Market Status Error:',
      err.message
    );

    return false;
  }
}

async function getStockSnapshot(symbol, options = {}) {
  const forceFresh = options.forceFresh === true;

  const cacheKey = symbol;
  const cached = stockCache.get(cacheKey);

  if (
    !forceFresh &&
    cached &&
    Date.now() - cached.time < STOCK_CACHE_MS
  ) {
    return cached.data;
  }

  try {
    const result = await getFinnhubQuote(symbol);

    stockCache.set(cacheKey, {
      time: Date.now(),
      data: result
    });

    return result;
  } catch (err) {
    console.error(
      'Finnhub Stock Price Error:',
      err.response?.status,
      err.response?.data || err.message
    );

    return null;
  }
}

async function getOptionsChain(symbol, options = {}) {
  const forceFresh = options.forceFresh === true;

  const cacheKey = symbol;
  const cached = chainCache.get(cacheKey);

  if (
    !forceFresh &&
    cached &&
    Date.now() - cached.time < CHAIN_CACHE_MS
  ) {
    return cached.data;
  }

  let url =
    `https://api.massive.com/v3/snapshot/options/${symbol}?limit=250&apiKey=${API_KEY}`;

  let allResults = [];
  let page = 0;
  const MAX_PAGES = 4;

  while (url && page < MAX_PAGES) {
    const data = await apiGet(url);
    const results = data.results || [];

    allResults = allResults.concat(results);

    if (data.next_url) {
      url = data.next_url.includes('apiKey=')
        ? data.next_url
        : `${data.next_url}&apiKey=${API_KEY}`;
    } else {
      url = null;
    }

    page++;
  }

  chainCache.set(cacheKey, {
    time: Date.now(),
    data: allResults
  });

  return allResults;
}

// =====================
// Flow Analysis
// =====================

function flowScore(item, stockPrice) {
  const volume = getVolume(item);
  const oi = getOI(item);
  const gamma = Number(
    getGamma(item) || 0
  );

  const delta = Math.abs(
    Number(getDelta(item) || 0)
  );

  const strike = getStrike(item);

  const dist = distancePercent(
    strike,
    stockPrice
  );

  let score = 0;

  score += Math.min(volume / 100, 400);

  if (volume > oi) {
    score += 250;
  }

  if (volume > oi * 2) {
    score += 250;
  }

  if (gamma >= 0.08) {
    score += 300;
  } else if (gamma >= 0.04) {
    score += 180;
  }

  if (delta >= 0.25 && delta <= 0.45) {
    score += 150;
  }

  if (dist !== null) {
    if (dist <= 0.5) {
      score += 200;
    } else if (dist <= 1) {
      score += 120;
    }
  }

  return Math.round(score);
}
function getFlowStats(chain, stockPrice) {
  const stats = {
    callScore: 0,
    putScore: 0,
    callVolume: 0,
    putVolume: 0,
    callUnusual: 0,
    putUnusual: 0,
    callGammaPower: 0,
    putGammaPower: 0
  };

  for (const item of chain) {
    const type = getType(item);
    const volume = getVolume(item);
    const gamma = Number(getGamma(item) || 0);
    const mid = getMid(item);
    const dist = distancePercent(
      getStrike(item),
      stockPrice
    );

    const score = flowScore(item, stockPrice);

    const unusual =
      volume >= 1000 &&
      getOI(item) > 0 &&
      volume > getOI(item) * 2 &&
      mid > 0 &&
      dist !== null &&
      dist <= 3;

    const gammaNear =
      gamma > 0 &&
      dist !== null &&
      dist <= 3 &&
      volume > 0;

    if (type === 'CALL') {
      stats.callScore += score;
      stats.callVolume += volume;

      if (unusual) stats.callUnusual++;
      if (gammaNear) stats.callGammaPower += gamma;
    }

    if (type === 'PUT') {
      stats.putScore += score;
      stats.putVolume += volume;

      if (unusual) stats.putUnusual++;
      if (gammaNear) stats.putGammaPower += gamma;
    }
  }

  return stats;
}

function getFlowBias(chain, stockPrice) {
  const stats = getFlowStats(chain, stockPrice);

  if (stats.callScore > stats.putScore * 1.30) {
    return '🟢 CALL DOMINANT';
  }

  if (stats.putScore > stats.callScore * 1.30) {
    return '🔴 PUT DOMINANT';
  }

  return '🟡 NEUTRAL';
}

function getFlowComparison(current, previous) {
  if (!previous) {
    return `أول تحديث للرادار.
سيتم عرض المقارنة بعد التحديث القادم.`;
  }

  const priceDiff =
    current.price - previous.price;

  const callDiff =
    current.callScore - previous.callScore;

  const putDiff =
    current.putScore - previous.putScore;

  let priceText = 'السعر بدون تغير واضح';

  if (priceDiff > 0) {
    priceText = `السعر ارتفع ${fmtPrice(priceDiff)}`;
  } else if (priceDiff < 0) {
    priceText = `السعر انخفض ${fmtPrice(Math.abs(priceDiff))}`;
  }

  let callText = 'سيولة الكول مستقرة تقريباً';

  if (callDiff > 0) {
    callText = `سيولة الكول زادت +${fmt(callDiff)}`;
  } else if (callDiff < 0) {
    callText = `سيولة الكول ضعفت -${fmt(Math.abs(callDiff))}`;
  }

  let putText = 'سيولة البوت مستقرة تقريباً';

  if (putDiff > 0) {
    putText = `سيولة البوت زادت +${fmt(putDiff)}`;
  } else if (putDiff < 0) {
    putText = `سيولة البوت ضعفت -${fmt(Math.abs(putDiff))}`;
  }

  let flipText = 'لا يوجد انقلاب واضح في السيطرة';

  if (
    previous.flowBias.includes('CALL') &&
    current.flowBias.includes('PUT')
  ) {
    flipText = 'انتباه: السيطرة تحولت من الكول إلى البوت';
  }

  if (
    previous.flowBias.includes('PUT') &&
    current.flowBias.includes('CALL')
  ) {
    flipText = 'انتباه: السيطرة تحولت من البوت إلى الكول';
  }

  return `${priceText}
${callText}
${putText}
${flipText}`;
}

function getAdvancedLiquidity(chain, stockPrice, flowStats, previous) {
  let callDex = 0;
  let putDex = 0;

  let callGex = 0;
  let putGex = 0;

  let askVolume = 0;
  let bidVolume = 0;
  let midVolume = 0;

  let callAskVolume = 0;
  let callBidVolume = 0;

  let putAskVolume = 0;
  let putBidVolume = 0;

  for (const item of chain) {
    const type = getType(item);
    const oi = getOI(item);
    const volume = getVolume(item);
    const delta = Number(getDelta(item) || 0);
    const gamma = Number(getGamma(item) || 0);
    const strike = getStrike(item);

    const dist = distancePercent(
      strike,
      stockPrice
    );

    if (
      !['CALL', 'PUT'].includes(type) ||
      oi <= 0 ||
      volume <= 0 ||
      dist === null ||
      dist > 5
    ) {
      continue;
    }

    const dex =
      delta * oi * 100 * stockPrice;

    const gex =
      gamma * oi * 100 * stockPrice;

    if (type === 'CALL') {
      callDex += dex;
      callGex += gex;
    }

    if (type === 'PUT') {
      putDex += dex;
      putGex += gex;
    }

    const tradeSide = getTradeSide(item);

    if (tradeSide === 'ASK') {
      askVolume += volume;

      if (type === 'CALL') {
        callAskVolume += volume;
      }

      if (type === 'PUT') {
        putAskVolume += volume;
      }
    } else if (tradeSide === 'BID') {
      bidVolume += volume;

      if (type === 'CALL') {
        callBidVolume += volume;
      }

      if (type === 'PUT') {
        putBidVolume += volume;
      }
    } else {
      midVolume += volume;
    }
  }
    const netDex =
    callDex + putDex;

  const netGex =
    callGex - Math.abs(putGex);

  const totalAggressiveVolume =
    askVolume + bidVolume;

  const askPct =
    totalAggressiveVolume > 0
      ? Math.round((askVolume / totalAggressiveVolume) * 100)
      : 0;

  const bidPct =
    totalAggressiveVolume > 0
      ? Math.round((bidVolume / totalAggressiveVolume) * 100)
      : 0;

  const callPower =
    flowStats.callScore || 0;

  const putPower =
    flowStats.putScore || 0;

  let buyerScore = 0;
  let sellerScore = 0;

  if (netDex > 0) buyerScore += 2;
  if (netDex < 0) sellerScore += 2;

  if (netGex > 0) buyerScore += 2;
  if (netGex < 0) sellerScore += 2;

  if (askPct >= 60) buyerScore += 3;
  if (bidPct >= 60) sellerScore += 3;

  if (callPower > putPower * 1.15) buyerScore += 3;
  if (putPower > callPower * 1.15) sellerScore += 3;

  const callAskBias =
    callAskVolume > callBidVolume;

  const putBidBias =
    putBidVolume > putAskVolume;

  if (callAskBias) buyerScore += 1;
  if (putBidBias) sellerScore += 1;

  const rawStrength =
    Math.max(buyerScore, sellerScore);

  const strength =
    Math.min(10, Number(rawStrength.toFixed(1)));

  let winner = 'متعادل';
  let winnerSide = 'NEUTRAL';

  if (buyerScore > sellerScore) {
    winner = 'المشترون';
    winnerSide = 'CALL';
  }

  if (sellerScore > buyerScore) {
    winner = 'البائعون';
    winnerSide = 'PUT';
  }

  const hedgeText =
    netDex > 0 && previous?.netDex !== undefined && netDex > previous.netDex
      ? '🟢 التحوط الشرائي يتزايد'
      : netDex > 0
        ? '🟢 التحوط الشرائي مسيطر'
        : netDex < 0 && previous?.netDex !== undefined && netDex < previous.netDex
          ? '🔴 التحوط البيعي يتزايد'
          : netDex < 0
            ? '🔴 التحوط البيعي مسيطر'
            : '🟡 التحوط متوازن';

  const dominanceText =
    winner === 'المشترون'
      ? '🟢 المشترون يسيطرون على الـ Ask'
      : winner === 'البائعون'
        ? '🔴 البائعون يضغطون على الـ Bid'
        : '🟡 لا يوجد طرف مسيطر بوضوح';

  const advancedText = `━━━━━━━━━━━━━━
🧠 قراءة السيولة المتقدمة

📊 Gamma Exposure: ${fmtCompact(netGex)}
📊 Delta Exposure: ${fmtCompact(netDex)}

${hedgeText}

🟢 Ask Flow: ${askPct}%
🔴 Bid Flow: ${bidPct}%

${dominanceText}

🏆 الطرف المسيطر: ${winner}
📊 قوة السيطرة: ${strength.toFixed(1)} / 10`;

  return {
    text: advancedText,
    netDex,
    netGex,
    askPct,
    bidPct,
    winner,
    winnerSide,
    strength
  };
}

function getEnhancedFollowSummary(
  direction,
  flowBias,
  stats,
  previous,
  advancedLiquidity,
  suggestedExpiration
) {
  const baseSummary =
    getFollowSummary(
      direction,
      flowBias,
      stats,
      previous
    );

  const dir = directionCode(direction);

  const callDominant =
    flowBias.includes('CALL');

  const putDominant =
    flowBias.includes('PUT');

  const deltaBullish =
    advancedLiquidity.netDex > 0;

  const deltaBearish =
    advancedLiquidity.netDex < 0;

  const gammaBullish =
    advancedLiquidity.netGex > 0;

  const gammaBearish =
    advancedLiquidity.netGex < 0;

  const askDominant =
    advancedLiquidity.askPct >= 60;

  const bidDominant =
    advancedLiquidity.bidPct >= 60;

  const buyersControl =
    advancedLiquidity.winner === 'المشترون';

  const sellersControl =
    advancedLiquidity.winner === 'البائعون';

  const expiryText =
    suggestedExpiration
      ? `📅 الانتهاء المقترح:
${suggestedExpiration}`
      : `📅 الانتهاء المقترح:
غير متوفر`;

  if (
    dir === 'UP' &&
    (callDominant || stats.callScore > stats.putScore * 1.15) &&
    buyersControl &&
    deltaBullish &&
    askDominant
  ) {
    return `✅ حسب المعطيات الحالية: تابع الكول

الأسباب:

• الاتجاه صاعد
• Delta Exposure موجب
${gammaBullish ? '• Gamma Exposure موجب' : '• Gamma Exposure غير داعم بقوة'}
• المشترون يسيطرون على الـ Ask
• تدفق الكول أقوى من البوت

${expiryText}

تنبيه:

هذه متابعة للمعطيات وليست توصية دخول.`;
  }

  if (
    dir === 'DOWN' &&
    (putDominant || stats.putScore > stats.callScore * 1.15) &&
    sellersControl &&
    deltaBearish &&
    bidDominant
  ) {
    return `✅ حسب المعطيات الحالية: تابع البوت

الأسباب:

• الاتجاه هابط
• Delta Exposure سلبي
${gammaBearish ? '• Gamma Exposure سلبي' : '• Gamma Exposure غير داعم بقوة'}
• البائعون يضغطون على الـ Bid
• تدفق البوت أقوى من الكول

${expiryText}

تنبيه:

هذه متابعة للمعطيات وليست توصية دخول.`;
  }

  if (
    dir === 'UP' &&
    (callDominant || buyersControl || askDominant)
  ) {
    return `⚠️ حسب المعطيات الحالية: مراقبة كول فقط

الأسباب:

• الاتجاه صاعد
${deltaBullish ? '• Delta Exposure موجب' : '• Delta Exposure غير واضح'}
${askDominant ? '• المشترون يسيطرون على الـ Ask' : '• سيولة الشراء لم تصل لتأكيد كامل'}
${callDominant ? '• تدفق الكول أقوى من البوت' : '• تدفق الكول يحتاج تأكيد إضافي'}

${expiryText}

تنبيه:

هذه متابعة للمعطيات وليست توصية دخول.`;
  }

  if (
    dir === 'DOWN' &&
    (putDominant || sellersControl || bidDominant)
  ) {
    return `⚠️ حسب المعطيات الحالية: مراقبة بوت فقط

الأسباب:

• الاتجاه هابط
${deltaBearish ? '• Delta Exposure سلبي' : '• Delta Exposure غير واضح'}
${bidDominant ? '• البائعون يضغطون على الـ Bid' : '• ضغط البيع لم يصل لتأكيد كامل'}
${putDominant ? '• تدفق البوت أقوى من الكول' : '• تدفق البوت يحتاج تأكيد إضافي'}

${expiryText}

تنبيه:

هذه متابعة للمعطيات وليست توصية دخول.`;
  }

  return baseSummary;
}

function getFollowSummary(direction, flowBias, stats, previous) {
  const dir = directionCode(direction);

  const callDominant = flowBias.includes('CALL');
  const putDominant  = flowBias.includes('PUT');

  const callPressure =
    stats.callScore > stats.putScore * 1.15;

  const putPressure =
    stats.putScore > stats.callScore * 1.15;

  const callIncreasing =
    previous
      ? stats.callScore > previous.callScore
      : false;

  const putIncreasing =
    previous
      ? stats.putScore > previous.putScore
      : false;

  if (
    dir === 'UP' &&
    callDominant &&
    callPressure
  ) {
    return `✅ حسب المعطيات الحالية: تابع الكول

السبب:

• الاتجاه صاعد.
• تدفق العقود يميل للكول.
• السيولة الحالية تدعم استمرار الحركة.
${callIncreasing ? '• نشاط الكول يزداد مقارنة بالتحديث السابق.' : ''}

تنبيه:

هذه متابعة للمعطيات وليست توصية دخول.`;
  }

  if (
    dir === 'DOWN' &&
    putDominant &&
    putPressure
  ) {
    return `✅ حسب المعطيات الحالية: تابع البوت

السبب:

• الاتجاه هابط.
• تدفق العقود يميل للبوت.
• السيولة الحالية تدعم استمرار الحركة.
${putIncreasing ? '• نشاط البوت يزداد مقارنة بالتحديث السابق.' : ''}

تنبيه:

هذه متابعة للمعطيات وليست توصية دخول.`;
  }
    if (
    dir === 'DOWN' &&
    (callDominant || callPressure)
  ) {
    return `⚠️ حسب المعطيات الحالية: مراقبة كول فقط

السبب:

• الاتجاه ما زال هابطاً.
• توجد سيولة كول ملحوظة عكس الحركة الحالية.
• لا يفضل الكول حتى يظهر انعكاس واضح بالسعر.

تنبيه:

هذه متابعة للمعطيات وليست توصية دخول.`;
  }

  if (
    dir === 'UP' &&
    (putDominant || putPressure)
  ) {
    return `⚠️ حسب المعطيات الحالية: مراقبة بوت فقط

السبب:

• الاتجاه ما زال صاعداً.
• توجد سيولة بوت ملحوظة عكس الحركة الحالية.
• لا يفضل البوت حتى يظهر ضعف واضح بالسعر.

تنبيه:

هذه متابعة للمعطيات وليست توصية دخول.`;
  }

  return `⛔ حسب المعطيات الحالية: انتظر

السبب:

• لا يوجد توافق كافٍ بين الاتجاه والسيولة.
• تدفق العقود غير حاسم حالياً.
• الأفضل انتظار إشارة أوضح.

تنبيه:

هذه متابعة للمعطيات وليست توصية دخول.`;
}

function getUnusualFlow(chain, stockPrice) {
  const items = chain
    .filter(item => {
      const volume = getVolume(item);
      const oi = getOI(item);
      const mid = getMid(item);

      const dist = distancePercent(
        getStrike(item),
        stockPrice
      );

      return (
        volume >= 1000 &&
        oi > 0 &&
        volume > oi * 2 &&
        mid > 0 &&
        dist !== null &&
        dist <= 3
      );
    })
    .map(item => ({
      item,
      ratio: getVolume(item) / Math.max(getOI(item), 1),
      score: flowScore(item, stockPrice)
    }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 3);

  if (!items.length) {
    return 'لا يوجد تدفق غير معتاد واضح حالياً';
  }

  return items.map((x, i) => {
    const item = x.item;

    return `${i + 1}) ${typeArabic(getType(item))} ${getStrike(item)}

📅 ${getExpiration(item)}
OI: ${fmt(getOI(item))}
VOL: ${fmt(getVolume(item))}

🔥 نسبة النشاط: ${x.ratio.toFixed(1)}x
💰 دخول سيولة جديدة قوية`;
  }).join('\n\n');
}

function getGammaZones(chain, stockPrice) {
  const items = chain
    .filter(item => {
      const gamma = Number(getGamma(item) || 0);

      const dist = distancePercent(
        getStrike(item),
        stockPrice
      );

      return (
        gamma > 0 &&
        dist !== null &&
        dist <= 3 &&
        getVolume(item) > 0
      );
    })
    .sort((a, b) =>
      Number(getGamma(b) || 0) -
      Number(getGamma(a) || 0)
    )
    .slice(0, 3);

  if (!items.length) {
    return 'لا توجد مناطق جاما واضحة حالياً';
  }

  return items.map((item, i) => {
    return `${i + 1}) ${typeArabic(getType(item))} ${getStrike(item)}
جاما: ${Number(getGamma(item) || 0).toFixed(2)}
القوة: ${gammaText(getGamma(item))}`;
  }).join('\n\n');
}

function getSmartMoneyRead(chain, stockPrice, flowBias, direction) {
  const best = chain
    .filter(item => {
      const volume = getVolume(item);
      const oi = getOI(item);
      const gamma = Number(getGamma(item) || 0);

      const delta = Math.abs(
        Number(getDelta(item) || 0)
      );

      const dist = distancePercent(
        getStrike(item),
        stockPrice
      );

      return (
        volume >= 1000 &&
        oi > 0 &&
        volume > oi &&
        gamma >= 0.02 &&
        delta >= 0.20 &&
        delta <= 0.55 &&
        dist !== null &&
        dist <= 3
      );
    })
    .map(item => ({
      item,
      score: flowScore(item, stockPrice)
    }))
    .sort((a, b) => b.score - a.score)[0];

  if (!best) {
    return 'لا توجد بصمة أموال ذكية واضحة حالياً';
  }

  const item = best.item;
  const type = getType(item);
  const strike = getStrike(item);
  const volume = getVolume(item);
  const oi = getOI(item);
  const gamma = Number(getGamma(item) || 0);

  const isCallBias = flowBias.includes('CALL');
  const isPutBias = flowBias.includes('PUT');
  const isDown = direction.includes('هابط');
  const isUp = direction.includes('صاعد');

  if (
    (type === 'CALL' && isDown && !isCallBias) ||
    (type === 'PUT' && isUp && !isPutBias)
  ) {
    return `الوضع متضارب حالياً.
يوجد نشاط على ${typeArabic(type)} ${strike}، لكن الاتجاه العام لا يدعمه بوضوح.
الأفضل قراءة السوق بحذر وعدم الاعتماد على طرف واحد فقط.`;
  }

  if (volume > oi * 3 && gamma >= 0.04) {
    return `نشاط قوي على ${typeArabic(type)} ${strike}.
الحجم أعلى من العقود المفتوحة بوضوح مع جاما مرتفعة، وهذا يدل على دخول سيولة نشط.`;
  }

  if (volume > oi) {
    return `نشاط ملحوظ على ${typeArabic(type)} ${strike}.
يوجد دخول سيولة جديد مقارنة بالعقود المفتوحة.`;
  }

  return `تمركز ملحوظ على ${typeArabic(type)} ${strike}، لكنه يحتاج متابعة خلال التحديثات القادمة.`;
}

// =====================
// OI Zones By Expiration + Volume
// =====================

function getDTE(expiration) {
  const today = new Date();
  const exp = new Date(expiration);

  if (isNaN(exp.getTime())) return null;

  today.setHours(0, 0, 0, 0);
  exp.setHours(0, 0, 0, 0);

  return Math.ceil((exp - today) / (1000 * 60 * 60 * 24));
}

function getConcentrationType(percent, expiryCount, expiration) {
  const dte = getDTE(expiration);

  if (dte !== null) {
    if (dte <= 14) {
      return {
        type: 'قصير المدى',
        note: '📌 التمركز على انتهاء قريب'
      };
    }

    if (dte <= 45) {
      return {
        type: 'متوسط المدى',
        note: '📌 التمركز على انتهاء متوسط'
      };
    }

    return {
      type: 'طويل المدى / مؤسسي',
      note: '🏦 التمركز على انتهاء بعيد'
    };
  }

  if (percent >= 50) {
    return {
      type: 'قصير المدى',
      note: '📌 تمركز قوي على انتهاء محدد'
    };
  }

  if (percent >= 35) {
    return {
      type: 'متوسط',
      note: '📌 يوجد تمركز واضح على انتهاء محدد'
    };
  }

  if (expiryCount >= 3) {
    return {
      type: 'متدرج',
      note: '✅ العقود موزعة على عدة تواريخ'
    };
  }

  return {
    type: 'غير واضح',
    note: '⚠️ التمركز غير كافٍ للتصنيف'
  };
}

function buildOIExpiryBlock(type, group) {
  if (!group) {
    return `${typeArabic(type)} غير متوفر`;
  }

  const totalOI = group.totalOI;
  const totalVOL = group.totalVOL;

  const expirations = Array.from(group.expirations.values())
    .filter(x => x.oi > 0)
    .sort((a, b) => new Date(a.expiration) - new Date(b.expiration));

  if (!expirations.length || totalOI <= 0) {
    return `${typeArabic(type)} غير متوفر`;
  }

  const dominantOI = expirations
    .slice()
    .sort((a, b) => b.oi - a.oi)[0];

  const dominantVOL = expirations
    .slice()
    .sort((a, b) => b.volume - a.volume)[0];

  const dominantPercent =
    totalOI > 0
      ? Math.round((dominantOI.oi / totalOI) * 100)
      : 0;

  const activityPercent =
    totalVOL > 0
      ? Math.round((dominantVOL.volume / totalVOL) * 100)
      : 0;
    const concentration =
    getConcentrationType(
      dominantPercent,
      expirations.length,
      dominantOI.expiration
    );

  const expiryLines = expirations.map(x => {
    const pct =
      totalOI > 0
        ? Math.round((x.oi / totalOI) * 100)
        : 0;

    return `📅 ${x.expiration}
OI: ${fmt(x.oi)} (${pct}%)
VOL: ${fmt(x.volume)}`;
  }).join('\n\n');

  const sameExpiration =
    dominantOI.expiration === dominantVOL.expiration;

  const flowAlignment = sameExpiration
    ? `🧠 التمركز التاريخي والنشاط الحالي متوافقان على انتهاء ${dominantOI.expiration}`
    : `🧠 التمركز التاريخي: ${dominantOI.expiration}
⚡ النشاط الحالي: ${dominantVOL.expiration}

📌 السيولة الجديدة تتركز على انتهاء مختلف عن التمركز الرئيسي`;

  const note =
    dominantPercent >= 50
      ? `🎯 التمركز الرئيسي على انتهاء ${dominantOI.expiration}
📍 ${dominantPercent}% من إجمالي العقود المفتوحة`
      : concentration.note;

  const activityText =
    totalVOL > 0
      ? `🔥 ${activityPercent}% من نشاط اليوم يتركز على انتهاء ${dominantVOL.expiration}
${dominantVOL.volume > dominantVOL.oi
        ? '💰 يرجح وجود فتح مراكز جديدة على هذا الانتهاء'
        : '📌 معظم النشاط الحالي ناتج عن مراكز قائمة مسبقاً'}`
      : '🔥 لا يوجد نشاط تداول واضح اليوم';

  return `🔥 ${typeArabic(type)} ${group.strike}

${expiryLines}

📊 إجمالي OI: ${fmt(totalOI)}
📈 إجمالي VOL: ${fmt(totalVOL)}

🎯 الانتهاء المسيطر: ${dominantOI.expiration}
📍 نسبة التمركز: ${dominantPercent}%

🧠 نوع التمركز: ${concentration.type}
${note}
${flowAlignment}
${activityText}`;
}

function getOIZones(chain, stockPrice) {
  const groups = {
    CALL: new Map(),
    PUT: new Map()
  };

  for (const item of chain) {
    const type = getType(item);
    const strike = getStrike(item);
    const expiration = getExpiration(item);
    const oi = getOI(item);
    const volume = getVolume(item);

    const dist = distancePercent(strike, stockPrice);

    if (
      !['CALL', 'PUT'].includes(type) ||
      !strike ||
      !expiration ||
      expiration === 'غير متوفر' ||
      oi <= 0 ||
      dist === null ||
      dist > 5
    ) {
      continue;
    }

    const key = String(strike);

    if (!groups[type].has(key)) {
      groups[type].set(key, {
        type,
        strike,
        totalOI: 0,
        totalVOL: 0,
        expirations: new Map()
      });
    }

    const group = groups[type].get(key);

    group.totalOI += oi;
    group.totalVOL += volume;

    if (!group.expirations.has(expiration)) {
      group.expirations.set(expiration, {
        expiration,
        oi: 0,
        volume: 0
      });
    }

    const expiryData = group.expirations.get(expiration);
    expiryData.oi += oi;
    expiryData.volume += volume;
  }

  const bestCall = Array.from(groups.CALL.values())
    .sort((a, b) => b.totalOI - a.totalOI)[0];

  const bestPut = Array.from(groups.PUT.values())
    .sort((a, b) => b.totalOI - a.totalOI)[0];

  return `${buildOIExpiryBlock('CALL', bestCall)}

━━━━━━━━━━━━━━

${buildOIExpiryBlock('PUT', bestPut)}`;
}

function getSuggestedExpiration(chain, stockPrice, side) {
  const targetType =
    side === 'CALL'
      ? 'CALL'
      : side === 'PUT'
        ? 'PUT'
        : '';

  if (!targetType) return null;

  const candidates = chain
    .filter(item => {
      const type = getType(item);
      const expiration = getExpiration(item);
      const volume = getVolume(item);
      const oi = getOI(item);
      const mid = getMid(item);

      const dist = distancePercent(
        getStrike(item),
        stockPrice
      );

      const dte = getDTE(expiration);

      return (
        type === targetType &&
        expiration &&
        expiration !== 'غير متوفر' &&
        dte !== null &&
        dte >= 3 &&
        dte <= 14 &&
        volume > 0 &&
        oi > 0 &&
        mid > 0 &&
        dist !== null &&
        dist <= 5
      );
    })
    .map(item => {
      const volume = getVolume(item);
      const oi = getOI(item);
      const gamma = Number(getGamma(item) || 0);
      const delta = Math.abs(Number(getDelta(item) || 0));
      const dist = distancePercent(getStrike(item), stockPrice) || 99;
      const dte = getDTE(getExpiration(item));

      let score = 0;

      score += Math.min(volume / 100, 400);

      if (volume > oi) score += 250;
      if (volume > oi * 2) score += 250;

      if (gamma >= 0.08) score += 200;
      else if (gamma >= 0.04) score += 120;
      else if (gamma >= 0.02) score += 60;

      if (delta >= 0.25 && delta <= 0.55) {
        score += 120;
      }

      if (dist <= 1) score += 150;
      else if (dist <= 3) score += 80;

      if (dte >= 3 && dte <= 10) {
        score += 80;
      }

      return {
        expiration: getExpiration(item),
        score
      };
    });

  if (!candidates.length) {
    return null;
  }

  const grouped = new Map();

  for (const c of candidates) {
    if (!grouped.has(c.expiration)) {
      grouped.set(c.expiration, 0);
    }

    grouped.set(
      c.expiration,
      grouped.get(c.expiration) + c.score
    );
  }

  const best = Array.from(grouped.entries())
    .sort((a, b) => b[1] - a[1])[0];

  return best ? best[0] : null;
}

function getSuggestedSideFromSummary(summary) {
  if (String(summary || '').includes('تابع الكول')) {
    return 'CALL';
  }

  if (String(summary || '').includes('تابع البوت')) {
    return 'PUT';
  }

  if (String(summary || '').includes('مراقبة كول')) {
    return 'CALL';
  }

  if (String(summary || '').includes('مراقبة بوت')) {
    return 'PUT';
  }

  return null;
}

async function buildRadarMessage(symbol, chatId) {
  const stock = await getStockSnapshot(symbol);

  if (!stock) {
    return `⚠️ لم أستطع جلب سعر السهم من Finnhub لـ ${symbol}

تأكد من:
1) إضافة FINNHUB_API_KEY في Railway
2) أن الرمز صحيح
3) أن مفتاح Finnhub فعال`;
  }

  const chain = await getOptionsChain(symbol);

  if (!chain.length) {
    return `⚠️ لا توجد بيانات عقود متاحة على ${symbol}`;
  }

  const key = radarStateKey(chatId, symbol);
  const previous = radarPreviousStates.get(key);

  const liquidityKey = `${chatId}:${symbol}:ADV`;
  const previousAdvanced =
    advancedLiquidityStates.get(liquidityKey);

  const direction = marketDirection(stock.change);
  const flowBias = getFlowBias(chain, stock.price);
  const flowStats = getFlowStats(chain, stock.price);

  const advancedLiquidity =
    getAdvancedLiquidity(
      chain,
      stock.price,
      flowStats,
      previousAdvanced
    );

  advancedLiquidityStates.set(
    liquidityKey,
    {
      netDex: advancedLiquidity.netDex,
      netGex: advancedLiquidity.netGex,
      askPct: advancedLiquidity.askPct,
      bidPct: advancedLiquidity.bidPct,
      winner: advancedLiquidity.winner,
      winnerSide: advancedLiquidity.winnerSide,
      strength: advancedLiquidity.strength
    }
  );

  const currentState = {
    symbol,
    price: stock.price,
    change: stock.change,
    direction,
    flowBias,
    callScore: flowStats.callScore,
    putScore: flowStats.putScore,
    callVolume: flowStats.callVolume,
    putVolume: flowStats.putVolume,
    callUnusual: flowStats.callUnusual,
    putUnusual: flowStats.putUnusual,
    updatedAt: Date.now()
  };

  const comparison = getFlowComparison(
    currentState,
    previous
  );

  const baseFollowSummary =
    getFollowSummary(
      direction,
      flowBias,
      flowStats,
      previous
    );

  const suggestedSide =
    getSuggestedSideFromSummary(baseFollowSummary) ||
    advancedLiquidity.winnerSide;

  const suggestedExpiration =
    getSuggestedExpiration(
      chain,
      stock.price,
      suggestedSide
    );

  const followSummary =
    getEnhancedFollowSummary(
      direction,
      flowBias,
      flowStats,
      previous,
      advancedLiquidity,
      suggestedExpiration
    );

  radarPreviousStates.set(key, currentState);

  const unusualFlow = getUnusualFlow(chain, stock.price);
  const gammaZones = getGammaZones(chain, stock.price);

  const smartMoney = getSmartMoneyRead(
    chain,
    stock.price,
    flowBias,
    direction
  );

  const oiZones = getOIZones(chain, stock.price);

  return `📡 رادار السوق — ${symbol}

💰 سعر السهم الحالي: ${fmtPrice(stock.price)}
📊 التغير: ${fmtPercent(stock.change)}
📈 الاتجاه: ${direction}
📌 مصدر السعر: Finnhub

━━━━━━━━━━━━━━
🧭 اتجاه تدفق العقود
${flowBias
  .replace('CALL DOMINANT', 'سيطرة الكول')
  .replace('PUT DOMINANT', 'سيطرة البوت')
  .replace('NEUTRAL', 'متوازن')}

━━━━━━━━━━━━━━
📊 مقارنة آخر تحديث
${comparison}

━━━━━━━━━━━━━━
🔥 التدفق غير المعتاد
${unusualFlow}

━━━━━━━━━━━━━━
⚡ مناطق الجاما القوية
${gammaZones}

━━━━━━━━━━━━━━
🧠 قراءة الأموال الذكية
${smartMoney}

━━━━━━━━━━━━━━
📂 مناطق العقود المفتوحة
${oiZones}

${advancedLiquidity.text}

━━━━━━━━━━━━━━
📌 خلاصة المتابعة
${followSummary}

━━━━━━━━━━━━━━
⏱ يتم التحديث كل 10 دقائق
🕒 مدة المتابعة 30 دقيقة`;
}

// =====================
// Decision Stop Review Analysis
// =====================

async function analyzeRadarForStopReview(symbol, requestedSide) {
  const normalizedSide = String(requestedSide || '').trim().toUpperCase();

  const stock = await getStockSnapshot(symbol, { forceFresh: true });

  if (!stock) {
    throw new Error(`NO_STOCK_DATA_FOR_${symbol}`);
  }

  const chain = await getOptionsChain(symbol, { forceFresh: true });

  if (!chain.length) {
    throw new Error(`NO_OPTIONS_DATA_FOR_${symbol}`);
  }

  const direction = marketDirection(stock.change);
  const flowBias = getFlowBias(chain, stock.price);
  const flowStats = getFlowStats(chain, stock.price);

  const advancedLiquidity = getAdvancedLiquidity(
    chain,
    stock.price,
    flowStats,
    null
  );

  const baseFollowSummary = getFollowSummary(
    direction,
    flowBias,
    flowStats,
    null
  );

  const suggestedSide =
    getSuggestedSideFromSummary(baseFollowSummary) ||
    advancedLiquidity.winnerSide;

  const suggestedExpiration = getSuggestedExpiration(
    chain,
    stock.price,
    suggestedSide
  );

  const followSummary = getEnhancedFollowSummary(
    direction,
    flowBias,
    flowStats,
    null,
    advancedLiquidity,
    suggestedExpiration
  );

  const detectedSide =
    getSuggestedSideFromSummary(followSummary) ||
    (['CALL', 'PUT'].includes(advancedLiquidity.winnerSide)
      ? advancedLiquidity.winnerSide
      : 'NEUTRAL');

  const strength = Number(advancedLiquidity.strength || 0);
  const confirmedFollow = isConfirmedFollowSignal(followSummary);
  const isWait = String(followSummary).includes('انتظر');

  const supportsTrade =
    confirmedFollow &&
    ['CALL', 'PUT'].includes(detectedSide) &&
    detectedSide === normalizedSide &&
    strength >= 6 &&
    !isWait;

  return {
    source: 'RADAR',
    symbol,
    requestedSide: normalizedSide,
    side: detectedSide,
    score: strength,
    supportsTrade,
    confirmedFollow,
    stockPrice: Number(stock.price || 0),
    stockChange: Number(stock.change || 0),
    direction,
    flowBias,
    callScore: Number(flowStats.callScore || 0),
    putScore: Number(flowStats.putScore || 0),
    callVolume: Number(flowStats.callVolume || 0),
    putVolume: Number(flowStats.putVolume || 0),
    netDex: Number(advancedLiquidity.netDex || 0),
    netGex: Number(advancedLiquidity.netGex || 0),
    askPct: Number(advancedLiquidity.askPct || 0),
    bidPct: Number(advancedLiquidity.bidPct || 0),
    winner: advancedLiquidity.winner,
    winnerSide: advancedLiquidity.winnerSide,
    suggestedExpiration: suggestedExpiration || null,
    summary: followSummary,
    analyzedAt: new Date().toISOString()
  };
}

// =====================
// Auto Scanner
// =====================

function isConfirmedFollowSignal(text) {
  return (
    String(text || '').includes('✅ حسب المعطيات الحالية: تابع الكول') ||
    String(text || '').includes('✅ حسب المعطيات الحالية: تابع البوت')
  );
}

function getSignalSideFromText(text) {
  if (String(text || '').includes('تابع الكول')) {
    return {
      side: 'CALL',
      arabic: 'كول',
      emoji: '🟢'
    };
  }

  if (String(text || '').includes('تابع البوت')) {
    return {
      side: 'PUT',
      arabic: 'بوت',
      emoji: '🔴'
    };
  }

  return {
    side: 'UNKNOWN',
    arabic: 'غير واضح',
    emoji: '⚪'
  };
}

function autoCooldownKey(symbol, side) {
  return `${symbol}:${side}`;
}

function canSendAutoAlert(symbol, side) {
  const key = autoCooldownKey(symbol, side);
  const last = autoAlertCooldowns.get(key) || 0;

  return Date.now() - last >= AUTO_ALERT_COOLDOWN_MS;
}

function markAutoAlertSent(symbol, side) {
  const key = autoCooldownKey(symbol, side);
  autoAlertCooldowns.set(key, Date.now());
}

async function buildAutoScanResult(symbol) {
  const stock = await getStockSnapshot(symbol);

  if (!stock) {
    return null;
  }

  const chain = await getOptionsChain(symbol);

  if (!chain.length) {
    return null;
  }

  const key = radarStateKey('AUTO_SCAN', symbol);
  const previous = radarPreviousStates.get(key);

  const liquidityKey = `AUTO_SCAN:${symbol}:ADV`;
  const previousAdvanced =
    advancedLiquidityStates.get(liquidityKey);

  const direction = marketDirection(stock.change);
  const flowBias = getFlowBias(chain, stock.price);
  const flowStats = getFlowStats(chain, stock.price);

  const advancedLiquidity =
    getAdvancedLiquidity(
      chain,
      stock.price,
      flowStats,
      previousAdvanced
    );

  advancedLiquidityStates.set(
    liquidityKey,
    {
      netDex: advancedLiquidity.netDex,
      netGex: advancedLiquidity.netGex,
      askPct: advancedLiquidity.askPct,
      bidPct: advancedLiquidity.bidPct,
      winner: advancedLiquidity.winner,
      winnerSide: advancedLiquidity.winnerSide,
      strength: advancedLiquidity.strength
    }
  );

  const currentState = {
    symbol,
    price: stock.price,
    change: stock.change,
    direction,
    flowBias,
    callScore: flowStats.callScore,
    putScore: flowStats.putScore,
    callVolume: flowStats.callVolume,
    putVolume: flowStats.putVolume,
    callUnusual: flowStats.callUnusual,
    putUnusual: flowStats.putUnusual,
    updatedAt: Date.now()
  };

  const baseFollowSummary =
    getFollowSummary(
      direction,
      flowBias,
      flowStats,
      previous
    );

  const suggestedSide =
    getSuggestedSideFromSummary(baseFollowSummary) ||
    advancedLiquidity.winnerSide;

  const suggestedExpiration =
    getSuggestedExpiration(
      chain,
      stock.price,
      suggestedSide
    );

  const followSummary =
    getEnhancedFollowSummary(
      direction,
      flowBias,
      flowStats,
      previous,
      advancedLiquidity,
      suggestedExpiration
    );

  radarPreviousStates.set(key, currentState);

  if (!isConfirmedFollowSignal(followSummary)) {
    return null;
  }

  const signal = getSignalSideFromText(followSummary);

  if (!canSendAutoAlert(symbol, signal.side)) {
    return null;
  }

  const unusualFlow = getUnusualFlow(chain, stock.price);

  const smartMoney = getSmartMoneyRead(
    chain,
    stock.price,
    flowBias,
    direction
  );

  const flowBiasArabic = flowBias
    .replace('CALL DOMINANT', 'سيطرة الكول')
    .replace('PUT DOMINANT', 'سيطرة البوت')
    .replace('NEUTRAL', 'متوازن');

  const expirationText = suggestedExpiration
    ? `📅 الانتهاء المقترح: ${suggestedExpiration}`
    : `📅 الانتهاء المقترح: غير متوفر`;

  const text = `🚨 رصد تلقائي قوي

${signal.emoji} النوع: ${signal.arabic}
📊 السهم: ${symbol}
${expirationText}

💰 السعر الحالي: ${fmtPrice(stock.price)}
📊 التغير: ${fmtPercent(stock.change)}
📈 الاتجاه: ${direction}
🧭 تدفق العقود: ${flowBiasArabic}

━━━━━━━━━━━━━━
🔥 أقوى تدفق غير معتاد
${unusualFlow}

━━━━━━━━━━━━━━
🧠 قراءة الأموال الذكية
${smartMoney}

${advancedLiquidity.text}

━━━━━━━━━━━━━━
📌 خلاصة المتابعة
${followSummary}
━━━━━━━━━━━━━━
📅 الانتهاء المقترح:
${suggestedExpiration || 'غير متوفر'}
━━━━━━━━━━━━━━
⏱ يتم التحديث كل 10 دقائق
━━━━━━━━━━━━━━
⏱ فحص تلقائي كل ${Math.round(AUTO_SCAN_INTERVAL_MS / 60000)} دقائق`;

  markAutoAlertSent(symbol, signal.side);

  return text;
}

async function runAutoScannerOnce() {
  if (!AUTO_SCAN_ENABLED) return;

  if (!AUTO_SCAN_CHAT_ID) {
    console.error('AUTO_SCAN_CHAT_ID is missing');
    return;
  }

  const marketOpen = await isMarketOpenNow();

  if (!marketOpen) {
    console.log('AUTO_SCAN: Market Closed');
    return;
  }

  if (!AUTO_SCAN_SYMBOLS.length) {
    console.error('AUTO_SCAN_SYMBOLS is empty');
    return;
  }

  const symbol =
    AUTO_SCAN_SYMBOLS[autoScanIndex % AUTO_SCAN_SYMBOLS.length];

  autoScanIndex++;

  try {
    const text = await buildAutoScanResult(symbol);

    if (!text) {
      console.log(`AUTO_SCAN: no confirmed signal for ${symbol}`);
      return;
    }

    const options = {};

    if (AUTO_SCAN_THREAD_ID > 0) {
      options.message_thread_id = AUTO_SCAN_THREAD_ID;
    }

    await bot.sendMessage(
      AUTO_SCAN_CHAT_ID,
      text,
      options
    );

    await saveDecisionMessage(
      'RADAR_AUTO',
      symbol,
      text
    );

    console.log(`AUTO_SCAN: sent alert for ${symbol}`);
  } catch (err) {
    console.error(
      `AUTO_SCAN error for ${symbol}:`,
      err.response?.data || err.message
    );
  }
}

function startAutoScanner() {
  if (!AUTO_SCAN_ENABLED) {
    console.log('AUTO_SCAN disabled');
    return;
  }

  if (!AUTO_SCAN_CHAT_ID) {
    console.log('AUTO_SCAN enabled but AUTO_SCAN_CHAT_ID is missing');
    return;
  }

  console.log(
    `AUTO_SCAN enabled: ${AUTO_SCAN_SYMBOLS.join(', ')}`
  );

  setTimeout(() => {
    runAutoScannerOnce();
  }, 15 * 1000);

  setInterval(
    runAutoScannerOnce,
    AUTO_SCAN_INTERVAL_MS
  );
}

function stopRadarSession(chatId) {
  const oldSession = activeRadarSessions.get(chatId);

  if (oldSession?.intervalId) {
    clearInterval(oldSession.intervalId);
  }

  if (oldSession?.timeoutId) {
    clearTimeout(oldSession.timeoutId);
  }

  if (oldSession?.symbol) {
    radarPreviousStates.delete(
      radarStateKey(chatId, oldSession.symbol)
    );
  }

  activeRadarSessions.delete(chatId);
}

async function sendRadarMessage(chatId, text, threadId) {
  await bot.sendMessage(chatId, text, {
    message_thread_id: threadId,
    reply_markup: {
      inline_keyboard: [
        [
          {
            text: '🛑 إيقاف التحديث',
            callback_data: 'STOP_RADAR'
          }
        ]
      ]
    }
  });
}

async function startRadarSession(msg, symbol) {
  const chatId = msg.chat.id;
  const userId = String(msg.from?.id || chatId);

  const lastRequest =
    userRequestCooldowns.get(userId) || 0;

  const now = Date.now();

  const remainingMs =
    REQUEST_COOLDOWN_MS - (now - lastRequest);

  if (remainingMs > 0) {
    const remainingSec =
      Math.ceil(remainingMs / 1000);

    await bot.sendMessage(
      chatId,
      `⏳ انتظر ${remainingSec} ثانية قبل طلب سهم جديد.`,
      {
        message_thread_id:
          msg.message_thread_id
      }
    );

    return;
  }

  userRequestCooldowns.set(
    userId,
    now
  );

  const access = await requireAccess(msg);

  if (!access) return;

  stopRadarSession(chatId);

  radarPreviousStates.delete(
    radarStateKey(chatId, symbol)
  );

  await bot.sendMessage(
    chatId,
    `🔎 تم بدء رادار ${symbol} لمدة 30 دقيقة.`,
    {
      message_thread_id: msg.message_thread_id
    }
  );

  try {
    const firstMessage = await buildRadarMessage(
      symbol,
      chatId
    );

    await sendRadarMessage(
      chatId,
      firstMessage,
      msg.message_thread_id
    );

    await saveDecisionMessage(
      'RADAR',
      symbol,
      firstMessage
    );

    await saveImageSnapshot({
  symbol,
  source: 'radar',
  messageText: firstMessage
});

    if (process.env.DECISION_GROUP_ID) {
      await bot.sendMessage(
        process.env.DECISION_GROUP_ID,
        firstMessage
      );
    }
  } catch (err) {
    await bot.sendMessage(
      chatId,
      `⚠️ حدث خطأ أثناء تحليل ${symbol}\n${err.message}`,
      {
        message_thread_id: msg.message_thread_id
      }
    );

    return;
  }

  const intervalId = setInterval(async () => {
    try {
      const message = await buildRadarMessage(
        symbol,
        chatId
      );

      await sendRadarMessage(
        chatId,
        message,
        msg.message_thread_id
      );

      await saveDecisionMessage(
        'RADAR',
        symbol,
        message
      );

      await saveImageSnapshot({
  symbol,
  source: 'radar',
  messageText: message
});

      if (process.env.DECISION_GROUP_ID) {
        await bot.sendMessage(
          process.env.DECISION_GROUP_ID,
          message
        );
      }
    } catch (err) {
      await bot.sendMessage(
        chatId,
        `⚠️ تعذر تحديث رادار ${symbol}\n${err.message}`,
        {
          message_thread_id: msg.message_thread_id
        }
      );
    }
  }, RADAR_INTERVAL_MS);

  const timeoutId = setTimeout(async () => {
    stopRadarSession(chatId);

    await bot.sendMessage(
      chatId,
      `⏹ انتهت جلسة رادار ${symbol}.`,
      {
        message_thread_id: msg.message_thread_id
      }
    );
  }, RADAR_DURATION_MS);

  activeRadarSessions.set(chatId, {
    symbol,
    intervalId,
    timeoutId,
    startedAt: Date.now(),
    expiresAt: Date.now() + RADAR_DURATION_MS
  });
}

// =====================
// Callback
// =====================

bot.on('callback_query', async (query) => {
  const chatId = query.message.chat.id;

  if (query.data === 'STOP_RADAR') {
    stopRadarSession(chatId);

    await bot.answerCallbackQuery(query.id, {
      text: 'تم إيقاف الرادار'
    });

    await bot.sendMessage(
      chatId,
      '🛑 تم إيقاف تحديث الرادار.',
      {
        message_thread_id:
          query.message.message_thread_id
      }
    );
  }
});

// =====================
// Start
// =====================

bot.onText(/\/start$/, async (msg) => {
  await bot.sendMessage(
    msg.chat.id,
`📡 بوت رادار السوق يعمل بنجاح

🔒 البوت يعمل بنظام اشتراكات.

لتفعيل اشتراكك:
أرسل كود التفعيل مباشرة مثل:

ST-ABCD-1234

━━━━━━━━━━━━━━

بعد التفعيل:
أرسل رمز السهم مباشرة مثل:

TSLA
NVDA
SPY
QQQ`,
    {
      message_thread_id:
        msg.message_thread_id
    }
  );
});

// =====================
// Create Codes
// =====================

bot.onText(/\/gencode (\d+)/, async (msg, match) => {
  try {
    if (!isAdmin(msg)) {
      return;
    }

    const days = Number(match[1]);

    if (!days || days <= 0) {
      return bot.sendMessage(
        msg.chat.id,
        '⚠️ حدد عدد أيام صحيح.',
        {
          message_thread_id:
            msg.message_thread_id
        }
      );
    }

    const result =
      await createActivationCode(days);

    await bot.sendMessage(
      msg.chat.id,
`✅ تم إنشاء كود جديد

🔑 الكود:
${result.code}

⏳ المدة:
${days} يوم

📅 صلاحية الكود:
${formatDate(result.expiresAt)}`,
      {
        message_thread_id:
          msg.message_thread_id
      }
    );
  } catch (err) {
    console.error(err);

    await bot.sendMessage(
      msg.chat.id,
      '❌ فشل إنشاء الكود.',
      {
        message_thread_id:
          msg.message_thread_id
      }
    );
  }
});

// =====================
// Subscription Status
// =====================

bot.onText(/\/mysub/, async (msg) => {
  try {
    const user = await getUserAccess(
      msg.from.id
    );

    if (!user) {
      return bot.sendMessage(
        msg.chat.id,
        '❌ لا يوجد اشتراك فعال.',
        {
          message_thread_id:
            msg.message_thread_id
        }
      );
    }

    const active =
      new Date(user.expires_at).getTime() >
      Date.now();

    await bot.sendMessage(
      msg.chat.id,
`📡 حالة الاشتراك

👤 المستخدم:
@${msg.from.username || 'غير متوفر'}

${active ? '🟢 مفعل' : '🔴 منتهي'}

📅 تاريخ الانتهاء:
${formatDate(user.expires_at)}`,
      {
        message_thread_id:
          msg.message_thread_id
      }
    );
  } catch (err) {
    console.error(err);
  }
});

// =====================
// Radar Status
// =====================

bot.onText(/\/radarstatus/, async (msg) => {
  const session =
    activeRadarSessions.get(msg.chat.id);

  if (!session) {
    return bot.sendMessage(
      msg.chat.id,
      'لا توجد جلسة رادار نشطة حالياً.',
      {
        message_thread_id:
          msg.message_thread_id
      }
    );
  }

  const remainingMs = Math.max(
    session.expiresAt - Date.now(),
    0
  );

  const remainingMin =
    Math.ceil(remainingMs / 60000);

  await bot.sendMessage(
    msg.chat.id,
`📡 جلسة الرادار الحالية

📊 السهم:
${session.symbol}

⏳ الوقت المتبقي:
${remainingMin} دقيقة`,
    {
      message_thread_id:
        msg.message_thread_id
    }
  );
});

// =====================
// Admin: Remove User
// =====================

bot.onText(/\/removeuser (.+)/, async (msg, match) => {
  try {
    if (!isAdmin(msg)) {
      return bot.sendMessage(
        msg.chat.id,
        '🚫 هذا الأمر للإدارة فقط'
      );
    }

    const telegramId =
      String(match[1] || '').trim();

    const { error } = await supabase
      .from('users_access')
      .delete()
      .eq('telegram_id', telegramId);

    if (error) throw error;

    await bot.sendMessage(
      msg.chat.id,
      `🗑 تم حذف اشتراك المستخدم:\n${telegramId}`,
      {
        message_thread_id:
          msg.message_thread_id
      }
    );
  } catch (err) {
    console.error(err);

    await bot.sendMessage(
      msg.chat.id,
      `⚠️ حدث خطأ أثناء حذف المستخدم\n${err.message}`,
      {
        message_thread_id:
          msg.message_thread_id
      }
    );
  }
});

// =====================
// Admin: Check User
// =====================

bot.onText(/\/checkuser (.+)/, async (msg, match) => {
  try {
    if (!isAdmin(msg)) {
      return bot.sendMessage(
        msg.chat.id,
        '🚫 هذا الأمر للإدارة فقط'
      );
    }

    const telegramId =
      String(match[1] || '').trim();

    const user =
      await getUserAccess(telegramId);

    if (!user) {
      return bot.sendMessage(
        msg.chat.id,
        `🚫 لا يوجد اشتراك لهذا المستخدم:\n${telegramId}`,
        {
          message_thread_id:
            msg.message_thread_id
        }
      );
    }

    const active =
      new Date(user.expires_at).getTime() >
      Date.now();

    await bot.sendMessage(
      msg.chat.id,
`📡 بيانات المستخدم

Telegram ID:
${telegramId}

Username:
@${user.username || 'غير متوفر'}

انتهاء الاشتراك:
${formatDate(user.expires_at)}

الحالة:
${active ? '✅ فعال' : '❌ منتهي'}`,
      {
        message_thread_id:
          msg.message_thread_id
      }
    );
  } catch (err) {
    console.error(err);

    await bot.sendMessage(
      msg.chat.id,
      `⚠️ حدث خطأ\n${err.message}`,
      {
        message_thread_id:
          msg.message_thread_id
      }
    );
  }
});

// =====================
// Admin: My ID
// =====================

bot.onText(/\/myid/, async (msg) => {
  await bot.sendMessage(
    msg.chat.id,
`chat.id:
${msg.chat.id}

from.id:
${msg.from.id}`,
    {
      message_thread_id:
        msg.message_thread_id
    }
  );
});

// =====================
// Broadcast
// =====================

bot.onText(/\/broadcast ([\s\S]+)/, async (msg, match) => {
  try {
    if (!isAdmin(msg)) {
      await bot.sendMessage(
        msg.chat.id,
        '⛔ هذا الأمر للمالك فقط'
      );
      return;
    }

    const message = match[1];

    const { data: users, error } = await supabase
      .from('users_access')
      .select('*');

    if (error) throw error;

    let sent = 0;
    let failed = 0;

    const now = Date.now();

    for (const user of users || []) {
      if (!user.expires_at) continue;

      const isActive =
        new Date(user.expires_at).getTime() > now;

      if (!isActive) continue;

      try {
        await bot.sendMessage(
          user.telegram_id,
          message
        );

        sent++;

        await new Promise(resolve =>
          setTimeout(resolve, 300)
        );
      } catch (err) {
        failed++;
        console.error(
          `Broadcast failed ${user.telegram_id}:`,
          err.message
        );
      }
    }

    await bot.sendMessage(
      msg.chat.id,
`✅ تم إرسال الرسالة

📨 وصل:
${sent}

⚠️ فشل:
${failed}`
    );
  } catch (err) {
    console.error(err);

    await bot.sendMessage(
      msg.chat.id,
      `⚠️ حدث خطأ أثناء الإرسال\n${err.message}`
    );
  }
});

// =====================
// Stats
// =====================

bot.onText(/\/stats/, async (msg) => {
  try {
    if (!isAdmin(msg)) {
      return bot.sendMessage(
        msg.chat.id,
        '⛔ هذا الأمر للمالك فقط'
      );
    }

    const { data: users, error } = await supabase
      .from('users_access')
      .select('*');

    if (error) throw error;

    const now = Date.now();

    const activeUsers =
      (users || []).filter(user =>
        user.expires_at &&
        new Date(user.expires_at).getTime() > now
      );

    const expiredUsers =
      (users || []).filter(user =>
        !user.expires_at ||
        new Date(user.expires_at).getTime() <= now
      );

    const activeRadar =
      activeRadarSessions.size;

    await bot.sendMessage(
      msg.chat.id,
`📊 إحصائيات البوت

━━━━━━━━━━━━━━

👥 إجمالي المستخدمين:
${users.length}

✅ المشتركين الفعالين:
${activeUsers.length}

❌ الاشتراكات المنتهية:
${expiredUsers.length}

📡 جلسات الرادار النشطة:
${activeRadar}

━━━━━━━━━━━━━━

🕒 وقت الفحص:
${new Date().toLocaleString('ar-SA')}`
    );
  } catch (err) {
    console.error(err);

    await bot.sendMessage(
      msg.chat.id,
      `⚠️ حدث خطأ\n${err.message}`
    );
  }
});

// =====================
// Message Handler
// =====================

bot.on('message', async (msg) => {
  const text = String(msg.text || '').trim();

  if (!text) return;
  if (text.startsWith('/')) return;

  const isActivationCode =
    /^ST-[A-Z0-9]{4}-[A-Z0-9]{4}$/i.test(text);

  if (isActivationCode) {
    try {
      const result = await redeemCode(
        msg,
        text
      );

      await bot.sendMessage(
        msg.chat.id,
        result.message,
        {
          message_thread_id:
            msg.message_thread_id
        }
      );
    } catch (err) {
      console.error(err);

      await bot.sendMessage(
        msg.chat.id,
        '❌ حدث خطأ أثناء التفعيل.',
        {
          message_thread_id:
            msg.message_thread_id
        }
      );
    }

    return;
  }

  if (!isStockSymbol(text)) return;

  const symbol =
    text.toUpperCase();

  await startRadarSession(
    msg,
    symbol
  );
});

startAutoScanner();

app.get('/api/radar', async (req, res) => {
  try {
    const key = String(req.query.key || '');
    const symbol = String(req.query.symbol || '').trim().toUpperCase();

    if (!RADAR_API_SECRET || key !== RADAR_API_SECRET) {
      return res.status(401).json({
        ok: false,
        error: 'UNAUTHORIZED'
      });
    }

    if (!isStockSymbol(symbol)) {
      return res.status(400).json({
        ok: false,
        error: 'INVALID_SYMBOL'
      });
    }

    const reportText = await buildRadarMessage(symbol, 'RADAR_API');

    await saveDecisionMessage('RADAR_API', symbol, reportText);

    await saveImageSnapshot({
      symbol,
      source: 'radar_api',
      messageText: reportText
    });

    return res.json({
      ok: true,
      symbol,
      text: reportText
    });
  } catch (err) {
    console.error('RADAR API ERROR:', err.response?.data || err.message);

    return res.status(500).json({
      ok: false,
      error: 'RADAR_ANALYSIS_FAILED'
    });
  }
});

app.get('/api/radar/stop-review', async (req, res) => {
  try {
    const key = String(req.query.key || '');
    const symbol = String(req.query.symbol || '').trim().toUpperCase();
    const requestedSide = String(req.query.side || '').trim().toUpperCase();

    if (!RADAR_API_SECRET || key !== RADAR_API_SECRET) {
      return res.status(401).json({
        ok: false,
        error: 'UNAUTHORIZED'
      });
    }

    if (!isStockSymbol(symbol)) {
      return res.status(400).json({
        ok: false,
        error: 'INVALID_SYMBOL'
      });
    }

    if (!['CALL', 'PUT'].includes(requestedSide)) {
      return res.status(400).json({
        ok: false,
        error: 'INVALID_SIDE'
      });
    }

    console.log('RADAR STOP REVIEW REQUEST:', {
      symbol,
      requestedSide
    });

    const result = await analyzeRadarForStopReview(
      symbol,
      requestedSide
    );

    return res.json({
      ok: true,
      symbol,
      purpose: 'STOP_REVIEW',
      fresh: true,
      result
    });
  } catch (err) {
    console.error(
      'RADAR STOP REVIEW ERROR:',
      err.response?.data || err.message
    );

    return res.status(500).json({
      ok: false,
      error: 'RADAR_STOP_REVIEW_FAILED',
      details: err.message
    });
  }
});

app.get('/health', (req, res) => {
  res.send('RADAR BOT OK');
});

app.listen(PORT, () => {
  console.log(`Radar API running on ${PORT}`);
});

console.log(
  '📡 ST Market Radar Bot Started with Finnhub Stock Price + Auto Scanner + Decision Messages'
);
