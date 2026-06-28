import { useState, useEffect, useCallback, useRef } from "react";
import { initializeApp } from "firebase/app";
import { getFirestore, doc, getDoc, setDoc, onSnapshot } from "firebase/firestore";

// Firebase yapılandırması (kripto-sinyal projesi)
const firebaseConfig = {
  apiKey: "AIzaSyB1ZubPyFBrBtRVDWjwQpUE8V1kjGFjnT4",
  authDomain: "kripto-sinyal-8a786.firebaseapp.com",
  projectId: "kripto-sinyal-8a786",
  storageBucket: "kripto-sinyal-8a786.firebasestorage.app",
  messagingSenderId: "946567790089",
  appId: "1:946567790089:web:01fcc5fca8fabf4c6fc2d8",
};
const fbApp = initializeApp(firebaseConfig);
const db = getFirestore(fbApp);
// Tek ortak liste belgesi — tüm cihazlar buraya bakar
const WATCH_DOC = doc(db, "kripto", "watchlist");

const INTERVALS = [
  { v: "15m", label: "15dk" }, { v: "1h", label: "1sa" },
  { v: "4h", label: "4sa" }, { v: "1d", label: "1gün" },
];
const MTF = ["1h", "4h", "1d"];
const STORAGE_KEY = "kripto_watch_v2";
const TABS = [
  { id: "piyasa", label: "Piyasa", icon: "📊" },
  { id: "izleme", label: "İzleme", icon: "👁" },
  { id: "araclar", label: "Araçlar", icon: "🛠" },
  { id: "ayarlar", label: "Ayarlar", icon: "⚙" },
];
const TG_TOKEN_KEY = "kripto_tg_token";
const TG_CHAT_KEY = "kripto_tg_chat";

// Telegram'a mesaj gönder (token cihazda saklanır, koda gömülmez)
async function sendTelegram(text) {
  const token = localStorage.getItem(TG_TOKEN_KEY);
  const chat = localStorage.getItem(TG_CHAT_KEY);
  if (!token || !chat) return false;
  try {
    const url = `https://api.telegram.org/bot${token}/sendMessage`;
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chat, text }),
    });
    return r.ok;
  } catch (e) { return false; }
}

// ── Borsa adaptörleri (OHLC döndürür) ──────────────────────
const BINANCE_IV = { "15m": "15m", "1h": "1h", "4h": "4h", "1d": "1d" };
const MEXC_IV    = { "15m": "15m", "1h": "60m", "4h": "4h", "1d": "1d" };
const GATE_IV    = { "15m": "15m", "1h": "1h", "4h": "4h", "1d": "1d" };
const BYBIT_IV   = { "15m": "15", "1h": "60", "4h": "240", "1d": "D" };

async function ohlcBinance(base, iv) {
  const url = `https://api.binance.com/api/v3/klines?symbol=${base}USDT&interval=${BINANCE_IV[iv]}&limit=120`;
  const r = await fetch(url); if (!r.ok) throw new Error("x");
  const j = await r.json();
  if (!Array.isArray(j) || !j.length) throw new Error("empty");
  return j.map((k) => ({ time: Math.floor(k[0] / 1000), open: +k[1], high: +k[2], low: +k[3], close: +k[4] }));
}
async function ohlcMexc(base, iv) {
  const url = `https://api.mexc.com/api/v3/klines?symbol=${base}USDT&interval=${MEXC_IV[iv]}&limit=120`;
  const r = await fetch(url); if (!r.ok) throw new Error("x");
  const j = await r.json();
  if (!Array.isArray(j) || !j.length) throw new Error("empty");
  return j.map((k) => ({ time: Math.floor(k[0] / 1000), open: +k[1], high: +k[2], low: +k[3], close: +k[4] }));
}
async function ohlcGate(base, iv) {
  const url = `https://api.gateio.ws/api/v4/spot/candlesticks?currency_pair=${base}_USDT&interval=${GATE_IV[iv]}&limit=120`;
  const r = await fetch(url); if (!r.ok) throw new Error("x");
  const j = await r.json();
  if (!Array.isArray(j) || !j.length) throw new Error("empty");
  // Gate: [time, volume, close, high, low, open, ...]
  return j.map((k) => ({ time: parseInt(k[0]), open: +k[5], high: +k[3], low: +k[4], close: +k[2] }));
}
async function ohlcBybit(base, iv) {
  const url = `https://api.bybit.com/v5/market/kline?category=spot&symbol=${base}USDT&interval=${BYBIT_IV[iv]}&limit=120`;
  const r = await fetch(url); if (!r.ok) throw new Error("x");
  const j = await r.json();
  const list = j && j.result && j.result.list;
  if (!Array.isArray(list) || !list.length) throw new Error("empty");
  // Bybit yeni->eski: [start, open, high, low, close, ...]
  return list.slice().reverse().map((k) => ({ time: Math.floor(+k[0] / 1000), open: +k[1], high: +k[2], low: +k[3], close: +k[4] }));
}

const EXCHANGES = [
  { id: "Binance", fn: ohlcBinance },
  { id: "MEXC", fn: ohlcMexc },
  { id: "Gate", fn: ohlcGate },
  { id: "Bybit", fn: ohlcBybit },
];
const exchangeCache = {};
async function resolveExchange(base, iv) {
  if (exchangeCache[base]) {
    const ex = EXCHANGES.find((e) => e.id === exchangeCache[base]);
    try { return { ohlc: await ex.fn(base, iv), ex: ex.id }; } catch (e) {}
  }
  for (const ex of EXCHANGES) {
    try { const ohlc = await ex.fn(base, iv); exchangeCache[base] = ex.id; return { ohlc, ex: ex.id }; }
    catch (e) {}
  }
  throw new Error("yok");
}

// ── Göstergeler ────────────────────────────────────────────
function calcRSI(c, p = 14) {
  if (c.length < p + 1) return null;
  let g = 0, l = 0;
  for (let i = c.length - p; i < c.length; i++) {
    const d = c[i] - c[i - 1];
    if (d >= 0) g += d; else l -= d;
  }
  const aL = l / p; if (aL === 0) return 100;
  return 100 - 100 / (1 + g / p / aL);
}
function rsiSeries(c, p = 14) {
  const out = [];
  for (let i = 0; i < c.length; i++) {
    if (i < p) { out.push(null); continue; }
    out.push(calcRSI(c.slice(0, i + 1), p));
  }
  return out;
}
function ema(a, p) {
  if (a.length < p) return null;
  const k = 2 / (p + 1);
  let e = a.slice(0, p).reduce((x, y) => x + y, 0) / p;
  for (let i = p; i < a.length; i++) e = a[i] * k + e * (1 - k);
  return e;
}
function emaSeries(a, p) {
  if (a.length < p) return [];
  const k = 2 / (p + 1), out = [];
  let e = a.slice(0, p).reduce((x, y) => x + y, 0) / p;
  out.push(e);
  for (let i = p; i < a.length; i++) { e = a[i] * k + e * (1 - k); out.push(e); }
  return out;
}
function emaFull(a, p) {
  // her index için ema (öncesi null)
  if (a.length < p) return a.map(() => null);
  const k = 2 / (p + 1), out = new Array(p - 1).fill(null);
  let e = a.slice(0, p).reduce((x, y) => x + y, 0) / p;
  out.push(e);
  for (let i = p; i < a.length; i++) { e = a[i] * k + e * (1 - k); out.push(e); }
  return out;
}
function calcMACD(c) {
  if (c.length < 35) return null;
  const e12 = emaSeries(c, 12), e26 = emaSeries(c, 26);
  const off = e12.length - e26.length;
  const macdLine = e26.map((v, i) => e12[i + off] - v);
  const signal = emaSeries(macdLine, 9);
  const last = macdLine[macdLine.length - 1] - signal[signal.length - 1];
  const prev = macdLine[macdLine.length - 2] - signal[signal.length - 2];
  return { hist: last, rising: last > prev, bullish: last > 0 };
}
function macdHistFull(c) {
  // grafik için histogram dizisi (her bara hizalı)
  if (c.length < 35) return c.map(() => null);
  const e12 = emaFull(c, 12), e26 = emaFull(c, 26);
  const macdLine = c.map((_, i) => (e12[i] != null && e26[i] != null) ? e12[i] - e26[i] : null);
  const valid = macdLine.map((v) => v == null ? 0 : v);
  const sig = emaFull(valid.slice(macdLine.findIndex((v) => v != null)), 9);
  // basit: signal'i kabaca hizala
  const out = [];
  let sigArrIdx = 0;
  const firstValid = macdLine.findIndex((v) => v != null);
  for (let i = 0; i < c.length; i++) {
    if (macdLine[i] == null || i < firstValid + 9) { out.push(null); continue; }
    const s = sig[sigArrIdx + ( (i - firstValid) - (sig.length ? 0 : 0) )];
    out.push(null); // aşağıda yeniden hesaplanacak
  }
  // Daha güvenilir: macdLine üzerinden ema9
  const macdVals = macdLine.filter((v) => v != null);
  const signalVals = emaFull(macdVals, 9);
  const res = c.map(() => null);
  let idx = 0;
  for (let i = 0; i < c.length; i++) {
    if (macdLine[i] == null) continue;
    const sv = signalVals[idx];
    if (sv != null) res[i] = macdLine[i] - sv;
    idx++;
  }
  return res;
}
function calcBollinger(c, p = 20) {
  if (c.length < p) return null;
  const slice = c.slice(-p);
  const mean = slice.reduce((a, b) => a + b, 0) / p;
  const sd = Math.sqrt(slice.reduce((a, b) => a + (b - mean) ** 2, 0) / p);
  const price = c[c.length - 1];
  let pos = "orta";
  if (price > mean + 2 * sd) pos = "üst bant üstü"; else if (price < mean - 2 * sd) pos = "alt bant altı";
  return { pos };
}
function calcVolatility(c, n = 14) {
  if (c.length < n + 1) return null;
  let sum = 0;
  for (let i = c.length - n; i < c.length; i++) sum += Math.abs(c[i] - c[i - 1]);
  return sum / n;
}

function buildSignal(c) {
  const rsi = calcRSI(c), fast = ema(c, 9), slow = ema(c, 21);
  const macd = calcMACD(c), boll = calcBollinger(c);
  if (rsi == null || fast == null || slow == null) return null;
  let score = 0, maxScore = 0;
  const reasons = [];
  maxScore += 2;
  if (rsi < 30) { score += 2; reasons.push(`RSI ${rsi.toFixed(0)} — aşırı satım`); }
  else if (rsi > 70) { score -= 2; reasons.push(`RSI ${rsi.toFixed(0)} — aşırı alım`); }
  else reasons.push(`RSI ${rsi.toFixed(0)} — nötr`);
  maxScore += 1;
  if (fast > slow) { score += 1; reasons.push("EMA9 > EMA21 — yukarı eğilim"); }
  else { score -= 1; reasons.push("EMA9 < EMA21 — aşağı eğilim"); }
  if (macd) {
    maxScore += 1;
    if (macd.bullish && macd.rising) { score += 1; reasons.push("MACD pozitif ve yükseliyor"); }
    else if (!macd.bullish && !macd.rising) { score -= 1; reasons.push("MACD negatif ve düşüyor"); }
    else reasons.push("MACD kararsız");
  }
  if (boll) {
    maxScore += 1;
    if (boll.pos === "alt bant altı") { score += 1; reasons.push("Fiyat alt Bollinger bandının altında"); }
    else if (boll.pos === "üst bant üstü") { score -= 1; reasons.push("Fiyat üst Bollinger bandının üstünde"); }
    else reasons.push(`Bollinger: ${boll.pos}`);
  }
  let verdict, tone;
  if (score >= 3) { verdict = "AL"; tone = "buy"; }
  else if (score <= -3) { verdict = "SAT"; tone = "sell"; }
  else { verdict = "BEKLE"; tone = "hold"; }
  const strength = maxScore ? Math.abs(score) / maxScore : 0;
  let confidence = "zayıf";
  if (strength >= 0.66) confidence = "güçlü";
  else if (strength >= 0.33) confidence = "orta";
  const price = c[c.length - 1];
  const vol = calcVolatility(c);
  let stop = null, tp1 = null, tp2 = null, rr = null;
  if (vol != null && score !== 0) {
    const dir = score > 0 ? 1 : -1;
    stop = price - dir * 1.5 * vol;
    tp1 = price + dir * 1.5 * vol;
    tp2 = price + dir * 3.5 * vol;
    rr = 2.3; // 1.5 risk : ~3.5 ödül ortalaması
  }
  return { rsi, verdict, tone, reasons, score, confidence, strength, price, stop, tp1, tp2, rr, dir: Math.sign(score) };
}

async function fetchCoin(base, interval) {
  const { ohlc, ex } = await resolveExchange(base, interval);
  const closes = ohlc.map((d) => d.close);
  const price = closes[closes.length - 1];
  const prev = closes[closes.length - 2];
  const sig = buildSignal(closes);
  let mtf = null;
  try {
    const exObj = EXCHANGES.find((e) => e.id === ex);
    const dirs = await Promise.all(
      MTF.map(async (iv) => {
        try { const o = await exObj.fn(base, iv); const s = buildSignal(o.map((d) => d.close)); return s ? s.dir : 0; }
        catch (e) { return 0; }
      })
    );
    const ups = dirs.filter((d) => d > 0).length, downs = dirs.filter((d) => d < 0).length;
    let align = "karışık", atone = "hold";
    if (ups === MTF.length) { align = "hepsi yukarı"; atone = "buy"; }
    else if (downs === MTF.length) { align = "hepsi aşağı"; atone = "sell"; }
    else if (ups > downs) { align = "çoğunluk yukarı"; atone = "buy"; }
    else if (downs > ups) { align = "çoğunluk aşağı"; atone = "sell"; }
    mtf = { align, atone, agree: Math.max(ups, downs), total: MTF.length };
  } catch (e) {}
  return { ohlc, closes, price, change: ((price - prev) / prev) * 100, sig, mtf, ex };
}

const TONE = { buy: "#00e08a", sell: "#ff4d6d", hold: "#f0c040" };
const CONF_COLOR = { "zayıf": "#7a8190", "orta": "#f0c040", "güçlü": "#00e08a" };
const EX_COLOR = { Binance: "#f0b90b", MEXC: "#1972f5", Gate: "#e6486a", Bybit: "#f7a600" };
const fmtPrice = (p) => p == null ? "—" :
  `$${p.toLocaleString("en-US", { maximumFractionDigits: p < 1 ? 6 : p < 100 ? 3 : 2 })}`;

function beep(tone) {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.connect(g); g.connect(ctx.destination);
    o.frequency.value = tone === "buy" ? 880 : tone === "sell" ? 330 : 550;
    g.gain.setValueAtTime(0.15, ctx.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.4);
    o.start(); o.stop(ctx.currentTime + 0.4);
  } catch (e) {}
}

// Basit düz çizgi fiyat grafiği
// Coin amblemi: gerçek logoyu dener, bulamazsa harf dairesine düşer
const LOGO_TINT = ["#5b8def","#00e08a","#f0b90b","#e6486a","#a06bff","#f7a600","#1972f5","#ff8a3d"];
function CoinLogo({ base, size = 34 }) {
  const [failed, setFailed] = useState(false);
  const tint = LOGO_TINT[(base.charCodeAt(0) + (base.charCodeAt(1) || 0)) % LOGO_TINT.length];
  if (failed) {
    return (
      <span style={{ width: size, height: size, borderRadius: "50%", background: tint + "22",
        border: `1px solid ${tint}`, color: tint, display: "inline-flex", alignItems: "center",
        justifyContent: "center", fontSize: size * 0.42, fontWeight: 800, flexShrink: 0 }}>
        {base.slice(0, 1)}
      </span>
    );
  }
  return (
    <img src={`https://assets.coincap.io/assets/icons/${base.toLowerCase()}@2x.png`}
      alt={base} width={size} height={size} onError={() => setFailed(true)}
      style={{ borderRadius: "50%", flexShrink: 0, background: "#1a1e27" }} />
  );
}

function Sparkline({ closes, up }) {
  if (!closes || closes.length < 2) return null;
  const pts = closes.slice(-50);
  const min = Math.min(...pts), max = Math.max(...pts);
  const range = max - min || 1;
  const w = 100, h = 40;
  const path = pts.map((p, i) => {
    const x = (i / (pts.length - 1)) * w;
    const y = h - ((p - min) / range) * h;
    return `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(" ");
  const color = up ? "#00e08a" : "#ff4d6d";
  return (
    <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none"
      style={{ width: "100%", height: 56, margin: "10px 0 4px", display: "block" }}>
      <path d={path} fill="none" stroke={color} strokeWidth="1" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

// ── Piyasa Genel Görünümü ──────────────────────────────────
async function fetchFearGreed() {
  const r = await fetch("https://api.alternative.me/fng/?limit=1");
  if (!r.ok) throw new Error("x");
  const j = await r.json();
  const d = j.data[0];
  return { value: parseInt(d.value), label: d.value_classification };
}
async function fetchGlobal() {
  const r = await fetch("https://api.coingecko.com/api/v3/global");
  if (!r.ok) throw new Error("x");
  const j = await r.json();
  const d = j.data;
  return {
    btcDom: d.market_cap_percentage.btc,
    ethDom: d.market_cap_percentage.eth,
    totalMcap: d.total_market_cap.usd,
    mcapChange: d.market_cap_change_percentage_24h_usd,
  };
}
async function fetchTrending() {
  const r = await fetch("https://api.coingecko.com/api/v3/search/trending");
  if (!r.ok) throw new Error("x");
  const j = await r.json();
  return j.coins.slice(0, 7).map((c) => c.item.symbol.toUpperCase());
}

const FG_COLOR = (v) => v <= 25 ? "#ff4d6d" : v <= 45 ? "#f0a030" : v <= 55 ? "#f0c040" : v <= 75 ? "#9ed85b" : "#00e08a";
const FG_TR = { "Extreme Fear": "Aşırı Korku", "Fear": "Korku", "Neutral": "Nötr", "Greed": "Açgözlülük", "Extreme Greed": "Aşırı Açgözlülük" };
const fmtBig = (n) => {
  if (n == null) return "—";
  if (n >= 1e12) return `$${(n / 1e12).toFixed(2)}T`;
  if (n >= 1e9) return `$${(n / 1e9).toFixed(1)}B`;
  return `$${n.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
};

function MarketOverview() {
  const [fg, setFg] = useState(null);
  const [glob, setGlob] = useState(null);
  const [trend, setTrend] = useState(null);
  const [err, setErr] = useState(false);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const [f, g, t] = await Promise.allSettled([fetchFearGreed(), fetchGlobal(), fetchTrending()]);
        if (!alive) return;
        if (f.status === "fulfilled") setFg(f.value);
        if (g.status === "fulfilled") setGlob(g.value);
        if (t.status === "fulfilled") setTrend(t.value);
        if (f.status !== "fulfilled" && g.status !== "fulfilled") setErr(true);
      } catch (e) { if (alive) setErr(true); }
    };
    load();
    const id = setInterval(load, 5 * 60 * 1000); // 5 dakikada bir
    return () => { alive = false; clearInterval(id); };
  }, []);

  return (
    <div style={S.card}>
      <div style={S.cardHead}>PİYASA GENEL GÖRÜNÜMÜ</div>
      <div style={S.moGrid}>
        {/* Fear & Greed */}
        <div style={S.moCell}>
          <div style={S.moKey}>Korku / Açgözlülük</div>
          {fg ? (
            <>
              <div style={{ fontSize: 26, fontWeight: 800, color: FG_COLOR(fg.value) }}>{fg.value}</div>
              <div style={{ fontSize: 11, color: FG_COLOR(fg.value), fontWeight: 700 }}>{FG_TR[fg.label] || fg.label}</div>
              <div style={S.moBarTrack}><div style={{ ...S.moBarFill, width: `${fg.value}%`, background: FG_COLOR(fg.value) }} /></div>
            </>
          ) : <div style={S.moLoad}>…</div>}
        </div>

        {/* BTC Dominance */}
        <div style={S.moCell}>
          <div style={S.moKey}>BTC Hakimiyeti</div>
          {glob ? (
            <>
              <div style={{ fontSize: 26, fontWeight: 800, color: "#f0b90b" }}>{glob.btcDom.toFixed(1)}%</div>
              <div style={{ fontSize: 11, color: "#7a8190" }}>ETH: {glob.ethDom.toFixed(1)}%</div>
            </>
          ) : <div style={S.moLoad}>…</div>}
        </div>

        {/* Toplam piyasa değeri */}
        <div style={S.moCell}>
          <div style={S.moKey}>Toplam Piyasa Değeri</div>
          {glob ? (
            <>
              <div style={{ fontSize: 22, fontWeight: 800 }}>{fmtBig(glob.totalMcap)}</div>
              <div style={{ fontSize: 11, fontWeight: 700, color: glob.mcapChange >= 0 ? "#00e08a" : "#ff4d6d" }}>
                {glob.mcapChange >= 0 ? "+" : ""}{glob.mcapChange.toFixed(2)}% (24s)
              </div>
            </>
          ) : <div style={S.moLoad}>…</div>}
        </div>

        {/* Trend coinler */}
        <div style={{ ...S.moCell, flex: "1 1 100%" }}>
          <div style={S.moKey}>🔥 Trend Coinler</div>
          {trend ? (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 4 }}>
              {trend.map((t) => (
                <span key={t} style={S.trendChip}>{t}</span>
              ))}
            </div>
          ) : <div style={S.moLoad}>…</div>}
        </div>
      </div>
      {err && <div style={{ ...S.muted, marginTop: 8 }}>Bazı piyasa verileri şu an alınamadı (kaynak geçici sınır koymuş olabilir).</div>}
      <div style={{ ...S.muted, marginTop: 8, fontSize: 10.5 }}>
        Veriler: alternative.me (Korku/Açgözlülük) ve CoinGecko (hakimiyet, piyasa değeri, trend). 5 dk'da bir güncellenir.
        Korku/Açgözlülük bir duygu göstergesidir, fiyat tahmini değildir.
      </div>
    </div>
  );
}

// ── Coin Risk Tarayıcısı ───────────────────────────────────
async function fetchCoinRisk(sym) {
  // önce sembolden coingecko id bul
  const lr = await fetch("https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&symbols=" + sym.toLowerCase());
  if (!lr.ok) throw new Error("x");
  const arr = await lr.json();
  if (!Array.isArray(arr) || arr.length === 0) throw new Error("yok");
  // aynı sembolde birden çok olabilir; en yüksek piyasa değerlisini al
  arr.sort((a, b) => (b.market_cap || 0) - (a.market_cap || 0));
  return arr[0];
}

function analyzeRisk(d) {
  const flags = [];
  const mcap = d.market_cap || 0;
  const vol = d.total_volume || 0;
  const fdv = d.fully_diluted_valuation || 0;
  const rank = d.market_cap_rank || 9999;
  const athChange = d.ath_change_percentage || 0;
  const volToMcap = mcap ? vol / mcap : 0;
  const fdvToMcap = mcap ? fdv / mcap : 0;

  // Piyasa değeri büyüklüğü
  if (mcap < 10e6) flags.push({ t: "yüksek", m: "Çok küçük piyasa değeri (<$10M) — manipülasyona çok açık" });
  else if (mcap < 100e6) flags.push({ t: "orta", m: "Küçük piyasa değeri (<$100M) — yüksek oynaklık beklenir" });
  else if (mcap < 1e9) flags.push({ t: "düşük", m: "Orta piyasa değeri ($100M–$1B) — büyüme potansiyeli + risk dengeli" });
  else flags.push({ t: "iyi", m: "Büyük piyasa değeri (>$1B) — görece daha oturmuş" });

  // Hacim/piyasa değeri oranı (likidite sağlığı)
  if (volToMcap < 0.01) flags.push({ t: "yüksek", m: "Çok düşük işlem hacmi — likidite zayıf, alım-satım zor olabilir" });
  else if (volToMcap > 1) flags.push({ t: "orta", m: "Hacim piyasa değerinden büyük — anormal hareket/pump olabilir" });
  else flags.push({ t: "iyi", m: "Hacim/piyasa değeri oranı sağlıklı görünüyor" });

  // FDV baskısı (gelecekteki arz)
  if (fdvToMcap > 3) flags.push({ t: "yüksek", m: `Yüksek FDV baskısı (${fdvToMcap.toFixed(1)}x) — gelecekte çok coin piyasaya çıkacak, fiyatı baskılayabilir` });
  else if (fdvToMcap > 1.5) flags.push({ t: "orta", m: `Orta FDV baskısı (${fdvToMcap.toFixed(1)}x) — bir miktar arz açılışı bekleniyor` });
  else if (fdv > 0) flags.push({ t: "iyi", m: "FDV baskısı düşük — arzın çoğu zaten dolaşımda" });

  // ATH'den düşüş
  if (athChange < -90) flags.push({ t: "orta", m: `Zirvesinden %${Math.abs(athChange).toFixed(0)} düşmüş — ya büyük fırsat ya da ölmekte olan proje` });
  else if (athChange > -20) flags.push({ t: "orta", m: `Zirvesine yakın (%${Math.abs(athChange).toFixed(0)} altında) — tepeden almaya dikkat` });

  // Sıralama
  if (rank > 500) flags.push({ t: "orta", m: `Piyasa değeri sıralaması düşük (#${rank}) — az bilinen, daha riskli` });

  return flags;
}

const RISK_COLOR = { "yüksek": "#ff4d6d", "orta": "#f0a030", "düşük": "#f0c040", "iyi": "#00e08a" };
const RISK_ICON = { "yüksek": "⚠", "orta": "•", "düşük": "•", "iyi": "✓" };

function TelegramSetup() {
  const [token, setToken] = useState(() => localStorage.getItem(TG_TOKEN_KEY) || "");
  const [chat, setChat] = useState(() => localStorage.getItem(TG_CHAT_KEY) || "");
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);

  const save = () => {
    if (token.trim()) localStorage.setItem(TG_TOKEN_KEY, token.trim());
    else localStorage.removeItem(TG_TOKEN_KEY);
    if (chat.trim()) localStorage.setItem(TG_CHAT_KEY, chat.trim());
    else localStorage.removeItem(TG_CHAT_KEY);
    setMsg("Kaydedildi (bu cihazda).");
  };

  const test = async () => {
    save();
    setBusy(true); setMsg("Test mesajı gönderiliyor…");
    const ok = await sendTelegram("✅ Kripto Sinyal Terminali bağlandı. Bildirimler buraya gelecek.");
    setMsg(ok ? "Başarılı! Telegram'ı kontrol et." : "Gönderilemedi — token veya chat ID hatalı olabilir.");
    setBusy(false);
  };

  const connected = !!localStorage.getItem(TG_TOKEN_KEY) && !!localStorage.getItem(TG_CHAT_KEY);

  return (
    <div style={S.card}>
      <div style={S.cardHead}>
        TELEGRAM BİLDİRİMLERİ {connected && <span style={{ color: "#00e08a" }}>● bağlı</span>}
      </div>
      <div style={{ ...S.muted, marginBottom: 12 }}>
        Bir coinin sinyali AL/SAT'a dönünce Telegram'dan haber alırsın. @BotFather'dan bot oluştur,
        token ve chat ID'ni aşağıya gir. Bu bilgiler sadece bu cihazda saklanır, paylaşılmaz.
      </div>
      <div style={{ marginBottom: 10 }}>
        <div style={RS.label}>Bot Token</div>
        <input value={token} onChange={(e) => setToken(e.target.value)} placeholder="123456:AAF..." style={RS.input} />
      </div>
      <div style={{ marginBottom: 12 }}>
        <div style={RS.label}>Chat ID</div>
        <input value={chat} onChange={(e) => setChat(e.target.value)} placeholder="123456789" inputMode="numeric" style={RS.input} />
      </div>
      <div style={{ display: "flex", gap: 8 }}>
        <button className="chip" onClick={save} style={{ ...S.chipSm, borderColor: "#5b8def", color: "#5b8def" }}>Kaydet</button>
        <button className="chip" onClick={test} disabled={busy} style={{ ...S.addBtn, opacity: busy ? 0.6 : 1 }}>
          {busy ? "…" : "Test mesajı gönder"}
        </button>
      </div>
      {msg && <div style={{ ...S.muted, marginTop: 10 }}>{msg}</div>}
    </div>
  );
}

function RiskScanner() {
  const [q, setQ] = useState("");
  const [data, setData] = useState(null);
  const [flags, setFlags] = useState(null);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");

  const scan = async () => {
    const sym = q.trim().toUpperCase();
    if (!sym) return;
    setLoading(true); setErr(""); setData(null); setFlags(null);
    try {
      const d = await fetchCoinRisk(sym);
      setData(d);
      setFlags(analyzeRisk(d));
    } catch (e) {
      setErr(`"${sym}" CoinGecko'da bulunamadı veya veri alınamadı.`);
    } finally { setLoading(false); }
  };

  // genel risk seviyesi
  let overall = null;
  if (flags) {
    const high = flags.filter((f) => f.t === "yüksek").length;
    const mid = flags.filter((f) => f.t === "orta").length;
    if (high >= 2) overall = { label: "YÜKSEK RİSK", color: "#ff4d6d" };
    else if (high === 1 || mid >= 2) overall = { label: "ORTA-YÜKSEK RİSK", color: "#f0a030" };
    else if (mid === 1) overall = { label: "ORTA RİSK", color: "#f0c040" };
    else overall = { label: "GÖRECE DÜŞÜK RİSK", color: "#00e08a" };
  }

  return (
    <div style={S.card}>
      <div style={S.cardHead}>COIN RİSK TARAYICISI</div>
      <div style={{ display: "flex", gap: 8 }}>
        <input value={q} onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && scan()}
          placeholder="Coin sembolü (örn. RENDER, ARB, PEPE)…" style={{ ...S.input, marginBottom: 0, flex: 1 }} />
        <button className="chip" onClick={scan} disabled={loading} style={{ ...S.addBtn, opacity: loading ? 0.6 : 1 }}>
          {loading ? "…" : "Tara"}
        </button>
      </div>
      {err && <div style={{ ...S.muted, marginTop: 8, color: "#ff4d6d" }}>{err}</div>}

      {data && flags && (
        <div style={{ marginTop: 14 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
            <span style={{ fontWeight: 700, fontSize: 15 }}>{data.symbol.toUpperCase()} — {data.name}</span>
            {overall && <span style={{ ...S.badge, color: overall.color, borderColor: overall.color }}>{overall.label}</span>}
          </div>

          <div style={S.riskStats}>
            <div style={S.riskStat}><span style={S.riskStatKey}>Piyasa değeri</span><span style={S.riskStatVal}>{fmtBig(data.market_cap)}</span></div>
            <div style={S.riskStat}><span style={S.riskStatKey}>Sıralama</span><span style={S.riskStatVal}>#{data.market_cap_rank || "—"}</span></div>
            <div style={S.riskStat}><span style={S.riskStatKey}>24s hacim</span><span style={S.riskStatVal}>{fmtBig(data.total_volume)}</span></div>
            <div style={S.riskStat}><span style={S.riskStatKey}>Zirveden</span><span style={{ ...S.riskStatVal, color: "#ff4d6d" }}>{data.ath_change_percentage ? data.ath_change_percentage.toFixed(0) + "%" : "—"}</span></div>
          </div>

          <div style={{ marginTop: 12 }}>
            {flags.map((f, i) => (
              <div key={i} style={{ fontSize: 12.5, color: "#c9cfd9", padding: "5px 0", display: "flex", gap: 8 }}>
                <span style={{ color: RISK_COLOR[f.t], fontWeight: 700, flexShrink: 0 }}>{RISK_ICON[f.t]}</span>
                <span>{f.m}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      <div style={{ ...S.muted, marginTop: 12, fontSize: 10.5 }}>
        Veri: CoinGecko. Bu bir risk *taraması*dır, fiyat tahmini veya tavsiye değildir. "Görece düşük risk"
        bile zarar etmeyeceğin anlamına gelmez. Risk bayrakları tuzaklardan kaçınmana yardımcı olur, kazanç
        garantisi vermez. Asıl karar ve araştırma sende.
      </div>
    </div>
  );
}

function RiskCalc() {
  const [capital, setCapital] = useState("1000");
  const [riskPct, setRiskPct] = useState("2");
  const [entry, setEntry] = useState("");
  const [stop, setStop] = useState("");
  const [target, setTarget] = useState("");
  const cap = parseFloat(capital) || 0, rp = parseFloat(riskPct) || 0;
  const e = parseFloat(entry) || 0, s = parseFloat(stop) || 0, t = parseFloat(target) || 0;
  const riskAmount = cap * (rp / 100);
  const perUnitRisk = e && s ? Math.abs(e - s) : 0;
  const lossPct = e && s ? (Math.abs(e - s) / e) * 100 : 0;
  const positionSize = perUnitRisk ? riskAmount / perUnitRisk : 0;
  const positionValue = positionSize * e;
  const rewardPerUnit = e && t ? Math.abs(t - e) : 0;
  const rr = perUnitRisk && rewardPerUnit ? rewardPerUnit / perUnitRisk : 0;
  const fld = (label, val, set, ph) => (
    <div style={{ flex: "1 1 130px" }}>
      <div style={RS.label}>{label}</div>
      <input value={val} onChange={(ev) => set(ev.target.value)} placeholder={ph} inputMode="decimal" style={RS.input} />
    </div>
  );
  return (
    <div style={S.card}>
      <div style={S.cardHead}>RİSK HESAPLAYICI</div>
      <div style={RS.row}>{fld("Sermaye ($)", capital, setCapital, "1000")}{fld("Risk %", riskPct, setRiskPct, "2")}</div>
      <div style={RS.row}>{fld("Giriş fiyatı", entry, setEntry, "0.00")}{fld("Stop-loss", stop, setStop, "0.00")}{fld("Hedef (ops.)", target, setTarget, "0.00")}</div>
      <div style={RS.results}>
        <div style={RS.resRow}><span style={RS.resKey}>Riske atılan para</span><span style={RS.resVal}>${riskAmount.toFixed(2)}</span></div>
        {perUnitRisk > 0 && (<>
          <div style={RS.resRow}><span style={RS.resKey}>Stop mesafesi</span><span style={RS.resVal}>{lossPct.toFixed(2)}%</span></div>
          <div style={RS.resRow}><span style={RS.resKey}>Alınacak miktar</span><span style={RS.resVal}>{positionSize.toLocaleString("en-US", { maximumFractionDigits: 4 })} birim</span></div>
          <div style={RS.resRow}><span style={RS.resKey}>Pozisyon değeri</span><span style={RS.resVal}>${positionValue.toFixed(2)}</span></div>
        </>)}
        {rr > 0 && (<div style={RS.resRow}><span style={RS.resKey}>Risk / Ödül</span>
          <span style={{ ...RS.resVal, color: rr >= 2 ? "#00e08a" : rr >= 1 ? "#f0c040" : "#ff4d6d" }}>1 : {rr.toFixed(2)}</span></div>)}
      </div>
      <div style={RS.hint}>Tek işlemde sermayenin %1–2'sinden fazlasını riske atma. Risk/Ödül en az 1:2 tercih edilir. Referans amaçlıdır.</div>
    </div>
  );
}

function LeverageSim() {
  const [margin, setMargin] = useState("100");
  const [lev, setLev] = useState(10);
  const [entry, setEntry] = useState("");
  const LEVS = [2, 3, 5, 10, 25, 50, 100];
  const m = parseFloat(margin) || 0;
  const e = parseFloat(entry) || 0;
  const position = m * lev;                 // pozisyon büyüklüğü
  const liqPct = 100 / lev;                 // yaklaşık likidasyon yüzdesi
  const liqLong = e ? e * (1 - liqPct / 100) : 0;  // long likidasyon fiyatı
  const liqShort = e ? e * (1 + liqPct / 100) : 0; // short likidasyon fiyatı
  // örnek: %5 ters hareket ne kaybettirir
  const lossOn5 = m * lev * 0.05;
  const lossPctOnMargin5 = lev * 5; // teminata oranla

  const sevColor = lev >= 25 ? "#ff4d6d" : lev >= 10 ? "#f0a030" : lev >= 5 ? "#f0c040" : "#00e08a";

  return (
    <div style={S.card}>
      <div style={S.cardHead}>KALDIRAÇ RİSK SİMÜLATÖRÜ</div>

      <div style={RS.row}>
        <div style={{ flex: "1 1 130px" }}>
          <div style={RS.label}>Teminat ($)</div>
          <input value={margin} onChange={(ev) => setMargin(ev.target.value)} placeholder="100" inputMode="decimal" style={RS.input} />
        </div>
        <div style={{ flex: "1 1 130px" }}>
          <div style={RS.label}>Giriş fiyatı (ops.)</div>
          <input value={entry} onChange={(ev) => setEntry(ev.target.value)} placeholder="60000" inputMode="decimal" style={RS.input} />
        </div>
      </div>

      <div style={{ ...RS.label, marginBottom: 6 }}>Kaldıraç</div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 14 }}>
        {LEVS.map((l) => (
          <button key={l} className="chip" onClick={() => setLev(l)}
            style={{ ...S.filterChip, borderColor: lev === l ? sevColor : "#23262f", color: lev === l ? sevColor : "#9098a6" }}>
            {l}x
          </button>
        ))}
      </div>

      <div style={RS.results}>
        <div style={RS.resRow}><span style={RS.resKey}>Pozisyon büyüklüğü</span><span style={RS.resVal}>${position.toLocaleString("en-US", { maximumFractionDigits: 2 })}</span></div>
        <div style={RS.resRow}>
          <span style={RS.resKey}>Likidasyon ≈ (ters hareket)</span>
          <span style={{ ...RS.resVal, color: sevColor }}>%{liqPct.toFixed(1)} → paran biter</span>
        </div>
        {e > 0 && (<>
          <div style={RS.resRow}><span style={RS.resKey}>Long likidasyon fiyatı</span><span style={{ ...RS.resVal, color: "#ff4d6d" }}>{fmtPrice(liqLong)}</span></div>
          <div style={RS.resRow}><span style={RS.resKey}>Short likidasyon fiyatı</span><span style={{ ...RS.resVal, color: "#ff4d6d" }}>{fmtPrice(liqShort)}</span></div>
        </>)}
        <div style={RS.resRow}>
          <span style={RS.resKey}>%5 ters giderse kaybın</span>
          <span style={{ ...RS.resVal, color: sevColor }}>${lossOn5.toFixed(2)} (teminatın %{lossPctOnMargin5})</span>
        </div>
      </div>

      <div style={{ ...RS.hint, color: sevColor }}>
        {lev >= 25
          ? `⚠ ${lev}x çok tehlikeli: fiyat sadece %${liqPct.toFixed(1)} ters giderse tüm paran sıfırlanır. Kripto bunu bir günde rahat yapar.`
          : lev >= 10
          ? `Dikkat: ${lev}x'te fiyat %${liqPct.toFixed(1)} ters giderse paran biter. Kripto günde %5–10 oynayabilir.`
          : `${lev}x'te fiyat %${liqPct.toFixed(1)} ters giderse likide olursun.`}
      </div>
      <div style={RS.hint}>
        Bu bir öğrenme/gösterim aracıdır, işlem önerisi değildir. Likidasyon yüzdesi yaklaşıktır
        (borsa ücretleri ve teminat türüne göre biraz değişir). Kaldıraçlı işlem, yeni başlayanların
        en hızlı para kaybettiği yoldur; çoğu kişi uzun vadede kaybeder.
      </div>
    </div>
  );
}

export default function App() {
  const [watch, setWatch] = useState(() => {
    try { const s = JSON.parse(localStorage.getItem(STORAGE_KEY)); if (Array.isArray(s) && s.length) return s; } catch (e) {}
    return ["BTC", "ETH", "SOL"];
  });
  const [interval, setIntervalSel] = useState(INTERVALS[3]); // varsayılan 1gün (grafik için)
  const [rows, setRows] = useState({});
  const [selected, setSelected] = useState("BTC");
  const [search, setSearch] = useState("");
  const [soundOn, setSoundOn] = useState(true);
  const [lastUpdate, setLastUpdate] = useState(null);
  const [adding, setAdding] = useState(false);
  const [addMsg, setAddMsg] = useState("");
  const [sortMode, setSortMode] = useState("default");
  const [filterMode, setFilterMode] = useState("all");
  const [tab, setTab] = useState("piyasa");
  const prevVerdicts = useRef({});
  const timerRef = useRef(null);
  const fbReady = useRef(false);       // ilk Firebase verisi geldi mi
  const skipNextWrite = useRef(false); // Firebase'den gelen değişikliği geri yazma

  // Firebase'i dinle: başka cihazda değişince burada da güncellensin
  useEffect(() => {
    const unsub = onSnapshot(WATCH_DOC, (snap) => {
      if (snap.exists()) {
        const data = snap.data();
        if (Array.isArray(data.coins)) {
          skipNextWrite.current = true; // bu güncellemeyi tekrar Firebase'e yazma
          setWatch(data.coins);
          try { localStorage.setItem(STORAGE_KEY, JSON.stringify(data.coins)); } catch (e) {}
        }
      } else {
        // belge yoksa, mevcut listeyle ilk kez oluştur
        setDoc(WATCH_DOC, { coins: watch }).catch(() => {});
      }
      fbReady.current = true;
    }, (err) => {
      // Firebase'e ulaşılamazsa (offline vb.) sessizce yerel listeyle devam
      fbReady.current = true;
    });
    return () => unsub();
    // eslint-disable-next-line
  }, []);

  // Liste değişince: yerel kaydet + Firebase'e yaz
  useEffect(() => {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(watch)); } catch (e) {}
    if (!fbReady.current) return;           // henüz Firebase hazır değilse bekle
    if (skipNextWrite.current) { skipNextWrite.current = false; return; } // Firebase'den geldiyse geri yazma
    setDoc(WATCH_DOC, { coins: watch }).catch(() => {});
  }, [watch]);

  const loadAll = useCallback(async () => {
    const results = {};
    await Promise.all(watch.map(async (base) => {
      try { results[base] = await fetchCoin(base, interval.v); } catch (e) { results[base] = { error: true }; }
    }));
    Object.entries(results).forEach(([base, d]) => {
      if (d.sig) {
        const prev = prevVerdicts.current[base];
        if (prev && prev !== d.sig.verdict && d.sig.verdict !== "BEKLE") {
          if (soundOn) beep(d.sig.tone);
          // Telegram bildirimi (token/chat varsa)
          const conf = Math.round(d.sig.strength * 100);
          sendTelegram(`🔔 ${base}/USDT → ${d.sig.verdict}\nGüven: %${conf}\nFiyat: ${fmtPrice(d.price)}\nZaman uyumu: ${d.mtf ? d.mtf.align : "—"}\n\n(Bu bir bilgilendirmedir, yatırım tavsiyesi değildir.)`);
        }
        prevVerdicts.current[base] = d.sig.verdict;
      }
    });
    setRows(results);
    setLastUpdate(new Date());
  }, [watch, interval, soundOn]);

  useEffect(() => {
    loadAll();
    timerRef.current = setInterval(loadAll, 30000);
    return () => clearInterval(timerRef.current);
  }, [loadAll]);

  const remove = (base) => {
    setWatch((w) => w.filter((s) => s !== base));
    if (selected === base) setSelected((prev) => watch.find((x) => x !== base) || "");
  };

  const tryAdd = async () => {
    const base = search.trim().toUpperCase();
    if (!base) return;
    if (watch.includes(base)) { setAddMsg(`${base} zaten listede.`); return; }
    setAdding(true); setAddMsg("Borsalarda aranıyor…");
    try {
      const r = await resolveExchange(base, interval.v);
      setWatch((w) => [...w, base]); setSelected(base);
      setAddMsg(`${base} eklendi (${r.ex}).`); setSearch("");
    } catch (e) { setAddMsg(`"${base}" hiçbir borsada bulunamadı.`); }
    finally { setAdding(false); }
  };

  const buildDisplayList = () => {
    let list = watch.map((base) => ({ base, d: rows[base] }));
    if (filterMode === "buy") list = list.filter((x) => x.d?.sig?.verdict === "AL");
    else if (filterMode === "sell") list = list.filter((x) => x.d?.sig?.verdict === "SAT");
    else if (filterMode === "strong") list = list.filter((x) => x.d?.sig?.confidence === "güçlü");
    if (sortMode === "strong") list.sort((a, b) => (b.d?.sig?.strength || 0) - (a.d?.sig?.strength || 0));
    else if (sortMode === "alpha") list.sort((a, b) => a.base.localeCompare(b.base));
    return list;
  };
  const displayList = buildDisplayList();
  const sel = rows[selected];

  return (
    <div style={S.page}>
      <style>{`
        *{box-sizing:border-box}
        html,body,#root{margin:0;padding:0;width:100%;min-height:100%;background:#080a0e;color:#e7eaf0;}
        @keyframes pulse{0%,100%{opacity:1}50%{opacity:.4}}
        .live-dot{width:7px;height:7px;border-radius:50%;background:#00e08a;animation:pulse 1.6s infinite}
        .chip{transition:all .15s ease;cursor:pointer;font-family:inherit}
        .chip:hover{border-color:#3a3f4b}
        .row{transition:background .15s ease}
        .row:hover{background:#12161f}
        input{font-family:inherit}
        input:focus{outline:none;border-color:#5b8def}
        .strip{cursor:pointer;transition:border-color .15s}
        .strip:hover{border-color:#3a3f4b}
        .strip-scroll{display:flex;gap:10px;overflow-x:auto;padding-bottom:6px;}
        .strip-scroll::-webkit-scrollbar{height:5px}
        .strip-scroll::-webkit-scrollbar-thumb{background:#23262f;border-radius:3px}
        .detail-grid{display:grid;gap:12px;grid-template-columns:1fr;}
        @media(min-width:760px){.detail-grid{grid-template-columns:1fr 1fr;}}
        @media(min-width:1100px){.detail-grid{grid-template-columns:1fr 1fr 1fr;}}

        /* Sekmeli responsive yerleşim */
        .shell{max-width:760px;}
        @media(min-width:900px){
          .shell{max-width:1140px;}
        }
        .layout{display:flex;flex-direction:column;gap:0;}
        .sidenav{display:none;}
        .bottomnav{
          position:fixed;left:0;right:0;bottom:0;z-index:50;
          display:flex;justify-content:space-around;align-items:center;
          background:rgba(12,15,21,0.96);border-top:1px solid #1a1e27;
          padding:6px 4px;backdrop-filter:blur(10px);
        }
        .navbtn{
          flex:1;display:flex;flex-direction:column;align-items:center;gap:2px;
          background:none;border:none;cursor:pointer;font-family:inherit;
          padding:6px 2px;color:#7a8190;font-size:10px;font-weight:600;
        }
        .navbtn .ico{font-size:18px;line-height:1;}
        .content{padding-bottom:76px;} /* alt menü için boşluk */

        @media(min-width:900px){
          .layout{flex-direction:row;gap:20px;align-items:flex-start;}
          .bottomnav{display:none;}
          .content{padding-bottom:0;flex:1;min-width:0;}
          .sidenav{
            display:flex;flex-direction:column;gap:4px;
            width:190px;flex-shrink:0;position:sticky;top:20px;
            background:linear-gradient(180deg,#11151d,#0b0e13);
            border:1px solid #1a1e27;border-radius:14px;padding:10px;
          }
          .sidebtn{
            display:flex;align-items:center;gap:10px;cursor:pointer;
            background:none;border:none;font-family:inherit;text-align:left;
            padding:11px 12px;border-radius:9px;color:#9098a6;font-size:13.5px;font-weight:600;
            transition:all .15s;
          }
          .sidebtn:hover{background:#161b24;}
          .sidebtn .ico{font-size:16px;}
        }
      `}</style>

      <div className="shell" style={S.shell}>
        <header style={S.header}>
          <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span style={{ fontSize: 22 }}>📈</span>
            <div>
              <div style={S.kicker}>KRİPTO SİNYAL PANELİ</div>
              <h1 style={S.title}>Sinyal Terminali</h1>
            </div>
          </div>
          <div style={S.liveBox}>
            <button className="chip" onClick={() => loadAll()} style={{ ...S.chipSm, borderColor: "#5b8def", color: "#5b8def" }}>⟳</button>
            <button className="chip" onClick={() => setSoundOn((s) => !s)}
              style={{ ...S.chipSm, borderColor: soundOn ? "#00e08a" : "#23262f", color: soundOn ? "#00e08a" : "#7a8190" }}>
              {soundOn ? "🔔" : "🔕"}
            </button>
            <span className="live-dot" />
          </div>
        </header>

        <div className="layout">
          {/* Sol menü (geniş ekran) */}
          <nav className="sidenav">
            {TABS.map((t) => (
              <button key={t.id} className="sidebtn" onClick={() => setTab(t.id)}
                style={tab === t.id ? { background: "#161b24", color: "#5b8def" } : {}}>
                <span className="ico">{t.icon}</span>{t.label}
              </button>
            ))}
          </nav>

          <div className="content">
          {/* ===== PİYASA SEKMESİ ===== */}
          {tab === "piyasa" && (<>
        {/* Piyasa genel görünümü */}
        <MarketOverview />

        {/* Üst coin şeritleri */}
        <div className="strip-scroll" style={{ marginBottom: 16 }}>
          {watch.map((base) => {
            const d = rows[base];
            const up = d && !d.error && d.change >= 0;
            return (
              <div key={base} className="strip" onClick={() => setSelected(base)}
                style={{ ...S.strip, borderColor: selected === base ? "#5b8def" : "#1a1e27" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 3 }}>
                  <CoinLogo base={base} size={18} />
                  <span style={{ fontSize: 12, color: "#9098a6", fontWeight: 700 }}>{base}/USDT</span>
                </div>
                <div style={{ fontSize: 16, fontWeight: 700, margin: "3px 0" }}>{d?.error ? "—" : fmtPrice(d?.price)}</div>
                <div style={{ fontSize: 12, fontWeight: 700, color: !d || d.error ? "#5a606e" : up ? "#00e08a" : "#ff4d6d" }}>
                  {d && !d.error ? `${up ? "+" : ""}${d.change.toFixed(2)}%` : ""}
                </div>
              </div>
            );
          })}
        </div>

        {/* Seçili coin: grafik + sinyal kutusu */}
        {sel && !sel.error && sel.sig && (
          <div style={S.card}>
            <div style={S.selHead}>
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <CoinLogo base={selected} size={34} />
                <div>
                  <span style={{ fontSize: 20, fontWeight: 700 }}>{selected}/USDT</span>
                  {sel.ex && <span style={{ ...S.exTag, color: EX_COLOR[sel.ex] || "#9098a6", borderColor: EX_COLOR[sel.ex] || "#23262f" }}>{sel.ex}</span>}
                </div>
              </div>
              <div style={{ textAlign: "right" }}>
                <div style={{ fontSize: 20, fontWeight: 700, color: sel.change >= 0 ? "#00e08a" : "#ff4d6d" }}>{fmtPrice(sel.price)}</div>
                <div style={{ fontSize: 12, color: sel.change >= 0 ? "#00e08a" : "#ff4d6d" }}>
                  {sel.change >= 0 ? "+" : ""}{sel.change.toFixed(2)}%
                </div>
              </div>
            </div>

            {/* zaman aralığı seçimi */}
            <div style={{ display: "flex", gap: 6, margin: "12px 0" }}>
              {INTERVALS.map((i) => (
                <button key={i.v} className="chip" onClick={() => setIntervalSel(i)}
                  style={{ ...S.chipSm, borderColor: interval.v === i.v ? "#5b8def" : "#23262f", color: interval.v === i.v ? "#5b8def" : "#9098a6" }}>
                  {i.label}
                </button>
              ))}
            </div>

            {/* Sinyal kutusu */}
            <div style={{ ...S.signalBox, borderColor: TONE[sel.sig.tone] }}>
              <div style={S.signalTop}>
                <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                  <span style={{ ...S.signalIcon, background: TONE[sel.sig.tone] }}>
                    {sel.sig.verdict === "AL" ? "↗" : sel.sig.verdict === "SAT" ? "↘" : "→"}
                  </span>
                  <div>
                    <div style={{ fontSize: 18, fontWeight: 800, color: TONE[sel.sig.tone] }}>{sel.sig.verdict} SİNYALİ</div>
                    <div style={{ fontSize: 11, color: "#7a8190" }}>
                      Güven: {sel.sig.confidence.toUpperCase()} (%{Math.round(sel.sig.strength * 100)})
                    </div>
                  </div>
                </div>
                <div style={{ textAlign: "right" }}>
                  <div style={{ fontSize: 10, color: "#7a8190", letterSpacing: 1 }}>ZAMAN UYUMU</div>
                  <div style={{ fontSize: 12, fontWeight: 700, color: sel.mtf ? TONE[sel.mtf.atone] : "#7a8190" }}>
                    {sel.mtf ? `${sel.mtf.align} (${sel.mtf.agree}/${sel.mtf.total})` : "—"}
                  </div>
                </div>
              </div>

              {/* Renkli güven çubuğu */}
              <div style={S.barTrack}>
                <div style={{ ...S.barFill, width: `${Math.round(sel.sig.strength * 100)}%`,
                  background: CONF_COLOR[sel.sig.confidence] }} />
              </div>

              {/* Basit fiyat grafiği (sparkline) */}
              <Sparkline closes={sel.closes} up={sel.change >= 0} />

              {sel.sig.dir !== 0 && (
                <div style={S.tpGrid}>
                  <div style={S.tpCell}><div style={S.tpKey}>Giriş</div><div style={S.tpVal}>{fmtPrice(sel.sig.price)}</div></div>
                  <div style={S.tpCell}><div style={S.tpKey}>Stop-Loss</div><div style={{ ...S.tpVal, color: "#ff4d6d" }}>{fmtPrice(sel.sig.stop)}</div></div>
                  <div style={S.tpCell}><div style={S.tpKey}>Hedef 1</div><div style={{ ...S.tpVal, color: "#00e08a" }}>{fmtPrice(sel.sig.tp1)}</div></div>
                  <div style={S.tpCell}><div style={S.tpKey}>Hedef 2</div><div style={{ ...S.tpVal, color: "#00e08a" }}>{fmtPrice(sel.sig.tp2)}</div></div>
                  <div style={S.tpCell}><div style={S.tpKey}>Risk/Ödül</div><div style={S.tpVal}>1 : {sel.sig.rr}</div></div>
                </div>
              )}

              <div style={S.reasonsTitle}>Sinyal Nedenleri</div>
              <div style={S.reasonsGrid}>
                {sel.sig.reasons.map((r, i) => (
                  <div key={i} style={S.reasonItem}>
                    <span style={{ color: r.includes("aşırı satım") || r.includes("yukarı") || r.includes("pozitif") || r.includes("alt Bollinger") ? "#00e08a" : "#7a8190" }}>•</span> {r}
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}
          </>)}

          {/* ===== İZLEME SEKMESİ ===== */}
          {tab === "izleme" && (<>
        {/* İzleme listesi */}
        <div style={S.card}>
          <div style={S.cardHead}>İZLEME LİSTESİ ({watch.length})</div>
          <div style={S.filterBar}>
            <span style={S.filterLabel}>Sırala:</span>
            {[["default","Varsayılan"],["strong","En güçlü"],["alpha","A-Z"]].map(([v,l]) => (
              <button key={v} className="chip" onClick={() => setSortMode(v)}
                style={{ ...S.filterChip, borderColor: sortMode === v ? "#5b8def" : "#23262f", color: sortMode === v ? "#5b8def" : "#9098a6" }}>{l}</button>
            ))}
          </div>
          <div style={S.filterBar}>
            <span style={S.filterLabel}>Filtre:</span>
            {[["all","Hepsi"],["buy","AL"],["sell","SAT"],["strong","Güçlü"]].map(([v,l]) => {
              const col = v === "buy" ? "#00e08a" : v === "sell" ? "#ff4d6d" : "#f0c040";
              return (<button key={v} className="chip" onClick={() => setFilterMode(v)}
                style={{ ...S.filterChip, borderColor: filterMode === v ? col : "#23262f", color: filterMode === v ? col : "#9098a6" }}>{l}</button>);
            })}
          </div>
          {watch.length === 0 && <div style={S.muted}>Aşağıdan coin ekle.</div>}
          {watch.length > 0 && displayList.length === 0 && <div style={S.muted}>Bu filtreye uyan coin yok.</div>}
          {displayList.map(({ base, d }) => (
            <div key={base} className="row" style={S.lrow} onClick={() => setSelected(base)}>
              <div style={{ flex: "0 0 84px", fontWeight: 700, color: selected === base ? "#5b8def" : "#e7eaf0", display: "flex", alignItems: "center", gap: 7 }}>
                <CoinLogo base={base} size={20} />{base}
              </div>
              <div style={{ flex: 1, color: "#c9cfd9" }}>{d?.error ? "—" : fmtPrice(d?.price)}</div>
              <div style={{ flex: "0 0 60px", textAlign: "right", color: !d || d.error ? "#5a606e" : d.change >= 0 ? "#00e08a" : "#ff4d6d" }}>
                {d && !d.error ? `${d.change >= 0 ? "+" : ""}${d.change.toFixed(2)}%` : ""}
              </div>
              <div style={{ flex: "0 0 54px", textAlign: "right" }}>
                {d?.sig && <span style={{ ...S.badge, color: TONE[d.sig.tone], borderColor: TONE[d.sig.tone] }}>{d.sig.verdict}</span>}
              </div>
              <button onClick={(e) => { e.stopPropagation(); remove(base); }} style={S.removeBtn} className="chip">✕</button>
            </div>
          ))}
        </div>

        {/* Coin ekle */}
        <div style={S.card}>
          <div style={S.cardHead}>COIN ARA VE EKLE (Binance · MEXC · Gate · Bybit)</div>
          <div style={{ display: "flex", gap: 8 }}>
            <input value={search} onChange={(e) => setSearch(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && tryAdd()}
              placeholder="Coin sembolü yaz (örn. WIF, PEPE)…" style={{ ...S.input, marginBottom: 0, flex: 1 }} />
            <button className="chip" onClick={tryAdd} disabled={adding} style={{ ...S.addBtn, opacity: adding ? 0.6 : 1 }}>
              {adding ? "…" : "+ Ekle"}
            </button>
          </div>
          {addMsg && <div style={{ ...S.muted, marginTop: 8 }}>{addMsg}</div>}
        </div>
          </>)}

          {/* ===== ARAÇLAR SEKMESİ ===== */}
          {tab === "araclar" && (<>
        <RiskScanner />

        <RiskCalc />

        <LeverageSim />
          </>)}

          {/* ===== AYARLAR SEKMESİ ===== */}
          {tab === "ayarlar" && (<>
        <TelegramSetup />

        <div style={S.disclaimer}>
          Bu araç teknik göstergeleri (RSI, EMA, MACD, Bollinger) birleştirir; güven skoru, zaman
          uyumu, stop-loss ve hedefler oynaklığa dayalı hesaplardır — geleceğin garantisi değildir.
          Veriler Binance, MEXC, Gate.io ve Bybit'in halka açık fiyatlarındandır. Sinyaller yanılabilir,
          bu bir yatırım tavsiyesi değildir. Küçük/düşük hacimli coinlerde göstergeler güvenilmezdir.
          Kararı ve işlemi sen kendi hesabında verirsin; risk yönetimi belirleyicidir.
        </div>
          </>)}
          </div>{/* content */}
        </div>{/* layout */}

        {/* Alt menü (telefon) */}
        <nav className="bottomnav">
          {TABS.map((t) => (
            <button key={t.id} className="navbtn" onClick={() => setTab(t.id)}
              style={tab === t.id ? { color: "#5b8def" } : {}}>
              <span className="ico">{t.icon}</span>{t.label}
            </button>
          ))}
        </nav>
      </div>
    </div>
  );
}

const S = {
  page: { minHeight: "100vh", width: "100%", background: "radial-gradient(circle at 50% 0%, #11151d 0%, #080a0e 55%)",
    color: "#e7eaf0", fontFamily: "'SF Mono','Menlo','Consolas',monospace", padding: "20px 16px", boxSizing: "border-box" },
  shell: { margin: "0 auto", width: "100%" },
  header: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 },
  kicker: { fontSize: 9, letterSpacing: 2, color: "#5b8def", marginBottom: 2 },
  title: { fontSize: 20, fontWeight: 700, margin: 0, letterSpacing: -0.5, color: "#e7eaf0" },
  liveBox: { display: "flex", alignItems: "center", gap: 8 },
  chipSm: { background: "#11151d", border: "1px solid #23262f", borderRadius: 8, padding: "6px 12px", fontSize: 12, fontWeight: 600 },
  strip: { minWidth: 130, background: "linear-gradient(180deg,#11151d,#0c0f15)", border: "1px solid #1a1e27",
    borderRadius: 12, padding: "12px 14px", flexShrink: 0 },
  card: { background: "linear-gradient(180deg,#11151d,#0b0e13)", border: "1px solid #1a1e27", borderRadius: 16, padding: 16, marginBottom: 14 },
  cardHead: { fontSize: 10, letterSpacing: 1.5, color: "#7a8190", marginBottom: 10 },
  moGrid: { display: "flex", flexWrap: "wrap", gap: 12 },
  moCell: { flex: "1 1 140px", background: "#0a0d12", border: "1px solid #1a1e27", borderRadius: 10, padding: "12px 14px" },
  moKey: { fontSize: 10.5, color: "#7a8190", marginBottom: 6, letterSpacing: 0.3 },
  moBarTrack: { height: 5, background: "#1a1e27", borderRadius: 3, marginTop: 7, overflow: "hidden" },
  moBarFill: { height: "100%", borderRadius: 3, transition: "width .4s ease" },
  moLoad: { fontSize: 18, color: "#3a3f4b" },
  trendChip: { fontSize: 11.5, fontWeight: 700, color: "#f0a030", background: "rgba(240,160,48,0.1)",
    border: "1px solid rgba(240,160,48,0.3)", borderRadius: 6, padding: "3px 9px" },
  riskStats: { display: "flex", flexWrap: "wrap", gap: 8 },
  riskStat: { flex: "1 1 100px", background: "#0a0d12", border: "1px solid #1a1e27", borderRadius: 8, padding: "8px 11px" },
  riskStatKey: { display: "block", fontSize: 10, color: "#7a8190", marginBottom: 3 },
  riskStatVal: { fontSize: 14, fontWeight: 700 },
  selHead: { display: "flex", justifyContent: "space-between", alignItems: "flex-start" },
  exTag: { fontSize: 9.5, fontWeight: 700, border: "1px solid", borderRadius: 5, padding: "1px 6px", marginLeft: 8, letterSpacing: 0.5 },
  chartLabel: { fontSize: 10, marginBottom: 4 },
  subLabel: { fontSize: 10, color: "#7a8190", margin: "10px 0 2px", letterSpacing: 1 },
  signalBox: { border: "2px solid", borderRadius: 14, padding: 16, marginTop: 16, background: "#0b0e13" },
  signalTop: { display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 14 },
  barTrack: { height: 8, background: "#1a1e27", borderRadius: 4, overflow: "hidden", marginBottom: 4 },
  barFill: { height: "100%", borderRadius: 4, transition: "width .4s ease" },
  signalIcon: { width: 40, height: 40, borderRadius: "50%", display: "flex", alignItems: "center", justifyContent: "center",
    fontSize: 20, color: "#0b0e13", fontWeight: 900 },
  tpGrid: { display: "flex", flexWrap: "wrap", gap: 8, padding: "12px 0", borderTop: "1px solid #1a1e27", borderBottom: "1px solid #1a1e27" },
  tpCell: { flex: "1 1 80px", textAlign: "center" },
  tpKey: { fontSize: 9.5, color: "#7a8190", marginBottom: 3, letterSpacing: 0.5 },
  tpVal: { fontSize: 13, fontWeight: 700 },
  reasonsTitle: { fontSize: 11, color: "#9098a6", margin: "14px 0 8px", fontWeight: 700 },
  reasonsGrid: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: "6px 14px" },
  reasonItem: { fontSize: 12, color: "#c9cfd9" },
  signalNote: { fontSize: 10.5, color: "#5a606e", marginTop: 12, lineHeight: 1.5, fontFamily: "system-ui,sans-serif" },
  filterBar: { display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap", marginBottom: 8 },
  filterLabel: { fontSize: 11, color: "#5a606e", minWidth: 42 },
  filterChip: { background: "#11151d", border: "1px solid #23262f", borderRadius: 7, padding: "4px 11px", fontSize: 11.5, fontWeight: 600, cursor: "pointer", fontFamily: "inherit" },
  lrow: { display: "flex", alignItems: "center", padding: "11px 8px", borderRadius: 8, fontSize: 14, gap: 4, cursor: "pointer" },
  badge: { fontSize: 11, fontWeight: 800, letterSpacing: 1, border: "1px solid", borderRadius: 6, padding: "2px 8px" },
  removeBtn: { flex: "0 0 auto", background: "rgba(255,77,109,0.10)", border: "1px solid #ff4d6d", color: "#ff4d6d",
    borderRadius: 7, padding: "5px 10px", fontSize: 12, fontWeight: 700, cursor: "pointer", marginLeft: 8 },
  addBtn: { background: "rgba(0,224,138,0.12)", border: "1px solid #00e08a", color: "#00e08a", borderRadius: 8,
    padding: "0 16px", fontSize: 13, fontWeight: 700, cursor: "pointer", whiteSpace: "nowrap" },
  input: { width: "100%", boxSizing: "border-box", background: "#0a0d12", border: "1px solid #23262f", borderRadius: 8,
    padding: "10px 12px", color: "#e7eaf0", fontSize: 13, marginBottom: 12 },
  muted: { color: "#7a8190", fontSize: 12.5, lineHeight: 1.5 },
  disclaimer: { marginTop: 14, fontSize: 11, lineHeight: 1.6, color: "#5a606e", fontFamily: "system-ui,sans-serif" },
};
const RS = {
  row: { display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 12 },
  label: { fontSize: 11, color: "#7a8190", marginBottom: 4 },
  input: { width: "100%", boxSizing: "border-box", background: "#0a0d12", border: "1px solid #23262f", borderRadius: 8, padding: "9px 11px", color: "#e7eaf0", fontSize: 14 },
  results: { background: "#0a0d12", borderRadius: 10, padding: "8px 14px", marginTop: 4 },
  resRow: { display: "flex", justifyContent: "space-between", padding: "7px 0", borderBottom: "1px solid #15191f", fontSize: 13.5 },
  resKey: { color: "#9098a6" }, resVal: { fontWeight: 700, color: "#e7eaf0" },
  hint: { fontSize: 11, lineHeight: 1.6, color: "#5a606e", marginTop: 12, fontFamily: "system-ui,sans-serif" },
};
