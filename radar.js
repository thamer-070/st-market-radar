const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');

const bot = new TelegramBot(process.env.BOT_TOKEN, {
  polling: true
});

const API_KEY = process.env.MASSIVE_API_KEY;

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

const ADMIN_IDS = String(process.env.ADMIN_IDS || '')
  .split(',')
  .map(x => x.trim())
  .filter(Boolean);

const RADAR_DURATION_MS = 30 * 60 * 1000;
const RADAR_INTERVAL_MS = 5 * 60 * 1000;

const activeRadarSessions = new Map();
const radarPreviousStates = new Map();

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

async function hasActiveAccess(userId) {
  if (ADMIN_IDS.includes(String(userId))) {
    return true;
  }

  const user = await getUserAccess(userId);

  if (!user) return false;
  if (!user.expires_at) return false;

  return new Date(user.expires_at).getTime() > Date.now();
}

async function requireAccess(msg) {
  const userId = msg.from?.id;

  const allowed = await hasActiveAccess(userId);

  if (allowed) return true;

  await bot.sendMessage(
    msg.chat.id,
`🔒 هذا البوت مخصص للمشتركين فقط.

لتفعيل اشتراكك أرسل:

/redeem CODE

مثال:
/redeem ST-ABCD-1234`,
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
  try {
    const now = new Date();
    const to = now.toISOString().split('T')[0];

    const fromDate = new Date();
    fromDate.setDate(fromDate.getDate() - 5);
    const from = fromDate.toISOString().split('T')[0];

    const minUrl =
      `https://api.massive.com/v2/aggs/ticker/${symbol}/range/1/minute/${from}/${to}?adjusted=true&sort=desc&limit=1&apiKey=${API_KEY}`;

    const prevUrl =
      `https://api.massive.com/v2/aggs/ticker/${symbol}/prev?adjusted=true&apiKey=${API_KEY}`;

    const minData = await apiGet(minUrl);
    const prevData = await apiGet(prevUrl);

    const lastBar = minData?.results?.[0];
    const prev = prevData?.results?.[0];

    if (!lastBar || !prev) return null;

    const price = lastBar.c;

    const change =
      prev.c
        ? ((price - prev.c) / prev.c) * 100
        : 0;

    return {
      symbol,
      price,
      open: lastBar.o,
      high: lastBar.h,
      low: lastBar.l,
      volume: lastBar.v,
      change
    };
  } catch (err) {
    console.error(
      'Stock Minute Price Error:',
      err.message
    );

    return null;
  }
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
    const oi = getOI(item);
    const gamma = Number(getGamma(item) || 0);
    const mid = getMid(item);
    const dist = distancePercent(
      getStrike(item),
      stockPrice
    );

    const score = flowScore(item, stockPrice);

    const unusual =
      volume >= 1000 &&
      oi > 0 &&
      volume > oi * 2 &&
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

      if (unusual) {
        stats.callUnusual++;
      }

      if (gammaNear) {
        stats.callGammaPower += gamma;
      }
    }

    if (type === 'PUT') {
      stats.putScore += score;
      stats.putVolume += volume;

      if (unusual) {
        stats.putUnusual++;
      }

      if (gammaNear) {
        stats.putGammaPower += gamma;
      }
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
function getFollowSummary(direction, flowBias, stats, previous) {
  const dir = directionCode(direction);

  const callDominant =
    flowBias.includes('CALL');

  const putDominant =
    flowBias.includes('PUT');

  const callPressure =
    stats.callScore > stats.putScore * 1.15;

  const putPressure =
    stats.putScore > stats.callScore * 1.15;

  const callUnusualOk =
    stats.callUnusual >= stats.putUnusual;

  const putUnusualOk =
    stats.putUnusual >= stats.callUnusual;

  const callIncreasing =
    previous
      ? stats.callScore > previous.callScore
      : false;

  const putIncreasing =
    previous
      ? stats.putScore > previous.putScore
      : false;

  if (dir === 'UP') {
    if (callDominant && callPressure && callUnusualOk) {
      return `✅ حسب المعطيات الحالية: تابع الكول

السبب:
الاتجاه صاعد، وتدفق العقود يميل للكول، ولا يوجد تعارض قوي من البوت.
${callIncreasing ? 'كما أن سيولة الكول زادت مقارنة بالتحديث السابق.' : 'راقب استمرار ثبات الاتجاه مع التحديث القادم.'}

تنبيه:
هذه متابعة للمعطيات وليست توصية دخول.`;
    }

    if (putDominant || putPressure) {
      return `⚠️ حسب المعطيات الحالية: انتظر

السبب:
الاتجاه صاعد، لكن تدفق العقود يميل للبوت أو يضغط عكس الحركة.
لا توجد توافقية كافية لمتابعة طرف واحد الآن.

تنبيه:
هذه متابعة للمعطيات وليست توصية دخول.`;
    }

    return `⚠️ حسب المعطيات الحالية: انتظر

السبب:
الاتجاه صاعد لكن تدفق العقود غير حاسم.
الأفضل انتظار توافق أوضح بين السعر والسيولة.

تنبيه:
هذه متابعة للمعطيات وليست توصية دخول.`;
  }

  if (dir === 'DOWN') {
    if (putDominant && putPressure && putUnusualOk) {
      return `✅ حسب المعطيات الحالية: تابع البوت

السبب:
الاتجاه هابط، وتدفق العقود يميل للبوت، ولا يوجد تعارض قوي من الكول.
${putIncreasing ? 'كما أن سيولة البوت زادت مقارنة بالتحديث السابق.' : 'راقب استمرار ثبات الاتجاه مع التحديث القادم.'}

تنبيه:
هذه متابعة للمعطيات وليست توصية دخول.`;
    }

    if (callDominant || callPressure) {
      return `⚠️ حسب المعطيات الحالية: انتظر

السبب:
الاتجاه هابط، لكن يوجد نشاط كول عكس الحركة.
لا يتم تفضيل الكول حتى يظهر انعكاس واضح في السعر.

تنبيه:
هذه متابعة للمعطيات وليست توصية دخول.`;
    }

    return `⚠️ حسب المعطيات الحالية: انتظر

السبب:
الاتجاه هابط لكن تدفق العقود غير حاسم.
الأفضل انتظار توافق أوضح بين السعر والسيولة.

تنبيه:
هذه متابعة للمعطيات وليست توصية دخول.`;
  }

  return `⚠️ حسب المعطيات الحالية: انتظر

السبب:
الاتجاه عرضي أو غير واضح، لذلك لا يتم تفضيل الكول أو البوت حالياً.

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
نسبة الحجم إلى العقود المفتوحة: ${x.ratio.toFixed(1)}x
الحجم: ${fmt(getVolume(item))} | العقود المفتوحة: ${fmt(getOI(item))}`;
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
function getOIZones(chain, stockPrice) {
  const calls = chain
    .filter(item => {
      const dist = distancePercent(
        getStrike(item),
        stockPrice
      );

      return (
        getType(item) === 'CALL' &&
        dist !== null &&
        dist <= 5
      );
    })
    .sort((a, b) => getOI(b) - getOI(a))[0];

  const puts = chain
    .filter(item => {
      const dist = distancePercent(
        getStrike(item),
        stockPrice
      );

      return (
        getType(item) === 'PUT' &&
        dist !== null &&
        dist <= 5
      );
    })
    .sort((a, b) => getOI(b) - getOI(a))[0];

  const callText = calls
    ? `كول ${getStrike(calls)} — عقود مفتوحة ${fmt(getOI(calls))}`
    : 'كول غير متوفر';

  const putText = puts
    ? `بوت ${getStrike(puts)} — عقود مفتوحة ${fmt(getOI(puts))}`
    : 'بوت غير متوفر';

  return `${callText}\n${putText}`;
}

async function buildRadarMessage(symbol, chatId) {
  const stock = await getStockSnapshot(symbol);

  if (!stock) {
    return `⚠️ لم أستطع جلب بيانات ${symbol}`;
  }

  const chain = await getOptionsChain(symbol);

  if (!chain.length) {
    return `⚠️ لا توجد بيانات عقود متاحة على ${symbol}`;
  }

  const key = radarStateKey(chatId, symbol);
  const previous = radarPreviousStates.get(key);

  const direction = marketDirection(stock.change);
  const flowBias = getFlowBias(chain, stock.price);
  const flowStats = getFlowStats(chain, stock.price);

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

  const followSummary = getFollowSummary(
    direction,
    flowBias,
    flowStats,
    previous
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

💰 السعر الحالي: ${fmtPrice(stock.price)}
📊 التغير: ${fmtPercent(stock.change)}
📈 الاتجاه: ${direction}

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

━━━━━━━━━━━━━━
📌 خلاصة المتابعة
${followSummary}

━━━━━━━━━━━━━━
⏱ يتم التحديث كل 5 دقائق
🕒 مدة المتابعة 30 دقيقة`;
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
أرسل كود التفعيل عبر:

/redeem CODE

مثال:
/redeem ST-ABCD-1234

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
// Redeem
// =====================

bot.onText(/\/redeem (.+)/, async (msg, match) => {
  try {
    const code = match[1];

    const result = await redeemCode(
      msg,
      code
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
// /removeuser 123456789
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
// /checkuser 123456789
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
// Symbol Message = Start Radar
// =====================

bot.on('message', async (msg) => {
  const text = msg.text;

  if (!text) return;
  if (text.startsWith('/')) return;
  if (!isStockSymbol(text)) return;

  const symbol =
    text.trim().toUpperCase();

  await startRadarSession(
    msg,
    symbol
  );
});

console.log(
  '📡 ST Market Radar Bot Started'
);
