"use strict";

const NUMBER_FORMATS = new Map();
function nf(digits) {
  let f = NUMBER_FORMATS.get(digits);
  if (!f) {
    f = new Intl.NumberFormat("ru-RU", { minimumFractionDigits: digits, maximumFractionDigits: digits });
    NUMBER_FORMATS.set(digits, f);
  }
  return f;
}

function priceDigits(x) {
  const a = Math.abs(x);
  return a >= 100 ? 2 : a >= 10 ? 3 : a >= 1 ? 4 : a >= 0.01 ? 5 : 8;
}

function fmtPrice(x, like) {
  return x == null ? "—" : nf(priceDigits(like ?? x)).format(x);
}

function fmtBig(x, prefix = "$") {
  if (x == null) return "—";
  for (const [limit, suffix] of [[1e12, " трлн"], [1e9, " млрд"], [1e6, " млн"], [1e3, " тыс"]]) {
    if (Math.abs(x) >= limit) return prefix + nf(2).format(x / limit) + suffix;
  }
  return prefix + nf(2).format(x);
}

function fmtQty(x) {
  if (x >= 1e6) return fmtBig(x, "");
  if (x >= 1000) return nf(0).format(x);
  if (x >= 1) return nf(3).format(x);
  return nf(5).format(x);
}

function fmtAge(sec) {
  if (sec < 1) return "<1 с";
  if (sec < 60) return `${Math.floor(sec)} с`;
  if (sec < 3600) return `${Math.floor(sec / 60)} мин`;
  if (sec < 86400) return `${Math.floor(sec / 3600)} ч`;
  return `${Math.floor(sec / 86400)} д`;
}

const timeFmt = new Intl.DateTimeFormat("ru-RU", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
const hmFmt = new Intl.DateTimeFormat("ru-RU", { hour: "2-digit", minute: "2-digit" });
const hhmmss = (ms) => timeFmt.format(ms);
const hhmm = (ms) => hmFmt.format(ms);

function until(moment) {
  return moment ? `${Math.max(0, Math.round((moment - Date.now()) / 1000))} с` : "—";
}

const $ = (selector) => document.querySelector(selector);

function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value == null || value === false) continue;
    if (key === "class") el.className = value;
    else if (key === "style") el.style.cssText = value;
    else if (key.startsWith("on")) el.addEventListener(key.slice(2), value);
    else el.setAttribute(key, value);
  }
  for (const child of children.flat()) {
    if (child == null || child === false) continue;
    el.append(child instanceof Node ? child : String(child));
  }
  return el;
}

function pct(x) {
  if (x == null) return h("span", { class: "muted" }, "—");
  return h("span", { class: x >= 0 ? "up" : "down" }, `${x >= 0 ? "+" : ""}${nf(2).format(x)}%`);
}

function kv(pairs) {
  return h("dl", { class: "kv" }, pairs.filter(Boolean).flatMap(([k, v]) => [h("dt", {}, k), h("dd", {}, v)]));
}

function safeUrl(url) {
  return typeof url === "string" && /^https?:\/\//i.test(url) ? url : null;
}

const META = { coins: [], sources: {}, order: [] };

const PANELS = {
  price: ["binance_ws", "coinbase_ws"],
  chart: ["klines", "binance_ws"],
  market: ["fng", "global"],
  book: ["binance_ws"],
  trades: ["binance_ws"],
  info: ["coingecko"],
  news: ["news"],
};

const MAX_CANDLES = 240;
const MAX_TRADES = 60;
const MAX_LOG = 300;

let stats = {};
let D = null;
let session = null;

function freshStats() {
  const s = {};
  for (const key of META.order) {
    s[key] = { state: "waiting", updated: null, latency: null, received: 0, errors: 0, error: null, retryAt: null, detail: null };
  }
  return s;
}

function freshData(coin) {
  return {
    coin, ticker: null, price: null, dir: 0, coinbase: null, candles: [], book: null,
    trades: [], lastTradeId: 0, info: null, fng: null, global: null, news: null, hover: null,
  };
}

const dirty = new Set();
let frameRequested = false;

function mark(...panels) {
  for (const p of panels) dirty.add(p);
  if (!frameRequested) {
    frameRequested = true;
    requestAnimationFrame(flush);
  }
}

function flush() {
  frameRequested = false;
  if (!D) return dirty.clear();
  for (const panel of dirty) RENDER[panel]();
  dirty.clear();
}

function badge(key) {
  const st = stats[key];
  const title = META.sources[key].title;
  if (st.state === "error" || st.state === "disconnected") {
    return h("span", { class: "badge err", title: st.error }, `✖ ${title}: ${st.error}`);
  }
  if (st.state === "unavailable") return h("span", { class: "badge off" }, `— ${title}: ${st.error}`);
  if (["loading", "connecting", "waiting"].includes(st.state)) {
    return h("span", { class: "badge" }, h("i", { class: "spin" }), title);
  }
  return h("span", { class: "badge" }, h("i", { class: "dot" }), title);
}

function renderBadges(panel) {
  $(`#${panel} .badges`).replaceChildren(...PANELS[panel].map(badge));
}

function placeholder(keys) {
  return h("div", { class: "placeholder" }, keys.map((key) => {
    const st = stats[key];
    const title = META.sources[key].title;
    if (st.state === "error" || st.state === "disconnected") {
      return h("div", {}, h("div", { class: "down" }, `${title}: ${st.error}`), h("div", { class: "muted" }, `повтор через ${until(st.retryAt)}`));
    }
    if (st.state === "unavailable") return h("div", { class: "muted" }, `${title}: ${st.error}`);
    return h("div", { class: "muted" }, `Загрузка: ${title}…`);
  }));
}

function renderPrice() {
  $("#price .card-title").textContent = `Цена ${D.coin.symbol}/${D.coin.quote}`;
  const body = $("#price .card-body");
  const t = D.ticker;
  if (!t) return body.replaceChildren(placeholder(["binance_ws"]));

  const dirClass = D.dir > 0 ? "up" : D.dir < 0 ? "down" : "";
  const changeClass = t.change >= 0 ? "up" : "down";

  let coinbase;
  const cbState = stats.coinbase_ws;
  if (D.coinbase) {
    const diff = D.price ? ((D.price - D.coinbase.price) / D.coinbase.price) * 100 : null;
    coinbase = h("span", {}, `${fmtPrice(D.coinbase.price)} USD `, h("span", { class: "muted" }, "Δ "), pct(diff));
  } else if (cbState.state === "unavailable") {
    coinbase = h("span", { class: "muted" }, cbState.error);
  } else {
    coinbase = h("span", { class: "muted" }, "ожидание…");
  }

  body.replaceChildren(
    h("div", { class: `big-price num ${dirClass}` }, fmtPrice(D.price)),
    h("div", { class: "change-line num" },
      h("span", { class: `change-chip ${changeClass}` }, `${t.change >= 0 ? "▲" : "▼"} ${fmtPrice(t.change, t.last)}`),
      pct(t.change_pct),
      h("span", { class: "muted" }, "за 24 ч"),
    ),
    kv([
      ["Макс. 24 ч", fmtPrice(t.high)],
      ["Мин. 24 ч", fmtPrice(t.low)],
      ["Объём 24 ч", `${fmtQty(t.volume)} ${D.coin.symbol}`],
      ["Оборот 24 ч", fmtBig(t.quote_volume)],
      ["Bid / Ask", `${fmtPrice(t.bid)} / ${fmtPrice(t.ask)}`],
      ["Coinbase", coinbase],
    ]),
  );
  document.title = `${fmtPrice(D.price)} ${D.coin.symbol} · Crypto Dashboard`;
}

const chart = { canvas: null, box: null, info: null, colors: null };

function setupChart() {
  chart.info = h("div", { class: "chart-info num" });
  chart.canvas = h("canvas");
  chart.box = h("div", { class: "chart-box" }, chart.canvas);
  $("#chart .card-body").replaceChildren(chart.info, chart.box);
  new ResizeObserver(() => mark("chart")).observe(chart.box);
  chart.canvas.addEventListener("mousemove", (e) => {
    if (!D) return;
    const r = chart.canvas.getBoundingClientRect();
    D.hover = { x: e.clientX - r.left, y: e.clientY - r.top };
    mark("chart");
  });
  chart.canvas.addEventListener("mouseleave", () => {
    if (D) D.hover = null;
    mark("chart");
  });
  const css = getComputedStyle(document.documentElement);
  chart.colors = Object.fromEntries(["up", "down", "grid", "muted", "faint", "text", "panel", "mono"].map((n) => [n, css.getPropertyValue(`--${n}`).trim()]));
}

function niceTicks(lo, hi, count) {
  const raw = (hi - lo) / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const norm = raw / mag;
  const step = (norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10) * mag;
  const ticks = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi; v += step) ticks.push(v);
  return ticks;
}

function renderChart() {
  const { canvas, box, info, colors: C } = chart;
  const W = box.clientWidth;
  const H = box.clientHeight;
  if (!W || !H) return;
  const dpr = window.devicePixelRatio || 1;
  if (canvas.width !== Math.round(W * dpr) || canvas.height !== Math.round(H * dpr)) {
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    canvas.style.width = `${W}px`;
    canvas.style.height = `${H}px`;
  }
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);

  const cs = D.candles;
  if (cs.length < 2) return info.replaceChildren(placeholder(["klines"]));

  const AXIS = 84, BOTTOM = 22, TOP = 6;
  const pw = W - AXIS, ph = H - BOTTOM - TOP;
  let lo = Infinity, hi = -Infinity;
  for (const c of cs) {
    lo = Math.min(lo, c.low);
    hi = Math.max(hi, c.high);
  }
  const pad = (hi - lo) * 0.08 || hi * 0.001;
  const ylo = lo - pad, yhi = hi + pad;
  const Y = (v) => TOP + ((yhi - v) / (yhi - ylo)) * ph;
  const step = pw / cs.length;
  const bodyW = Math.max(1, Math.min(14, step * 0.7));
  const line = (x1, y1, x2, y2) => { ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke(); };

  ctx.font = `11px ${C.mono}`;
  ctx.lineWidth = 1;
  ctx.textBaseline = "middle";

  for (const t of niceTicks(ylo, yhi, Math.max(3, Math.floor(ph / 45)))) {
    const y = Math.round(Y(t)) + 0.5;
    ctx.strokeStyle = C.grid;
    line(0, y, pw, y);
    ctx.fillStyle = C.muted;
    ctx.fillText(fmtPrice(t, hi), pw + 8, y);
  }

  const every = [5, 10, 15, 30, 60, 120, 240].find((m) => m * step >= 80) ?? 480;
  ctx.textAlign = "center";
  cs.forEach((c, i) => {
    if (Math.round(c.open_time / 60) % every !== 0) return;
    const x = Math.round(i * step + step / 2) + 0.5;
    ctx.strokeStyle = C.grid;
    line(x, TOP, x, TOP + ph);
    ctx.fillStyle = C.muted;
    ctx.fillText(hhmm(c.open_time * 1000), x, H - BOTTOM / 2);
  });
  ctx.textAlign = "left";

  cs.forEach((c, i) => {
    const x = i * step + step / 2;
    ctx.strokeStyle = ctx.fillStyle = c.close >= c.open ? C.up : C.down;
    const xl = Math.round(x) + 0.5;
    line(xl, Y(c.high), xl, Y(c.low));
    const yo = Y(c.open), yc = Y(c.close);
    ctx.fillRect(Math.round(x - bodyW / 2), Math.min(yo, yc), Math.max(1, Math.round(bodyW)), Math.max(1, Math.abs(yo - yc)));
  });

  const last = cs[cs.length - 1];
  const lastColor = last.close >= last.open ? C.up : C.down;
  const yl = Math.round(Y(last.close)) + 0.5;
  ctx.setLineDash([3, 3]);
  ctx.strokeStyle = lastColor;
  line(0, yl, pw, yl);
  ctx.setLineDash([]);
  ctx.fillStyle = lastColor;
  ctx.fillRect(pw + 2, yl - 9, AXIS - 4, 18);
  ctx.fillStyle = "#fff";
  ctx.fillText(fmtPrice(last.close), pw + 8, yl);

  let sel = last;
  if (D.hover && D.hover.x < pw && D.hover.y < TOP + ph) {
    const i = Math.min(cs.length - 1, Math.max(0, Math.floor(D.hover.x / step)));
    sel = cs[i];
    const x = Math.round(i * step + step / 2) + 0.5;
    const y = Math.round(D.hover.y) + 0.5;
    ctx.strokeStyle = C.faint;
    ctx.setLineDash([2, 3]);
    line(x, TOP, x, TOP + ph);
    line(0, y, pw, y);
    ctx.setLineDash([]);
    const value = yhi - ((D.hover.y - TOP) / ph) * (yhi - ylo);
    ctx.fillStyle = C.faint;
    ctx.fillRect(pw + 2, y - 9, AXIS - 4, 18);
    ctx.fillStyle = "#fff";
    ctx.fillText(fmtPrice(value, hi), pw + 8, y);
  }

  const first = cs[0];
  const hours = (last.open_time - first.open_time) / 3600;
  info.replaceChildren(
    h("span", { class: "muted" }, hhmm(sel.open_time * 1000)),
    h("span", {}, h("span", { class: "muted" }, "откр "), fmtPrice(sel.open)),
    h("span", {}, h("span", { class: "muted" }, "макс "), fmtPrice(sel.high)),
    h("span", {}, h("span", { class: "muted" }, "мин "), fmtPrice(sel.low)),
    h("span", {}, h("span", { class: "muted" }, "закр "), h("b", { class: sel.close >= sel.open ? "up" : "down" }, fmtPrice(sel.close))),
    h("span", {}, h("span", { class: "muted" }, `за ${nf(1).format(hours)} ч `), pct(((last.close - first.open) / first.open) * 100)),
  );
}

const FNG_LABELS = {
  "Extreme Fear": "крайний страх",
  Fear: "страх",
  Neutral: "нейтрально",
  Greed: "жадность",
  "Extreme Greed": "крайняя жадность",
};

function fngColor(v) {
  return v < 25 ? "#ea3943" : v < 45 ? "#f08a24" : v < 56 ? "#f0b90b" : v < 75 ? "#93d900" : "#16c784";
}

function renderMarket() {
  const parts = [h("div", { class: "section-title" }, "Индекс страха и жадности")];
  if (!D.fng) {
    parts.push(placeholder(["fng"]));
  } else {
    const { value: v, label, yesterday } = D.fng;
    parts.push(
      h("div", { class: "fng" },
        h("div", { class: "fng-value num", style: `color:${fngColor(v)}` }, v),
        h("div", {},
          h("div", { class: "fng-label" }, FNG_LABELS[label] ?? label),
          yesterday != null && h("div", { class: "muted" }, `вчера ${yesterday} (${v - yesterday >= 0 ? "+" : ""}${v - yesterday})`),
        ),
      ),
      h("div", { class: "gauge" }, h("i", { style: `left:${v}%` })),
    );
  }

  parts.push(h("div", { class: "section-title" }, "Глобальный рынок"));
  const m = D.global;
  if (!m) {
    parts.push(placeholder(["global"]));
  } else {
    const share = D.info?.market_cap && D.coin.symbol !== "BTC"
      ? [`Доля ${D.coin.symbol}`, `${nf(2).format((D.info.market_cap / m.market_cap) * 100)}%`]
      : null;
    parts.push(kv([
      ["Капитализация", h("span", {}, `${fmtBig(m.market_cap)} `, pct(m.market_cap_change_24h))],
      ["Объём 24 ч", fmtBig(m.volume_24h)],
      ["Доля BTC", `${nf(2).format(m.btc_dominance)}%`],
      share,
      ["Монет", nf(0).format(m.cryptocurrencies)],
    ]));
  }
  $("#market .card-body").replaceChildren(...parts);
}

function renderBook() {
  const body = $("#book .card-body");
  const b = D.book;
  if (!b || !b.bids.length || !b.asks.length) return body.replaceChildren(placeholder(["binance_ws"]));
  const asks = b.asks.slice(0, 10).reverse();
  const bids = b.bids.slice(0, 10);
  const biggest = Math.max(...asks.concat(bids).map(([, q]) => q)) || 1;
  const level = ([p, q], side) => h("div", { class: `row lvl ${side}`, style: `--w:${((q / biggest) * 100).toFixed(1)}%` },
    h("span", { class: side === "ask" ? "down" : "up" }, fmtPrice(p)),
    h("span", {}, fmtQty(q)),
    h("span", { class: "muted" }, fmtBig(p * q)),
  );
  const bestAsk = b.asks[0][0], bestBid = b.bids[0][0];
  const spread = bestAsk - bestBid;
  body.replaceChildren(h("div", { class: "rows" },
    h("div", { class: "row head" }, h("span", {}, "Цена"), h("span", {}, "Кол-во"), h("span", {}, "Сумма")),
    asks.map((l) => level(l, "ask")),
    h("div", { class: "spread" }, h("span", {}, `спред ${fmtPrice(spread, bestAsk)}`), h("span", { class: "muted" }, `${nf(4).format((spread / bestAsk) * 100)}%`)),
    bids.map((l) => level(l, "bid")),
  ));
}

function renderTrades() {
  const body = $("#trades .card-body");
  if (!D.trades.length) return body.replaceChildren(placeholder(["binance_ws"]));
  const seen = body.dataset.lastId ? Number(body.dataset.lastId) : 0;
  body.replaceChildren(h("div", { class: "rows trades" },
    h("div", { class: "row head" }, h("span", {}, "Время"), h("span", {}, "Цена"), h("span", {}, "Кол-во")),
    D.trades.map((t) => h("div", { class: `row${t.id > seen && seen ? " trade-new" : ""}` },
      h("span", { class: "muted" }, hhmmss(t.time * 1000)),
      h("span", { class: t.is_sell ? "down" : "up" }, `${t.is_sell ? "▼" : "▲"} ${fmtPrice(t.price)}`),
      h("span", {}, fmtQty(t.qty)),
    )),
  ));
  body.dataset.lastId = D.trades[0].id;
}

function renderInfo() {
  const i = D.info;
  $("#info .card-title").textContent = i ? `О монете: ${i.name}` : "О монете";
  const body = $("#info .card-body");
  if (!i) return body.replaceChildren(placeholder(["coingecko"]));

  const supplyShare = i.circulating && i.max_supply ? i.circulating / i.max_supply : null;
  const supply = h("div", {},
    `${fmtBig(i.circulating, "")} ${i.symbol}`,
    supplyShare != null && h("div", { class: "supply-bar", title: `${nf(1).format(supplyShare * 100)}% от максимальной эмиссии` },
      h("i", { style: `width:${(supplyShare * 100).toFixed(1)}%` })),
  );
  const homepage = safeUrl(i.homepage);
  const paragraphs = i.description.split(/\n\s*\n/).filter(Boolean).slice(0, 3);
  let budget = 900;
  const description = [];
  for (const p of paragraphs) {
    if (budget <= 0) break;
    description.push(h("p", {}, p.length > budget ? `${p.slice(0, budget).replace(/\s+\S*$/, "")}…` : p));
    budget -= p.length;
  }

  body.replaceChildren(h("div", { class: "info" },
    kv([
      ["Ранг", i.rank ? `#${i.rank}` : "—"],
      ["Капитализация", fmtBig(i.market_cap)],
      ["FDV", fmtBig(i.fdv)],
      ["Объём 24 ч", fmtBig(i.volume)],
      ["В обращении", supply],
      ["Макс. эмиссия", i.max_supply ? `${fmtBig(i.max_supply, "")} ${i.symbol}` : "не ограничена"],
      ["ATH", h("span", {}, `$${fmtPrice(i.ath)} `, pct(i.ath_change_pct), h("span", { class: "muted" }, ` ${(i.ath_date || "").slice(0, 10)}`))],
      ["ATL", `$${fmtPrice(i.atl)}`],
      ["7 д / 30 д / 1 г", h("span", {}, pct(i.change_7d), " / ", pct(i.change_30d), " / ", pct(i.change_1y))],
      i.genesis && ["Запуск", i.genesis],
      i.algorithm && ["Алгоритм", i.algorithm],
      homepage && ["Сайт", h("a", { href: homepage, target: "_blank", rel: "noopener noreferrer" }, homepage.replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, ""))],
    ]),
    i.categories.length > 0 && h("div", { class: "chips" }, i.categories.slice(0, 6).map((c) => h("span", { class: "chip" }, c))),
    h("div", { class: "description" }, description),
  ));
}

function renderNews() {
  $("#news .card-title").textContent = `Новости: ${D.coin.name}`;
  const body = $("#news .card-body");
  if (!D.news) return body.replaceChildren(placeholder(["news"]));
  const now = Date.now();
  body.replaceChildren(h("div", { class: "news-list" }, D.news.map((n) => {
    const url = safeUrl(n.link);
    const age = n.published ? `${fmtAge((now - Date.parse(n.published)) / 1000)} назад` : "";
    return h(url ? "a" : "div", { class: "news-item", href: url, target: url && "_blank", rel: url && "noopener noreferrer" },
      h("div", {}, n.title),
      h("div", { class: "news-meta" }, [age, n.author].filter(Boolean).join(" · ")),
    );
  })));
}

function statusCell(kind, st) {
  switch (st.state) {
    case "waiting": return h("span", { class: "muted" }, "ожидание");
    case "connecting": return h("span", { class: "warn" }, `⟳ подключение (${st.detail})`);
    case "loading": return h("span", { class: "warn" }, "⟳ запрос…");
    case "connected": return h("span", { class: "up" }, "● подключено");
    case "data": return kind === "WS"
      ? h("span", { class: "up" }, "● онлайн")
      : h("span", { class: "up" }, `● OK, след. через ${until(st.retryAt)}`);
    case "error": return h("span", { class: "down" }, `✖ ${st.error}; повтор через ${until(st.retryAt)}`);
    case "disconnected": return h("span", { class: "down" }, `✖ ${st.error}; переподключение через ${until(st.retryAt)}`);
    case "unavailable": return h("span", { class: "muted" }, `— ${st.error}`);
    default: return st.state;
  }
}

function renderSources() {
  const now = Date.now();
  $("#sources .card-body").replaceChildren(h("table", { class: "sources-table" },
    h("thead", {}, h("tr", {},
      h("th", {}, "Источник"), h("th", { class: "opt" }, "Тип"), h("th", {}, "Статус"),
      h("th", { class: "r" }, "Обновлено"), h("th", { class: "r opt" }, "Ответ"),
      h("th", { class: "r opt" }, "Получено"), h("th", { class: "r" }, "Ошибок"),
    )),
    h("tbody", {}, META.order.map((key) => {
      const info = META.sources[key];
      const st = stats[key];
      return h("tr", {},
        h("td", {}, info.title, h("span", { class: "desc" }, info.provides)),
        h("td", { class: "opt" }, h("span", { class: `tag ${info.kind.toLowerCase()}` }, info.kind)),
        h("td", { class: "status" }, statusCell(info.kind, st)),
        h("td", { class: "r" }, st.updated ? `${fmtAge((now - st.updated) / 1000)} назад` : "—"),
        h("td", { class: "r opt" }, st.latency != null ? `${Math.round(st.latency * 1000)} мс` : "—"),
        h("td", { class: "r opt" }, st.received),
        h("td", { class: `r ${st.errors ? "down" : "muted"}` }, st.errors),
      );
    })),
  ));
}

const RENDER = {
  price: renderPrice, chart: renderChart, market: renderMarket, book: renderBook,
  trades: renderTrades, info: renderInfo, news: renderNews, sources: renderSources,
};

function logLine(text, cls = "") {
  const body = $("#log .card-body");
  const nearBottom = body.scrollHeight - body.scrollTop - body.clientHeight < 40;
  body.append(h("div", { class: `log-line ${cls}` }, h("time", {}, hhmmss(Date.now())), text));
  while (body.childElementCount > MAX_LOG) body.firstElementChild.remove();
  if (nearBottom) body.scrollTop = body.scrollHeight;
}

function handleEvent(ev) {
  const st = stats[ev.source];
  const info = META.sources[ev.source];
  if (!st) return;
  const prev = st.state;

  switch (ev.state) {
    case "data":
      st.updated = Date.now();
      st.received += 1;
      if (ev.latency != null) st.latency = ev.latency;
      if (ev.retry_in != null) st.retryAt = Date.now() + ev.retry_in * 1000;
      if ((prev === "error" || prev === "loading") && st.error) logLine(`${info.title}: данные снова поступают`, "ok");
      st.error = null;
      if (info.kind === "HTTP") logLine(`${info.title}: ответ за ${Math.round(ev.latency * 1000)} мс`);
      route(ev);
      break;
    case "error":
      st.errors += 1;
      st.error = ev.error;
      st.retryAt = Date.now() + (ev.retry_in ?? 0) * 1000;
      logLine(`${info.title}: ${ev.error} — повтор через ${Math.round(ev.retry_in)} с`, "err");
      break;
    case "disconnected":
      st.errors += 1;
      st.error = ev.error;
      st.retryAt = Date.now() + (ev.retry_in ?? 0) * 1000;
      logLine(`${info.title}: обрыв WebSocket (${ev.error}) — переподключение через ${nf(1).format(ev.retry_in)} с`, "err");
      break;
    case "connecting":
      st.detail = ev.detail;
      logLine(`${info.title}: подключение к WebSocket (${ev.detail})`, "dim");
      break;
    case "connected":
      st.error = null;
      logLine(`${info.title}: WebSocket подключён`, "ok");
      break;
    case "unavailable":
      st.error = ev.error;
      logLine(`${info.title}: ${ev.error}, источник отключён для этой монеты`, "warn");
      break;
  }
  st.state = ev.state;

  if (ev.state !== prev) {
    for (const [panel, keys] of Object.entries(PANELS)) {
      if (keys.includes(ev.source)) {
        renderBadges(panel);
        mark(panel);
      }
    }
  }
}

function route(ev) {
  const d = ev.data;
  switch (ev.source) {
    case "binance_ws":
      if (ev.channel === "trade") {
        if (D.price != null && d.price !== D.price) D.dir = d.price > D.price ? 1 : -1;
        D.price = d.price;
        d.id = ++D.lastTradeId;
        D.trades.unshift(d);
        D.trades.length = Math.min(D.trades.length, MAX_TRADES);
        const last = D.candles[D.candles.length - 1];
        if (last && d.time >= last.open_time && d.time < last.open_time + 60) {
          last.close = d.price;
          last.high = Math.max(last.high, d.price);
          last.low = Math.min(last.low, d.price);
          mark("chart");
        }
        mark("price", "trades");
      } else if (ev.channel === "ticker") {
        D.ticker = d;
        if (D.price == null) D.price = d.last;
        mark("price");
      } else if (ev.channel === "kline") {
        const cs = D.candles;
        const last = cs[cs.length - 1];
        if (last && last.open_time === d.open_time) cs[cs.length - 1] = d;
        else if (!last || d.open_time > last.open_time) {
          cs.push(d);
          if (cs.length > MAX_CANDLES) cs.splice(0, cs.length - MAX_CANDLES);
        }
        mark("chart");
      } else if (ev.channel === "depth") {
        D.book = d;
        mark("book");
      }
      break;
    case "coinbase_ws":
      D.coinbase = d;
      mark("price");
      break;
    case "klines":
      D.candles = d.slice(-MAX_CANDLES);
      mark("chart");
      break;
    case "coingecko":
      D.info = d;
      mark("info", "market");
      break;
    case "fng":
      D.fng = d;
      mark("market");
      break;
    case "global":
      D.global = d;
      mark("market");
      break;
    case "news":
      D.news = d;
      mark("news");
      break;
  }
}

function setLink(state, text) {
  const el = $("#link");
  el.dataset.state = state;
  el.textContent = text;
}

function openSession(coin) {
  closeSession();
  stats = freshStats();
  D = freshData(coin);
  session = { coin, ws: null, attempt: 0, timer: null };
  $("#welcome").hidden = true;
  $("#dashboard").hidden = false;
  $("#log .card-body").replaceChildren();
  for (const pill of document.querySelectorAll(".pill")) pill.classList.toggle("active", pill.dataset.symbol === coin.symbol);
  for (const panel of Object.keys(PANELS)) renderBadges(panel);
  mark(...Object.keys(RENDER));
  logLine(`Выбрана монета ${coin.name} (${coin.symbol}), запуск ${META.order.length} независимых источников`);
  connect();
}

function closeSession() {
  if (!session) return;
  clearTimeout(session.timer);
  const ws = session.ws;
  session = null;
  if (ws) ws.close();
}

function connect() {
  const s = session;
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const ws = new WebSocket(`${proto}://${location.host}/ws?coin=${encodeURIComponent(s.coin.symbol)}`);
  s.ws = ws;
  setLink("connecting", "подключение к серверу…");
  updateButtons();

  ws.onopen = () => {
    s.attempt = 0;
    setLink("online", "сервер на связи");
    updateButtons();
  };
  ws.onmessage = (msg) => {
    if (session !== s) return;
    const data = JSON.parse(msg.data);
    if (data.type === "event") handleEvent(data);
    else if (data.type === "notice") logLine(data.text, "warn");
  };
  ws.onclose = () => {
    if (session !== s) return;
    const delay = Math.min(10, 2 ** s.attempt);
    s.attempt += 1;
    setLink("offline", `нет связи с сервером, повтор через ${delay} с`);
    logLine(`Соединение с сервером потеряно — повтор через ${delay} с`, "err");
    updateButtons();
    s.timer = setTimeout(() => session === s && connect(), delay * 1000);
  };
}

function send(cmd) {
  if (session?.ws?.readyState === WebSocket.OPEN) session.ws.send(JSON.stringify({ cmd }));
}

function updateButtons() {
  const open = session?.ws?.readyState === WebSocket.OPEN;
  for (const b of document.querySelectorAll("[data-cmd]")) b.disabled = !open;
}

function showWelcome() {
  closeSession();
  D = null;
  $("#welcome").hidden = false;
  $("#dashboard").hidden = true;
  for (const pill of document.querySelectorAll(".pill")) pill.classList.remove("active");
  setLink("offline", "монета не выбрана");
  updateButtons();
  document.title = "Crypto Dashboard";
}

function onHashChange() {
  const symbol = decodeURIComponent(location.hash.slice(1)).toUpperCase();
  const coin = META.coins.find((c) => c.symbol === symbol);
  if (!coin) return showWelcome();
  if (session?.coin.symbol !== coin.symbol) openSession(coin);
}

function buildStatic() {
  const choose = (c) => { location.hash = c.symbol; };
  $("#coin-pills").replaceChildren(...META.coins.map((c) =>
    h("button", { class: "pill", "data-symbol": c.symbol, title: c.name, onclick: () => choose(c) }, c.symbol)));
  $("#coin-grid").replaceChildren(...META.coins.map((c) =>
    h("button", { class: "coin-card", onclick: () => choose(c) }, h("b", {}, c.symbol), h("span", {}, c.name))));
  $("#source-list").replaceChildren(...META.order.flatMap((key) => {
    const s = META.sources[key];
    return [h("span", { class: `tag ${s.kind.toLowerCase()}` }, s.kind), h("b", {}, s.title), h("span", { class: "muted" }, s.provides)];
  }));
  for (const b of document.querySelectorAll("[data-cmd]")) b.addEventListener("click", () => send(b.dataset.cmd));
}

function tick() {
  if (!D) return;
  mark("sources");
  if (!D.ticker) mark("price");
  if (D.candles.length < 2) mark("chart");
  if (!D.book) mark("book");
  if (!D.trades.length) mark("trades");
  if (!D.info) mark("info");
  if (!D.fng || !D.global) mark("market");
  if (!D.news || Date.now() % 30000 < 1000) mark("news");
}

async function init() {
  let meta;
  try {
    meta = await fetch("/api/meta").then((r) => {
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return r.json();
    });
  } catch (err) {
    setLink("offline", "сервер недоступен, повтор через 3 с");
    setTimeout(init, 3000);
    return;
  }
  META.coins = meta.coins;
  META.order = meta.sources.map((s) => s.key);
  for (const s of meta.sources) META.sources[s.key] = s;

  buildStatic();
  setupChart();
  document.addEventListener("keydown", (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const cmd = { r: "refresh", x: "drop_ws", f: "fail_http" }[e.key.toLowerCase()];
    if (cmd) send(cmd);
    else if (e.key === "Escape" && session) location.hash = "";
  });
  window.addEventListener("hashchange", onHashChange);
  setInterval(tick, 1000);
  onHashChange();
}

init();
