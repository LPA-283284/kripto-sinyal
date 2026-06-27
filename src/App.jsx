import { useState, useEffect, useCallback, useRef } from "react";

const INTERVALS = [
  { v: "15m", label: "15dk" }, { v: "1h", label: "1sa" },
  { v: "4h", label: "4sa" }, { v: "1d", label: "1gün" },
];
const MTF = ["1h", "4h", "1d"];
const STORAGE_KEY = "kripto_watch_v2";

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
  const prevVerdicts = useRef({});
  const timerRef = useRef(null);

  useEffect(() => { try { localStorage.setItem(STORAGE_KEY, JSON.stringify(watch)); } catch (e) {} }, [watch]);

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
      `}</style>

      <div style={S.shell}>
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

        {/* Üst coin şeritleri */}
        <div className="strip-scroll" style={{ marginBottom: 16 }}>
          {watch.map((base) => {
            const d = rows[base];
            const up = d && !d.error && d.change >= 0;
            return (
              <div key={base} className="strip" onClick={() => setSelected(base)}
                style={{ ...S.strip, borderColor: selected === base ? "#5b8def" : "#1a1e27" }}>
                <div style={{ fontSize: 12, color: "#9098a6", fontWeight: 700 }}>{base}/USDT</div>
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
              <div>
                <span style={{ fontSize: 20, fontWeight: 700 }}>{selected}/USDT</span>
                {sel.ex && <span style={{ ...S.exTag, color: EX_COLOR[sel.ex] || "#9098a6", borderColor: EX_COLOR[sel.ex] || "#23262f" }}>{sel.ex}</span>}
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
              <div style={S.signalNote}>
                Bu değerler (stop/hedef) coinin oynaklığına göre hesaplanır; geleceğin garantisi
                değildir. Sinyal yanılabilir, yatırım tavsiyesi değildir.
              </div>
            </div>
          </div>
        )}

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
              <div style={{ flex: "0 0 64px", fontWeight: 700, color: selected === base ? "#5b8def" : "#e7eaf0" }}>{base}</div>
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

        <RiskCalc />

        <div style={S.disclaimer}>
          Bu araç teknik göstergeleri (RSI, EMA, MACD, Bollinger) birleştirir; güven skoru, zaman
          uyumu, stop-loss ve hedefler oynaklığa dayalı hesaplardır — geleceğin garantisi değildir.
          Veriler Binance, MEXC, Gate.io ve Bybit'in halka açık fiyatlarındandır. Sinyaller yanılabilir,
          bu bir yatırım tavsiyesi değildir. Küçük/düşük hacimli coinlerde göstergeler güvenilmezdir.
          Kararı ve işlemi sen kendi hesabında verirsin; risk yönetimi belirleyicidir.
        </div>
      </div>
    </div>
  );
}

const S = {
  page: { minHeight: "100vh", width: "100%", background: "radial-gradient(circle at 50% 0%, #11151d 0%, #080a0e 55%)",
    color: "#e7eaf0", fontFamily: "'SF Mono','Menlo','Consolas',monospace", padding: "20px 16px", boxSizing: "border-box" },
  shell: { maxWidth: 760, margin: "0 auto", width: "100%" },
  header: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 },
  kicker: { fontSize: 9, letterSpacing: 2, color: "#5b8def", marginBottom: 2 },
  title: { fontSize: 20, fontWeight: 700, margin: 0, letterSpacing: -0.5 },
  liveBox: { display: "flex", alignItems: "center", gap: 8 },
  chipSm: { background: "#11151d", border: "1px solid #23262f", borderRadius: 8, padding: "6px 12px", fontSize: 12, fontWeight: 600 },
  strip: { minWidth: 130, background: "linear-gradient(180deg,#11151d,#0c0f15)", border: "1px solid #1a1e27",
    borderRadius: 12, padding: "12px 14px", flexShrink: 0 },
  card: { background: "linear-gradient(180deg,#11151d,#0b0e13)", border: "1px solid #1a1e27", borderRadius: 16, padding: 16, marginBottom: 14 },
  cardHead: { fontSize: 10, letterSpacing: 1.5, color: "#7a8190", marginBottom: 10 },
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
