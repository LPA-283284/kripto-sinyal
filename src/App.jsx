import { useState, useEffect, useCallback, useRef } from "react";

const ALL_COINS = [
  ["BTCUSDT", "BTC"], ["ETHUSDT", "ETH"], ["SOLUSDT", "SOL"], ["BNBUSDT", "BNB"],
  ["XRPUSDT", "XRP"], ["DOGEUSDT", "DOGE"], ["ADAUSDT", "ADA"], ["AVAXUSDT", "AVAX"],
  ["LINKUSDT", "LINK"], ["DOTUSDT", "DOT"], ["MATICUSDT", "MATIC"], ["LTCUSDT", "LTC"],
  ["TRXUSDT", "TRX"], ["SHIBUSDT", "SHIB"], ["ATOMUSDT", "ATOM"], ["UNIUSDT", "UNI"],
  ["NEARUSDT", "NEAR"], ["APTUSDT", "APT"], ["FILUSDT", "FIL"], ["ARBUSDT", "ARB"],
].map(([sym, label]) => ({ sym, label }));

const INTERVALS = [
  { v: "15m", label: "15dk" }, { v: "1h", label: "1sa" },
  { v: "4h", label: "4sa" }, { v: "1d", label: "1gün" },
];

function calcRSI(c, p = 14) {
  if (c.length < p + 1) return null;
  let g = 0, l = 0;
  for (let i = c.length - p; i < c.length; i++) {
    const d = c[i] - c[i - 1];
    if (d >= 0) g += d; else l -= d;
  }
  const aL = l / p;
  if (aL === 0) return 100;
  return 100 - 100 / (1 + g / p / aL);
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
function calcBollinger(c, p = 20) {
  if (c.length < p) return null;
  const slice = c.slice(-p);
  const mean = slice.reduce((a, b) => a + b, 0) / p;
  const sd = Math.sqrt(slice.reduce((a, b) => a + (b - mean) ** 2, 0) / p);
  const upper = mean + 2 * sd, lower = mean - 2 * sd;
  const price = c[c.length - 1];
  let pos = "orta";
  if (price > upper) pos = "üst bant üstü"; else if (price < lower) pos = "alt bant altı";
  return { upper, lower, mean, pos, price };
}

function buildSignal(c) {
  const rsi = calcRSI(c), fast = ema(c, 9), slow = ema(c, 21);
  const macd = calcMACD(c), boll = calcBollinger(c);
  if (rsi == null || fast == null || slow == null) return null;
  let score = 0;
  const reasons = [];
  if (rsi < 30) { score += 2; reasons.push(`RSI ${rsi.toFixed(0)} — aşırı satım`); }
  else if (rsi > 70) { score -= 2; reasons.push(`RSI ${rsi.toFixed(0)} — aşırı alım`); }
  else reasons.push(`RSI ${rsi.toFixed(0)} — nötr`);
  if (fast > slow) { score += 1; reasons.push("EMA9 > EMA21 — yukarı eğilim"); }
  else { score -= 1; reasons.push("EMA9 < EMA21 — aşağı eğilim"); }
  if (macd) {
    if (macd.bullish && macd.rising) { score += 1; reasons.push("MACD pozitif ve yükseliyor"); }
    else if (!macd.bullish && !macd.rising) { score -= 1; reasons.push("MACD negatif ve düşüyor"); }
    else reasons.push("MACD kararsız");
  }
  if (boll) {
    if (boll.pos === "alt bant altı") { score += 1; reasons.push("Fiyat alt Bollinger bandının altında"); }
    else if (boll.pos === "üst bant üstü") { score -= 1; reasons.push("Fiyat üst Bollinger bandının üstünde"); }
    else reasons.push(`Bollinger: ${boll.pos}`);
  }
  let verdict, tone;
  if (score >= 3) { verdict = "AL"; tone = "buy"; }
  else if (score <= -3) { verdict = "SAT"; tone = "sell"; }
  else { verdict = "BEKLE"; tone = "hold"; }
  return { rsi, verdict, tone, reasons, score };
}

async function fetchCoin(sym, interval) {
  const url = `https://api.binance.com/api/v3/klines?symbol=${sym}&interval=${interval}&limit=100`;
  const res = await fetch(url);
  if (!res.ok) throw new Error("fail");
  const raw = await res.json();
  const closes = raw.map((k) => parseFloat(k[4]));
  const price = closes[closes.length - 1];
  const prev = closes[closes.length - 2];
  return { closes, price, change: ((price - prev) / prev) * 100, sig: buildSignal(closes) };
}

const TONE = { buy: "#00e08a", sell: "#ff4d6d", hold: "#f0c040" };

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

// ── Risk hesaplayıcı ───────────────────────────────────────
function RiskCalc() {
  const [capital, setCapital] = useState("1000");
  const [riskPct, setRiskPct] = useState("2");
  const [entry, setEntry] = useState("");
  const [stop, setStop] = useState("");
  const [target, setTarget] = useState("");

  const cap = parseFloat(capital) || 0;
  const rp = parseFloat(riskPct) || 0;
  const e = parseFloat(entry) || 0;
  const s = parseFloat(stop) || 0;
  const t = parseFloat(target) || 0;

  const riskAmount = cap * (rp / 100);            // riske atılan para
  const perUnitRisk = e && s ? Math.abs(e - s) : 0; // birim başına zarar
  const lossPct = e && s ? (Math.abs(e - s) / e) * 100 : 0;
  const positionSize = perUnitRisk ? riskAmount / perUnitRisk : 0; // kaç birim
  const positionValue = positionSize * e;
  const rewardPerUnit = e && t ? Math.abs(t - e) : 0;
  const rr = perUnitRisk && rewardPerUnit ? rewardPerUnit / perUnitRisk : 0;

  const fld = (label, val, set, ph) => (
    <div style={{ flex: "1 1 130px" }}>
      <div style={RS.label}>{label}</div>
      <input value={val} onChange={(ev) => set(ev.target.value)} placeholder={ph}
        inputMode="decimal" style={RS.input} />
    </div>
  );

  return (
    <div style={S.card}>
      <div style={S.cardHead}>RİSK HESAPLAYICI</div>
      <div style={RS.row}>
        {fld("Sermaye ($)", capital, setCapital, "1000")}
        {fld("Risk %", riskPct, setRiskPct, "2")}
      </div>
      <div style={RS.row}>
        {fld("Giriş fiyatı", entry, setEntry, "0.00")}
        {fld("Stop-loss", stop, setStop, "0.00")}
        {fld("Hedef (ops.)", target, setTarget, "0.00")}
      </div>

      <div style={RS.results}>
        <div style={RS.resRow}>
          <span style={RS.resKey}>Riske atılan para</span>
          <span style={RS.resVal}>${riskAmount.toFixed(2)}</span>
        </div>
        {perUnitRisk > 0 && (
          <>
            <div style={RS.resRow}>
              <span style={RS.resKey}>Stop mesafesi</span>
              <span style={RS.resVal}>{lossPct.toFixed(2)}%</span>
            </div>
            <div style={RS.resRow}>
              <span style={RS.resKey}>Alınacak miktar</span>
              <span style={RS.resVal}>{positionSize.toLocaleString("en-US", { maximumFractionDigits: 4 })} birim</span>
            </div>
            <div style={RS.resRow}>
              <span style={RS.resKey}>Pozisyon değeri</span>
              <span style={RS.resVal}>${positionValue.toFixed(2)}</span>
            </div>
          </>
        )}
        {rr > 0 && (
          <div style={RS.resRow}>
            <span style={RS.resKey}>Risk / Ödül</span>
            <span style={{ ...RS.resVal, color: rr >= 2 ? "#00e08a" : rr >= 1 ? "#f0c040" : "#ff4d6d" }}>
              1 : {rr.toFixed(2)}
            </span>
          </div>
        )}
      </div>
      <div style={RS.hint}>
        Genel kural: tek işlemde sermayenin %1–2'sinden fazlasını riske atma.
        Risk/Ödül oranı en az 1:2 olan işlemler tercih edilir. Bunlar kesin
        kural değil, sadece disiplin için referans.
      </div>
    </div>
  );
}

export default function App() {
  const [watch, setWatch] = useState(["BTCUSDT", "ETHUSDT", "SOLUSDT"]);
  const [interval, setIntervalSel] = useState(INTERVALS[1]);
  const [rows, setRows] = useState({});
  const [search, setSearch] = useState("");
  const [soundOn, setSoundOn] = useState(true);
  const [lastUpdate, setLastUpdate] = useState(null);
  const [flash, setFlash] = useState(null);
  const prevVerdicts = useRef({});
  const timerRef = useRef(null);

  const loadAll = useCallback(async () => {
    const results = {};
    await Promise.all(
      watch.map(async (sym) => {
        try { results[sym] = await fetchCoin(sym, interval.v); }
        catch { results[sym] = { error: true }; }
      })
    );
    Object.entries(results).forEach(([sym, d]) => {
      if (d.sig) {
        const prev = prevVerdicts.current[sym];
        if (prev && prev !== d.sig.verdict && d.sig.verdict !== "BEKLE") {
          setFlash({ sym, verdict: d.sig.verdict, tone: d.sig.tone });
          if (soundOn) beep(d.sig.tone);
          setTimeout(() => setFlash(null), 4000);
        }
        prevVerdicts.current[sym] = d.sig.verdict;
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

  const toggle = (sym) =>
    setWatch((w) => (w.includes(sym) ? w.filter((s) => s !== sym) : [...w, sym]));

  const filtered = ALL_COINS.filter((c) =>
    c.label.toLowerCase().includes(search.toLowerCase())
  );

  const fmt = (p) => p == null ? "—" :
    `$${p.toLocaleString("en-US", { maximumFractionDigits: p < 1 ? 6 : p < 100 ? 3 : 2 })}`;

  return (
    <div style={S.page}>
      <style>{`
        *{box-sizing:border-box}
        html,body,#root{margin:0;padding:0;width:100%;min-height:100%;
          background:#0a0c11;color:#e7eaf0;}
        @keyframes pulse{0%,100%{opacity:1}50%{opacity:.4}}
        @keyframes slideIn{from{transform:translateY(-20px);opacity:0}to{transform:translateY(0);opacity:1}}
        .live-dot{width:7px;height:7px;border-radius:50%;background:#00e08a;animation:pulse 1.6s infinite}
        .chip{transition:all .15s ease;cursor:pointer;font-family:inherit}
        .chip:hover{border-color:#3a3f4b}
        .row{transition:background .15s ease}
        .row:hover{background:#181c25}
        input{font-family:inherit}
        input:focus{outline:none;border-color:#5b8def}
        .detail-grid{display:grid;gap:12px;grid-template-columns:1fr;}
        @media(min-width:760px){.detail-grid{grid-template-columns:1fr 1fr;}}
        @media(min-width:1100px){.detail-grid{grid-template-columns:1fr 1fr 1fr;}}
      `}</style>

      <div style={S.shell}>
        <header style={S.header}>
          <div>
            <div style={S.kicker}>KRİPTO SİNYAL PANELİ · PRO</div>
            <h1 style={S.title}>Sinyal Terminali</h1>
          </div>
          <div style={S.liveBox}>
            <span className="live-dot" />
            <span style={{ fontSize: 11, color: "#7a8190" }}>
              {lastUpdate ? lastUpdate.toLocaleTimeString("tr-TR") : "…"}
            </span>
          </div>
        </header>

        <div style={S.controls}>
          <div style={S.chipRow}>
            {INTERVALS.map((i) => (
              <button key={i.v} className="chip" onClick={() => setIntervalSel(i)}
                style={{ ...S.chipSm, borderColor: interval.v === i.v ? "#5b8def" : "#23262f",
                  color: interval.v === i.v ? "#5b8def" : "#9098a6" }}>
                {i.label}
              </button>
            ))}
          </div>
          <button className="chip" onClick={() => setSoundOn((s) => !s)}
            style={{ ...S.chipSm, borderColor: soundOn ? "#00e08a" : "#23262f",
              color: soundOn ? "#00e08a" : "#7a8190" }}>
            {soundOn ? "🔔 Ses açık" : "🔕 Ses kapalı"}
          </button>
        </div>

        {flash && (
          <div style={{ ...S.flash, borderColor: TONE[flash.tone], color: TONE[flash.tone] }}>
            ⚡ Yeni sinyal: {ALL_COINS.find((c) => c.sym === flash.sym)?.label} → {flash.verdict}
          </div>
        )}

        <div style={S.card}>
          <div style={S.cardHead}>İZLEME LİSTESİ</div>
          {watch.length === 0 && <div style={S.muted}>Aşağıdan coin ekle.</div>}
          {watch.map((sym) => {
            const d = rows[sym];
            const label = ALL_COINS.find((c) => c.sym === sym)?.label || sym;
            return (
              <div key={sym} className="row" style={S.row}>
                <div style={{ flex: "0 0 56px", fontWeight: 700 }}>{label}</div>
                <div style={{ flex: 1, color: "#c9cfd9" }}>{d?.error ? "—" : fmt(d?.price)}</div>
                <div style={{ flex: "0 0 70px", textAlign: "right",
                  color: !d || d.error ? "#5a606e" : d.change >= 0 ? "#00e08a" : "#ff4d6d" }}>
                  {d && !d.error ? `${d.change >= 0 ? "+" : ""}${d.change.toFixed(2)}%` : ""}
                </div>
                <div style={{ flex: "0 0 64px", textAlign: "right" }}>
                  {d?.sig && (
                    <span style={{ ...S.badge, color: TONE[d.sig.tone], borderColor: TONE[d.sig.tone] }}>
                      {d.sig.verdict}
                    </span>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        <div className="detail-grid">
          {watch.map((sym) => {
            const d = rows[sym];
            if (!d?.sig) return null;
            const label = ALL_COINS.find((c) => c.sym === sym)?.label || sym;
            return (
              <div key={sym} style={S.detail}>
                <div style={S.detailHead}>
                  <span style={{ fontWeight: 700 }}>{label}/USDT</span>
                  <span style={{ ...S.badge, color: TONE[d.sig.tone], borderColor: TONE[d.sig.tone] }}>
                    {d.sig.verdict}
                  </span>
                </div>
                <ul style={S.reasons}>
                  {d.sig.reasons.map((r, i) => <li key={i} style={S.reasonItem}>· {r}</li>)}
                </ul>
              </div>
            );
          })}
        </div>

        <RiskCalc />

        <div style={S.card}>
          <div style={S.cardHead}>COIN EKLE / ÇIKAR</div>
          <input value={search} onChange={(e) => setSearch(e.target.value)}
            placeholder="Ara… (örn. SOL)" style={S.input} />
          <div style={S.grid}>
            {filtered.map((c) => (
              <button key={c.sym} className="chip" onClick={() => toggle(c.sym)}
                style={{ ...S.gridChip, borderColor: watch.includes(c.sym) ? "#00e08a" : "#23262f",
                  color: watch.includes(c.sym) ? "#00e08a" : "#9098a6" }}>
                {watch.includes(c.sym) ? "✓ " : ""}{c.label}
              </button>
            ))}
          </div>
        </div>

        <div style={S.disclaimer}>
          Bu araç yalnızca eğitim amaçlıdır. Sinyaller basit teknik göstergelere
          (RSI, EMA, MACD, Bollinger) dayanır, yatırım tavsiyesi değildir ve
          yanılabilir. Hesabına bağlanmaz, emir vermez — kararı ve işlemi sen
          kendi hesabında verirsin. Kaybetmeyi göze alamayacağın parayla işlem yapma.
        </div>
      </div>
    </div>
  );
}

const S = {
  page: { minHeight: "100vh", width: "100%",
    background: "radial-gradient(circle at 50% 0%, #14171f 0%, #0a0c11 55%)",
    color: "#e7eaf0", fontFamily: "'SF Mono','Menlo','Consolas',monospace",
    padding: "28px 20px", boxSizing: "border-box" },
  shell: { maxWidth: 1280, margin: "0 auto", width: "100%" },
  header: { display: "flex", justifyContent: "space-between", alignItems: "flex-end", marginBottom: 18 },
  kicker: { fontSize: 10, letterSpacing: 2, color: "#5b8def", marginBottom: 4 },
  title: { fontSize: 26, fontWeight: 700, margin: 0, letterSpacing: -0.5 },
  liveBox: { display: "flex", alignItems: "center", gap: 6 },
  controls: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14, flexWrap: "wrap", gap: 8 },
  chipRow: { display: "flex", gap: 6 },
  chipSm: { background: "#14171f", border: "1px solid #23262f", borderRadius: 8, padding: "6px 14px", fontSize: 12 },
  flash: { border: "2px solid", borderRadius: 10, padding: "10px 14px", marginBottom: 14, fontSize: 14, fontWeight: 700, animation: "slideIn .3s ease" },
  card: { background: "linear-gradient(180deg,#14171f,#10131a)", border: "1px solid #23262f", borderRadius: 16, padding: 18, marginBottom: 14, maxWidth: 720 },
  cardHead: { fontSize: 10, letterSpacing: 1.5, color: "#7a8190", marginBottom: 10 },
  row: { display: "flex", alignItems: "center", padding: "11px 8px", borderRadius: 8, fontSize: 14 },
  badge: { fontSize: 11, fontWeight: 800, letterSpacing: 1, border: "1px solid", borderRadius: 6, padding: "2px 8px" },
  detail: { background: "#10131a", border: "1px solid #1c2029", borderRadius: 12, padding: 16 },
  detailHead: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 },
  reasons: { margin: 0, padding: 0, listStyle: "none" },
  reasonItem: { fontSize: 12.5, color: "#9098a6", padding: "4px 0", textAlign: "left" },
  input: { width: "100%", boxSizing: "border-box", background: "#0c0e13", border: "1px solid #23262f",
    borderRadius: 8, padding: "10px 12px", color: "#e7eaf0", fontSize: 13, marginBottom: 12 },
  grid: { display: "flex", flexWrap: "wrap", gap: 6 },
  gridChip: { background: "#14171f", border: "1px solid #23262f", borderRadius: 8, padding: "7px 13px", fontSize: 12.5, fontWeight: 600 },
  muted: { color: "#7a8190", fontSize: 13 },
  disclaimer: { marginTop: 18, fontSize: 11, lineHeight: 1.6, color: "#5a606e", fontFamily: "system-ui,sans-serif", maxWidth: 720 },
};

const RS = {
  row: { display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 12 },
  label: { fontSize: 11, color: "#7a8190", marginBottom: 4 },
  input: { width: "100%", boxSizing: "border-box", background: "#0c0e13", border: "1px solid #23262f",
    borderRadius: 8, padding: "9px 11px", color: "#e7eaf0", fontSize: 14 },
  results: { background: "#0c0e13", borderRadius: 10, padding: "8px 14px", marginTop: 4 },
  resRow: { display: "flex", justifyContent: "space-between", padding: "7px 0", borderBottom: "1px solid #181c25", fontSize: 13.5 },
  resKey: { color: "#9098a6" },
  resVal: { fontWeight: 700, color: "#e7eaf0" },
  hint: { fontSize: 11, lineHeight: 1.6, color: "#5a606e", marginTop: 12, fontFamily: "system-ui,sans-serif" },
};
