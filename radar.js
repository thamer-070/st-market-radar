const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');

const bot = new TelegramBot(process.env.BOT_TOKEN, {
  polling: true
});

const API_KEY = process.env.MASSIVE_API_KEY;

const ADMIN_IDS = String(process.env.ADMIN_IDS || '')
  .split(',')
  .map(x => x.trim())
  .filter(Boolean);

const RADAR_DURATION_MS = 30 * 60 * 1000;
const RADAR_INTERVAL_MS = 5 * 60 * 1000;

const activeRadarSessions = new Map();

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
// =====================
// Massive API
// =====================

async function apiGet(url) {
  if (!API_KEY) {
    throw new Error(
      'Missing MASSIVE_API_KEY'
    );
  }

  const res = await axios.get(url);

  return res.data;
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

async function getStockSnapshot(symbol) {
  const url =
    `https://api.massive.com/v2/aggs/ticker/${symbol}/prev?adjusted=true&apiKey=${API_KEY}`;

  const data = await apiGet(url);

  const r = data?.results?.[0];

  if (!r) return null;

  const change =
    r.o
      ? ((r.c - r.o) / r.o) * 100
      : 0;

  return {
    symbol,
    price: r.c,
    open: r.o,
    high: r.h,
    low: r.l,
    volume: r.v,
    change
  };
}

async function getOptionsChain(symbol) {
  const url =
    `https://api.massive.com/v3/snapshot/options/${symbol}?limit=250&apiKey=${API_KEY}`;

  const data = await apiGet(url);

  return data.results || [];
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

function getFlowBias(chain, stockPrice) {
  let callScore = 0;
  let putScore = 0;

  for (const item of chain) {
    const type = getType(item);

    const score = flowScore(
      item,
      stockPrice
    );

    if (type === 'CALL') {
      callScore += score;
    }

    if (type === 'PUT') {
      putScore += score;
    }
  }

  if (callScore > putScore * 1.30) {
    return '🟢 CALL DOMINANT';
  }

  if (putScore > callScore * 1.30) {
    return '🔴 PUT DOMINANT';
  }

  return '🟡 NEUTRAL';
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

    return `${i + 1}) ${getType(item)} ${getStrike(item)}
Volume/OI: ${x.ratio.toFixed(1)}x
Vol: ${fmt(getVolume(item))} | OI: ${fmt(getOI(item))}`;
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
    .sort((a, b) => {
      return Number(getGamma(b) || 0) -
        Number(getGamma(a) || 0);
    })
    .slice(0, 3);

  if (!items.length) {
    return 'لا توجد مناطق Gamma واضحة حالياً';
  }

  return items.map((item, i) => {
    return `${i + 1}) ${getType(item)} ${getStrike(item)}
Γ ${Number(getGamma(item) || 0).toFixed(2)}
${gammaText(getGamma(item))}`;
  }).join('\n\n');
}

function getSmartMoneyRead(chain, stockPrice) {
  const best = chain
    .filter(item => {
      const volume = getVolume(item);
      const oi = getOI(item);
      const gamma = Number(getGamma(item) || 0);
      const delta = Math.abs(Number(getDelta(item) || 0));
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
    return 'لا توجد بصمة Smart Money واضحة حالياً';
  }

  const item = best.item;
  const type = getType(item);
  const strike = getStrike(item);
  const volume = getVolume(item);
  const oi = getOI(item);
  const gamma = getGamma(item);

  if (volume > oi * 3 && Number(gamma || 0) >= 0.04) {
    return `نشاط قوي على ${type} ${strike}
Volume أعلى من OI بشكل واضح مع Gamma مرتفعة`;
  }

  if (volume > oi) {
    return `نشاط ملحوظ على ${type} ${strike}
يوجد دخول سيولة جديد مقارنة بالعقود المفتوحة`;
  }

  return `تمركز ملحوظ على ${type} ${strike}
لكن يحتاج متابعة للتأكيد`;
}

function getOIZones(chain, stockPrice) {
  const calls = chain
    .filter(item => {
      const dist = distancePercent(getStrike(item), stockPrice);
      return getType(item) === 'CALL' && dist !== null && dist <= 5;
    })
    .sort((a, b) => getOI(b) - getOI(a))[0];

  const puts = chain
    .filter(item => {
      const dist = distancePercent(getStrike(item), stockPrice);
      return getType(item) === 'PUT' && dist !== null && dist <= 5;
    })
    .sort((a, b) => getOI(b) - getOI(a))[0];

  const callText = calls
    ? `CALL ${getStrike(calls)} — OI ${fmt(getOI(calls))}`
    : 'CALL غير متوفر';

  const putText = puts
    ? `PUT ${getStrike(puts)} — OI ${fmt(getOI(puts))}`
    : 'PUT غير متوفر';

  return `${callText}\n${putText}`;
}
async function buildRadarMessage(symbol) {
  const stock = await getStockSnapshot(symbol);

  if (!stock) {
    return `⚠️ لم أستطع جلب بيانات ${symbol}`;
  }

  const chain = await getOptionsChain(symbol);

  if (!chain.length) {
    return `⚠️ لا توجد بيانات عقود متاحة على ${symbol}`;
  }

  const flowBias = getFlowBias(chain, stock.price);
  const unusualFlow = getUnusualFlow(chain, stock.price);
  const gammaZones = getGammaZones(chain, stock.price);
  const smartMoney = getSmartMoneyRead(chain, stock.price);
  const oiZones = getOIZones(chain, stock.price);

  return `📡 ${symbol} Market Radar

💰 السعر:
${fmtPrice(stock.price)}

📈 الاتجاه:
${marketDirection(stock.change)}

📊 التغير:
${fmtPercent(stock.change)}

━━━━━━━━━━━━━━

🧭 Flow Bias:
${flowBias}

━━━━━━━━━━━━━━

🔥 Unusual Flow:
${unusualFlow}

━━━━━━━━━━━━━━

⚡ Gamma Zones:
${gammaZones}

━━━━━━━━━━━━━━

🧠 Smart Money:
${smartMoney}

━━━━━━━━━━━━━━

📂 OI Zones:
${oiZones}

━━━━━━━━━━━━━━

⏱ التحديث:
كل 5 دقائق لمدة 30 دقيقة`;
}

function stopRadarSession(chatId) {
  const oldSession = activeRadarSessions.get(chatId);

  if (oldSession?.intervalId) {
    clearInterval(oldSession.intervalId);
  }

  if (oldSession?.timeoutId) {
    clearTimeout(oldSession.timeoutId);
  }

  activeRadarSessions.delete(chatId);
}

async function startRadarSession(msg, symbol) {
  const chatId = msg.chat.id;

  stopRadarSession(chatId);

  await bot.sendMessage(
    chatId,
    `🔎 تم بدء مراقبة ${symbol} لمدة 30 دقيقة.`,
    {
      message_thread_id: msg.message_thread_id
    }
  );

  try {
    const firstMessage = await buildRadarMessage(symbol);

    await bot.sendMessage(
      chatId,
      firstMessage,
      {
        message_thread_id: msg.message_thread_id
      }
    );
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
      const message = await buildRadarMessage(symbol);

      await bot.sendMessage(
        chatId,
        message,
        {
          message_thread_id: msg.message_thread_id
        }
      );
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
      `⏹ انتهت جلسة مراقبة ${symbol}.`,
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

bot.onText(/\/start/, async (msg) => {
  await bot.sendMessage(
    msg.chat.id,
`📡 ST Market Radar يعمل بنجاح

أرسل رمز السهم مباشرة مثل:
TSLA
NVDA
SPY
QQQ

وسيبدأ الرادار لمدة 30 دقيقة مع تحديث كل 5 دقائق.`,
    {
      message_thread_id: msg.message_thread_id
    }
  );
});

bot.onText(/\/stopradar/, async (msg) => {
  stopRadarSession(msg.chat.id);

  await bot.sendMessage(
    msg.chat.id,
    '🛑 تم إيقاف الرادار.',
    {
      message_thread_id: msg.message_thread_id
    }
  );
});

bot.onText(/\/radarstatus/, async (msg) => {
  const session = activeRadarSessions.get(msg.chat.id);

  if (!session) {
    await bot.sendMessage(
      msg.chat.id,
      'لا توجد جلسة رادار نشطة حالياً.',
      {
        message_thread_id: msg.message_thread_id
      }
    );

    return;
  }

  const remainingMs = Math.max(session.expiresAt - Date.now(), 0);
  const remainingMin = Math.ceil(remainingMs / 60000);

  await bot.sendMessage(
    msg.chat.id,
`📡 جلسة الرادار الحالية

السهم:
${session.symbol}

الوقت المتبقي:
${remainingMin} دقيقة`,
    {
      message_thread_id: msg.message_thread_id
    }
  );
});

bot.on('message', async (msg) => {
  const text = msg.text;

  if (!text) return;
  if (text.startsWith('/')) return;

  if (!isStockSymbol(text)) {
    return;
  }

  const symbol = text.trim().toUpperCase();

  await startRadarSession(msg, symbol);
});

console.log('📡 ST Market Radar Bot Started');
