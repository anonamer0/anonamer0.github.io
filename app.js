'use strict';
/* =========================================================
   合約風控助手 — 夏爾製
   ① K線 + 支撐/壓力/情緒位   ② 短中長計畫(買多少、進場點)
   ③ 即時監控 + 提醒          ④ 市場情緒 + 時事(AI 判讀)
   ⑤ 交易紀錄 + 教練調整
   ========================================================= */

const $ = id => document.getElementById(id);
const FAPI = 'https://fapi.binance.com';
const FEE = 0.001;                                   // 開+平吃單手續費 ≈ 倉位 0.1%
const MMR = 0.005;                                   // 維持保證金率(小倉位約 0.5%)
const TZ = -new Date().getTimezoneOffset() * 60;     // K 線時間轉成台灣時間
const TFS = ['15m', '1h', '4h', '1d', '1w'];
const TERMS = [
  {key: 'short', name: '短線', tf: '15m', htf: '1h', hold: '幾小時'},
  {key: 'mid',   name: '中線', tf: '4h',  htf: '1d', hold: '幾天'},
  {key: 'long',  name: '長線', tf: '1d',  htf: '1w', hold: '幾週'},
];
const TF_NAME = {'15m': '15分', '1h': '1小時', '4h': '4小時', '1d': '日線', '1w': '週線'};
const DIR = {long: '朝上', short: '朝下', none: '震盪'};
const SIDE = {long: '做多', short: '做空'};
const TERM_NAME = {short: '短線', mid: '中線', long: '長線'};
const QUICK = ['SOLUSDT', 'BTCUSDT', 'ETHUSDT', 'DOGEUSDT', '1000PEPEUSDT', '1000SHIBUSDT'];
const ALIAS = {SOL: ['索拉纳', 'Solana'], BTC: ['比特币', 'Bitcoin'], ETH: ['以太坊', 'Ethereum'],
               DOGE: ['狗狗币', 'Dogecoin'], PEPE: ['佩佩'], SHIB: ['柴犬币', 'Shiba'], XRP: ['瑞波']};
const FNG_TXT = {'Extreme Fear': '極度恐懼', 'Fear': '恐懼', 'Neutral': '中性', 'Greed': '貪婪', 'Extreme Greed': '極度貪婪'};

/* ---------- 小工具 ---------- */
function fp(x){   // 價格:大幣少小數、迷因幣多小數
  if(x == null || !isFinite(x)) return '-';
  const a = Math.abs(x);
  if(a > 0 && a < 1e-6) return x.toFixed(12).replace(/0+$/, '');
  if(a >= 1000) return x.toFixed(2);
  if(a >= 1) return String(+x.toFixed(4));
  return String(+x.toPrecision(5));
}
const fu = x => isFinite(x) ? x.toFixed(2) : '-';
const pc = x => isFinite(x) ? (x >= 0 ? '+' : '') + (x * 100).toFixed(2) + '%' : '-';
const fq = q => !isFinite(q) ? '-' : q >= 100 ? Math.floor(q).toLocaleString() : q >= 1 ? String(+q.toFixed(3)) : String(+q.toPrecision(4));
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
const coinOf = sym => sym.replace(/USDT$/, '');            // 1000PEPEUSDT → 1000PEPE(下單單位)
const baseOf = sym => coinOf(sym).replace(/^1000+/, '');  // 1000PEPEUSDT → PEPE(新聞用)
const msg = (cls, t) => `<div class="msg ${cls}">${t}</div>`;
const sum = a => a.reduce((x, y) => x + y, 0);
const avg = a => a.length ? sum(a) / a.length : 0;
const ago = ts => { const m = Math.max(0, Math.round((Date.now() / 1000 - ts) / 60));
  return m < 60 ? m + ' 分前' : m < 1440 ? Math.round(m / 60) + ' 小時前' : Math.round(m / 1440) + ' 天前'; };
const dayKey = t => new Date(t).toDateString();
function toast(text, cls = 'ok', ms = 6000){
  const d = document.createElement('div');
  d.className = 'toast ' + cls; d.textContent = text;
  $('toasts').appendChild(d); setTimeout(() => d.remove(), ms);
}
function normSym(s){
  s = (s || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  if(s && !s.endsWith('USDT')) s += 'USDT';
  return s;
}
const lsGet = k => { try{ return localStorage.getItem(k) || ''; }catch(e){ return ''; } };
const lsSet = (k, v) => { try{ localStorage.setItem(k, v); }catch(e){} };

/* =========================================================
   資料存取(紀錄檔在伺服器那邊)
   ========================================================= */
const DEF = {total: 890, risk: 2, alloc: {short: 25, mid: 25, long: 25, reserve: 25},
             watch: ['SOLUSDT', '1000PEPEUSDT', 'DOGEUSDT'], sym: 'SOLUSDT', tf: '4h', alertOn: false,
             show: {lv: true, ema: true, bb: true, st: true}, spot: {budget: 130, plans: []},
             params: {adx: 20, stK: 3, regime: false, trail: true},    // 判斷參數(回測室可以換)
             ntfy: {topic: '', on: false}};                            // 手機推播
let db = {settings: {}, trades: [], spot: []}, S;

// 電腦版:紀錄存在資料夾的「交易紀錄.json」(透過本機小伺服器)
// 手機版(放在網路上,沒有伺服器):紀錄存在手機瀏覽器裡,用「匯出/匯入」和電腦同步
let SERVER = true;
function fillDB(j){
  const D = JSON.parse(JSON.stringify(DEF));
  db.settings = {...D, ...(j.settings || {})};
  ['alloc', 'show', 'spot', 'params', 'ntfy'].forEach(k => db.settings[k] = {...D[k], ...(db.settings[k] || {})});
  db.trades = j.trades || [];
  db.spot = j.spot || [];
  db.bt = j.bt || {};
  S = db.settings;
}
async function loadDB(){
  let j = null;
  try{
    const r = await fetch('/api/journal');
    if(r.ok && (r.headers.get('content-type') || '').includes('json')) j = await r.json();
  }catch(e){}
  if(j === null){
    SERVER = false;
    try{ j = JSON.parse(localStorage.getItem('ciel_db') || '{}'); }catch(e){ j = {}; }
  }
  fillDB(j);
}
let saveTimer;
function saveDB(){
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    if(!SERVER){
      try{ localStorage.setItem('ciel_db', JSON.stringify(db)); }catch(e){ toast('手機存檔失敗(是不是開了無痕模式?)', 'bad', 15000); }
      return;
    }
    try{
      const r = await fetch('/api/journal', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(db)});
      if(!r.ok) throw 0;
    }catch(e){ toast('存檔失敗!伺服器是不是關了?', 'bad', 15000); }
  }, 300);
}

// 匯出:下載一個 JSON 檔(電腦 ↔ 手機搬紀錄用)
function exportDB(){
  const blob = new Blob([JSON.stringify(db, null, 1)], {type: 'application/json'});
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `交易紀錄-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  toast('已匯出。把這個檔傳到另一台裝置,按「匯入」就能合併。');
}
// 匯入:合併(同一筆以匯入的為準),這台裝置自己的畫面設定保留
async function importDB(file){
  let j;
  try{ j = JSON.parse(await file.text()); }catch(e){ return toast('這個檔案不是交易紀錄。', 'bad'); }
  if(!j || !j.settings || !Array.isArray(j.trades)) return toast('這個檔案不是交易紀錄。', 'bad');
  const merge = (a, b) => { const m = new Map(a.map(x => [x.id, x])); (b || []).forEach(x => m.set(x.id, x)); return [...m.values()]; };
  const keep = {sym: S.sym, tf: S.tf, alertOn: S.alertOn, show: S.show, ntfy: S.ntfy};
  const nt = merge(db.trades, j.trades).length - db.trades.length, ns = merge(db.spot, j.spot).length - db.spot.length;
  fillDB({settings: {...j.settings, ...keep}, trades: merge(db.trades, j.trades), spot: merge(db.spot, j.spot), bt: {...db.bt, ...(j.bt || {})}});
  saveDB();
  toast(`匯入完成:新增 ${nt} 筆合約、${ns} 筆現貨紀錄,設定已更新。`);
  fillSettings(); renderJournal(); renderSpot(); renderBtParams(); refreshAllPlans();
}

/* =========================================================
   行情(幣安公開 API,不用登入)
   ========================================================= */
const kcache = {};
async function klines(sym, tf, spot = false, limit = 300){
  const key = (spot ? 'S|' : 'F|') + sym + '|' + tf + '|' + limit, c = kcache[key];
  if(c && Date.now() - c.t < 45000) return c.bars;
  const url = spot ? `https://api.binance.com/api/v3/klines?symbol=${sym}&interval=${tf}&limit=${limit}`
                   : `${FAPI}/fapi/v1/klines?symbol=${sym}&interval=${tf}&limit=${limit}`;
  const j = await (await fetch(url)).json();
  if(!Array.isArray(j)) throw new Error(j.code === -1121 ? `找不到 ${sym}${spot ? '(現貨)' : ',合約代號對嗎?(例:1000PEPEUSDT)'}` : (j.msg || 'API 錯誤'));
  const bars = j.map(k => ({t: k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5]}));
  kcache[key] = {t: Date.now(), bars};
  return bars;
}

/* =========================================================
   指標
   ========================================================= */
function emaSeries(vals, n){
  const out = new Array(vals.length).fill(null);
  if(vals.length < n) return out;
  const k = 2 / (n + 1);
  let e = avg(vals.slice(0, n));
  out[n - 1] = e;
  for(let i = n; i < vals.length; i++){ e = vals[i] * k + e * (1 - k); out[i] = e; }
  return out;
}

// ATR = 每根 K 平均晃多少;ADX = 趨勢有多「用力」(<20 多半是震盪)
function atrAdx(b, n = 14){
  const trs = [], pdm = [], mdm = [];
  for(let i = 1; i < b.length; i++){
    const up = b[i].h - b[i - 1].h, dn = b[i - 1].l - b[i].l;
    trs.push(Math.max(b[i].h - b[i].l, Math.abs(b[i].h - b[i - 1].c), Math.abs(b[i].l - b[i - 1].c)));
    pdm.push(up > dn && up > 0 ? up : 0);
    mdm.push(dn > up && dn > 0 ? dn : 0);
  }
  let st = sum(trs.slice(0, n)), sp = sum(pdm.slice(0, n)), sm = sum(mdm.slice(0, n));
  const dx = () => { const p = sp / st, m = sm / st; return p + m === 0 ? 0 : 100 * Math.abs(p - m) / (p + m); };
  const dxs = [dx()];
  for(let i = n; i < trs.length; i++){
    st = st - st / n + trs[i]; sp = sp - sp / n + pdm[i]; sm = sm - sm / n + mdm[i];
    dxs.push(dx());
  }
  let adx = avg(dxs.slice(0, n));
  for(let i = n; i < dxs.length; i++) adx = (adx * (n - 1) + dxs[i]) / n;
  return {atr: st / n, adx};
}

// 支撐/壓力:找過去的轉折高低點,價格接近的合併成一條,碰越多次越可靠
function pivotsOf(bars, N = 5){   // 轉折點:比左右各 5 根都高(低)
  const piv = [];
  for(let i = N; i < bars.length - N; i++){
    let isH = true, isL = true;
    for(let j = i - N; j <= i + N; j++){
      if(bars[j].h > bars[i].h) isH = false;
      if(bars[j].l < bars[i].l) isL = false;
    }
    if(isH) piv.push({p: bars[i].h, i});
    if(isL) piv.push({p: bars[i].l, i});
  }
  return piv;
}
function clusterLevels(piv, atr, price, recentFrom){
  const ps = piv.slice().sort((a, b) => a.p - b.p), cl = [];
  for(const x of ps){
    const c = cl[cl.length - 1];
    if(c && x.p - c.avg <= 0.6 * atr){ c.s += x.p; c.n++; c.avg = c.s / c.n; c.i = Math.max(c.i, x.i); }
    else cl.push({s: x.p, n: 1, avg: x.p, i: x.i});
  }
  const lv = cl.filter(c => c.n >= 2 || c.i >= recentFrom).map(c => ({p: c.avg, touch: c.n}));   // 碰 2 次以上,或最近才出現
  return {
    sup: lv.filter(l => l.p < price).sort((a, b) => b.p - a.p).slice(0, 3),
    res: lv.filter(l => l.p > price).sort((a, b) => a.p - b.p).slice(0, 3),
  };
}
function findLevels(bars, atr, price){ return clusterLevels(pivotsOf(bars), atr, price, bars.length - 30); }

// 籌碼密集區:成交量最多的價位(很多人的成本在這,價格到這容易卡住)
function pocOf(bars){
  let lo = Infinity, hi = -Infinity;
  bars.forEach(b => { lo = Math.min(lo, b.l); hi = Math.max(hi, b.h); });
  const B = 60, w = (hi - lo) / B || 1, bins = new Array(B).fill(0);
  bars.forEach(b => { const tp = (b.h + b.l + b.c) / 3; bins[Math.min(B - 1, Math.floor((tp - lo) / w))] += b.v * tp; });
  let m = 0; bins.forEach((v, i) => { if(v > bins[m]) m = i; });
  return lo + (m + 0.5) * w;
}

// 整數關口(情緒位):100、0.005 這種漂亮數字,大家的掛單和情緒會聚在這
function roundLevels(p){
  const mag = Math.pow(10, Math.floor(Math.log10(p)));
  const step = (p / mag < 3 ? 0.1 : 0.5) * mag;
  const lo = Math.floor(p / step) * step;
  return [+lo.toPrecision(6), +(lo + step).toPrecision(6)];
}

// ATR 序列(Wilder 平滑),SuperTrend 要用
function atrSeries(b, n){
  const out = new Array(b.length).fill(null);
  let a = 0;
  for(let i = 1; i < b.length; i++){
    const tr = Math.max(b[i].h - b[i].l, Math.abs(b[i].h - b[i - 1].c), Math.abs(b[i].l - b[i - 1].c));
    if(i < n) a += tr;
    else if(i === n){ a = (a + tr) / n; out[i] = a; }
    else { a = (a * (n - 1) + tr) / n; out[i] = a; }
  }
  return out;
}

// SuperTrend(10, 3):價格在線上 = 多、線下 = 空。線本身就是很好的「移動止損」
function superTrend(b, n = 10, k = 3){
  const atr = atrSeries(b, n), line = new Array(b.length).fill(null), up = new Array(b.length).fill(null);
  let fu = 0, fl = 0, isUp = true, started = false;
  for(let i = 0; i < b.length; i++){
    if(atr[i] == null) continue;
    const mid = (b[i].h + b[i].l) / 2, bu = mid + k * atr[i], bl = mid - k * atr[i];
    if(!started){ fu = bu; fl = bl; isUp = b[i].c >= mid; started = true; }
    else{
      const pu = fu, pl = fl;
      fl = b[i - 1].c > pl ? Math.max(bl, pl) : bl;
      fu = b[i - 1].c < pu ? Math.min(bu, pu) : bu;
      if(!isUp && b[i].c > pu) isUp = true;
      else if(isUp && b[i].c < pl) isUp = false;
    }
    line[i] = isUp ? fl : fu; up[i] = isUp;
  }
  return {line, up};
}

// 布林通道(20, 2):中軌 = 20 日平均;上下軌 = 正常晃動的邊界,衝出去 = 過熱/超跌
function bollinger(closes, n = 20, k = 2){
  const u = [], m = [], l = [], bw = [];
  for(let i = 0; i < closes.length; i++){
    if(i < n - 1){ u.push(null); m.push(null); l.push(null); bw.push(null); continue; }
    const w = closes.slice(i - n + 1, i + 1), mean = avg(w), sd = Math.sqrt(avg(w.map(x => (x - mean) ** 2)));
    m.push(mean); u.push(mean + k * sd); l.push(mean - k * sd); bw.push(2 * k * sd / mean);
  }
  return {u, m, l, bw};
}

// RSI(14):低於 30 = 跌過頭、高於 70 = 漲過頭
function rsi(closes, n = 14){
  let g = 0, l = 0;
  for(let i = 1; i <= n; i++){ const d = closes[i] - closes[i - 1]; if(d > 0) g += d; else l -= d; }
  g /= n; l /= n;
  for(let i = n + 1; i < closes.length; i++){
    const d = closes[i] - closes[i - 1];
    g = (g * (n - 1) + Math.max(d, 0)) / n; l = (l * (n - 1) + Math.max(-d, 0)) / n;
  }
  return l === 0 ? 100 : 100 - 100 / (1 + g / l);
}

function analyze(bars){
  const closed = bars.slice(0, -1);                 // 最後一根還沒收完,不拿來判斷
  if(closed.length < 60) return null;
  const closes = closed.map(b => b.c);
  const e20 = emaSeries(closes, 20).at(-1), e50 = emaSeries(closes, 50).at(-1);
  const c = closes.at(-1);
  const {atr, adx} = atrAdx(closed);
  const ST = superTrend(closed, 10, S.params.stK), stUp = ST.up.at(-1);
  const BB = bollinger(closes), bws = BB.bw.filter(x => x != null);
  const bb = {u: BB.u.at(-1), m: BB.m.at(-1), l: BB.l.at(-1), squeeze: bws.at(-1) <= 1.1 * Math.min(...bws.slice(-120))};
  const emaUp = c > e50 && e20 > e50, emaDn = c < e50 && e20 < e50, strong = adx >= S.params.adx;
  // 方向 = 均線 和 SuperTrend 同意;力道 = ADX 夠大(預設 20,可用回測室調整)
  let dir = 'none';
  if(strong && emaUp && stUp) dir = 'long';
  if(strong && emaDn && !stUp) dir = 'short';
  const price = bars.at(-1).c;
  return {dir, e20, e50, atr, adx, price, emaUp, emaDn, strong, stUp, st: ST.line.at(-1), bb,
          lv: findLevels(closed.slice(-200), atr, price)};
}

/* =========================================================
   計畫:短中長各一張(方向、進場點、止損止盈、買多少)
   ========================================================= */
const st = {ana: {}, plans: {}, price: {}, chg: {}, senti: null, news: [], ai: null, fng: null, spot: {}, spotErr: {}};

// 進場點、止損、止盈的核心規則(即時計畫和回測室共用,保證兩邊一模一樣)
// m 需要:e20、atr、lv{sup,res};p = 現價
function planCore(L, p, m){
  const s = L ? 1 : -1, a = m.atr;
  // 進場:優先找「以前的支撐(做空找壓力)」,和 20 均線重疊最好
  const near = (L ? m.lv.sup : m.lv.res).find(x => Math.abs(p - x.p) <= 2.5 * a);
  let entry, basis;
  if(L ? p < m.e20 : p > m.e20){ entry = p; basis = '價格已回到 20 均線內側(回踩中)'; }
  else if(near && Math.abs(near.p - m.e20) <= 0.7 * a){ entry = (near.p + m.e20) / 2; basis = `20均線 + ${L ? '支撐' : '壓力'} ${fp(near.p)} 重疊(碰過 ${near.touch} 次)`; }
  else if(near){ entry = near.p + s * 0.2 * a; basis = `以前的${L ? '支撐' : '壓力'} ${fp(near.p)}(碰過 ${near.touch} 次)`; }
  else { entry = m.e20; basis = '20 均線'; }
  if(L ? entry > p : entry < p) entry = p;   // 不追價
  // 止損 1.5 倍 ATR 外(避開正常晃動);止盈1 = 1.5R 平一半,止盈2 = 下一個壓力(支撐)或 3R
  const stop = entry - s * 1.5 * a, R = Math.abs(entry - stop);
  const tp1 = entry + s * 1.5 * R;
  const far = (L ? m.lv.res : m.lv.sup).find(x => Math.abs(x.p - entry) >= 2 * R && Math.abs(x.p - entry) <= 5 * R && (L ? x.p > entry : x.p < entry));
  const tp2 = far ? far.p - s * 0.1 * a : entry + s * 3 * R;
  const block = (L ? m.lv.res : m.lv.sup).find(x => L ? (x.p > entry && x.p < tp1) : (x.p < entry && x.p > tp1));
  return {entry, basis, stop, R, tp1, tp2, block};
}

function makePlan(t, m, h, sym){
  const p = st.price[sym] || m.price;
  const P = {term: t, m, h, sym, price: p, warns: []};
  if(m.dir === 'none' || m.dir !== h.dir){
    P.dir = 'none'; P.status = 'no';
    P.why = m.dir !== 'none' ? `${TF_NAME[t.tf]}${DIR[m.dir]},但${TF_NAME[t.htf]}${DIR[h.dir]} → 大方向不點頭`
          : !m.strong ? `${TF_NAME[t.tf]} ADX ${m.adx.toFixed(0)} 低於 ${S.params.adx} → 沒力,在震盪`
          : !m.emaUp && !m.emaDn ? `${TF_NAME[t.tf]} 均線糾纏在一起 → 方向不明`
          : `${TF_NAME[t.tf]} 均線和 SuperTrend 意見不同 → 方向不明`;
    if(m.bb.squeeze) P.warns.push(['warn', '布林通道收窄中:快有大波動了,等它選好方向。']);
    return P;
  }
  const L = m.dir === 'long';
  // 大盤燈:逆大盤的方向,濾網開著就不做;沒開就亮紅字
  const rg = st.regime && st.regime.state, against = (rg === 'bear' && L) || (rg === 'bull' && !L);
  if(against && S.params.regime){
    P.dir = 'none'; P.status = 'no';
    P.why = `方向是${SIDE[m.dir]},但大盤是${REGIME[rg][0]},大盤濾網開著 → 不做`;
    return P;
  }
  P.dir = m.dir;

  // 1)+2) 進場、止損、止盈(和回測室用同一套規則)
  const {entry, basis, stop, R, tp1, tp2, block} = planCore(L, p, m);

  // 3) 買多少:打到止損剛好虧「總資金 × 風險%」(熊市自動砍半);保證金不超過這一份錢
  const cap = S.total * S.alloc[t.key] / 100;
  const riskU = S.total * effRisk() / 100;
  const dist = R / entry;
  let notional = riskU / (dist + FEE);
  const maxLev = Math.max(1, Math.floor(1 / (1.5 * dist + MMR)));   // 爆倉價要比止損遠 1.5 倍
  let lev = Math.max(1, Math.ceil(notional / cap));
  if(!(cap > 0)){ lev = 1; notional = 0; P.warns.push(['bad', `${t.name}分配 0%,這份不做。`]); }
  else if(lev > maxLev){
    lev = maxLev; notional = cap * maxLev;
    P.warns.push(['warn', `這份資金不夠大,已自動縮小倉位(實際只虧 ${fu(notional * (dist + FEE))} U)。`]);
  }
  const qty = notional / entry;
  Object.assign(P, {entry, basis, stop, tp1, tp2, R, lev, notional, qty, cap,
    margin: notional / lev,
    loss: notional * (dist + FEE),
    gain1: qty / 2 * Math.abs(tp1 - entry) - notional / 2 * FEE,
    gain2: qty / 2 * Math.abs(tp2 - entry) - notional / 2 * FEE,
    liq: L ? entry * (1 - 1 / lev + MMR) : entry * (1 + 1 / lev - MMR),
    rr2: Math.abs(tp2 - entry) / R});

  // 4) 提醒
  if(against) P.warns.push(['bad', `逆大盤:現在是${REGIME[rg][0]},你在${SIDE[m.dir]}。勝率通常比較低。`]);
  if(rg === 'bear') P.warns.push(['warn', `熊市:單筆風險自動砍半(${S.risk}% → ${effRisk()}%)。`]);
  if(block) P.warns.push(['warn', `途中 ${fp(block.p)} 有${L ? '壓力' : '支撐'},可能先卡住,到那可以先落袋一點。`]);
  if(dist < 0.003) P.warns.push(['warn', '止損不到 0.3%,一根插針就掃掉。']);
  if(L ? p > m.bb.u : p < m.bb.l) P.warns.push(['warn', `價格衝出布林${L ? '上' : '下'}軌,短期過熱,別追。`]);
  if(m.bb.squeeze) P.warns.push(['warn', '布林通道收窄中:快有大波動,小心假突破。']);
  if(sym === S.sym) sentiWarns(P);
  liveStatus(P, p);
  return P;
}

// 用最新價格判斷:到進場區了沒?
function liveStatus(P, p){
  if(P.dir === 'none' || !isFinite(p)) return;
  P.price = p;
  const L = P.dir === 'long';
  if(L ? p <= P.stop : p >= P.stop){ P.status = 'no'; P.why = '價格已經打穿止損位,這個計畫作廢,等下一次。'; }
  else if(L ? p <= P.entry + 0.3 * P.m.atr : p >= P.entry - 0.3 * P.m.atr) P.status = 'go';
  else P.status = 'wait';
}

function sentiWarns(P){
  const x = st.senti, L = P.dir === 'long';
  if(x){
    if(L && x.funding > 0.0005) P.warns.push(['warn', `資金費率 ${pc(x.funding)} 偏高:做多的人太擠,容易被「多殺多」。`]);
    if(!L && x.funding < -0.0003) P.warns.push(['warn', `資金費率 ${pc(x.funding)} 偏負:做空的人太擠,小心被軋空。`]);
    if(L && x.ls > 2.5) P.warns.push(['warn', `散戶 ${(x.longPct * 100).toFixed(0)}% 在做多,一面倒時常反著走。`]);
    if(!L && x.ls < 0.6) P.warns.push(['warn', `散戶 ${((1 - x.longPct) * 100).toFixed(0)}% 在做空,一面倒時常反著走。`]);
    if(L && x.fng >= 80) P.warns.push(['warn', `恐懼貪婪 ${x.fng}(極度貪婪),追多要小心。`]);
    if(!L && x.fng <= 20) P.warns.push(['warn', `恐懼貪婪 ${x.fng}(極度恐懼),追空要小心。`]);
  }
  const ai = st.ai;
  if(ai && ai.sym === P.sym && ai.bias){
    if((L && ai.bias < 0) || (!L && ai.bias > 0)) P.warns.push(['bad', `新聞面偏${ai.bias < 0 ? '利空' : '利多'}(${esc(ai.why)}),跟你的方向相反。`]);
    else P.warns.push(['ok', `新聞面偏${ai.bias > 0 ? '利多' : '利空'},和方向一致。`]);
  }
}

async function fetchAna(sym){
  const d = {};
  await Promise.all(TFS.map(async tf => { d[tf] = analyze(await klines(sym, tf)); }));
  st.ana[sym] = d;
  if(d['15m']) st.price[sym] = st.price[sym] && sym === S.sym ? st.price[sym] : d['15m'].price;
}
function buildPlans(sym){
  const d = st.ana[sym];
  if(!d) return;
  st.plans[sym] = TERMS.map(t => {
    const m = d[t.tf], h = d[t.htf];
    if(!m || !h) return {term: t, sym, dir: 'none', status: 'no', warns: [], why: '上市不夠久,資料太少,判斷不了。'};
    return makePlan(t, m, h, sym);
  });
}

/* =========================================================
   K 線圖
   ========================================================= */
let chart, candle, volS, e20S, e50S, bbU, bbM, bbL, stUpS, stDnS, lines = [];
function initChart(){
  if(!window.LightweightCharts){ $('chart').innerHTML = msg('bad', '圖表元件載入失敗(網路?)。重新整理試試。'); return; }
  chart = LightweightCharts.createChart($('chart'), {
    autoSize: true,
    layout: {background: {color: '#1a1d24'}, textColor: '#c9ced6'},
    grid: {vertLines: {color: '#222631'}, horzLines: {color: '#222631'}},
    rightPriceScale: {borderColor: '#2a2f3a'},
    timeScale: {borderColor: '#2a2f3a', timeVisible: true},
    crosshair: {mode: 0},
  });
  candle = chart.addCandlestickSeries({upColor: '#22c55e', downColor: '#ef4444', borderVisible: false, wickUpColor: '#22c55e', wickDownColor: '#ef4444'});
  volS = chart.addHistogramSeries({priceScaleId: 'vol', priceFormat: {type: 'volume'}, lastValueVisible: false, priceLineVisible: false});
  chart.priceScale('vol').applyOptions({scaleMargins: {top: 0.82, bottom: 0}});
  e20S = chart.addLineSeries({color: '#eab308', lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false});
  e50S = chart.addLineSeries({color: '#60a5fa', lineWidth: 1, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false});
  const thin = (color, style = 0, width = 1) => chart.addLineSeries({color, lineWidth: width, lineStyle: style, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false});
  bbU = thin('rgba(148,163,184,.75)'); bbM = thin('rgba(148,163,184,.5)', 2); bbL = thin('rgba(148,163,184,.75)');
  stUpS = thin('#22c55e', 0, 2); stDnS = thin('#ef4444', 0, 2);
}
function applyShow(){
  if(!chart) return;
  [e20S, e50S].forEach(s => s.applyOptions({visible: S.show.ema}));
  [bbU, bbM, bbL].forEach(s => s.applyOptions({visible: S.show.bb}));
  [stUpS, stDnS].forEach(s => s.applyOptions({visible: S.show.st}));
}

const kl = b => ({time: b.t / 1000 + TZ, open: b.o, high: b.h, low: b.l, close: b.c});
const vl = b => ({time: b.t / 1000 + TZ, value: b.v, color: b.c >= b.o ? 'rgba(34,197,94,.35)' : 'rgba(239,68,68,.35)'});

async function loadChart(){
  if(!chart) return;
  const sym = S.sym, tf = S.tf;
  $('chartTitle').textContent = `${coinOf(sym)} · ${TF_NAME[tf]}`;
  document.querySelectorAll('#tfBtns button').forEach(b => b.classList.toggle('on', b.dataset.tf === tf));
  try{
    const bars = await klines(sym, tf);
    if(sym !== S.sym || tf !== S.tf) return;
    const p = bars.at(-1).c;
    const prec = p >= 1000 ? 2 : p >= 1 ? 4 : Math.min(10, Math.ceil(-Math.log10(p)) + 4);
    candle.applyOptions({priceFormat: {type: 'price', precision: prec, minMove: Math.pow(10, -prec)}});
    candle.setData(bars.map(kl));
    volS.setData(bars.map(vl));
    const closes = bars.map(b => b.c);
    const toLine = arr => arr.map((v, i) => v == null ? null : {time: bars[i].t / 1000 + TZ, value: v}).filter(Boolean);
    e20S.setData(toLine(emaSeries(closes, 20)));
    e50S.setData(toLine(emaSeries(closes, 50)));
    const BB = bollinger(closes);
    bbU.setData(toLine(BB.u)); bbM.setData(toLine(BB.m)); bbL.setData(toLine(BB.l));
    // SuperTrend 分成綠(多)紅(空)兩條,翻轉時斷開,比較好看
    const ST = superTrend(bars, 10, S.params.stK), T = i => bars[i].t / 1000 + TZ;
    stUpS.setData(ST.line.map((v, i) => v != null && ST.up[i] ? {time: T(i), value: v} : {time: T(i)}));
    stDnS.setData(ST.line.map((v, i) => v != null && !ST.up[i] ? {time: T(i), value: v} : {time: T(i)}));
    applyShow();
    drawLevels(bars);
  }catch(e){ toast('K 線讀取失敗:' + e.message, 'bad'); }
}

function drawLevels(bars){
  lines.forEach(l => candle.removePriceLine(l)); lines = [];
  const A = analyze(bars); if(!A) return;
  const p = st.price[S.sym] || A.price;
  const D = LightweightCharts.LineStyle;
  const add = (price, color, title, style = D.Dashed, width = 1) =>
    lines.push(candle.createPriceLine({price, color, lineWidth: width, lineStyle: style, axisLabelVisible: true, title}));
  const poc = pocOf(bars.slice(-200)), rounds = roundLevels(p);
  if(S.show.lv){
    A.lv.sup.forEach((l, i) => add(l.p, '#22c55e', `支撐${i + 1}`));
    A.lv.res.forEach((l, i) => add(l.p, '#ef4444', `壓力${i + 1}`));
    add(poc, '#f97316', '籌碼密集', D.Solid);
    rounds.forEach(r => add(r, '#a78bfa', '整數關口', D.Dotted));
  }

  // 對應期別的計畫線(進場/止損/止盈)
  const P = (st.plans[S.sym] || []).find?.(x => x.term.tf === S.tf && x.dir !== 'none');
  if(P){
    add(P.entry, '#60a5fa', `${P.term.name}進場`, D.Solid, 2);
    add(P.stop, '#ef4444', '止損', D.Solid, 2);
    add(P.tp1, '#22c55e', '止盈1', D.Solid, 2);
    add(P.tp2, '#22c55e', '止盈2', D.Solid, 2);
  }

  const d = x => `${fp(x)} <small>(${pc((x - p) / p)})</small>`;
  $('lvls').innerHTML =
    `<div><span class="g">支撐</span>:${A.lv.sup.map(l => d(l.p) + `<small> ×${l.touch}</small>`).join('、') || '<small>附近沒有</small>'}</div>` +
    `<div><span class="r">壓力</span>:${A.lv.res.map(l => d(l.p) + `<small> ×${l.touch}</small>`).join('、') || '<small>附近沒有</small>'}</div>` +
    `<div><span style="color:var(--orange)">籌碼密集</span>:${d(poc)}</div>` +
    `<div><span style="color:var(--accent)">整數關口</span>:${rounds.map(d).join('、')}</div>`;
}

/* ---------- 即時連線(WebSocket):K 線跳動 + 現價 ---------- */
// 幣安 2026 起合約行情改走 /market;舊網址留著當備援
const WS_URLS = ['wss://fstream.binance.com/market/stream?streams=', 'wss://fstream.binance.com/stream?streams='];
let ws, wsKey, wsUrl = 0, wsRetry = 0, wsLastMsg = 0, lastLive = 0;
function openWS(){
  const sym = S.sym.toLowerCase(), key = sym + S.tf;
  if(ws && wsKey === key && ws.readyState <= 1) return;
  if(ws){ ws.onclose = null; ws.close(); }
  wsKey = key; wsLastMsg = Date.now();
  ws = new WebSocket(`${WS_URLS[wsUrl]}${sym}@kline_${S.tf}/${sym}@ticker`);
  ws.onopen = () => { wsRetry = 0; };
  ws.onclose = () => { $('conn').classList.remove('ok'); setTimeout(openWS, Math.min(30000, 1000 * 2 ** wsRetry++)); };
  ws.onmessage = e => {
    wsLastMsg = Date.now(); $('conn').classList.add('ok');
    const {stream, data} = JSON.parse(e.data);
    if(data.s !== S.sym) return;
    if(stream.endsWith('@ticker')) onTicker(data);
    else if(candle){
      const k = data.k, b = {t: k.t, o: +k.o, h: +k.h, l: +k.l, c: +k.c, v: +k.v};
      candle.update(kl(b)); volS.update(vl(b));
    }
  };
}
// 連線開著卻 15 秒沒資料 → 換另一個網址重連
setInterval(() => {
  if(ws && ws.readyState === 1 && Date.now() - wsLastMsg > 15000){
    wsUrl = (wsUrl + 1) % WS_URLS.length;
    ws.onclose = null; ws.close(); ws = null; $('conn').classList.remove('ok'); openWS();
  }
}, 5000);
function onTicker(d){
  const p = +d.c, chg = +d.P;
  st.price[S.sym] = p; st.chg[S.sym] = chg;
  $('lsym').textContent = coinOf(S.sym);
  $('lp').textContent = fp(p);
  $('lc').innerHTML = `<span class="${chg >= 0 ? 'up' : 'down'}">${chg >= 0 ? '+' : ''}${chg.toFixed(2)}%</span>`;
  document.title = `${fp(p)} ${coinOf(S.sym)} · 合約風控助手`;
  if(Date.now() - lastLive < 3000) return;   // 每 3 秒更新一次卡片就好
  lastLive = Date.now();
  const plans = st.plans[S.sym];
  if(Array.isArray(plans)){ plans.forEach(P => liveStatus(P, p)); renderCards(); checkAlerts(S.sym); }
  renderOpen();
}

/* =========================================================
   提醒(聲音 + 系統通知 + 右下角)
   ========================================================= */
let actx;
function beep(){
  try{
    actx = actx || new AudioContext();
    [0, 0.25].forEach(dt => {
      const o = actx.createOscillator(), g = actx.createGain(), t0 = actx.currentTime + dt;
      o.frequency.value = 880;
      g.gain.setValueAtTime(0.15, t0); g.gain.exponentialRampToValueAtTime(0.001, t0 + 0.2);
      o.connect(g).connect(actx.destination); o.start(t0); o.stop(t0 + 0.2);
    });
  }catch(e){}
}
// always = true:就算提醒關著也要在右下角說(例如定投日)
function notify(title, body, always = false){
  if(!S.alertOn && !always) return;
  if(S.alertOn){
    beep();
    try{ if(Notification.permission === 'granted') new Notification(title, {body}); }catch(e){}
  }
  toast(`${title}\n${body}`, 'ok', 20000);
  pushPhone(title, body);
}
// 手機推播:送到 ntfy(主人 iPhone 上的 ntfy App 訂閱同一個頻道就會跳通知)
async function pushPhone(title, message){
  if(!S.ntfy.on || !S.ntfy.topic) return false;
  try{
    const r = await fetch('https://ntfy.sh/', {method: 'POST', body: JSON.stringify({topic: S.ntfy.topic, title, message, tags: ['chart_with_upwards_trend'], priority: 4})});
    return r.ok;
  }catch(e){ return false; }
}
const alerted = {};
function checkAlerts(sym){
  const plans = st.plans[sym];
  if(!Array.isArray(plans)) return;
  plans.forEach(P => {
    const k = sym + '|' + P.term.key;
    if(P.status === 'go' && (!alerted[k] || Date.now() - alerted[k] > 30 * 60e3)){
      alerted[k] = Date.now();
      notify(`${coinOf(sym)} ${P.term.name}${SIDE[P.dir]}:到進場區了`,
        `進場 ${fp(P.entry)}|止損 ${fp(P.stop)}(${pc((P.stop - P.entry) / P.entry)})|數量 ${fq(P.qty)}|打到止損虧 ${fu(P.loss)} U`);
    }
    if(P.status !== 'go' && alerted[k] && Date.now() - alerted[k] > 5 * 60e3) delete alerted[k];
  });
}
function renderAlertBtn(){ $('alertBtn').textContent = S.alertOn ? '🔔 提醒:開' : '🔕 提醒:關'; $('alertBtn').classList.toggle('on', S.alertOn); }
$('alertBtn').onclick = async () => {
  S.alertOn = !S.alertOn;
  if(S.alertOn){
    actx = actx || new AudioContext(); actx.resume();
    try{ if(Notification.permission === 'default') await Notification.requestPermission(); }catch(e){}
    beep(); toast('提醒已開:到進場區會「嗶嗶」+ 跳通知。這個分頁要開著喔。');
  }
  renderAlertBtn(); saveDB();
};
document.addEventListener('click', () => { if(actx && actx.state === 'suspended') actx.resume(); });

/* =========================================================
   畫面:短中長計畫卡
   ========================================================= */
function badge(P){
  if(P.status === 'go') return '<span class="badge go">可進場</span>';
  if(P.status === 'wait') return `<span class="badge wait">等回踩 ${pc((P.entry - P.price) / P.price)}</span>`;
  return '<span class="badge no">不做</span>';
}
function renderCards(){
  const plans = st.plans[S.sym], box = $('cards');
  if(!plans){ box.innerHTML = '<div class="card sub">計算中…</div>'; return; }
  if(plans.error){ box.innerHTML = `<div class="card">${msg('bad', esc(plans.error))}</div>`; return; }
  box.innerHTML = plans.map((P, i) => cardHTML(P, i)).join('');
}
function cardHTML(P, i){
  const t = P.term, dot = P.dir === 'long' ? 'g' : P.dir === 'short' ? 'r' : 'y';
  const bt = btNote(P.sym, t.key);
  const btLine = !bt ? '<div class="votes">回測:還沒跑(到回測室按「跑整個監控清單」)</div>'
    : `<div class="votes">回測(${bt.n} 單):勝率 ${(bt.win * 100).toFixed(0)}%、平均每單 <b class="${bt.exp >= 0 ? 'g' : 'r'}">${bt.exp >= 0 ? '+' : ''}${bt.exp.toFixed(2)}R</b>${bt.n < 30 ? '(樣本少)' : Math.abs(bt.exp) <= 0.02 ? '(≈ 打平,扣掉資金費率就是賠)' : bt.exp < 0 ? ' ← 過去是賠錢的' : ''}</div>`;
  const head = `<div class="th"><span class="dot ${dot}"></span><b>${t.name}</b><span class="sub">${TF_NAME[t.tf]}+${TF_NAME[t.htf]} · 抱${t.hold}</span>${badge(P)}</div>` + votesHTML(P) + btLine;
  if(P.dir !== 'none' && bt && bt.n >= 30 && bt.exp < -0.02) P.warns = [['bad', `回測顯示這個幣的${t.name},這套規則過去是賠錢的(每單 ${bt.exp.toFixed(2)}R)。亮燈也要三思。`], ...P.warns.filter(w => !w[1].startsWith('回測顯示'))];
  if(P.dir === 'none') return `<div class="card term">${head}<div class="sub" style="margin:8px 0">${esc(P.why)}</div>${msg('warn', '不做。沒機會就等,天天開單是在幫平台刷手續費。')}${P.warns.map(w => msg(w[0], w[1])).join('')}</div>`;
  const E = P.entry, p = P.price, T = S.total, L = P.dir === 'long', rel = x => `<small>(${pc((x - E) / E)})</small>`;
  const rows = [
    ['方向', `<b class="${P.dir === 'long' ? 'g' : 'r'}">${SIDE[P.dir]}</b>`],
    ['計畫進場', `<b>${fp(E)}</b> <small>(${E === p ? '就是現價' : '現價' + pc((E - p) / p)})</small><br><small>依據:${esc(P.basis)}</small>`],
    ['止損', `${fp(P.stop)} ${rel(P.stop)}`],
    ['止盈1 平一半', `${fp(P.tp1)} ${rel(P.tp1)} <span class="up">+${fu(P.gain1)} U</span>`],
    ['止盈2 全平', `${fp(P.tp2)} ${rel(P.tp2)} <span class="up">+${fu(P.gain2)} U</span>`],
    ['移動止損', `${fp(P.m.st)} ${rel(P.m.st)}<br><small>SuperTrend 線。進場後止損可以跟著它${L ? '往上' : '往下'}移</small>`],
    ['買多少', `<b>${fq(P.qty)}</b> ${coinOf(P.sym)} <small>(倉位 ${fu(P.notional)} U)</small>`],
    ['槓桿/保證金', `${P.lev} 倍 / ${fu(P.margin)} U <small>(這份 ${fu(P.cap)} U 的 ${P.cap ? (P.margin / P.cap * 100).toFixed(0) : 0}%)</small>`],
    ['打到止損', `<span class="down">-${fu(P.loss)} U</span> <small>(總資金 -${(P.loss / T * 100).toFixed(2)}%)</small>`],
    ['全部止盈', `<span class="up">+${fu(P.gain1 + P.gain2)} U</span> <small>(總資金 +${((P.gain1 + P.gain2) / T * 100).toFixed(2)}%)</small>`],
    ['賺賠比', `止盈1 1:1.5|止盈2 1:${P.rr2.toFixed(1)}`],
    ['約爆倉價', `${fp(P.liq)} ${rel(P.liq)}`],
  ];
  const tip = P.status === 'go' ? msg('ok', '到進場區了。掛單前先勾完下面的鐵紀律。')
            : P.status === 'wait' ? msg('warn', `還沒到。掛限價單在 ${fp(E)} 等,或開著提醒等我叫你。`)
            : msg('bad', esc(P.why || '不做'));
  return `<div class="card term">${head}
    <table class="plan">${rows.map(r => `<tr><td>${r[0]}</td><td>${r[1]}</td></tr>`).join('')}</table>
    ${tip}${P.warns.map(w => msg(w[0], w[1])).join('')}
    <div class="row" style="margin-top:10px"><button onclick="drawPlan(${i})">畫到圖上</button><button onclick="planToForm(${i})">記這一單</button></div>
  </div>`;
}
// 每張卡上方的「判斷依據」:讓主人一眼看出為什麼亮這個燈
function votesHTML(P){
  if(!P.m) return '';
  const m = P.m, h = P.h, p = P.price, c = (cls, txt) => `<span class="${cls}">${txt}</span>`;
  const ema = m.emaUp ? c('g', '均線多') : m.emaDn ? c('r', '均線空') : c('y', '均線亂');
  const stv = m.stUp ? c('g', 'SuperTrend多') : c('r', 'SuperTrend空');
  const adx = m.strong ? c('g', `ADX ${m.adx.toFixed(0)} 有力`) : c('y', `ADX ${m.adx.toFixed(0)} 沒力`);
  const bb = p > m.bb.u ? c('y', '布林上軌外') : p > m.bb.m ? '布林中軌上' : p >= m.bb.l ? '布林中軌下' : c('y', '布林下軌外');
  const big = h.dir === 'long' ? c('g', '多') : h.dir === 'short' ? c('r', '空') : c('y', '沒方向');
  return `<div class="votes">${TF_NAME[P.term.tf]}:${ema} · ${stv} · ${adx} · ${bb}${m.bb.squeeze ? ' · ' + c('y', '布林收窄') : ''}<br>${TF_NAME[P.term.htf]}(大方向):${big}</div>`;
}
function drawPlan(i){ const P = st.plans[S.sym][i]; S.tf = P.term.tf; saveDB(); openWS(); loadChart(); $('chart').scrollIntoView({behavior: 'smooth'}); }
function planToForm(i){
  const P = st.plans[S.sym][i];
  $('jSym').value = P.sym; $('jTerm').value = P.term.key; $('jSide').value = P.dir;
  $('jEntry').value = fp(P.entry); $('jStop').value = fp(P.stop); $('jTp1').value = fp(P.tp1); $('jTp2').value = fp(P.tp2);
  $('jQty').value = +P.qty.toPrecision(6); $('jLev').value = P.lev;
  $('jRules').checked = rules.every(r => r.checked);
  $('addBox').open = true; $('journal').scrollIntoView({behavior: 'smooth'});
  toast('已帶入。實際成交價不同的話改一下再儲存。');
}

/* ---------- 監控清單 ---------- */
function renderWatch(){
  const cell = P => !P ? '…'
    : P.dir === 'none' ? '<span class="sub">—</span>'
    : P.status === 'go' ? `<b class="${P.dir === 'long' ? 'g' : 'r'}">● ${SIDE[P.dir]}</b>`
    : P.status === 'wait' ? `<span class="sub">${P.dir === 'long' ? '▲' : '▼'} 差${pc((P.entry - P.price) / P.price)}</span>`
    : '<span class="sub">×</span>';
  $('watch').innerHTML = `<table class="wt"><tr><th>幣</th><th>現價</th><th>短</th><th>中</th><th>長</th><th></th></tr>` +
    S.watch.map(sym => {
      const ps = st.plans[sym];
      const cells = Array.isArray(ps) ? ps.map(P => `<td>${cell(P)}</td>`).join('')
        : `<td colspan="3" class="sub">${ps && ps.error ? esc(ps.error).slice(0, 30) : '讀取中…'}</td>`;
      return `<tr data-sym="${sym}" class="${sym === S.sym ? 'sel' : ''}"><td><b>${coinOf(sym)}</b></td><td>${fp(st.price[sym])}</td>${cells}<td><button class="x" data-del="${sym}" title="移除">×</button></td></tr>`;
    }).join('') + '</table><div class="sub" style="margin-top:4px">● 可進場|▲▼ 趨勢對了、等回踩|— 不做。點一列看詳細。</div>';
}
$('watch').onclick = e => {
  const del = e.target.dataset.del;
  if(del){ S.watch = S.watch.filter(s => s !== del); saveDB(); renderWatch(); return; }
  const tr = e.target.closest('tr[data-sym]');
  if(tr) selectSym(tr.dataset.sym);
};
$('watchBtn').onclick = async () => {
  const sym = normSym($('watchAdd').value);
  if(!sym || S.watch.includes(sym)) return;
  try{ await klines(sym, '1h'); }catch(e){ toast(e.message, 'bad'); return; }
  S.watch.push(sym); $('watchAdd').value = ''; saveDB(); renderWatch(); tick();
};
$('watchAdd').onkeydown = e => { if(e.key === 'Enter') $('watchBtn').click(); };

/* =========================================================
   市場情緒 + 時事
   ========================================================= */
async function loadSenti(sym){
  const x = {};
  const get = async u => (await fetch(u)).json();
  await Promise.allSettled([
    get('https://api.alternative.me/fng/?limit=1').then(j => { x.fng = +j.data[0].value; x.fngTxt = FNG_TXT[j.data[0].value_classification] || j.data[0].value_classification; }),
    get(`${FAPI}/fapi/v1/premiumIndex?symbol=${sym}`).then(j => { x.funding = +j.lastFundingRate; }),
    get(`${FAPI}/futures/data/globalLongShortAccountRatio?symbol=${sym}&period=1h&limit=1`).then(j => { x.ls = +j[0].longShortRatio; x.longPct = +j[0].longAccount; }),
    get(`${FAPI}/futures/data/openInterestHist?symbol=${sym}&period=1h&limit=25`).then(j => { x.oi = j.at(-1).sumOpenInterestValue / j[0].sumOpenInterestValue - 1; }),
  ]);
  if(x.fng != null) st.fng = x.fng;
  if(sym !== S.sym) return;
  st.senti = x;
  const say = (v, parts) => { for(const [cond, txt, cls] of parts) if(cond(v)) return `<span class="${cls || ''}">${txt}</span>`; return ''; };
  $('senti').innerHTML = `<div class="gauge">
    <span>恐懼貪婪(全市場)</span><span><b>${x.fng ?? '-'}</b> ${x.fngTxt || ''} ${say(x.fng, [[v => v >= 75, '→ 大家很貪,別追高', 'y'], [v => v <= 25, '→ 大家很怕,別恐慌殺低', 'y']])}</span>
    <span>資金費率</span><span><b>${isFinite(x.funding) ? (x.funding * 100).toFixed(4) + '%' : '-'}</b> ${say(x.funding, [[v => v > 0.0005, '→ 做多太擠', 'y'], [v => v < -0.0003, '→ 做空太擠', 'y'], [v => isFinite(v), '→ 正常', 'sub']])}</span>
    <span>散戶多空人數</span><span><b>${isFinite(x.longPct) ? (x.longPct * 100).toFixed(0) + '% 多 / ' + ((1 - x.longPct) * 100).toFixed(0) + '% 空' : '-'}</b> ${say(x.ls, [[v => v > 2.5, '→ 一面倒做多', 'y'], [v => v < 0.6, '→ 一面倒做空', 'y']])}</span>
    <span>持倉量 24h</span><span><b>${pc(x.oi)}</b> ${say(x.oi, [[v => v > 0.1, '→ 錢湧進來,波動會變大', 'y'], [v => v < -0.1, '→ 錢在撤出', 'sub']])}</span>
  </div>`;
  buildPlans(sym); renderCards();
}

async function loadNews(){
  if(!SERVER){   // 幣安新聞擋外部網站,只有電腦版的小伺服器抓得到
    $('newsSym').textContent = '';
    $('news').innerHTML = '<li class="sub">手機版沒有新聞:幣安新聞只讓電腦版的小伺服器抓。</li>';
    $('ai').innerHTML = '';
    return;
  }
  try{
    const j = await (await fetch('/api/news')).json();
    if(Array.isArray(j) && j.length) st.news = j;
  }catch(e){}
  renderNews();
  aiJudge();
}
function coinNews(sym){
  const b = baseOf(sym), keys = [b, ...(ALIAS[b] || [])];
  const re = new RegExp(`(^|[^A-Z])(${keys.map(k => k.toUpperCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})([^A-Z]|$)`);
  return st.news.filter(n => n.coins.includes(b) || re.test((n.title + ' ' + n.sub).toUpperCase()));
}
const mktNews = () => st.news.filter(n => !n.coins.length || n.coins.includes('BTC'));
function renderNews(){
  const mine = coinNews(S.sym).slice(0, 8), mkt = mktNews().slice(0, 8);
  $('newsSym').textContent = `${baseOf(S.sym)} 相關 ${coinNews(S.sym).length} 則`;
  const li = n => `<li><a href="${esc(n.link)}" target="_blank" rel="noopener">${esc(n.title)}</a><br><small>${ago(n.t)}</small>${n.coins.slice(0, 3).map(c => `<span class="tag">${esc(c)}</span>`).join('')}</li>`;
  $('news').innerHTML = !st.news.length ? '<li class="sub">新聞讀不到(伺服器沒開?)</li>'
    : (mine.length ? `<li class="sub">— ${baseOf(S.sym)} —</li>` + mine.map(li).join('') : `<li class="sub">最近沒有 ${baseOf(S.sym)} 的新聞</li>`)
      + '<li class="sub">— 大盤 / 總經 —</li>' + mkt.map(li).join('');
}

/* ---------- AI 判讀新聞(用 Groq,需要金鑰;沒有就只列新聞) ---------- */
let groqModel;
async function pickModel(key){
  if(groqModel) return groqModel;
  const pref = ['openai/gpt-oss-120b', 'llama-3.3-70b-versatile', 'openai/gpt-oss-20b', 'llama-3.1-8b-instant'];
  try{
    const ids = (await (await fetch('https://api.groq.com/openai/v1/models', {headers: {Authorization: 'Bearer ' + key}})).json()).data.map(m => m.id);
    groqModel = pref.find(p => ids.includes(p)) || ids.find(i => !/whisper|tts|guard|orpheus|playai|compound|distil/i.test(i));
  }catch(e){}
  return groqModel || 'llama-3.1-8b-instant';
}
const aiCache = {};
async function aiJudge(){
  const sym = S.sym, key = lsGet('groqKey');
  if(!key){ $('ai').innerHTML = '<div class="sub">想讓 AI 幫忙判讀新聞利多/利空:⚙ 設定 → 設定 AI 金鑰。</div>'; return; }
  const c = aiCache[sym];
  if(c && Date.now() - c.t < 15 * 60e3){ showAI(c.v); return; }
  $('ai').innerHTML = '<div class="sub">AI 判讀中…</div>';
  const lines = [...coinNews(sym).slice(0, 12).map(n => `[${baseOf(sym)}] ${n.title}:${n.sub.slice(0, 120)}`),
                 ...mktNews().slice(0, 8).map(n => `[大盤] ${n.title}`)].join('\n');
  try{
    const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {Authorization: 'Bearer ' + key, 'Content-Type': 'application/json'},
      body: JSON.stringify({model: await pickModel(key), temperature: 0.2, max_tokens: 400, messages: [
        {role: 'system', content: '你是加密貨幣新聞分析員。只根據使用者給的新聞判斷,不要編造。只輸出一個 JSON 物件:{"bias":整數 -2 到 2(負=利空,正=利多,0=中性或沒有相關新聞),"why":"繁體中文 30 字內的理由"}'},
        {role: 'user', content: `幣種:${baseOf(sym)}\n判斷這些新聞對它「未來幾天」價格的影響:\n${lines || '(沒有新聞)'}`},
      ]}),
    });
    const j = await r.json();
    if(!r.ok) throw new Error(j.error?.message || 'Groq 錯誤');
    const v = JSON.parse((j.choices[0].message.content.match(/\{[\s\S]*\}/) || ['{}'])[0]);
    v.bias = Math.max(-2, Math.min(2, Math.round(+v.bias || 0)));
    v.sym = sym;
    aiCache[sym] = {t: Date.now(), v};
    if(sym === S.sym) showAI(v);
  }catch(e){ $('ai').innerHTML = msg('warn', 'AI 判讀失敗:' + esc(e.message)); }
}
function showAI(v){
  st.ai = v;
  const txt = {'-2': '明顯利空', '-1': '偏利空', '0': '中性', '1': '偏利多', '2': '明顯利多'}[v.bias];
  $('ai').innerHTML = msg(v.bias > 0 ? 'ok' : v.bias < 0 ? 'bad' : 'warn', `AI 新聞判讀:<b>${txt}</b>|${esc(v.why || '')}<br><small>只看標題的粗略判斷,參考就好。</small>`);
  buildPlans(S.sym); renderCards();
}

/* =========================================================
   交易紀錄
   ========================================================= */
const openTrades = () => db.trades.filter(t => t.status === 'open');
const closedTrades = () => db.trades.filter(t => t.status === 'closed').sort((a, b) => a.exitTime - b.exitTime);

$('jSave').onclick = () => {
  const n = id => +$(id).value;
  const t = {id: Date.now().toString(36), time: Date.now(), status: 'open',
    sym: normSym($('jSym').value), term: $('jTerm').value, side: $('jSide').value,
    entry: n('jEntry'), stop: n('jStop'), tp1: n('jTp1'), tp2: n('jTp2'), qty: n('jQty'), lev: n('jLev') || 1,
    reason: $('jReason').value.trim(), rules: $('jRules').checked};
  if(!t.sym || !t.entry || !t.stop || !t.qty) return toast('幣、進場價、止損價、數量一定要填。', 'bad');
  if(t.side === 'long' ? t.stop >= t.entry : t.stop <= t.entry) return toast('止損方向反了。', 'bad');
  t.riskU = t.qty * Math.abs(t.entry - t.stop) + t.qty * t.entry * FEE;
  db.trades.push(t); saveDB();
  ['jEntry', 'jStop', 'jTp1', 'jTp2', 'jQty', 'jReason'].forEach(id => $(id).value = '');
  $('addBox').open = false;
  if(!S.watch.includes(t.sym)){ S.watch.push(t.sym); }
  toast(`已記下:${coinOf(t.sym)} ${TERM_NAME[t.term]}${SIDE[t.side]}。我會幫你盯著。`);
  renderJournal(); tick();
};

function closeTrade(id){
  const t = db.trades.find(x => x.id === id), exit = +$('ex-' + id).value, given = $('pl-' + id).value;
  if(!exit && given === '') return toast('填平倉價,或直接填幣安顯示的「已實現盈虧」。', 'bad');
  const s = t.side === 'long' ? 1 : -1;
  t.exit = exit || null;
  t.pnl = given !== '' ? +given : s * (exit - t.entry) * t.qty - t.qty * (t.entry + exit) / 2 * FEE;
  t.r = t.pnl / t.riskU;
  t.note = $('nt-' + id).value.trim();
  t.exitTime = Date.now(); t.status = 'closed';
  saveDB(); renderJournal();
  toast(t.pnl >= 0 ? `結算 +${fu(t.pnl)} U(${t.r.toFixed(2)}R)。……等待表揚。` : `結算 ${fu(t.pnl)} U(${t.r.toFixed(2)}R)。有照計畫止損就是好單。`, t.pnl >= 0 ? 'ok' : 'bad');
}
function delTrade(id){
  if(!confirm('確定刪掉這筆紀錄?(資料夾裡有「交易紀錄.備份.json」可以救回上一版)')) return;
  db.trades = db.trades.filter(x => x.id !== id); saveDB(); renderJournal();
}

// 持倉中:即時浮動盈虧 + 該怎麼調整
const hit = {};
function renderOpen(){
  // 使用者正在輸入平倉價時先不要重畫,免得打到一半被清掉
  if(document.activeElement && /^(ex|pl|nt)-/.test(document.activeElement.id)) return;
  const list = openTrades();
  // 全部持倉一起打到止損,總共會虧多少(止損移過進場價的單 = 0 風險)
  const totRisk = sum(list.map(t => Math.max(0, (t.side === 'long' ? 1 : -1) * (t.entry - t.stop) * t.qty)));
  const sameSide = list.length > 1 && list.every(t => t.side === list[0].side);
  const summary = list.length < 2 ? '' : msg(totRisk / S.total > 0.05 ? 'warn' : 'ok',
    `${list.length} 單全部打到止損,一共約虧 ${fu(totRisk)} U(總資金 ${pc(-totRisk / S.total)})。` +
    (totRisk / S.total > 0.05 ? '超過 5%,先別再開新單。' : '') +
    (sameSide ? `<br>全部都是${SIDE[list[0].side]}:幣圈常常一起漲跌,等於押同一件事。` : ''));
  $('openList').innerHTML = !list.length ? '<div class="sub">沒有持倉。</div>' : summary + list.map(t => {
    const p = st.price[t.sym], s = t.side === 'long' ? 1 : -1;
    const pnl = isFinite(p) ? s * (p - t.entry) * t.qty : NaN, r = pnl / t.riskU;
    const R = Math.abs(t.entry - t.stop);
    let tip = msg('ok', '照計畫抱著。別手動把止損拉遠。');
    if(isFinite(p)){
      if(t.tp2 && s * (p - t.tp2) >= 0){ tip = msg('ok', '到止盈2了 → 全部平倉,落袋。'); hitOnce(t, 'tp2', '到止盈2,全部平倉'); }
      else if(t.tp1 && s * (p - t.tp1) >= 0){ tip = msg('ok', '到止盈1了 → 先平一半,止損移到進場價(保本),剩下讓它跑。'); hitOnce(t, 'tp1', '到止盈1,先平一半+止損移保本'); }
      else if(s * (p - t.stop) <= 0) tip = msg('bad', '已經碰到止損價。如果止損單沒成交,現在就手動平掉。');
      else if(s * (t.entry - p) >= 0.7 * R) tip = msg('warn', '接近止損了。止損單在就好,不要加倉攤平。');
    }
    // SuperTrend 移動止損建議
    const term = TERMS.find(x => x.key === t.term), a = term && st.ana[t.sym] && st.ana[t.sym][term.tf];
    let trail = '';
    if(a && isFinite(p)){
      const L = t.side === 'long';
      if(L ? !a.stUp : a.stUp) trail = msg('warn', `${TF_NAME[term.tf]} SuperTrend 翻${a.stUp ? '多' : '空'}了 → 趨勢可能反轉,考慮提早出場。`);
      else if(S.params.trail && (L ? (a.st > t.stop && a.st < p) : (a.st < t.stop && a.st > p)))
        trail = msg('ok', `止損可以${L ? '上' : '下'}移到 SuperTrend 線 ${fp(a.st)}(少虧或鎖住利潤)。 <button onclick="moveStop('${t.id}', ${a.st})">已在幣安改好</button>`);
    }
    tip += trail;
    return `<div class="trade">
      <div><b>${coinOf(t.sym)}</b> ${TERM_NAME[t.term]} <b class="${t.side === 'long' ? 'g' : 'r'}">${SIDE[t.side]}</b> ${t.lev}x · 進 ${fp(t.entry)} · 損 ${fp(t.stop)} · 盈 ${fp(t.tp1)} / ${fp(t.tp2)} · ${fq(t.qty)} 顆
        <small>${new Date(t.time).toLocaleString()}</small></div>
      <div>現價 ${fp(p)} · 浮動 <b class="${pnl >= 0 ? 'up' : 'down'}">${isFinite(pnl) ? (pnl >= 0 ? '+' : '') + fu(pnl) + ' U' : '-'}</b>
        <small>(${isFinite(r) ? (r >= 0 ? '+' : '') + r.toFixed(2) + 'R' : '-'},總資金 ${isFinite(pnl) ? pc(pnl / S.total) : '-'})</small></div>
      ${t.reason ? `<small>理由:${esc(t.reason)}</small>` : ''}
      ${tip}
      <div class="row" style="margin-top:8px">
        <input id="ex-${t.id}" type="number" step="any" placeholder="平倉價">
        <input id="pl-${t.id}" type="number" step="any" placeholder="或填實際盈虧 U">
        <input id="nt-${t.id}" placeholder="心得(選填)" style="flex:1;min-width:120px">
        <button onclick="closeTrade('${t.id}')">結算</button>
        <button onclick="delTrade('${t.id}')">刪除</button>
      </div></div>`;
  }).join('');
}
function moveStop(id, v){
  const t = db.trades.find(x => x.id === id);
  t.stop = +fp(v); saveDB(); renderOpen();
  toast(`紀錄的止損改成 ${fp(v)}。`);
}
function hitOnce(t, what, text){
  const k = t.id + what;
  if(hit[k]) return;
  hit[k] = 1;
  notify(`${coinOf(t.sym)} 持倉:${text}`, `現價 ${fp(st.price[t.sym])}`);
}

function renderJournal(){
  renderOpen();
  const list = closedTrades().slice().reverse();
  $('closedList').innerHTML = !list.length ? '<div class="sub">還沒有結束的單。</div>' :
    `<div style="overflow:auto"><table class="tbl"><tr><th>日期</th><th>幣</th><th>期別</th><th>方向</th><th>進場</th><th>平倉</th><th>盈虧</th><th>R</th><th>守紀律</th><th>心得</th><th></th></tr>` +
    list.map(t => `<tr><td>${new Date(t.exitTime).toLocaleDateString()}</td><td>${coinOf(t.sym)}</td><td>${TERM_NAME[t.term]}</td>
      <td class="${t.side === 'long' ? 'g' : 'r'}">${SIDE[t.side]}</td><td>${fp(t.entry)}</td><td>${fp(t.exit)}</td>
      <td class="${t.pnl >= 0 ? 'up' : 'down'}">${t.pnl >= 0 ? '+' : ''}${fu(t.pnl)} U<br><small>${pc(t.pnl / S.total)}</small></td>
      <td>${t.r.toFixed(2)}</td><td>${t.rules ? '✓' : '<span class="r">✗</span>'}</td><td><small>${esc(t.note || '')}</small></td>
      <td><button class="x" onclick="delTrade('${t.id}')">×</button></td></tr>`).join('') + '</table></div>';
  renderCoach(); renderDay();
}

/* ---------- 教練室:看紀錄,給調整建議 ---------- */
function statsOf(list){
  if(!list.length) return null;
  const w = list.filter(t => t.pnl > 0), l = list.filter(t => t.pnl <= 0);
  let run = 0, maxRun = 0;
  list.forEach(t => { run = t.pnl <= 0 ? run + 1 : 0; maxRun = Math.max(maxRun, run); });
  return {n: list.length, win: w.length / list.length, avgW: avg(w.map(t => t.r)), avgL: avg(l.map(t => t.r)),
          exp: avg(list.map(t => t.r)), pnl: sum(list.map(t => t.pnl)), maxRun};
}
function renderCoach(){
  const all = closedTrades(), s = statsOf(all), tips = [];
  let risk = Math.min(S.risk, 2);
  if(!s){ $('coach').innerHTML = '<div class="sub">還沒有結束的單。每一單都記下來,5 單以後我就看得出你的習慣。</div>'; return; }
  const last20 = statsOf(all.slice(-20)), last3 = all.slice(-3);
  // 資金回撤:從最高點掉了多少
  let eq = 0, peak = 0; all.forEach(t => { eq += t.pnl; peak = Math.max(peak, eq); });
  const dd = (peak - eq) / S.total;
  if(all.length < 5) tips.push(['warn', `才 ${all.length} 單,樣本太少,先照 ${risk}% 做,再記 ${5 - all.length} 單我就能判斷。`]);
  if(last3.length === 3 && last3.every(t => t.pnl <= 0)){ risk = Math.max(0.5, S.risk / 2); tips.push(['bad', '連虧 3 單 → 風險先減半,手感回來再說。']); }
  if(dd >= 0.1){ risk = Math.min(risk, 1); tips.push(['bad', `從最高點回撤 ${(dd * 100).toFixed(1)}% → 單筆風險降到 1%,先止血。`]); }
  if(all.length >= 10 && last20.exp < 0){ risk = Math.min(risk, 1); tips.push(['bad', `最近 ${last20.n} 單平均每單 ${last20.exp.toFixed(2)}R(賠錢) → 減量,回頭看是不是逆勢或沒守紀律。`]); }
  if(all.length >= 10 && last20.exp >= 0.3 && dd < 0.05) tips.push(['ok', `最近平均每單 +${last20.exp.toFixed(2)}R,做法有效,維持,不要加碼到 2% 以上。`]);
  if(s.avgL < -1.2) tips.push(['warn', `平均虧損 ${s.avgL.toFixed(2)}R,超過計畫的 1R → 止損沒掛、或打到了還在拗。`]);
  if(s.n >= 5 && s.win >= 0.55 && s.avgW < 1) tips.push(['warn', `勝率 ${(s.win * 100).toFixed(0)}% 但平均只賺 ${s.avgW.toFixed(2)}R → 太早跑,讓一半倉位跑到止盈2。`]);
  const broke = all.filter(t => !t.rules);
  if(broke.length){ const bp = sum(broke.map(t => t.pnl)); if(bp < 0) tips.push(['bad', `沒守紀律的 ${broke.length} 單,一共虧 ${fu(bp)} U。證據在這。`]); }
  TERMS.forEach(T => {
    const ts = statsOf(all.filter(t => t.term === T.key));
    if(ts && ts.n >= 5 && ts.exp < 0) tips.push(['warn', `「${T.name}」${ts.n} 單平均 ${ts.exp.toFixed(2)}R(負的)→ 先暫停${T.name},把那份資金移給做得好的。`]);
  });
  if(!tips.length) tips.push(['ok', '目前沒有需要調整的地方,照規則繼續。']);

  const box = (label, v, cls = '') => `<div><small>${label}</small><b class="${cls}">${v}</b></div>`;
  const byTerm = TERMS.map(T => { const x = statsOf(all.filter(t => t.term === T.key));
    return x ? `<tr><td>${T.name}</td><td>${x.n}</td><td>${(x.win * 100).toFixed(0)}%</td><td class="${x.exp >= 0 ? 'up' : 'down'}">${x.exp.toFixed(2)}R</td><td class="${x.pnl >= 0 ? 'up' : 'down'}">${fu(x.pnl)} U</td></tr>` : ''; }).join('');
  $('coach').innerHTML = `<div class="stat">
      ${box('總單數', s.n)}${box('勝率', (s.win * 100).toFixed(0) + '%')}
      ${box('平均每單', (s.exp >= 0 ? '+' : '') + s.exp.toFixed(2) + 'R', s.exp >= 0 ? 'up' : 'down')}
      ${box('總盈虧', (s.pnl >= 0 ? '+' : '') + fu(s.pnl) + ' U', s.pnl >= 0 ? 'up' : 'down')}
      ${box('佔總資金', pc(s.pnl / S.total), s.pnl >= 0 ? 'up' : 'down')}
      ${box('賺的平均 / 虧的平均', `${s.avgW.toFixed(2)}R / ${s.avgL.toFixed(2)}R`)}
      ${box('最多連虧', s.maxRun + ' 單')}
    </div>
    ${byTerm ? `<table class="tbl" style="margin-bottom:8px"><tr><th>期別</th><th>單數</th><th>勝率</th><th>平均</th><th>盈虧</th></tr>${byTerm}</table>` : ''}
    ${tips.map(t => msg(t[0], t[1])).join('')}
    <div class="row" style="margin-top:10px"><span>建議單筆風險:<b>${risk}%</b>(現在 ${S.risk}%)</span>
      ${risk !== S.risk ? `<button onclick="applyRisk(${risk})" class="on">套用</button>` : ''}</div>
    <div class="sub" style="margin-top:4px">R = 以「計畫止損會虧的錢」為 1 單位。+2R = 賺了兩倍風險。</div>`;
}
function applyRisk(r){ S.risk = r; $('sRisk').value = r; saveDB(); refreshAllPlans(); renderCoach(); toast(`單筆風險改成 ${r}%。`); }

/* ---------- 鐵紀律 + 今日戰績 ---------- */
const rules = [...document.querySelectorAll('.rule')];
function renderRules(){
  const n = rules.filter(r => r.checked).length;
  $('ruleOut').innerHTML = n === rules.length ? msg('ok', '五條都勾了,可以按下單。') : msg('warn', `還差 ${rules.length - n} 條,先別按。`);
}
rules.forEach(r => r.onchange = renderRules);
$('newTrade').onclick = () => { rules.forEach(r => r.checked = false); renderRules(); };
function renderDay(){
  const today = closedTrades().filter(t => dayKey(t.exitTime) === dayKey(Date.now()));
  const loss = today.filter(t => t.pnl <= 0).length, win = today.length - loss, pnl = sum(today.map(t => t.pnl));
  const t = `今天:賺 ${win} 單、虧 ${loss} 單,合計 ${pnl >= 0 ? '+' : ''}${fu(pnl)} U。`;
  $('dayOut').innerHTML = loss >= 2 ? msg('bad', t + '已經虧兩單 → 今天到此為止,關 App。明天市場還在。')
                                    : msg(loss ? 'warn' : 'ok', t + '規則:一天虧兩單就停手。');
}

/* =========================================================
   大盤燈:BTC 在 200 日均線上面 = 牛市,下面 = 熊市
   熊市:單筆風險自動砍半;逆大盤的單亮紅字(濾網開著就直接不做)
   ========================================================= */
const regimeOf = d => d > 0.03 ? 'bull' : d < -0.03 ? 'bear' : 'mid';
const REGIME = {bull: ['🟢 牛市', 'g'], bear: ['🔴 熊市', 'r'], mid: ['🟡 盤整', 'y']};
const effRisk = () => st.regime && st.regime.state === 'bear' ? S.risk / 2 : S.risk;
async function loadRegime(){
  try{
    const bars = await klines('BTCUSDT', '1d'), c = bars.slice(0, -1).map(b => b.c);
    const ma = avg(c.slice(-200)), ma0 = avg(c.slice(-220, -20)), p = bars.at(-1).c, d = p / ma - 1;
    st.regime = {state: regimeOf(d), p, ma, d, rising: ma > ma0};
  }catch(e){}
  renderRegime();
}
function renderRegime(){
  const r = st.regime, el = $('regime');
  if(!r){ el.textContent = '大盤 …'; return; }
  el.innerHTML = `大盤 <b class="${REGIME[r.state][1]}">${REGIME[r.state][0]}</b>`;
  el.title = `BTC ${fp(r.p)}|200 日均線 ${fp(r.ma)}(${pc(r.d)})|均線${r.rising ? '向上' : '向下'}`;
}
$('regime').onclick = () => {
  const r = st.regime; if(!r) return;
  toast(`${REGIME[r.state][0]}:BTC ${fp(r.p)},在 200 日均線 ${fp(r.ma)} 的${r.d >= 0 ? '上' : '下'}方 ${pc(r.d)},均線${r.rising ? '向上' : '向下'}。\n上方 3% 以上 = 牛市、下方 3% 以上 = 熊市、中間 = 盤整。\n熊市時單筆風險自動砍半;逆大盤的單會亮紅字${S.params.regime ? '(濾網開著:直接不做)' : ''}。`, 'ok', 15000);
};

/* =========================================================
   回測室:把「同一套規則」丟回過去的 K 線跑一遍,看真實勝率
   規則:兩個週期同方向 → 計畫進場(到進場區才進)→ 止損 / 止盈1 平一半並移保本 / 止盈2
   不偷看未來:每一根只用「那時候已經收完」的資料
   ========================================================= */
const BT_SPAN = {short: 60, mid: 540, long: 1500};          // 回測幾天
const TF_MS = {'15m': 9e5, '1h': 36e5, '4h': 144e5, '1d': 864e5, '1w': 6048e5};
const hcache = {};

// 往回翻頁抓很多根 K 線(幣安一次最多 1500 根)
async function history(sym, tf, count){
  const key = sym + '|' + tf + '|' + count, c = hcache[key];
  if(c && Date.now() - c.t < 10 * 60e3) return c.bars;
  let out = [], end;
  while(out.length < count){
    const lim = Math.min(1500, count - out.length);
    const j = await (await fetch(`${FAPI}/fapi/v1/klines?symbol=${sym}&interval=${tf}&limit=${lim}${end ? '&endTime=' + end : ''}`)).json();
    if(!Array.isArray(j)) throw new Error(j.code === -1121 ? `找不到 ${sym}` : (j.msg || 'API 錯誤'));
    if(!j.length) break;
    const b = j.map(k => ({t: k[0], o: +k[1], h: +k[2], l: +k[3], c: +k[4], v: +k[5], T: k[6]}));
    out = b.concat(out); end = b[0].t - 1;
    if(j.length < lim) break;
  }
  out = out.slice(0, -1);   // 最後一根還沒收完
  hcache[key] = {t: Date.now(), bars: out};
  return out;
}

function adxSeries(b, n = 14){
  const out = new Array(b.length).fill(null);
  let st = 0, sp = 0, sm = 0, k = 0, adx = null, dsum = 0;
  for(let i = 1; i < b.length; i++){
    const up = b[i].h - b[i - 1].h, dn = b[i - 1].l - b[i].l;
    const tr = Math.max(b[i].h - b[i].l, Math.abs(b[i].h - b[i - 1].c), Math.abs(b[i].l - b[i - 1].c));
    const p = up > dn && up > 0 ? up : 0, m = dn > up && dn > 0 ? dn : 0;
    if(i <= n){ st += tr; sp += p; sm += m; if(i < n) continue; }
    else { st = st - st / n + tr; sp = sp - sp / n + p; sm = sm - sm / n + m; }
    const P = sp / st, M = sm / st, dx = P + M === 0 ? 0 : 100 * Math.abs(P - M) / (P + M);
    k++;
    if(k < n) dsum += dx;
    else if(k === n) adx = (dsum + dx) / n;
    else adx = (adx * (n - 1) + dx) / n;
    if(adx != null) out[i] = adx;
  }
  return out;
}

// 每一根 K 收盤時的方向(和即時判斷同一條規則)
function dirSeries(bars, P){
  const c = bars.map(b => b.c), e20 = emaSeries(c, 20), e50 = emaSeries(c, 50);
  const adx = adxSeries(bars), ST = superTrend(bars, 10, P.stK), atr = atrSeries(bars, 14);
  const dir = bars.map((b, i) => {
    if(e50[i] == null || adx[i] == null || ST.up[i] == null) return 'none';
    const up = c[i] > e50[i] && e20[i] > e50[i], dn = c[i] < e50[i] && e20[i] < e50[i];
    if(adx[i] >= P.adx && up && ST.up[i]) return 'long';
    if(adx[i] >= P.adx && dn && !ST.up[i]) return 'short';
    return 'none';
  });
  return {dir, e20, atr, st: ST.line, stUp: ST.up};
}

function regimeSeries(btc){
  const c = btc.map(b => b.c), out = [];
  let s = 0;
  for(let i = 0; i < c.length; i++){
    s += c[i]; if(i >= 200) s -= c[i - 200];
    out.push(i >= 199 ? regimeOf(c[i] / (s / 200) - 1) : 'mid');
  }
  return {T: btc.map(b => b.T), st: out};
}

// 跑一次模擬。M = 主週期、H = 大週期(都已收盤);回傳每一筆交易的 R
function simulate(M, H, P, RG){
  const sm = dirSeries(M, P), sh = dirSeries(H, P), piv = pivotsOf(M);
  const trades = [];
  let j = -1, k = -1, pv = 0, pos = null, order = null;
  const close = (b, parts) => {
    const s = pos.L ? 1 : -1, risk = Math.abs(pos.fill - pos.stop0) + pos.fill * FEE;
    const r = (sum(parts.map(([f, x]) => f * s * (x - pos.fill))) - pos.fill * FEE) / risk;
    trades.push({t0: pos.t0, t1: b.T, L: pos.L, fill: pos.fill, exit: parts.at(-1)[1], r});
    pos = null;
  };
  for(let i = 60; i < M.length; i++){
    const b = M[i];
    while(j + 1 < H.length && H[j + 1].T <= b.T) j++;
    // 1) 有單在手:先看止損(保守:同一根同時碰到,算先打到止損)
    if(pos){
      const L = pos.L;
      if(L ? b.l <= pos.stop : b.h >= pos.stop){ close(b, [...pos.parts, [pos.left, pos.stop]]); }
      else{
        if(!pos.half && (L ? b.h >= pos.tp1 : b.l <= pos.tp1)){ pos.half = true; pos.parts.push([0.5, pos.tp1]); pos.left = 0.5; pos.stop = pos.fill; }
        if(pos.half && (L ? b.h >= pos.tp2 : b.l <= pos.tp2)) close(b, [...pos.parts, [0.5, pos.tp2]]);
        else if(P.trail && sm.st[i] != null && sm.stUp[i] === L && (L ? sm.st[i] > pos.stop : sm.st[i] < pos.stop)) pos.stop = sm.st[i];
      }
      continue;
    }
    // 2) 掛著的單:這根有沒有成交
    if(order){
      if(i - order.i > 12 || sm.dir[i - 1] !== order.dir){ order = null; }
      else{
        const L = order.L;
        const hit = order.market || (L ? b.l <= order.entry : b.h >= order.entry);
        if(hit){
          const fill = order.market ? b.o : (L ? Math.min(b.o, order.entry) : Math.max(b.o, order.entry));
          if(L ? fill > order.stop : fill < order.stop){
            pos = {L, fill, stop: order.stop, stop0: order.stop, tp1: order.tp1, tp2: order.tp2, parts: [], left: 1, half: false, t0: b.t};
            if(L ? b.l <= pos.stop : b.h >= pos.stop) close(b, [[1, pos.stop]]);
          }
          order = null;
        }
        continue;
      }
    }
    // 3) 這根收盤:兩個週期同方向 → 下計畫
    const d = sm.dir[i], hd = j >= 0 ? sh.dir[j] : 'none';
    if(d === 'none' || d !== hd) continue;
    if(P.regime && RG){
      while(k + 1 < RG.T.length && RG.T[k + 1] <= b.T) k++;
      const r = k >= 0 ? RG.st[k] : 'mid';
      if((r === 'bear' && d === 'long') || (r === 'bull' && d === 'short')) continue;
    }
    while(pv < piv.length && piv[pv].i < i - 199) pv++;   // 只用視窗內、已確認的轉折
    const win = [];
    for(let q = pv; q < piv.length && piv[q].i <= i - 5; q++) win.push(piv[q]);
    const L = d === 'long', a = sm.atr[i];
    const pc0 = planCore(L, b.c, {e20: sm.e20[i], atr: a, lv: clusterLevels(win, a, b.c, i - 30)});
    const go = L ? b.c <= pc0.entry + 0.3 * a : b.c >= pc0.entry - 0.3 * a;
    order = {L, dir: d, i, market: go, entry: pc0.entry, stop: pc0.stop, tp1: pc0.tp1, tp2: pc0.tp2};
  }
  return trades;
}

function btStats(trades){
  const n = trades.length;
  if(!n) return {n: 0, win: 0, exp: 0, tot: 0, dd: 0, run: 0, avgW: 0, avgL: 0};
  const w = trades.filter(t => t.r > 0), l = trades.filter(t => t.r <= 0);
  let eq = 0, peak = 0, dd = 0, run = 0, maxRun = 0;
  trades.forEach(t => { eq += t.r; peak = Math.max(peak, eq); dd = Math.max(dd, peak - eq); run = t.r <= 0 ? run + 1 : 0; maxRun = Math.max(maxRun, run); });
  return {n, win: w.length / n, exp: eq / n, tot: eq, dd, run: maxRun, avgW: avg(w.map(t => t.r)), avgL: avg(l.map(t => t.r))};
}

async function btData(sym, termKey){
  const T = TERMS.find(x => x.key === termKey), days = BT_SPAN[termKey];
  const nM = Math.ceil(days * 864e5 / TF_MS[T.tf]) + 300, nH = Math.ceil(days * 864e5 / TF_MS[T.htf]) + 300;
  const [M, H, B] = await Promise.all([history(sym, T.tf, nM), history(sym, T.htf, nH), history('BTCUSDT', '1d', days + 260)]);
  if(M.length < 200) throw new Error(`${coinOf(sym)} 上市太短,${T.name}資料不夠回測。`);
  return {T, M, H, RG: regimeSeries(B)};
}

const paramTxt = P => `ADX ≥ ${P.adx} · SuperTrend 因子 ${P.stK} · 大盤濾網${P.regime ? '開' : '關'} · SuperTrend 移動止損${P.trail ? '開' : '關'}`;
const paramKey = P => [P.adx, P.stK, +P.regime, +P.trail].join('/');
// 把回測結果記下來,計畫卡上會顯示「這個幣這個期別,過去賺不賺」
function saveBt(sym, term, s){
  db.bt = db.bt || {};
  db.bt[sym + '|' + term] = {n: s.n, win: s.win, exp: s.exp, t: Date.now(), p: paramKey(S.params)};
  saveDB(); renderCards();
}
function btNote(sym, term){
  const b = (db.bt || {})[sym + '|' + term];
  if(!b || b.p !== paramKey(S.params)) return null;
  return b;
}
const riskUNow = () => S.total * S.risk / 100;
function statBoxes(s){
  const box = (label, v, cls = '') => `<div><small>${label}</small><b class="${cls}">${v}</b></div>`;
  const u = riskUNow();
  return `<div class="stat">
    ${box('交易數', s.n)}${box('勝率', (s.win * 100).toFixed(0) + '%')}
    ${box('平均每單', (s.exp >= 0 ? '+' : '') + s.exp.toFixed(2) + 'R', s.exp >= 0 ? 'up' : 'down')}
    ${box('總共', (s.tot >= 0 ? '+' : '') + s.tot.toFixed(1) + 'R', s.tot >= 0 ? 'up' : 'down')}
    ${box(`換算(單筆 ${fu(u)} U)`, (s.tot >= 0 ? '+' : '') + fu(s.tot * u) + ' U', s.tot >= 0 ? 'up' : 'down')}
    ${box('最大回撤', '-' + s.dd.toFixed(1) + 'R(' + fu(s.dd * u) + ' U)', 'down')}
    ${box('最多連虧', s.run + ' 單')}
    ${box('賺的平均 / 虧的平均', `${s.avgW.toFixed(2)}R / ${s.avgL.toFixed(2)}R`)}
  </div>`;
}
function verdict(s, name){
  if(s.n < 30) return msg('warn', `只有 ${s.n} 單,樣本太少(至少 30 單才比較可信),結果參考就好。`);
  if(s.exp >= 0.15) return msg('ok', `這套規則在${name}過去是賺錢的:平均每單 +${s.exp.toFixed(2)}R。`);
  if(s.exp > 0) return msg('warn', `微幅賺錢(每單 +${s.exp.toFixed(2)}R),扣掉資金費率可能打平。`);
  return msg('bad', `這套規則在${name}過去是賠錢的(每單 ${s.exp.toFixed(2)}R)→ 這個期別先別做,或換參數/換幣。`);
}

let btChart, btLine, btBusy = false;
function btLock(on, text){
  btBusy = on;
  ['btRun', 'btGrid', 'btAll'].forEach(id => $(id).disabled = on);
  if(text != null) $('btOut').innerHTML = `<div class="sub" style="margin-top:8px">${text}</div>`;
}
function renderBtParams(){ $('btParams').textContent = '目前參數:' + paramTxt(S.params); }

$('btRun').onclick = async () => {
  if(btBusy) return;
  const sym = normSym($('btSym').value) || S.sym, term = $('btTerm').value;
  $('btSym').value = sym; $('btGridOut').innerHTML = '';
  btLock(true, `抓 ${coinOf(sym)} 的歷史 K 線中…(第一次比較久)`);
  try{
    const {T, M, H, RG} = await btData(sym, term);
    const trades = simulate(M, H, S.params, RG), s = btStats(trades);
    saveBt(sym, term, s);
    const from = new Date(M[60].t).toLocaleDateString(), to = new Date(M.at(-1).T).toLocaleDateString();
    $('btOut').innerHTML = `<div class="sub" style="margin:8px 0">${coinOf(sym)} ${T.name}(${TF_NAME[T.tf]}+${TF_NAME[T.htf]})· ${from} ~ ${to} · ${paramTxt(S.params)}</div>`
      + statBoxes(s) + verdict(s, `${coinOf(sym)} ${T.name}`)
      + `<div class="sub" style="margin-top:6px">回測沒算資金費率和滑價;過去賺錢不代表未來也賺。</div>`
      + (trades.length ? `<details style="margin-top:8px"><summary class="sub" style="cursor:pointer">最近 20 筆交易</summary><div style="overflow:auto"><table class="tbl"><tr><th>進場時間</th><th>方向</th><th>進場</th><th>出場</th><th>結果</th></tr>`
        + trades.slice(-20).reverse().map(t => `<tr><td>${new Date(t.t0).toLocaleString()}</td><td class="${t.L ? 'g' : 'r'}">${t.L ? '做多' : '做空'}</td><td>${fp(t.fill)}</td><td>${fp(t.exit)}</td><td class="${t.r > 0 ? 'up' : 'down'}">${t.r >= 0 ? '+' : ''}${t.r.toFixed(2)}R</td></tr>`).join('')
        + '</table></div></details>' : '');
    drawEquity(trades);
  }catch(e){ $('btOut').innerHTML = msg('bad', '回測失敗:' + esc(e.message)); }
  btLock(false);
};

// 資金曲線:每一單結束後累積了幾 R
function drawEquity(trades){
  const box = $('btChart');
  if(!window.LightweightCharts || !trades.length){ box.style.display = 'none'; return; }
  box.style.display = 'block';
  if(!btChart){
    btChart = LightweightCharts.createChart(box, {autoSize: true, layout: {background: {color: '#1a1d24'}, textColor: '#c9ced6'},
      grid: {vertLines: {color: '#222631'}, horzLines: {color: '#222631'}}, timeScale: {borderColor: '#2a2f3a'}, rightPriceScale: {borderColor: '#2a2f3a'}});
    btLine = btChart.addBaselineSeries({baseValue: {type: 'price', price: 0}, priceFormat: {type: 'custom', formatter: v => v.toFixed(1) + 'R'}});
  }
  let eq = 0, last = 0;
  const data = trades.map(t => { eq += t.r; let time = Math.floor(t.t1 / 1000) + TZ; if(time <= last) time = last + 1; last = time; return {time, value: eq}; });
  btLine.setData(data);
  btChart.timeScale().fitContent();
}

// 比較參數:同一個幣、同一段時間,換 24 組參數各跑一次
$('btGrid').onclick = async () => {
  if(btBusy) return;
  const sym = normSym($('btSym').value) || S.sym, term = $('btTerm').value;
  $('btSym').value = sym;
  btLock(true, `抓資料、跑 24 組參數中…`);
  try{
    const {T, M, H, RG} = await btData(sym, term), rows = [];
    for(const adx of [15, 20, 25]) for(const stK of [3, 4]) for(const regime of [false, true]) for(const trail of [false, true]){
      const P = {adx, stK, regime, trail};
      rows.push({P, s: btStats(simulate(M, H, P, RG))});
    }
    rows.sort((a, b) => b.s.tot - a.s.tot);
    const same = P => ['adx', 'stK', 'regime', 'trail'].every(k => P[k] === S.params[k]);
    const best = rows.find(r => r.s.n >= 30);
    $('btOut').innerHTML = `<div class="sub" style="margin-top:8px">${coinOf(sym)} ${T.name}:24 組參數,依「總共賺幾 R」排序。</div>`
      + (best ? msg(best.s.exp > 0 ? 'ok' : 'bad', `樣本夠(≥30 單)的最好一組:${paramTxt(best.P)} → 平均每單 ${best.s.exp.toFixed(2)}R`) : msg('warn', '每一組都不到 30 單,樣本太少,先別換參數。'))
      + msg('warn', '小心「挑到剛好適合過去的參數」:換一個幣或期別也要好,才算真的好。');
    $('btGridOut').innerHTML = `<div style="overflow:auto;margin-top:8px"><table class="tbl"><tr><th>ADX</th><th>因子</th><th>大盤濾網</th><th>移動止損</th><th>單數</th><th>勝率</th><th>平均</th><th>總共</th><th>最大回撤</th><th></th></tr>`
      + rows.map(({P, s}) => `<tr style="${same(P) ? 'background:#221d33' : ''}"><td>${P.adx}</td><td>${P.stK}</td><td>${P.regime ? '開' : '關'}</td><td>${P.trail ? '開' : '關'}</td>
          <td>${s.n}${s.n < 30 ? ' <small class="y">少</small>' : ''}</td><td>${(s.win * 100).toFixed(0)}%</td>
          <td class="${s.exp >= 0 ? 'up' : 'down'}">${s.exp.toFixed(2)}R</td><td class="${s.tot >= 0 ? 'up' : 'down'}">${s.tot.toFixed(1)}R</td><td>-${s.dd.toFixed(1)}R</td>
          <td>${same(P) ? '<small>使用中</small>' : `<button onclick='applyParams(${JSON.stringify(P)})'>套用</button>`}</td></tr>`).join('')
      + '</table></div>';
    $('btChart').style.display = 'none';
  }catch(e){ $('btOut').innerHTML = msg('bad', '回測失敗:' + esc(e.message)); }
  btLock(false);
};
function applyParams(P){
  S.params = {...P}; saveDB(); renderBtParams();
  tick().then(() => { if(chart) loadChart(); });   // 規則換了,全部重新判斷
  toast(`已套用:${paramTxt(P)}。計畫卡、提醒都改用這組。`);
}

// 監控清單每個幣 × 短中長,用目前參數一次跑完
$('btAll').onclick = async () => {
  if(btBusy) return;
  btLock(true);
  const rows = [];
  $('btChart').style.display = 'none'; $('btGridOut').innerHTML = '';
  for(const sym of S.watch) for(const T of TERMS){
    $('btOut').innerHTML = `<div class="sub" style="margin-top:8px">回測中:${coinOf(sym)} ${T.name}…(${rows.length + 1}/${S.watch.length * 3})</div>`;
    try{
      const {M, H, RG} = await btData(sym, T.key), s = btStats(simulate(M, H, S.params, RG));
      rows.push({sym, T, s}); saveBt(sym, T.key, s);
    }
    catch(e){ rows.push({sym, T, err: e.message}); }
  }
  $('btOut').innerHTML = `<div class="sub" style="margin:8px 0">${paramTxt(S.params)}|短線看近 ${BT_SPAN.short} 天、中線 ${BT_SPAN.mid} 天、長線 ${BT_SPAN.long} 天</div>`
    + `<div style="overflow:auto"><table class="tbl"><tr><th>幣</th><th>期別</th><th>單數</th><th>勝率</th><th>平均</th><th>總共</th><th>最大回撤</th><th>結論</th></tr>`
    + rows.map(r => r.err ? `<tr><td>${coinOf(r.sym)}</td><td>${r.T.name}</td><td colspan="6" class="sub">${esc(r.err)}</td></tr>`
      : `<tr><td>${coinOf(r.sym)}</td><td>${r.T.name}</td><td>${r.s.n}</td><td>${(r.s.win * 100).toFixed(0)}%</td>
          <td class="${r.s.exp >= 0 ? 'up' : 'down'}">${r.s.exp.toFixed(2)}R</td><td class="${r.s.tot >= 0 ? 'up' : 'down'}">${r.s.tot.toFixed(1)}R</td><td>-${r.s.dd.toFixed(1)}R</td>
          <td>${r.s.n < 30 ? '<span class="y">樣本少</span>' : r.s.exp >= 0.15 ? '<span class="g">可以做</span>' : r.s.exp > 0 ? '<span class="y">勉強</span>' : '<span class="r">別做</span>'}</td></tr>`).join('')
    + '</table></div>';
  btLock(false);
};

/* =========================================================
   現貨定投:不用槓桿、不會爆倉,長期慢慢買
   便宜分數:越便宜分數越高 → 這期多買;太貴 → 少買
   ========================================================= */
const FREQ = {week: '每週', '2week': '每兩週', month: '每月'};
const WEEKDAY = ['', '週一', '週二', '週三', '週四', '週五', '週六', '週日'];
const REF_MON = new Date(2024, 0, 1).getTime();      // 2024/1/1 是星期一,用來數「第幾週」
const spotCache = {};

async function spotAna(sym){
  const c = spotCache[sym];
  if(c && Date.now() - c.t < 5 * 60e3) return c.v;
  const [d, w] = await Promise.all([klines(sym, '1d', true, 400), klines(sym, '1w', true, 150)]);
  const p = d.at(-1).c, dc = d.map(b => b.c), wc = w.slice(0, -1).map(b => b.c);
  const ma200 = dc.length >= 200 ? avg(dc.slice(-200)) : null;
  const dd = p / Math.max(...d.slice(-365).map(b => b.h)) - 1;
  const wr = wc.length > 15 ? rsi(wc) : null;
  const wbb = wc.length >= 20 ? bollinger(wc) : null;
  const pts = [];   // [分數, 理由]
  if(ma200){
    const r = p / ma200 - 1;
    pts.push(r < -0.2 ? [2, `比 200 日均線低 ${pc(r)}(很便宜)`] : r < 0 ? [1, `在 200 日均線下 ${pc(r)}`]
           : r > 0.5 ? [-1, `比 200 日均線高 ${pc(r)}(偏貴)`] : [0, `在 200 日均線上 ${pc(r)}`]);
  }else pts.push([0, '上市不到 200 天,少一項判斷']);
  if(wr != null) pts.push(wr < 30 ? [2, `週 RSI ${wr.toFixed(0)}(跌過頭)`] : wr < 40 ? [1, `週 RSI ${wr.toFixed(0)}(偏弱)`]
                        : wr > 75 ? [-1, `週 RSI ${wr.toFixed(0)}(漲過頭)`] : [0, `週 RSI ${wr.toFixed(0)}`]);
  if(wbb){
    if(p < wbb.l.at(-1)) pts.push([1, '跌破週布林下軌']);
    else if(p > wbb.u.at(-1)) pts.push([-1, '衝出週布林上軌']);
  }
  pts.push(dd <= -0.5 ? [1, `離一年高點 ${pc(dd)}`] : [0, `離一年高點 ${pc(dd)}`]);
  if(st.fng != null) pts.push(st.fng <= 25 ? [1, `恐懼貪婪 ${st.fng}(大家很怕)`] : st.fng >= 80 ? [-1, `恐懼貪婪 ${st.fng}(大家很貪)`] : [0, `恐懼貪婪 ${st.fng}`]);
  const score = sum(pts.map(x => x[0]));
  const mult = score >= 5 ? 2 : score >= 3 ? 1.5 : score >= 1 ? 1.25 : score <= -2 ? 0.5 : score <= -1 ? 0.75 : 1;
  const v = {p, pts, score, mult, big: score >= 5};
  spotCache[sym] = {t: Date.now(), v};
  return v;
}

function weekIdx(d){ const x = new Date(d); x.setHours(0, 0, 0, 0); x.setDate(x.getDate() - (x.getDay() + 6) % 7); return Math.round((x - REF_MON) / (7 * 864e5)); }
function periodKey(p, d){
  d = new Date(d);
  return p.freq === 'month' ? `m${d.getFullYear()}-${d.getMonth()}` : p.freq === '2week' ? `b${Math.floor(weekIdx(d) / 2)}` : `w${weekIdx(d)}`;
}
function dueInfo(p){
  const now = new Date(), key = periodKey(p, now);
  if(db.spot.some(r => r.sym === p.sym && r.plan && periodKey(p, r.time) === key)) return {state: 'done', text: '本期已買 ✓'};
  const dow = (now.getDay() + 6) % 7 + 1;   // 1 = 週一 … 7 = 週日
  const due = p.freq === 'month' ? now.getDate() >= p.day
            : p.freq === '2week' ? (weekIdx(now) % 2 === 1 || dow >= p.day)
            : dow >= p.day;
  return due ? {state: 'due', text: '該買了'} : {state: 'wait', text: `${p.freq === 'month' ? p.day + ' 號' : WEEKDAY[p.day]}再買`};
}

const spotSyms = () => [...new Set([...S.spot.plans.map(p => p.sym), ...db.spot.map(r => r.sym)])];
const spotNotified = {};
async function spotTick(){
  if(st.fng == null){ try{ st.fng = +(await (await fetch('https://api.alternative.me/fng/?limit=1')).json()).data[0].value; }catch(e){} }
  for(const sym of spotSyms()){
    try{ st.spot[sym] = await spotAna(sym); delete st.spotErr[sym]; }catch(e){ st.spotErr[sym] = e.message; }
  }
  const today = dayKey(Date.now());
  S.spot.plans.forEach(p => {
    const a = st.spot[p.sym]; if(!a) return;
    if(dueInfo(p).state === 'due' && !spotNotified['d' + p.sym + today]){
      spotNotified['d' + p.sym + today] = 1;
      notify(`定投日:${coinOf(p.sym)}`, `這期買 ${fu(p.amt * a.mult)} U(${a.mult} 倍,便宜分數 ${a.score})`, true);
    }
    if(a.big && !spotNotified['b' + p.sym + today]){
      spotNotified['b' + p.sym + today] = 1;
      notify(`${coinOf(p.sym)} 進入「大筆買入區」`, `便宜分數 ${a.score}。可分 3 批,每批 ${fu(S.spot.budget / 3)} U,一週一批。`, true);
    }
  });
  renderSpot();
}

function renderSpot(){
  if(document.activeElement && /^sp[UP]-/.test(document.activeElement.id)) return;   // 正在打字就先別重畫
  const plans = S.spot.plans;
  const monthly = sum(plans.map(p => p.amt * (p.freq === 'week' ? 4.35 : p.freq === '2week' ? 2.17 : 1)));
  $('spotSum').innerHTML = plans.length
    ? `照目前計畫每月約 ${fu(monthly)} U(1 倍時),現貨 ${fu(S.spot.budget)} U 大約撐 ${monthly ? (S.spot.budget / monthly).toFixed(1) : '-'} 個月。` : '';
  $('spotList').innerHTML = !plans.length
    ? '<div class="sub" style="margin-top:8px">還沒有定投計畫。上面填好按「加入定投」,例:BTC、每週一、10 U。</div>'
    : plans.map((p, i) => {
      const a = st.spot[p.sym], due = dueInfo(p), err = st.spotErr[p.sym];
      const when = p.freq === 'month' ? `每月 ${p.day} 號` : FREQ[p.freq] + WEEKDAY[p.day].slice(1);
      const buy = a ? +(p.amt * a.mult).toFixed(2) : p.amt;
      return `<div class="trade">
        <div class="row"><b>${coinOf(p.sym)}</b><span>現價 ${a ? fp(a.p) : '…'}</span><span class="sub">${when} · 基本 ${fu(p.amt)} U</span>
          <span class="badge ${due.state === 'due' ? 'go' : due.state === 'done' ? 'no' : 'wait'}" style="margin-left:0">${due.text}</span>
          <button class="x" onclick="delSpotPlan(${i})" title="移除計畫">×</button></div>
        ${err ? msg('bad', esc(err)) : !a ? '<small>讀取中…</small>' :
          `<div style="margin-top:4px">便宜分數 <b class="${a.score > 0 ? 'g' : a.score < 0 ? 'r' : ''}">${a.score > 0 ? '+' : ''}${a.score}</b>
             → 這期買 <b>${fu(buy)} U</b> <small>(${a.mult} 倍)</small></div>
           <small>${a.pts.map(x => esc(x[1])).join('、')}</small>
           ${a.big ? msg('ok', `大筆買入條件成立(分數 ≥ 5,歷史上的便宜區):可動用現貨的 1/3 = ${fu(S.spot.budget / 3)} U,一週一批、分 3 批買。便宜還可能更便宜,所以要分批。`) : ''}`}
        <div class="row" style="margin-top:8px"><span class="sub">花了</span><input id="spU-${i}" type="number" step="any" value="${buy}" style="width:90px">
          <span class="sub">U,成交價</span><input id="spP-${i}" type="number" step="any" value="${a ? fp(a.p) : ''}" style="width:130px">
          <button onclick="recordSpot(${i})">記錄已買</button></div>
      </div>`;
    }).join('');
  renderHold();
}

function renderHold(){
  const by = {};
  db.spot.forEach(r => (by[r.sym] = by[r.sym] || []).push(r));
  const syms = Object.keys(by);
  $('spotHold').innerHTML = !syms.length ? '<div class="sub">還沒有紀錄。</div>' :
    `<div style="overflow:auto"><table class="tbl"><tr><th>幣</th><th>投入</th><th>數量</th><th>平均成本</th><th>現價</th><th>現值</th><th>盈虧</th><th>次數</th></tr>` +
    syms.map(sym => {
      const rs = by[sym], inv = sum(rs.map(r => r.usd)), q = sum(rs.map(r => r.qty)), a = st.spot[sym];
      const px = a ? a.p : NaN, val = q * px, pnl = val - inv;
      return `<tr><td><b>${coinOf(sym)}</b></td><td>${fu(inv)} U</td><td>${fq(q)}</td><td>${fp(inv / q)}</td><td>${fp(px)}</td>
        <td>${isFinite(val) ? fu(val) + ' U' : '-'}</td>
        <td class="${pnl >= 0 ? 'up' : 'down'}">${isFinite(pnl) ? (pnl >= 0 ? '+' : '') + fu(pnl) + ' U<br><small>' + pc(pnl / inv) + '</small>' : '-'}</td><td>${rs.length}</td></tr>`;
    }).join('') + '</table></div>' +
    `<details style="margin-top:8px"><summary class="sub" style="cursor:pointer">每一筆明細</summary>` +
    db.spot.slice().reverse().map(r => `<div class="row sub" style="margin:4px 0">${new Date(r.time).toLocaleDateString()} ${coinOf(r.sym)} ${fu(r.usd)} U @ ${fp(r.price)} ${r.plan ? '(定投)' : ''}<button class="x" onclick="delSpot('${r.id}')" title="刪除">×</button></div>`).join('') +
    '</details>';
}

function addSpot(sym, usd, price, plan, deduct){
  db.spot.push({id: Date.now().toString(36), time: Date.now(), sym, usd, price, qty: usd / price, plan, deduct});
  if(deduct){ S.spot.budget = Math.max(0, +(S.spot.budget - usd).toFixed(2)); $('spBudget').value = S.spot.budget; }
  saveDB(); renderSpot(); spotTick();
  toast(`記下了:${coinOf(sym)} ${fu(usd)} U。現貨可用剩 ${fu(S.spot.budget)} U。`);
}
function recordSpot(i){
  const p = S.spot.plans[i], usd = +$('spU-' + i).value, price = +$('spP-' + i).value;
  if(!(usd > 0 && price > 0)) return toast('花了多少 U、成交價都要填。', 'bad');
  addSpot(p.sym, usd, price, true, true);
}
function delSpot(id){
  const r = db.spot.find(x => x.id === id);
  if(!r || !confirm(`刪掉這筆 ${coinOf(r.sym)} ${fu(r.usd)} U 的紀錄?`)) return;
  if(r.deduct){ S.spot.budget = +(S.spot.budget + r.usd).toFixed(2); $('spBudget').value = S.spot.budget; }
  db.spot = db.spot.filter(x => x.id !== id); saveDB(); renderSpot();
}
function delSpotPlan(i){
  if(!confirm(`移除 ${coinOf(S.spot.plans[i].sym)} 的定投計畫?(買過的紀錄會留著)`)) return;
  S.spot.plans.splice(i, 1); saveDB(); renderSpot();
}
function fillSpDay(){
  $('spDay').innerHTML = $('spFreq').value === 'month'
    ? Array.from({length: 28}, (_, i) => `<option value="${i + 1}">${i + 1} 號</option>`).join('')
    : WEEKDAY.slice(1).map((w, i) => `<option value="${i + 1}">${w}</option>`).join('');
}
$('spFreq').onchange = fillSpDay;
$('spBudget').oninput = () => { S.spot.budget = +$('spBudget').value || 0; saveDB(); renderSpot(); };
$('spAdd').onclick = async () => {
  const sym = normSym($('spSym').value), amt = +$('spAmt').value;
  if(!sym || !(amt > 0)) return toast('幣和每期金額要填。', 'bad');
  if(S.spot.plans.some(p => p.sym === sym)) return toast('這個幣已經有定投計畫了。', 'bad');
  try{ st.spot[sym] = await spotAna(sym); }catch(e){ return toast(e.message, 'bad'); }
  S.spot.plans.push({sym, amt, freq: $('spFreq').value, day: +$('spDay').value});
  $('spSym').value = ''; $('spAmt').value = '';
  saveDB(); renderSpot(); spotTick();
};
$('spOAdd').onclick = async () => {
  const sym = normSym($('spOSym').value), usd = +$('spOU').value, price = +$('spOP').value;
  if(!sym || !(usd > 0 && price > 0)) return toast('幣、花了多少 U、成交價都要填。', 'bad');
  try{ await spotAna(sym); }catch(e){ return toast(e.message, 'bad'); }
  addSpot(sym, usd, price, false, $('spODeduct').checked);
  $('spOSym').value = ''; $('spOU').value = ''; $('spOP').value = '';
};

/* =========================================================
   設定
   ========================================================= */
function fillSettings(){
  $('sTotal').value = S.total; $('sRisk').value = S.risk;
  $('sShort').value = S.alloc.short; $('sMid').value = S.alloc.mid; $('sLong').value = S.alloc.long; $('sReserve').value = S.alloc.reserve;
  renderAlloc();
  $('keyStat').textContent = lsGet('groqKey') ? '已設定 ✓' : '未設定(可不設,只是少了 AI 判讀)';
  renderNtfy();
}
function renderNtfy(){
  const n = S.ntfy;
  $('ntfyBtn').textContent = n.on ? '關閉手機推播' : '開啟手機推播';
  $('ntfyTest').hidden = !n.on;
  $('ntfyStat').textContent = n.on ? '已開啟 ✓' : '關閉中';
  $('ntfyHelp').innerHTML = !n.on ? '' :
    `iPhone:App Store 裝「ntfy」→ 打開 → 右上「+」→ 頻道名稱填 <b style="user-select:all">${esc(n.topic)}</b> → 訂閱。<br>`
    + '頻道名稱就像密碼,別給別人看。電腦版開著、而且「🔔 提醒」是開的時候,進場提醒會推到手機;定投日提醒一定會推。';
}
$('ntfyBtn').onclick = () => {
  if(!S.ntfy.topic){
    const a = new Uint8Array(12); crypto.getRandomValues(a);
    S.ntfy.topic = 'ciel-' + [...a].map(x => (x % 36).toString(36)).join('');
  }
  S.ntfy.on = !S.ntfy.on; saveDB(); renderNtfy();
};
$('ntfyTest').onclick = async () => {
  const ok = await pushPhone('夏爾測試', '手機收到這則,推播就設定好了。');
  toast(ok ? '已送出,看看手機有沒有跳通知。' : '送不出去,網路有通嗎?', ok ? 'ok' : 'bad');
};
$('expBtn').onclick = exportDB;
$('impBtn').onclick = () => $('impFile').click();
$('impFile').onchange = e => { const f = e.target.files[0]; if(f) importDB(f); e.target.value = ''; };
function renderAlloc(){
  const a = S.alloc, tot = a.short + a.mid + a.long + a.reserve, u = x => fu(S.total * x / 100) + ' U';
  $('allocOut').innerHTML = `短線 ${u(a.short)}|中線 ${u(a.mid)}|長線 ${u(a.long)}|備用 ${u(a.reserve)}|單筆最多虧 ${fu(S.total * S.risk / 100)} U`
    + (tot !== 100 ? ` <b class="r">加起來 ${tot}%,應該是 100%</b>` : '')
    + (S.risk > 2 ? ` <b class="y">單筆超過 2%,連虧幾單就很痛</b>` : '');
}
['sTotal', 'sRisk', 'sShort', 'sMid', 'sLong', 'sReserve'].forEach(id => $(id).oninput = () => {
  S.total = +$('sTotal').value || 0; S.risk = +$('sRisk').value || 0;
  S.alloc = {short: +$('sShort').value || 0, mid: +$('sMid').value || 0, long: +$('sLong').value || 0, reserve: +$('sReserve').value || 0};
  renderAlloc(); saveDB(); refreshAllPlans();
});
$('setBtn').onclick = () => $('settings').classList.toggle('hidden');
$('keyBtn').onclick = () => {
  const k = prompt('貼上 Groq 金鑰(gsk_ 開頭)。只存在這台電腦的瀏覽器裡。留空 = 清除。', lsGet('groqKey'));
  if(k === null) return;
  lsSet('groqKey', k.trim()); groqModel = null; delete aiCache[S.sym];
  fillSettings(); aiJudge();
};

/* =========================================================
   切換幣種 / 主迴圈
   ========================================================= */
function refreshAllPlans(){ Object.keys(st.ana).forEach(buildPlans); renderCards(); renderWatch(); if(chart) loadChart(); }

async function selectSym(sym){
  sym = normSym(sym);
  if(!sym) return;
  try{ await klines(sym, '1h'); }catch(e){ toast(e.message, 'bad'); return; }
  S.sym = sym; $('sym').value = sym; saveDB();
  st.senti = null; st.ai = null;
  $('lp').textContent = '-'; $('lc').textContent = ''; $('lsym').textContent = coinOf(sym);
  st.plans[sym] = st.plans[sym] || null;
  renderCards(); renderWatch(); openWS();
  await fetchAna(sym).catch(e => { st.plans[sym] = {error: e.message}; });
  if(st.ana[sym]) buildPlans(sym);
  renderCards(); renderWatch(); loadChart();
  loadSenti(sym); renderNews(); aiJudge();
}

let busy = false;
async function tick(){
  if(busy) return;
  busy = true;
  await loadRegime();
  const syms = [...new Set([S.sym, ...S.watch, ...openTrades().map(t => t.sym)])];
  for(const sym of syms){
    try{ await fetchAna(sym); buildPlans(sym); checkAlerts(sym); }
    catch(e){ st.plans[sym] = {error: e.message}; }
  }
  busy = false;
  renderCards(); renderWatch(); renderJournal(); renderSpot();
}

/* ---------- 啟動 ---------- */
(async function start(){
  await loadDB();
  if(!SERVER) $('storeWhere').textContent = '存在這支手機的瀏覽器裡(用匯出/匯入和電腦同步)';
  QUICK.forEach(s => { const b = document.createElement('button'); b.textContent = coinOf(s); b.onclick = () => selectSym(s); $('quick').appendChild(b); });
  TFS.forEach(tf => { const b = document.createElement('button'); b.textContent = TF_NAME[tf]; b.dataset.tf = tf;
    b.onclick = () => { S.tf = tf; saveDB(); openWS(); loadChart(); }; $('tfBtns').appendChild(b); });
  $('sym').value = S.sym;
  $('sym').onkeydown = e => { if(e.key === 'Enter') selectSym($('sym').value); };
  fillSettings(); renderAlertBtn(); renderRules(); renderJournal();
  document.querySelectorAll('#legend input[data-k]').forEach(cb => {
    cb.checked = S.show[cb.dataset.k];
    cb.onchange = () => { S.show[cb.dataset.k] = cb.checked; saveDB(); applyShow(); if(cb.dataset.k === 'lv') loadChart(); };
  });
  fillSpDay(); $('spBudget').value = S.spot.budget; renderSpot(); spotTick();
  setInterval(spotTick, 10 * 60e3);                               // 現貨定投 10 分鐘檢查一次
  renderBtParams(); $('btSym').value = S.sym;
  initChart();
  await loadRegime();                                             // 先知道大盤,計畫才算得對
  await selectSym(S.sym);
  loadNews();
  tick();
  setInterval(tick, 60e3);                                        // 每分鐘檢查監控清單
  setInterval(() => loadSenti(S.sym), 5 * 60e3);                  // 情緒 5 分鐘
  setInterval(loadNews, 5 * 60e3);                                // 新聞 5 分鐘
  if(SERVER) setInterval(() => fetch('/api/ping').catch(() => {}), 30e3);   // 告訴伺服器「我還開著」
  if(chart) setInterval(loadChart, 5 * 60e3);                     // 支撐壓力 5 分鐘重算
})();
