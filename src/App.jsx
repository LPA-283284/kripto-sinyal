import { useState, useEffect, useCallback, useRef } from "react";

const INTERVALS = [
  { v: "15m", label: "15dk" }, { v: "1h", label: "1sa" },
  { v: "4h", label: "4sa" }, { v: "1d", label: "1gün" },
];
const MTF = ["1h", "4h", "1d"];
const STORAGE_KEY = "kripto_watch_v1";

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
  let stop = null;
  if (vol != null) {
    if (score > 0) stop = price - 1.5 * vol;
    else if (score < 0) stop = price + 1.5 * vol;
  }
  return { rsi, verdict, tone, reasons, score, confidence, strength, price, stop, dir: Math.sign(score) };
}

async function fetchCloses(sym, interval) {
  const url = `https://api.binance.com/api/v3/klines?symbol=${sym}&interval=${interval}&limit=100`;
  const res = await fetch(url);
  if (!res.ok) throw new Error("fail");
  const raw = await res.json();
  return raw.map((k) => parseFloat(k[4]));
}

async function fetchCoin(sym, interval) {
  const closes = await fetchCloses(sym, interval);
  const price = closes[closes.length - 1];
  const prev = closes[closes.length - 2];
  const sig = buildSignal(closes);
  let mtf = null;
  try {
    const dirs = await Promise.all(
      MTF.map(async (iv) => {
        const cc = await fetchCloses(sym, iv);
        const s = buildSignal(cc);
        return s ? s.dir : 0;
      })
    );
    const ups = dirs.filter((d) => d > 0).length;
    const downs = dirs.filter((d) => d < 0).length;
    let align = "karışık", atone = "hold";
    if (ups === MTF.length) { align = "hepsi yukarı"; atone = "buy"; }
    else if (downs === MTF.length) { align = "hepsi aşağı"; atone = "sell"; }
    else if (ups > downs) { align = "çoğunluk yukarı"; atone = "buy"; }
    else if (downs > ups) { align = "çoğunluk aşağı"; atone = "sell"; }
    mtf = { dirs, align, atone, agree: Math.max(ups, downs), total: MTF.length };
  } catch {}
  return { closes, price, change: ((price - prev) / prev) * 100, sig, mtf };
}

const TONE = { buy: "#00e08a", sell: "#ff4d6d", hold: "#f0c040" };
const CONF_COLOR = { "zayıf": "#7a8190", "orta": "#f0c040", "güçlü": "#00e08a" };

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

const fmtPrice = (p) => p == null ? "—" :
  `$${p.toLocaleString("en-US", { maximumFractionDigits: p < 1 ? 6 : p < 100 ? 3 : 2 })}`;

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
        Risk/Ödül oranı en az 1:2 olan işlemler tercih edilir. Kesin kural değil,
        sadece disiplin için referans.
      </div>
    </div>
  );
}

export default function App() {
  const [allSymbols, setAllSymbols] = useState([]); // Binance'teki tüm USDT baseAsset'leri
  const [watch, setWatch] = useState(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
      if (Array.isArray(saved) && saved.length) return saved;
    } catch {}
    return ["BTCUSDT", "ETHUSDT", "SOLUSDT"];
  });
  const [interval, setIntervalSel] = useState(INTERVALS[1]);
  const [rows, setRows] = useState({});
  const [search, setSearch] = useState("");
  const [soundOn, setSoundOn] = useState(true);
  const [lastUpdate, setLastUpdate] = useState(null);
  const [flash, setFlash] = useState(null);
  const [loadingList, setLoadingList] = useState(true);
  const prevVerdicts = useRef({});
  const timerRef = useRef(null);

  // İzleme listesini kalıcı sakla
  useEffect(() => {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(watch)); } catch {}
  }, [watch]);

  // Açılışta Binance'in TÜM geçerli USDT coinlerini çek
  useEffect(() => {
    (async () => {
      try {
        const res = await fetch("https://api.binance.com/api/v3/exchangeInfo");
        const data = await res.json();
        const bases = data.symbols
          .filter((s) => s.quoteAsset === "USDT" && s.status === "TRADING")
          .map((s) => s.baseAsset);
        setAllSymbols([...new Set(bases)].sort());
      } catch {
        setAllSymbols(["BTC","ETH","SOL","XRP","DOGE","BNB","ADA","AVAX"]);
      } finally { setLoadingList(false); }
    })();
  }, []);

  const labelOf = (sym) => sym.replace("USDT", "");

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

  const add = (sym) => setWatch((w) => (w.includes(sym) ? w : [...w, sym]));
  const remove = (sym) => setWatch((w) => w.filter((s) => s !== sym));

  // Arama: tüm Binance USDT coinlerinde, izlemede olmayanlardan ilk 40 sonuç
  const q = search.trim().toUpperCase();
  const searchResults = q
    ? allSymbols
        .filter((b) => b.includes(q) && !watch.includes(b + "USDT"))
        .slice(0, 40)
    : [];

  return (
    <div style={S.page}>
      <style>{`
        *{box-sizing:border-box}
        html,body,#root{margin:0;padding:0;width:100%;min-height:100%;background:#0a0c11;color:#e7eaf0;}
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
            ⚡ Yeni sinyal: {labelOf(flash.sym)} → {flash.verdict}
          </div>
        )}

        {/* Coin ARAMA / EKLEME — en üste taşındı, kolay erişim */}
        <div style={S.card}>
          <div style={S.cardHead}>
            COIN ARA VE EKLE {!loadingList && allSymbols.length > 0 && `(${allSymbols.length} coin mevcut)`}
          </div>
          {loadingList ? (
            <div style={S.muted}>Binance coin listesi yükleniyor…</div>
          ) : (
            <>
              <input value={search} onChange={(e) => setSearch(e.target.value)}
                placeholder="Coin yaz (örn. WIF, PEPE, BTC)…" style={S.input} />
              {q && (
                <div style={S.grid}>
                  {searchResults.map((b) => (
                    <button key={b} className="chip" onClick={() => { add(b + "USDT"); }}
                      style={{ ...S.gridChip, borderColor: "#23262f", color: "#9098a6" }}>
                      + {b}
                    </button>
                  ))}
                  {searchResults.length === 0 && (
                    <div style={S.muted}>"{q}" için sonuç yok (zaten ekli olabilir veya Binance'te USDT çifti yok).</div>
                  )}
                </div>
              )}
              {!q && <div style={S.muted}>Yukarıya bir coin adı yazınca eşleşenler çıkar, dokununca eklenir.</div>}
            </>
          )}
        </div>

        <div style={S.card}>
          <div style={S.cardHead}>İZLEME LİSTESİ ({watch.length})</div>
          {watch.length === 0 && <div style={S.muted}>Yukarıdan coin ara ve ekle.</div>}
          {watch.map((sym) => {
            const d = rows[sym];
            return (
              <div key={sym} className="row" style={S.row}>
                <div style={{ flex: "0 0 70px", fontWeight: 700 }}>{labelOf(sym)}</div>
                <div style={{ flex: 1, color: "#c9cfd9" }}>{d?.error ? "—" : fmtPrice(d?.price)}</div>
                <div style={{ flex: "0 0 64px", textAlign: "right",
                  color: !d || d.error ? "#5a606e" : d.change >= 0 ? "#00e08a" : "#ff4d6d" }}>
                  {d && !d.error ? `${d.change >= 0 ? "+" : ""}${d.change.toFixed(2)}%` : ""}
                </div>
                <div style={{ flex: "0 0 58px", textAlign: "right" }}>
                  {d?.sig && (
                    <span style={{ ...S.badge, color: TONE[d.sig.tone], borderColor: TONE[d.sig.tone] }}>
                      {d.sig.verdict}
                    </span>
                  )}
                </div>
                <button onClick={() => remove(sym)} title="Listeden çıkar"
                  style={S.removeBtn} className="chip">✕</button>
              </div>
            );
          })}
        </div>

        <div className="detail-grid">
          {watch.map((sym) => {
            const d = rows[sym];
            if (!d?.sig) return null;
            const sig = d.sig;
            return (
              <div key={sym} style={S.detail}>
                <div style={S.detailHead}>
                  <span style={{ fontWeight: 700 }}>{labelOf(sym)}/USDT</span>
                  <span style={{ ...S.badge, color: TONE[sig.tone], borderColor: TONE[sig.tone] }}>
                    {sig.verdict}
                  </span>
                </div>
                <div style={S.metaRow}>
                  <span style={S.metaKey}>Güven</span>
                  <span style={{ color: CONF_COLOR[sig.confidence], fontWeight: 700, fontSize: 12.5 }}>
                    {sig.confidence.toUpperCase()} ({Math.round(sig.strength * 100)}%)
                  </span>
                </div>
                <div style={S.barTrack}>
                  <div style={{ ...S.barFill, width: `${Math.round(sig.strength * 100)}%`,
                    background: CONF_COLOR[sig.confidence] }} />
                </div>
                {d.mtf && (
                  <div style={S.metaRow}>
                    <span style={S.metaKey}>Zaman uyumu (1s/4s/1g)</span>
                    <span style={{ color: TONE[d.mtf.atone], fontWeight: 700, fontSize: 12 }}>
                      {d.mtf.align} ({d.mtf.agree}/{d.mtf.total})
                    </span>
                  </div>
                )}
                {sig.stop != null && sig.dir !== 0 && (
                  <div style={S.metaRow}>
                    <span style={S.metaKey}>Önerilen stop-loss</span>
                    <span style={{ color: "#c9cfd9", fontWeight: 700, fontSize: 12.5 }}>
                      {fmtPrice(sig.stop)}
                    </span>
                  </div>
                )}
                <ul style={S.reasons}>
                  {sig.reasons.map((r, i) => <li key={i} style={S.reasonItem}>· {r}</li>)}
                </ul>
              </div>
            );
          })}
        </div>

        <RiskCalc />

        <div style={S.disclaimer}>
          Bu araç teknik göstergeleri (RSI, EMA, MACD, Bollinger) tek bir görünümde
          birleştirir; güven skoru, zaman aralığı uyumu ve oynaklığa dayalı stop-loss
          önerisi de bu göstergelerin hesabıdır — gelecek hakkında kesinlik değildir.
          Sinyaller yanılabilir ve bu bir yatırım tavsiyesi değildir. Sadece Binance'te
          USDT karşılığı işlem gören coinler gösterilir. Kararı ve işlemi sen kendi
          hesabında verirsin; risk yönetimi (stop-loss, pozisyon büyüklüğü) belirleyicidir.
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
  row: { display: "flex", alignItems: "center", padding: "11px 8px", borderRadius: 8, fontSize: 14, gap: 4 },
  badge: { fontSize: 11, fontWeight: 800, letterSpacing: 1, border: "1px solid", borderRadius: 6, padding: "2px 8px" },
  removeBtn: { flex: "0 0 28px", background: "transparent", border: "1px solid #23262f", color: "#7a8190",
    borderRadius: 6, padding: "4px 0", fontSize: 11, cursor: "pointer", marginLeft: 4 },
  detail: { background: "#10131a", border: "1px solid #1c2029", borderRadius: 12, padding: 16 },
  detailHead: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 },
  metaRow: { display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 8, fontSize: 12 },
  metaKey: { color: "#7a8190" },
  barTrack: { height: 5, background: "#1c2029", borderRadius: 3, marginTop: 5, overflow: "hidden" },
  barFill: { height: "100%", borderRadius: 3, transition: "width .4s ease" },
  reasons: { margin: "10px 0 0", padding: 0, listStyle: "none", borderTop: "1px solid #1c2029", paddingTop: 8 },
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
