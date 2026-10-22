/* Pullback – personal levels & alerts app (Babyfolio method)
 * Data comes from data/*.json, written by engine/check.py on GitHub Actions.
 * Edits (lists, levels, settings) are committed to config.json via the GitHub API.
 */
(() => {
  "use strict";
  const LWC = window.LightweightCharts;
  const $ = (s, el = document) => el.querySelector(s);
  const view = $("#view");

  const COLORS = {
    up: "#26a69a", down: "#ef5350", ema8: "#5ac8fa", ema21: "#ffd60a",
    sma50: "#4f9dff", sma100: "#a78bfa", sma150: "#f59e0b", sma200: "#f5f5f7",
    zone: "#2bd576", grid: "#161c28", text: "#8a93a6", line: "#222a3a",
  };
  const LABEL = { ema8: "8 EMA", ema21: "21 EMA", sma50: "50 SMA", sma100: "100 SMA", sma150: "150 SMA", sma200: "200 SMA" };
  const VIEWS = {
    ema: { name: "EMA 8 / 21", lines: ["ema8", "ema21"], bars: 130 },
    sma: { name: "SMA 50–200", lines: ["sma50", "sma100", "sma150", "sma200"], bars: 260 },
    gaps: { name: "Gaps", lines: [], bars: 260 },
  };
  const RANGES = [["3M", 63], ["6M", 130], ["1Y", 260], ["2Y", 520], ["All", 99999]];
  // Candle timeframes. Weekly/monthly series come precomputed in the detail JSON (d.w / d.m)
  // with their own EMAs/SMAs (e.g. weekly 200 SMA = TradingView's weekly 200 SMA).
  const TFS = { d: "D", w: "W", m: "M" };
  const TF_RANGES = {
    d: RANGES,
    w: [["6M", 26], ["1Y", 52], ["2Y", 104], ["5Y", 260], ["All", 99999]],
    m: [["2Y", 24], ["5Y", 60], ["10Y", 120], ["All", 99999]],
  };
  const TF_NAME = { d: "daily", w: "weekly", m: "monthly" };
  const defaultBars = (v) => (S.tf === "w" ? (v === "ema" ? 52 : 260) : S.tf === "m" ? 99999 : VIEWS[v].bars);
  const rangesHTML = () => TF_RANGES[S.tf].map(([l, n]) => `<button data-n="${n}">${l}</button>`).join("");
  const tfSegHTML = () => `<div class="seg tf" id="tfSeg">${Object.entries(TFS).map(([k, l]) => `<button data-tf="${k}" class="${k === S.tf ? "on" : ""}" aria-label="${TF_NAME[k]} candles">${l}</button>`).join("")}</div>`;
  function tfData(detail) {
    if (S.tf === "d" || !detail[S.tf]) return detail;
    return { ...detail[S.tf], gaps: detail.gaps, close_only: detail.close_only, tf: S.tf };
  }
  const LEVEL_TYPES = {
    support: { label: "Support", color: "#2bd576", help: "Alert when price comes within the zone (±band)" },
    resistance: { label: "Resistance", color: "#ef5350", help: "Alert when price comes within the zone (±band)" },
    below: { label: "Price falls to", color: "#f5f5f7", help: "Alert when price is at or below" },
    above: { label: "Price rises to", color: "#f5f5f7", help: "Alert when price is at or above" },
  };

  // ------------------------------------------------------------------ storage
  const store = {
    get(k, d) { try { const v = localStorage.getItem("pb." + k); return v === null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem("pb." + k, JSON.stringify(v)); } catch { /* private mode */ } },
  };

  function detectRepo() {
    const saved = store.get("repo", "");
    if (saved) return saved;
    const h = location.hostname;
    if (h.endsWith(".github.io")) {
      const owner = h.split(".")[0];
      const repo = location.pathname.split("/").filter(Boolean)[0] || `${owner}.github.io`;
      return `${owner}/${repo}`;
    }
    return "";
  }

  const S = {
    summary: null, alerts: [], config: null, configSha: null, details: {},
    chart: null, sheetOpen: false, picking: null,
    sort: store.get("sort", "default"),
    zones: store.get("zones", true),
    tf: store.get("tf", "d"),
    repo: detectRepo(),
    token: store.get("token", ""),
    branch: store.get("branch", "main"),
    movers: null, briefs: [], briefCache: {},
    lang: store.get("lang", "en"),
    searchQ: "", lookups: {}, lookupMeta: {}, lkPending: {},
  };

  // ------------------------------------------------------------------ utils
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  // Links from briefs and headlines come from outside sources: only allow normal web links,
  // so a "javascript:" link can never run inside the app (where your GitHub key lives).
  const safeUrl = (u) => { try { const x = new URL(String(u || ""), location.href); return /^https?:$/.test(x.protocol) ? x.href : "#"; } catch { return "#"; } };
  function fmt(x) {
    if (x === null || x === undefined || Number.isNaN(x)) return "–";
    const a = Math.abs(x);
    if (a >= 10000) return x.toLocaleString("en-US", { maximumFractionDigits: 0 });
    if (a >= 1) return x.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    return x.toFixed(4);
  }
  const sgn = (x, d = 1) => (x === null || x === undefined ? "–" : `${x > 0 ? "+" : x < 0 ? "−" : ""}${Math.abs(x).toFixed(d)}%`);
  const cls = (x) => (x > 0 ? "up" : x < 0 ? "down" : "muted");
  const pct = (a, b) => (b ? ((a - b) / b) * 100 : null);
  function timeAgo(iso) {
    if (!iso) return "never";
    const s = (Date.now() - new Date(iso).getTime()) / 1000;
    if (s < 90) return "just now";
    if (s < 3600) return `${Math.round(s / 60)} min ago`;
    if (s < 86400) return `${Math.round(s / 3600)} h ago`;
    return new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short" });
  }
  const clock = (iso) => { try { return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }); } catch { return new Date(iso).toISOString().slice(11, 16); } };

  let toastT;
  function toast(msg, ms = 2600) {
    const t = $("#toast");
    t.textContent = msg;
    t.classList.add("show");
    clearTimeout(toastT);
    toastT = setTimeout(() => t.classList.remove("show"), ms);
  }

  function spark(values, up) {
    const v = (values || []).filter((x) => x !== null);
    if (v.length < 2) return "";
    const mn = Math.min(...v), mx = Math.max(...v), r = mx - mn || 1;
    const pts = v.map((x, i) => `${((i / (v.length - 1)) * 70 + 1).toFixed(1)},${(28 - ((x - mn) / r) * 26).toFixed(1)}`).join(" ");
    return `<svg viewBox="0 0 72 30"><polyline points="${pts}" stroke="${up ? COLORS.up : COLORS.down}"/></svg>`;
  }

  // ------------------------------------------------------------------ data
  async function getJSON(url) {
    const r = await fetch(url, { cache: "no-store" });
    if (!r.ok) throw new Error(`${r.status} ${url}`);
    return r.json();
  }

  async function loadSummary() {
    const bust = `t=${Date.now()}`;
    const [summary, alerts, movers, briefs] = await Promise.all([
      getJSON(`data/summary.json?${bust}`),
      getJSON(`data/alerts.json?${bust}`).catch(() => []),
      getJSON(`data/movers.json?${bust}`).catch(() => null),
      getJSON(`data/briefs/index.json?${bust}`).catch(() => []),
    ]);
    S.movers = movers;
    S.briefs = briefs;
    const changed = !S.summary || S.summary.generated !== summary.generated;
    S.summary = summary;
    S.alerts = alerts;
    if (changed) S.details = {};
    deskNotify();
    updateStatus();
    updateAlertDot();
    return changed;
  }

  async function loadBrief(id) {
    if (S.briefCache[id]) return S.briefCache[id];
    const b = await getJSON(`data/briefs/${encodeURIComponent(id)}.json`);
    S.briefCache[id] = b;
    return b;
  }

  async function loadDetail(sym) {
    if (S.details[sym]) return S.details[sym];
    const d = await getJSON(`data/${encodeURIComponent(sym)}.json?v=${encodeURIComponent(S.summary?.generated || Date.now())}`);
    S.details[sym] = d;
    return d;
  }

  // ---------------------------------------------------------------- GitHub
  const b64enc = (s) => btoa(unescape(encodeURIComponent(s)));
  const b64dec = (s) => decodeURIComponent(escape(atob(s.replace(/\n/g, ""))));

  async function gh(path, opts = {}) {
    if (!S.token || !S.repo) throw new Error("NO_TOKEN");
    const r = await fetch(`https://api.github.com/repos/${S.repo}${path}`, {
      cache: "no-store",
      ...opts,
      headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${S.token}`, "X-GitHub-Api-Version": "2022-11-28", ...(opts.headers || {}) },
    });
    if (!r.ok) {
      const e = new Error(`GitHub ${r.status}`);
      e.status = r.status;
      throw e;
    }
    return r.status === 204 ? null : r.json();
  }

  async function loadConfig(force) {
    if (S.config && !force) return S.config;
    if (S.token && S.repo) {
      try {
        const f = await gh(`/contents/config.json?ref=${encodeURIComponent(S.branch)}&t=${Date.now()}`);
        S.config = JSON.parse(b64dec(f.content));
        S.configSha = f.sha;
        return S.config;
      } catch (e) { console.warn("config via API failed", e); }
    }
    S.config = await getJSON(`config.json?t=${Date.now()}`);
    S.configSha = null;
    return S.config;
  }

  async function saveConfig(mutate, message) {
    if (!S.token || !S.repo) {
      toast("To save changes, add your GitHub key in Settings first.", 3500);
      location.hash = "#/settings";
      return false;
    }
    for (let attempt = 0; attempt < 2; attempt++) {
      await loadConfig(true);
      const next = JSON.parse(JSON.stringify(S.config));
      try {
        mutate(next);
      } catch {
        // e.g. the stock was removed on another device, so the change has nothing to apply to
        toast("That stock was changed or removed on another device – showing the latest version.", 4000);
        render(true);
        return false;
      }
      try {
        const res = await gh("/contents/config.json", {
          method: "PUT",
          body: JSON.stringify({ message: message || "Update alerts from app", content: b64enc(JSON.stringify(next, null, 2) + "\n"), sha: S.configSha, branch: S.branch }),
        });
        S.config = next;
        S.configSha = res.content.sha;
        toast("Saved – live after the next check (≈1–2 min).");
        return true;
      } catch (e) {
        if ((e.status === 409 || e.status === 422) && attempt === 0) { await new Promise((r) => setTimeout(r, 1200)); continue; }
        toast(e.status === 401 || e.status === 403 ? "GitHub key rejected – check it in Settings." : `Could not save (${e.message}).`, 4000);
        return false;
      }
    }
    return false;
  }

  async function runWorkflow(test) {
    try {
      await gh("/actions/workflows/check.yml/dispatches", {
        method: "POST",
        body: JSON.stringify({ ref: S.branch, inputs: { test_notification: test ? "true" : "false" } }),
      });
      toast(test ? "Test sent – your phone should ping within ~1 min." : "Check started – new data in ~1 min.", 4000);
    } catch (e) {
      toast(e.message === "NO_TOKEN" ? "Add your GitHub key first." : `Could not start (${e.message}). Key needs “Actions: read & write”.`, 4500);
    }
  }

  // ------------------------------------------------- notifications on this device
  // For the Mac: the Dock app shows new alerts as system notifications while it is running
  // (also minimised or in the background). Clicking one opens the stock in the app.
  // Off by default – on the phone, ntfy already does this.
  const canNotify = () => "Notification" in window && "serviceWorker" in navigator;
  function deskNotify() {
    if (!store.get("deskNotify", false) || !canNotify() || Notification.permission !== "granted") return;
    const list = S.alerts || [];
    const upTo = store.get("notifiedUpTo", "");
    if (!upTo) { store.set("notifiedUpTo", list[0]?.time || new Date().toISOString()); return; }
    const pushEma = !!S.summary?.settings?.ema_push;
    const fresh = list.filter((a) => a.time > upTo && (pushEma || !["ema8", "ema21"].includes(a.kind)));
    if (list[0]?.time > upTo) store.set("notifiedUpTo", list[0].time);
    if (!fresh.length) return;
    const url = (a) => location.pathname + (a.brief ? `#/brief/${encodeURIComponent(a.brief)}` : `#/s/${encodeURIComponent(a.symbol)}`);
    navigator.serviceWorker.ready.then((reg) => {
      if (fresh.length > 4) {
        reg.showNotification(`${fresh.length} new alerts`, { body: fresh.map((a) => a.title).join("\n"), tag: "pb-bundle", icon: "icons/icon-192.png", data: { url: location.pathname + "#/alerts" } });
      } else {
        fresh.reverse().forEach((a, i) => reg.showNotification(a.title, { body: a.message, tag: `pb-${a.time}-${i}`, icon: "icons/icon-192.png", data: { url: url(a) } }));
      }
    }).catch(() => {});
  }

  // ------------------------------------------------------------- shell / nav
  function updateStatus() {
    const s = S.summary;
    if (!s) return;
    const open = (s.market || "").startsWith("open");
    const stale = open && Date.now() - new Date(s.generated).getTime() > 20 * 60e3;
    const label = stale ? '<b class="warn">Checks paused?</b>' : `<b>${open ? "Market open" : "Market closed"}</b>`;
    $("#status").innerHTML = `${label}${clock(s.generated)} · ${timeAgo(s.generated)}`;
  }

  function updateAlertDot() {
    const seen = store.get("seenAlerts", "");
    const latest = S.alerts[0]?.time || "";
    $("#alertDot").hidden = !latest || latest <= seen;
  }

  function setTop(title, back) {
    $("#title").textContent = title;
    $("#backBtn").hidden = !back;
    document.title = title === "Pullback" ? "Pullback" : `${title} · Pullback`;
  }

  function setTab(tab) {
    document.querySelectorAll(".tabs a").forEach((a) => a.classList.toggle("on", a.dataset.tab === tab));
  }

  function destroyChart() {
    if (S.chart) { S.chart.chart.remove(); S.chart = null; }
  }

  function parseRoute() {
    const h = location.hash.replace(/^#\/?/, "");
    const [a, b] = h.split("/");
    if (a === "s" && b) return { name: "detail", sym: decodeURIComponent(b) };
    if (a === "brief" && b) return { name: "brief", id: decodeURIComponent(b) };
    if (a === "q" && b) return { name: "lookup", sym: decodeURIComponent(b) };
    if (["portfolio", "watchlist", "search", "fed", "alerts", "settings"].includes(a)) return { name: a };
    return { name: store.get("lastList", "portfolio") };
  }

  async function render(keepChartRange, keepScroll) {
    const r = parseRoute();
    let range = null;
    if (keepChartRange && S.chart) range = S.chart.chart.timeScale().getVisibleLogicalRange();
    destroyChart();
    closeSheet();
    clearInterval(fedTimer);
    if (!S.summary && !["settings", "search", "lookup", "fed"].includes(r.name)) {
      view.innerHTML = `<div class="empty"><b>Loading…</b></div>`;
      return;
    }
    if (r.name === "detail") return renderDetail(r.sym, range);
    if (r.name === "lookup") return renderLookup(r.sym, range, !keepChartRange);
    if (r.name === "search") return renderSearch();
    if (r.name === "brief") return renderBriefPage(r.id);
    if (r.name === "fed") return renderFed();
    const y = window.scrollY;
    if (r.name === "alerts") renderAlerts();
    else if (r.name === "settings") renderSettings();
    else { store.set("lastList", r.name); renderList(r.name); }
    window.scrollTo(0, keepScroll ? y : 0);
  }

  // ------------------------------------------------------------------ list
  function stocksFor(kind) {
    const rows = S.summary.stocks || [];
    const known = new Set(rows.map((r) => r.symbol));
    const extra = (S.config?.stocks || []).filter((s) => !known.has(s.symbol)).map((s) => ({ ...s, pending: true }));
    const cfg = Object.fromEntries((S.config?.stocks || []).map((s) => [s.symbol, s]));
    return rows.concat(extra)
      .map((r) => (cfg[r.symbol] ? { ...r, list: cfg[r.symbol].list, high_conviction: cfg[r.symbol].high_conviction } : r))
      .filter((r) => (r.list || "watchlist") === kind);
  }

  function renderList(kind) {
    setTop("Pullback", false);
    setTab(kind);
    let rows = stocksFor(kind);
    if (S.sort === "closest") {
      rows = rows.slice().sort((a, b) => Math.abs(a.nearest?.dist_pct ?? 999) - Math.abs(b.nearest?.dist_pct ?? 999));
    } else if (S.sort === "change") {
      rows = rows.slice().sort((a, b) => (b.change_pct ?? -999) - (a.change_pct ?? -999));
    }
    const inZone = rows.filter((r) => r.in_zone?.length);
    const title = kind === "portfolio" ? "Portfolio" : "Watchlist";

    let html = `<div class="list-head"><h2>${title} · ${rows.length}</h2>
      <div class="seg" id="sortSeg">
        <button data-s="default" class="${S.sort === "default" ? "on" : ""}">Default</button>
        <button data-s="closest" class="${S.sort === "closest" ? "on" : ""}">Near level</button>
        <button data-s="change" class="${S.sort === "change" ? "on" : ""}">Today</button>
      </div>
      <button class="icon-btn" id="addStock" aria-label="Add stock"><svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg></button></div>`;

    html += moversStripHTML();
    if (inZone.length) {
      html += `<div class="banner"><b>${inZone.length} in a zone now:</b> ${inZone.map((r) => esc(r.symbol)).join(", ")}</div>`;
    }
    if (S.summary.errors?.length) {
      html += `<div class="banner warn"><b>No data for</b> ${S.summary.errors.map((e) => esc(e.symbol)).join(", ")} – check the ticker symbol.</div>`;
    }

    if (!rows.length) {
      html += `<div class="empty"><b>Nothing here yet</b>${kind === "portfolio"
        ? "Open a stock from your Watchlist and tap “Watchlist” to move it into your Portfolio."
        : "Tap + to add a ticker."}</div>`;
    } else {
      html += `<ul class="rows">` + rows.map(rowHTML).join("") + `</ul>`;
    }
    view.innerHTML = html;

    $("#sortSeg").onclick = (e) => {
      const s = e.target.closest("button")?.dataset.s;
      if (!s) return;
      S.sort = s; store.set("sort", s); renderList(kind);
    };
    $("#addStock").onclick = () => addStockSheet(kind);
    bindMovers();
    view.querySelectorAll(".row").forEach((el) => (el.onclick = () => (location.hash = `#/s/${encodeURIComponent(el.dataset.sym)}`)));
  }

  function rowHTML(r) {
    if (r.pending || r.error) {
      return `<li class="row" data-sym="${esc(r.symbol)}"><div><div class="sym">${esc(r.symbol)}</div>
        <div class="name">${esc(r.name || "")}</div><div class="chips"><span class="chip">${r.error ? "No data – check ticker" : "Waiting for next check"}</span></div></div><div></div><div></div></li>`;
    }
    const chips = [];
    (r.in_zone || []).forEach((z) => chips.push(`<span class="chip zone">● ${esc(z)}</span>`));
    if (!r.in_zone?.length && r.nearest) chips.push(`<span class="chip">${esc(r.nearest.label)} ${sgn(r.nearest.dist_pct)}</span>`);
    const ext = S.summary.settings?.extended_pct ?? 15;
    if (r.extended_pct !== null && r.extended_pct >= ext) chips.push(`<span class="chip ext">Extended ${sgn(r.extended_pct, 0)} vs 8 EMA</span>`);
    return `<li class="row" data-sym="${esc(r.symbol)}">
      <div><div class="sym">${esc(disp(r.symbol))}${r.high_conviction ? '<span class="star" title="High conviction">★</span>' : ""}</div>
        <div class="name">${esc(r.name)}</div><div class="chips">${chips.join("")}</div></div>
      <div class="spark">${spark(r.spark, (r.change_pct ?? 0) >= 0)}</div>
      <div class="px num"><div class="p">${fmt(r.price)}</div><div class="c ${cls(r.change_pct)}">${sgn(r.change_pct, 2)}</div></div>
    </li>`;
  }

  // ------------------------------------------------------------------ detail
  async function renderDetail(sym, keepRange) {
    const row = (S.summary.stocks || []).find((r) => r.symbol === sym);
    const cfg = (S.config?.stocks || []).find((s) => s.symbol === sym) || row || { symbol: sym, levels: [] };
    setTop(disp(sym), true);
    setTab(cfg.list || "watchlist");
    if (!row || row.error) {
      view.innerHTML = `<div class="empty"><b>${esc(sym)}</b>${row?.error ? "No data could be loaded for this ticker." : "Data appears after the next check."}</div>` + manageCard(cfg);
      bindManage(cfg);
      return;
    }
    const vname = store.get("view", "ema");
    const levels = cfg.levels || [];
    const hc = !!cfg.high_conviction;
    const isPort = (cfg.list || "watchlist") === "portfolio";

    view.innerHTML = `
      <div class="d-head">
        <div><div class="muted" style="font-size:13px">${esc(row.name)}</div>
          <div class="big num">${fmt(row.price)}</div></div>
        <div class="chg num ${cls(row.change_pct)}">${sgn(row.change_pct, 2)}</div>
        <div class="spacer"></div>
        <button class="pill ${hc ? "on" : ""}" id="hcBtn">★ High conviction</button>
        <button class="pill port ${isPort ? "on" : ""}" id="listBtn">${isPort ? "✓ In portfolio" : "+ Portfolio"}</button>
      </div>
      <div class="views"><div class="seg" id="viewSeg">
        ${Object.entries(VIEWS).map(([k, v]) => `<button data-v="${k}" class="${k === vname ? "on" : ""}">${v.name}</button>`).join("")}
      </div>${tfSegHTML()}</div>
      <div class="chart-wrap"><div id="chart"></div><div class="legend num" id="legend"></div>
        <div class="pick-hint" id="pickHint" hidden>Tap the chart at your price</div></div>
      <div class="ranges" id="ranges">
        ${rangesHTML()}
        <span class="sp"></span>
        <label class="toggle"><input type="checkbox" id="zonesChk" ${S.zones ? "checked" : ""}> Zones ±${S.summary.settings?.band_pct ?? 1.5}%</label>
      </div>
      ${moverCardHTML(sym)}
      <div class="detail-grid">
        <div id="levelsCard"></div>
        <div>${manualCard(levels, row)}${manageCard(cfg)}</div>
      </div>`;
    bindMovers();

    $("#hcBtn").onclick = () => saveConfig((c) => { const s = c.stocks.find((x) => x.symbol === sym); s.high_conviction = !s.high_conviction; }, `${sym}: toggle high conviction`).then((ok) => ok && render(true));
    $("#listBtn").onclick = () => saveConfig((c) => { const s = c.stocks.find((x) => x.symbol === sym); s.list = s.list === "portfolio" ? "watchlist" : "portfolio"; }, `${sym}: move list`).then((ok) => ok && render(true));
    $("#addLevel").onclick = () => levelSheet(sym, row);
    view.querySelectorAll("[data-del]").forEach((b) => (b.onclick = () => {
      const i = +b.dataset.del;
      saveConfig((c) => { c.stocks.find((x) => x.symbol === sym).levels.splice(i, 1); }, `${sym}: remove level`).then((ok) => ok && render(true));
    }));
    bindManage(cfg);

    let detail;
    try { detail = await loadDetail(sym); } catch (e) {
      $("#chart").innerHTML = `<div class="empty">Chart data not available yet.</div>`;
      return;
    }
    if (parseRoute().sym !== sym) return;   // user navigated away meanwhile
    buildChart(tfData(detail), row, levels, vname, keepRange);
    bindChartControls(detail);
  }

  function bindChartControls(detail) {
    if (S.tf !== "d" && !detail[S.tf]) toast(`${TF_NAME[S.tf][0].toUpperCase() + TF_NAME[S.tf].slice(1)} candles appear after the next update – showing daily`);
    $("#tfSeg").onclick = (e) => {
      const tf = e.target.closest("button")?.dataset.tf;
      if (!tf || tf === S.tf) return;
      S.tf = tf;
      store.set("tf", tf);
      render(false);
    };
    $("#viewSeg").onclick = (e) => {
      const v = e.target.closest("button")?.dataset.v;
      if (!v) return;
      store.set("view", v);
      view.querySelectorAll("#viewSeg button").forEach((b) => b.classList.toggle("on", b.dataset.v === v));
      applyView(v, true);
    };
    $("#ranges").onclick = (e) => {
      const n = e.target.closest("button")?.dataset.n;
      if (n) setBars(+n);
    };
    $("#zonesChk").onchange = (e) => { S.zones = e.target.checked; store.set("zones", S.zones); applyView(S.chart.view, false); };
  }

  function levelsCardHTML(v, row, detail) {
    const inner = levelsCardInner(v, row, detail);
    if (!detail?.tf || v === "gaps") return inner;
    return `<div class="tf-note">Chart shows ${TF_NAME[detail.tf]} candles with ${TF_NAME[detail.tf]} averages. The levels and alerts below use daily values.</div>` + inner;
  }

  function levelsCardInner(v, row, detail) {
    const set = S.summary.settings || {};
    const band = set.band_pct ?? 1.5;
    const L = row.levels || {};
    const line = (key, extra = "") => {
      const val = L[key], d = row.dist?.[key];
      const zone = d !== undefined && Math.abs(d) <= band;
      return `<div class="lv"><span class="sw" style="background:${COLORS[key]}"></span>
        <span>${LABEL[key]}${extra}${val ? `<span class="sub num">Zone ${fmt(val * (1 - band / 100))} – ${fmt(val * (1 + band / 100))}</span>` : ""}</span><span class="v num">${fmt(val)}</span>
        <span class="d num ${zone ? "zone" : cls(d)}">${zone ? "● " : ""}${sgn(d)}</span></div>`;
    };
    if (v === "ema") {
      const ext = set.extended_pct ?? 15;
      return `<div class="card"><h3>Short-term momentum</h3>
        ${line("ema8", '<span class="sub">Entry 1 – first, smaller buy</span>')}
        ${line("ema21", '<span class="sub">Entry 2 – second, heavier buy</span>')}
        <div class="lv"><span class="sw" style="background:${row.momentum ? COLORS.up : COLORS.down}"></span>
          <span>Momentum<span class="sub">${row.momentum ? "Intact – 8 EMA above 21 EMA" : "Weakening – 8 EMA below 21 EMA"}</span></span><span></span><span></span></div>
        <div class="lv"><span class="sw" style="background:${COLORS.sma150}"></span>
          <span>Stretch vs 8 EMA<span class="sub">Profit-taking alert at +${ext}% (no news)</span></span><span></span>
          <span class="d num ${row.extended_pct >= ext ? "zone" : ""}">${sgn(row.extended_pct)}</span></div>
        <div class="note" style="padding-top:10px">Distances are price vs. the line. Lines are areas, not exact prices (±${band}%).</div></div>`;
    }
    if (v === "sma") {
      const all = new Set(set.sma_alerts_all || []);
      const hcs = new Set(set.sma_alerts_high_conviction || [200]);
      const bell = (n) => (all.has(n) || (row.high_conviction && hcs.has(n)) ? '<span class="bell" title="Alert on">🔔</span>' : "");
      return `<div class="card"><h3>Longer-term trend</h3>
        ${line("sma50", bell(50))}${line("sma100", bell(100))}${line("sma150", bell(150))}
        ${line("sma200", bell(200) + '<span class="sub">Major entry on high-conviction names – check why it fell</span>')}
        <div class="note" style="padding-top:10px">${row.list === "lookup" ? "Not on your lists – no alerts." : row.high_conviction ? "★ High conviction: 200-day alerts on." : "Mark ★ High conviction to get 200-day alerts."}</div></div>`;
    }
    // gaps
    const gaps = (detail?.gaps || []).filter((g) => !g.filled)
      .map((g) => ({ ...g, below: g.open_top <= row.price, edge: g.open_top <= row.price ? g.open_top : g.open_bottom }))
      .sort((a, b) => Math.abs(pct(row.price, a.edge)) - Math.abs(pct(row.price, b.edge)));
    const filled = (detail?.gaps || []).filter((g) => g.filled).slice(-3).reverse();
    const gl = (g) => {
      const d = pct(g.edge, row.price);
      const inside = row.price >= g.open_bottom && row.price <= g.open_top;
      return `<div class="lv"><span class="sw box" style="background:${g.below ? "rgba(38,166,154,.6)" : "rgba(239,83,80,.6)"}"></span>
        <span>${fmt(g.open_bottom)} – ${fmt(g.open_top)}<span class="sub">${g.below ? "Below · possible entry" : "Above · resistance / trim"} · from ${g.start} · ${g.fill_pct}% filled</span></span>
        <span></span><span class="d num ${inside || Math.abs(d) <= band ? "zone" : ""}">${inside ? "● inside" : sgn(d)}</span></div>`;
    };
    return `<div class="card"><h3>Open gaps · ${gaps.length}</h3>
      ${gaps.length ? gaps.slice(0, 8).map(gl).join("") : `<div class="note">${detail?.close_only ? "Yields only have one value per day, so there are no gaps to track." : "No open gaps in the last 3 years."}</div>`}
      ${filled.length ? `<h3 style="padding-top:14px">Recently filled</h3>${filled.map((g) => `<div class="lv"><span class="sw box" style="background:#3a4357"></span><span>${fmt(g.bottom)} – ${fmt(g.top)}<span class="sub">${g.dir}-gap ${g.start} · filled ${g.filled_date}</span></span><span></span><span></span></div>`).join("")}` : ""}
      <div class="note" style="padding-top:10px">Distance = how far price must move to reach the open edge.</div></div>`;
  }

  function manualCard(levels, row) {
    const items = levels.map((m, i) => {
      const t = LEVEL_TYPES[m.type] || LEVEL_TYPES.support;
      const d = pct(row.price, m.price);
      return `<div class="lv"><span class="sw" style="background:${t.color}"></span>
        <span>${t.label}${m.note ? `<span class="sub">${esc(m.note)}</span>` : ""}</span>
        <span class="v num">${fmt(+m.price)}</span>
        <span style="display:flex;align-items:center;gap:4px"><span class="d num ${cls(-d)}">${sgn(d)}</span><button class="del" data-del="${i}" aria-label="Delete">×</button></span></div>`;
    }).join("");
    return `<div class="card"><h3>Your alert levels<span class="sp"></span></h3>
      ${items || '<div class="note">Add your own support, resistance or price targets – you get a push when price gets there.</div>'}
      <div class="actions"><button class="btn primary small" id="addLevel">+ Add level</button></div></div>`;
  }

  function manageCard(cfg) {
    return `<div class="card"><h3>Manage</h3><div class="actions" style="border-top:0">
      <button class="btn small danger" id="removeStock">Remove ${esc(cfg.symbol)}</button></div></div>`;
  }
  function bindManage(cfg) {
    const b = $("#removeStock");
    if (!b) return;
    b.onclick = () => {
      if (b.dataset.confirm !== "1") { b.dataset.confirm = "1"; b.textContent = "Tap again to remove"; return; }
      saveConfig((c) => { c.stocks = c.stocks.filter((s) => s.symbol !== cfg.symbol); }, `Remove ${cfg.symbol}`)
        .then((ok) => { if (ok) location.hash = `#/${cfg.list || "watchlist"}`; });
    };
  }

  // ------------------------------------------------------------------ chart
  class Overlay {
    // Custom drawing layer: gap boxes and ±band zones around moving averages.
    constructor() { this.gaps = []; this.bands = []; this._views = [{ zOrder: () => "bottom", renderer: () => ({ draw: (t) => this.draw(t) }) }]; }
    attached({ chart, series, requestUpdate }) { this.chart = chart; this.series = series; this.req = requestUpdate; }
    detached() {}
    updateAllViews() {}
    paneViews() { return this._views; }
    set(gaps, bands) { this.gaps = gaps; this.bands = bands; this.req && this.req(); }
    draw(target) {
      if (!this.chart) return;
      const ts = this.chart.timeScale(), s = this.series;
      target.useBitmapCoordinateSpace(({ context: ctx, bitmapSize, horizontalPixelRatio: hr, verticalPixelRatio: vr }) => {
        const range = ts.getVisibleLogicalRange();
        if (!range) return;
        for (const b of this.bands) {
          const from = Math.max(0, Math.floor(range.from) - 1), to = Math.min(b.values.length - 1, Math.ceil(range.to) + 1);
          const up = [], dn = [];
          for (let i = from; i <= to; i++) {
            const v = b.values[i];
            if (v === null || v === undefined) continue;
            const x = ts.logicalToCoordinate(i);
            const y1 = s.priceToCoordinate(v * (1 + b.pct / 100)), y2 = s.priceToCoordinate(v * (1 - b.pct / 100));
            if (x === null || y1 === null || y2 === null) continue;
            up.push([x * hr, y1 * vr]); dn.push([x * hr, y2 * vr]);
          }
          if (up.length < 2) continue;
          ctx.beginPath();
          up.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
          for (let i = dn.length - 1; i >= 0; i--) ctx.lineTo(dn[i][0], dn[i][1]);
          ctx.closePath();
          ctx.fillStyle = b.fill;
          ctx.fill();
          // crisp thin edges so the zone reads as a clear band instead of a haze
          ctx.save();
          ctx.strokeStyle = b.edge;
          ctx.lineWidth = Math.max(1, Math.round(hr));
          ctx.setLineDash([4 * hr, 3 * hr]);
          for (const pts of [up, dn]) {
            ctx.beginPath();
            pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, Math.round(y) + 0.5) : ctx.moveTo(x, Math.round(y) + 0.5)));
            ctx.stroke();
          }
          ctx.restore();
        }
        for (const g of this.gaps) {
          const x1 = ts.logicalToCoordinate(g.i0 - 0.5);
          const x2 = g.i1 === null ? bitmapSize.width / hr : ts.logicalToCoordinate(g.i1);
          if (x1 === null || x2 === null) continue;
          const draw = (top, bot, fill, stroke) => {
            const y1 = s.priceToCoordinate(top), y2 = s.priceToCoordinate(bot);
            if (y1 === null || y2 === null) return;
            const X = Math.round(x1 * hr), W = Math.round((x2 - x1) * hr), Y = Math.round(y1 * vr), H = Math.max(1, Math.round((y2 - y1) * vr));
            ctx.fillStyle = fill; ctx.fillRect(X, Y, W, H);
            if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = hr; ctx.strokeRect(X + 0.5, Y + 0.5, W - 1, H - 1); }
          };
          if (g.filled) { draw(g.top, g.bottom, "rgba(138,147,166,.10)"); continue; }
          draw(g.top, g.bottom, g.below ? "rgba(38,166,154,.07)" : "rgba(239,83,80,.07)");
          draw(g.open_top, g.open_bottom, g.below ? "rgba(38,166,154,.28)" : "rgba(239,83,80,.28)", g.below ? "rgba(38,166,154,.7)" : "rgba(239,83,80,.7)");
        }
      });
    }
  }

  function buildChart(d, row, levels, vname, keepRange) {
    const el = $("#chart");
    const chart = LWC.createChart(el, {
      autoSize: true,
      localization: { locale: "en-US", dateFormat: "dd MMM 'yy" },
      layout: { background: { type: "solid", color: "#0b0e14" }, textColor: COLORS.text, fontSize: 11, fontFamily: "-apple-system, Roboto, system-ui, sans-serif" },
      grid: { vertLines: { color: COLORS.grid }, horzLines: { color: COLORS.grid } },
      rightPriceScale: { borderColor: COLORS.line, scaleMargins: { top: 0.12, bottom: 0.18 } },
      timeScale: { borderColor: COLORS.line, rightOffset: 4, barSpacing: 6, minBarSpacing: 0.5 },
      crosshair: { mode: LWC.CrosshairMode.Normal, vertLine: { color: "#4b556b", labelBackgroundColor: "#263044" }, horzLine: { color: "#4b556b", labelBackgroundColor: "#263044" } },
      handleScale: { axisPressedMouseMove: { time: true, price: true }, pinch: true, mouseWheel: false },
      handleScroll: { vertTouchDrag: false, mouseWheel: false },
      kineticScroll: { touch: true, mouse: false },
    });

    const n = d.t.length;
    const priceFormat = { type: "price", precision: row.price >= 10 ? 2 : 4, minMove: row.price >= 10 ? 0.01 : 0.0001 };
    let candles;
    if (d.close_only) {      // bond yields: one value per day -> line chart
      candles = chart.addLineSeries({ color: "#e7eaf0", lineWidth: 2, priceFormat: { type: "price", precision: 2, minMove: 0.01 } });
      candles.setData(d.t.map((t, i) => ({ time: t, value: d.c[i] })));
    } else {
      candles = chart.addCandlestickSeries({
        upColor: COLORS.up, downColor: COLORS.down, wickUpColor: COLORS.up, wickDownColor: COLORS.down, borderVisible: false, priceFormat,
      });
      candles.setData(d.t.map((t, i) => ({ time: t, open: d.o[i], high: d.h[i], low: d.l[i], close: d.c[i] })));
    }

    const vol = chart.addHistogramSeries({ priceScaleId: "vol", priceFormat: { type: "volume" }, lastValueVisible: false, priceLineVisible: false });
    chart.priceScale("vol").applyOptions({ scaleMargins: { top: 0.86, bottom: 0 }, visible: false });
    if (d.v.some((x) => x > 0)) {
      vol.setData(d.t.map((t, i) => ({ time: t, value: d.v[i], color: d.c[i] >= d.o[i] ? "rgba(38,166,154,.28)" : "rgba(239,83,80,.28)" })));
    }

    const lines = {};
    for (const key of ["ema8", "ema21", "sma50", "sma100", "sma150", "sma200"]) {
      lines[key] = chart.addLineSeries({
        color: COLORS[key], lineWidth: key === "sma200" ? 3 : 2, priceLineVisible: false, lastValueVisible: true,
        crosshairMarkerVisible: false, visible: false, title: "",
      });
      lines[key].setData(d.t.map((t, i) => (d[key][i] === null ? { time: t } : { time: t, value: d[key][i] })));
    }

    // manual levels as price lines (all views)
    const levelLines = levels.map((m) => {
      const t = LEVEL_TYPES[m.type] || LEVEL_TYPES.support;
      return { price: +m.price, color: t.color, title: m.note ? m.note.slice(0, 14) : t.label,
        line: candles.createPriceLine({ price: +m.price, color: t.color, lineWidth: 1, lineStyle: LWC.LineStyle.Dashed, axisLabelVisible: true, title: m.note ? m.note.slice(0, 14) : t.label }) };
    });

    const overlay = new Overlay();
    candles.attachPrimitive(overlay);
    const zoneBox = new ZoneBox();
    candles.attachPrimitive(zoneBox);
    bindWheel(el, chart);

    const barOf = (date) => {          // last bar starting on or before date
      let lo = 0, hi = n - 1;
      if (!date || date < d.t[0]) return 0;
      while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (d.t[mid] <= date) lo = mid; else hi = mid - 1; }
      return lo;
    };
    const gaps = (d.gaps || []).map((g) => ({
      ...g, i0: barOf(g.start), i1: g.filled ? barOf(g.filled_date) : null,
      below: g.open_top <= row.price,
    }));

    S.chart = { chart, candles, vol, lines, overlay, zoneBox, levelLines, gaps, d, row, view: vname, n };

    // legend + chart picking
    const legend = $("#legend");
    const showLegend = (i) => {
      if (i === null || i === undefined || i < 0 || i >= n) i = n - 1;
      const v = S.chart.view;
      const parts = [`<span class="k">${d.t[i]}</span>`];
      if (v === "sma" || d.close_only) parts.push(`<span><span class="k">C</span> <i>${fmt(d.c[i])}</i></span>`);
      else parts.push(`<span><span class="k">O</span> ${fmt(d.o[i])} <span class="k">H</span> ${fmt(d.h[i])} <span class="k">L</span> ${fmt(d.l[i])} <span class="k">C</span> <i>${fmt(d.c[i])}</i></span>`);
      for (const key of VIEWS[v].lines) parts.push(`<span><span class="k">${LABEL[key]}</span> <i style="color:${COLORS[key]}">${fmt(d[key][i])}</i></span>`);
      legend.innerHTML = parts.join("");
    };
    S.chart.showLegend = showLegend;
    chart.subscribeCrosshairMove((p) => showLegend(p.logical !== undefined && p.point ? Math.round(p.logical) : null));
    chart.subscribeClick((p) => {
      if (!S.picking || !p.point) return;
      const price = candles.coordinateToPrice(p.point.y);
      if (price !== null) S.picking(price);
    });

    applyView(vname, !keepRange);
    if (keepRange) chart.timeScale().setVisibleLogicalRange(keepRange);
    $("#levelsCard").innerHTML = levelsCardHTML(vname, row, d);
  }

  // Mac trackpad / mouse wheel: plain vertical scrolling scrolls the page (the chart no
  // longer swallows it), pinch or Ctrl/⌘ + scroll zooms around the pointer, sideways
  // swipe or Shift + scroll pans through time.
  function bindWheel(el, chart) {
    el.addEventListener("wheel", (e) => {
      const ts = chart.timeScale();
      const r = ts.getVisibleLogicalRange();
      if (!r) return;
      const width = el.clientWidth || 1;
      const zoom = e.ctrlKey || e.metaKey;
      const dx = e.shiftKey && !e.deltaX ? e.deltaY : e.deltaX;
      if (!zoom && Math.abs(dx) <= Math.abs(e.deltaY)) return;   // let the page scroll
      e.preventDefault();
      const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? width : 1;
      if (zoom) {
        const rect = el.getBoundingClientRect();
        const anchor = ts.coordinateToLogical(e.clientX - rect.left) ?? r.to;
        const f = Math.min(1.5, Math.max(0.67, Math.exp(e.deltaY * unit * 0.01)));
        const from = anchor - (anchor - r.from) * f, to = anchor + (r.to - anchor) * f;
        if (to - from >= 10 && (to - from) <= width * 2) ts.setVisibleLogicalRange({ from, to });
      } else {
        const shift = (dx * unit) * (r.to - r.from) / width;
        ts.setVisibleLogicalRange({ from: r.from + shift, to: r.to + shift });
      }
    }, { passive: false });
  }

  function applyView(v, resetRange) {
    const c = S.chart;
    if (!c) return;
    c.view = v;
    const band = S.summary.settings?.band_pct ?? 1.5;
    for (const [key, s] of Object.entries(c.lines)) s.applyOptions({ visible: VIEWS[v].lines.includes(key) });
    // zone = lighter shade of its line: flat tinted fill + thin dashed edges in the same tint
    const bands = S.zones ? VIEWS[v].lines.map((key) => ({
      values: c.d[key], pct: band,
      fill: tintA(COLORS[key], 0.35, key === "sma200" ? 0.11 : 0.15),
      edge: tintA(COLORS[key], 0.35, 0.55),
    })) : [];
    c.overlay.set(v === "gaps" ? c.gaps : [], bands);
    setZoneEdges(c, v, band);
    c.showLegend(null);
    if (resetRange) setBars(defaultBars(v));
    $("#levelsCard").innerHTML = levelsCardHTML(v, c.row, c.d);
  }

  // One taller price-axis label for the zone the price is closest to: the line's value in the
  // middle (at the line's height), the +band edge above it and the −band edge below it – the same
  // order as on the chart. While the box is shown, the other axis labels (other lines, your
  // levels, the current price) are drawn here too, *after* the box, so where they overlap the
  // smaller labels always stay visible on top of the bigger box.
  class ZoneBox {
    constructor() {
      this.box = null;
      this.labels = [];
      this._views = [{ zOrder: () => "top", renderer: () => ({ draw: (t) => this.draw(t) }) }];
      this._pane = [{ zOrder: () => "top", renderer: () => ({ draw: (t) => this.drawTitles(t) }) }];
    }
    attached({ series, requestUpdate }) { this.series = series; this.req = requestUpdate; }
    detached() {}
    updateAllViews() {}
    paneViews() { return this._pane; }
    priceAxisPaneViews() { return this._views; }
    // names of your levels ("Support", or your note) at the right edge of the chart, as the
    // library shows them when it draws the labels itself
    drawTitles(target) {
      if (!this.box || !this.series) return;
      target.useBitmapCoordinateSpace(({ context: ctx, bitmapSize, horizontalPixelRatio: hr, verticalPixelRatio: vr }) => {
        ctx.save();
        ctx.textBaseline = "middle";
        ctx.font = `400 ${Math.round(11 * vr)}px -apple-system, Roboto, system-ui, sans-serif`;
        for (const l of this.labels) {
          if (!l.title) continue;
          const ly = this.series.priceToCoordinate(l.val);
          if (ly === null) continue;
          const tw = ctx.measureText(l.title).width, pad = 5 * hr, h = 16;
          const W = tw + pad * 2, X = bitmapSize.width - W, Y = Math.round((ly - h / 2) * vr);
          ctx.fillStyle = l.color;
          ctx.fillRect(X, Y, W, Math.round(h * vr));
          ctx.fillStyle = textOn(l.color);
          ctx.fillText(l.title, X + pad, Y + (h / 2) * vr);
        }
        ctx.restore();
      });
    }
    set(box, labels) { this.box = box; this.labels = labels || []; this.req && this.req(); }
    draw(target) {
      const b = this.box;
      if (!b || !this.series) return;
      const y = this.series.priceToCoordinate(b.val);
      target.useBitmapCoordinateSpace(({ context: ctx, bitmapSize, horizontalPixelRatio: hr, verticalPixelRatio: vr }) => {
        const W = bitmapSize.width, r = 3 * hr, x = Math.round(6 * hr);
        const font = (wt, px) => `${wt} ${Math.round(px * vr)}px -apple-system, Roboto, system-ui, sans-serif`;
        const rect = (Y, H, color) => {
          ctx.fillStyle = color;
          ctx.beginPath();
          if (ctx.roundRect) ctx.roundRect(0, Y, W, H, [0, r, r, 0]); else ctx.rect(0, Y, W, H);
          ctx.fill();
        };
        ctx.save();
        ctx.textBaseline = "middle";
        ctx.textAlign = "left";
        if (y !== null) {
          const row = 11, h = row * 3 + 2;                   // css px – compact
          const Y = Math.round((y - h / 2) * vr);
          rect(Y, Math.round(h * vr), b.color);
          ctx.fillStyle = textOn(b.color);
          ctx.font = font(400, 9);
          ctx.fillText(b.upTxt, x, Y + (1 + row * 0.5) * vr);
          ctx.font = font(700, 11);
          ctx.fillText(b.valTxt, x, Y + (1 + row * 1.5) * vr);
          ctx.font = font(400, 9);
          ctx.fillText(b.dnTxt, x, Y + (1 + row * 2.5) * vr);
        }
        // normal one-value labels on top (current price last, so it always wins)
        for (const l of this.labels) {
          const ly = this.series.priceToCoordinate(l.val);
          if (ly === null) continue;
          const h = 16, Y = Math.round((ly - h / 2) * vr);
          rect(Y, Math.round(h * vr), l.color);
          ctx.fillStyle = textOn(l.color);
          ctx.font = font(400, 11);
          ctx.fillText(l.txt, x, Y + (h / 2) * vr);
        }
        ctx.restore();
      });
    }
  }

  function textOn(hex) {             // dark text on light labels, white on dark ones
    const n = parseInt(String(hex).slice(1, 7), 16);
    const lum = 0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255);
    return lum > 150 ? "#0b0e14" : "#ffffff";
  }

  function setZoneEdges(c, v, band) {
    const keys = VIEWS[v].lines;
    const lastVal = (arr) => { for (let i = (arr || []).length - 1; i >= 0; i--) if (arr[i] !== null && arr[i] !== undefined) return arr[i]; return null; };
    let best = null;
    if (S.zones && keys.length && c.row?.price) {
      for (const key of keys) {
        const val = lastVal(c.d[key]);
        if (val === null) continue;
        const dist = Math.abs(c.row.price - val);
        if (!best || dist < best.dist) best = { key, val, dist };
      }
    }
    const own = !!best;                      // while the box shows, we draw every axis label
    for (const s of Object.values(c.lines)) s.applyOptions({ lastValueVisible: !own });
    c.candles.applyOptions({ lastValueVisible: !own });
    for (const l of c.levelLines || []) l.line.applyOptions({ axisLabelVisible: !own });
    if (!own) { c.zoneBox.set(null); return; }

    const dec = c.row.price >= 10 ? 2 : 4;
    const txt = (x) => (+x).toFixed(dec);
    const labels = [];
    for (const key of keys) {
      if (key === best.key) continue;
      const val = lastVal(c.d[key]);
      if (val !== null) labels.push({ val, color: COLORS[key], txt: txt(val) });
    }
    for (const l of c.levelLines || []) labels.push({ val: l.price, color: l.color, txt: txt(l.price), title: l.title });
    const last = c.n - 1;
    const pxColor = c.d.close_only ? "#e7eaf0" : (c.d.c[last] >= c.d.o[last] ? COLORS.up : COLORS.down);
    labels.push({ val: c.d.c[last], color: pxColor, txt: txt(c.d.c[last]) });
    c.zoneBox.set({
      val: best.val, color: COLORS[best.key],
      upTxt: fmt(best.val * (1 + band / 100)), valTxt: fmt(best.val), dnTxt: fmt(best.val * (1 - band / 100)),
    }, labels);
  }

  function setBars(bars) {
    const c = S.chart;
    if (!c) return;
    if (bars >= c.n) c.chart.timeScale().fitContent();
    else c.chart.timeScale().setVisibleLogicalRange({ from: c.n - bars, to: c.n + 3 });
    document.querySelectorAll("#ranges button").forEach((b) => b.classList.toggle("on", +b.dataset.n === bars));
  }

  function tintA(hex, mix, a) {          // blend towards white, then apply alpha
    const n = parseInt(hex.slice(1), 16);
    const ch = (v) => Math.round(v + (255 - v) * mix);
    return `rgba(${ch((n >> 16) & 255)},${ch((n >> 8) & 255)},${ch(n & 255)},${a})`;
  }

  function hexA(hex, a) {
    const n = parseInt(hex.slice(1), 16);
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
  }

  // ------------------------------------------------------------------ sheets
  function openSheet(html, onMount) {
    closeSheet();
    const bg = document.createElement("div");
    bg.className = "sheet-bg";
    bg.innerHTML = `<div class="sheet">${html}</div>`;
    bg.onclick = (e) => { if (e.target === bg) closeSheet(); };
    document.body.appendChild(bg);
    S.sheetOpen = true;
    onMount(bg);
  }
  function closeSheet() {
    document.querySelectorAll(".sheet-bg").forEach((x) => x.remove());
    S.sheetOpen = false;
    S.picking = null;
    const h = $("#pickHint");
    if (h) h.hidden = true;
  }

  function levelSheet(sym, row) {
    const html = `<h4>New alert level · ${esc(sym)}</h4>
      <div class="form">
        <label class="field">Type<select id="lvType">
          ${Object.entries(LEVEL_TYPES).map(([k, t]) => `<option value="${k}">${t.label}</option>`).join("")}</select></label>
        <div class="help" id="lvHelp"></div>
        <div class="row2">
          <label class="field">Price<input id="lvPrice" type="number" inputmode="decimal" step="any" value="${row.price}"></label>
          <label class="field">&nbsp;<button class="btn" id="lvPick" type="button">Pick on chart</button></label>
        </div>
        <label class="field">Note (optional)<input id="lvNote" maxlength="60" placeholder="e.g. earnings gap, add 2nd tranche"></label>
        <div class="help" id="lvDist"></div>
        <div style="display:flex;gap:8px"><button class="btn" id="lvCancel" style="flex:1">Cancel</button>
          <button class="btn primary" id="lvSave" style="flex:2">Save level</button></div>
      </div>`;
    openSheet(html, (bg) => {
      const type = $("#lvType", bg), price = $("#lvPrice", bg);
      const upd = () => {
        $("#lvHelp", bg).textContent = LEVEL_TYPES[type.value].help;
        const p = parseFloat(price.value);
        $("#lvDist", bg).textContent = p ? `${sgn(pct(p, row.price))} from current price ${fmt(row.price)}` : "";
      };
      type.onchange = upd; price.oninput = upd;
      type.value = "support"; upd();
      $("#lvCancel", bg).onclick = closeSheet;
      $("#lvPick", bg).onclick = () => {
        bg.style.display = "none";
        $("#pickHint").hidden = false;
        S.picking = (p) => {
          price.value = (p >= 10 ? p.toFixed(2) : p.toFixed(4));
          type.value = p < row.price ? "support" : "resistance";
          bg.style.display = "";
          $("#pickHint").hidden = true;
          S.picking = null;
          upd();
        };
      };
      $("#lvSave", bg).onclick = async () => {
        const p = parseFloat(price.value);
        if (!(p > 0)) return toast("Enter a price.");
        const lvl = { price: +p.toFixed(p >= 10 ? 2 : 4), type: type.value };
        const note = $("#lvNote", bg).value.trim();
        if (note) lvl.note = note;
        $("#lvSave", bg).disabled = true;
        const ok = await saveConfig((c) => { const s = c.stocks.find((x) => x.symbol === sym); (s.levels = s.levels || []).push(lvl); }, `${sym}: add ${lvl.type} ${lvl.price}`);
        if (ok) { closeSheet(); render(true); } else $("#lvSave", bg).disabled = false;
      };
    });
  }

  function addStockSheet(kind) {
    openSheet(`<h4>Add a stock</h4><div class="form">
        <label class="field">Ticker<input id="asSym" autocapitalize="characters" placeholder="e.g. TSM, ASML, ETH-USD"></label>
        <label class="field">Name<input id="asName" placeholder="e.g. TSMC"></label>
        <label class="field">List<select id="asList"><option value="watchlist">Watchlist</option><option value="portfolio">Portfolio</option></select></label>
        <div class="help">US-listed stocks, ADRs and ETFs (as on Nasdaq.com), crypto like <code>BTC-USD</code> or <code>ETH-USD</code>. European listings (e.g. Vienna) are not available from the free data source – use the US ADR if there is one.</div>
        <div style="display:flex;gap:8px"><button class="btn" id="asCancel" style="flex:1">Cancel</button><button class="btn primary" id="asSave" style="flex:2">Add</button></div>
      </div>`, (bg) => {
      $("#asList", bg).value = kind;
      $("#asCancel", bg).onclick = closeSheet;
      $("#asSave", bg).onclick = async () => {
        const sym = $("#asSym", bg).value.trim().toUpperCase();
        if (!/^[A-Z0-9.\-^=]{1,15}$/.test(sym)) return toast("Enter a valid ticker.");
        const name = $("#asName", bg).value.trim() || sym;
        const list = $("#asList", bg).value;
        const ok = await saveConfig((c) => {
          if (c.stocks.some((s) => s.symbol === sym)) return;
          c.stocks.push({ symbol: sym, name, list, high_conviction: false, levels: [] });
        }, `Add ${sym}`);
        if (ok) { closeSheet(); location.hash = `#/${list}`; render(); }
      };
    });
  }

  // ------------------------------------------------------------------ briefs
  const DRIVER = { company: "Company news", sector: "Sector move", macro: "Macro", mixed: "Mixed", unclear: "No clear catalyst" };
  const T = {
    en: { what: "What happened", why: "Why it moved", ctx: "Market & chart context", learn: "Learn", watch: "What to watch", src: "Sources", pending: "Claude's brief on the catalyst usually arrives within about an hour. Meanwhile, today's headlines:", heads: "Headlines", mkt: "Market today", noNews: "No headlines found yet." },
    de: { what: "Was passiert ist", why: "Warum sich der Kurs bewegt", ctx: "Markt & Chart", learn: "Dazugelernt", watch: "Worauf achten", src: "Quellen", pending: "Claudes Erklärung kommt meist innerhalb einer Stunde. Bis dahin die heutigen Schlagzeilen:", heads: "Schlagzeilen", mkt: "Markt heute", noNews: "Noch keine Schlagzeilen gefunden." },
  };
  const tr = () => T[S.lang] || T.en;

  function todaysMovers() {
    const m = S.movers;
    if (!m || !m.movers?.length) return [];
    // only show movers of the latest session
    const lastBar = (S.summary.stocks || []).map((r) => r.last_bar).filter(Boolean).sort().pop();
    if (lastBar && m.date < lastBar && m.date !== lastBar) return [];
    return m.movers;
  }

  function moversStripHTML() {
    const ms = todaysMovers();
    if (!ms.length) return "";
    return `<div class="movers"><div class="mv-h">⚡ Big moves today (±${S.movers.threshold}%)</div><div class="mv-row">${ms.map((m) =>
      `<button class="mv" data-mover="${esc(m.symbol)}"><b>${esc(m.symbol)}</b> <span class="${cls(m.change_pct)}">${sgn(m.change_pct)}</span>
        <span class="mv-s">${m.brief ? "Read why →" : "Brief pending"}</span></button>`).join("")}</div></div>`;
  }

  function moverCardHTML(sym) {
    const m = todaysMovers().find((x) => x.symbol === sym);
    if (!m) {
      const past = S.briefs.filter((b) => b.symbol === sym).slice(0, 3);
      if (!past.length) return "";
      return `<div class="card"><h3>Past briefs</h3>${past.map((b) => `<div class="lv" data-open-brief="${esc(b.id)}" style="cursor:pointer;grid-template-columns:1fr auto">
        <span>${esc((b[S.lang]?.title ? b[S.lang] : b.en).title)}<span class="sub">${esc(b.date)}</span></span><span class="d num ${cls(b.change_pct)}">${sgn(b.change_pct)}</span></div>`).join("")}</div>`;
    }
    const idx = m.brief ? S.briefs.find((b) => b.id === m.brief) : null;
    const t = idx ? (idx[S.lang]?.title ? idx[S.lang] : idx.en) : null;
    return `<div class="card brief-card"><h3>⚡ Why it moved today<span class="sp"></span><span class="${cls(m.change_pct)}" style="font-size:13px">${sgn(m.change_pct)}</span></h3>
      ${t ? `<div class="note"><b style="color:var(--text);font-size:15px">${esc(t.title)}</b><br>${esc(t.tldr || "")}</div>
        <div class="actions"><button class="btn primary small" data-open-brief="${esc(m.brief)}">Read the brief</button></div>`
        : `<div class="note">${tr().pending}</div>${headlinesHTML(m.headlines, 4)}`}</div>`;
  }

  function headlinesHTML(list, n) {
    if (!list?.length) return `<div class="note">${tr().noNews}</div>`;
    return `<ul class="heads">${list.slice(0, n).map((h) => `<li><a href="${esc(safeUrl(h.url))}" target="_blank" rel="noopener noreferrer">${esc(h.title)}</a>
      <span>${esc(h.publisher || "")}${h.time ? ` · ${timeAgo(h.time)}` : ""}</span></li>`).join("")}</ul>`;
  }

  function marketHTML(mkt, sector) {
    const items = Object.entries(mkt || {}).map(([k, v]) => [v.name, v.change_pct]);
    if (sector?.change_pct !== undefined) items.push([`${sector.name} (${sector.etf})`, sector.change_pct]);
    if (!items.length) return "";
    return `<div class="mkt">${items.map(([n, c]) => `<span>${esc(n)} <b class="${cls(c)}">${sgn(c)}</b></span>`).join("")}</div>`;
  }

  function bindMovers() {
    view.querySelectorAll("[data-mover]").forEach((el) => (el.onclick = () => {
      const m = todaysMovers().find((x) => x.symbol === el.dataset.mover);
      if (m?.brief) location.hash = `#/brief/${encodeURIComponent(m.brief)}`;
      else moverSheet(m);
    }));
    view.querySelectorAll("[data-open-brief]").forEach((el) => (el.onclick = () => (location.hash = `#/brief/${encodeURIComponent(el.dataset.openBrief)}`)));
  }

  function moverSheet(m) {
    if (!m) return;
    openSheet(`<h4>${esc(m.symbol)} <span class="${cls(m.change_pct)}">${sgn(m.change_pct)}</span> <span class="muted" style="font-size:14px;font-weight:400">${esc(m.name)}</span></h4>
      <div class="note" style="padding:0 14px 8px">${tr().pending}</div>${headlinesHTML(m.headlines, 6)}
      <div class="note" style="padding:4px 14px 0"><b style="color:var(--text)">${tr().mkt}</b></div>${marketHTML(S.movers.market, m.sector)}
      <div class="actions"><button class="btn small" id="mvChart">Open chart</button><button class="btn small" id="mvClose">Close</button></div>`, (bg) => {
      $("#mvClose", bg).onclick = closeSheet;
      $("#mvChart", bg).onclick = () => { closeSheet(); location.hash = `#/s/${encodeURIComponent(m.symbol)}`; };
    });
  }

  function briefBodyHTML(b) {
    const t = b[S.lang]?.title ? b[S.lang] : b.en;
    const L = T[b[S.lang]?.title ? S.lang : "en"];
    const p = (x) => esc(x || "").replace(/\n+/g, "<br>");
    return `<div class="brief">
      <div class="b-meta"><span class="b-sym">${esc(b.symbol)}</span><span class="${cls(b.change_pct)} b-chg">${sgn(b.change_pct)}</span>
        ${b.driver ? `<span class="chip">${esc(DRIVER[b.driver] || b.driver)}</span>` : ""}<span class="sp"></span>
        <span class="seg b-lang"><button data-l="en" class="${S.lang === "en" ? "on" : ""}">EN</button><button data-l="de" class="${S.lang === "de" ? "on" : ""}">DE</button></span></div>
      <h2>${esc(t.title)}</h2>
      <p class="tldr">${p(t.tldr)}</p>
      ${t.what_happened ? `<h5>${L.what}</h5><p>${p(t.what_happened)}</p>` : ""}
      ${t.why_it_moved ? `<h5>${L.why}</h5><p>${p(t.why_it_moved)}</p>` : ""}
      ${t.context ? `<h5>${L.ctx}</h5><p>${p(t.context)}</p>` : ""}
      ${t.learn?.text ? `<div class="learn"><div class="lt">💡 ${L.learn}: ${esc(t.learn.term || "")}</div><p>${p(t.learn.text)}</p></div>` : ""}
      ${t.watch ? `<h5>${L.watch}</h5><p>${p(t.watch)}</p>` : ""}
      ${b.sources?.length ? `<h5>${L.src}</h5><ul class="heads">${b.sources.map((s) => `<li><a href="${esc(safeUrl(s.url))}" target="_blank" rel="noopener noreferrer">${esc(s.title)}</a><span>${esc(s.publisher || "")}</span></li>`).join("")}</ul>` : ""}
      <div class="b-foot">Written by Claude · ${b.written_at ? new Date(b.written_at).toLocaleString([], { dateStyle: "medium", timeStyle: "short" }) : esc(b.date)} · Not investment advice</div>
    </div>`;
  }

  function bindLang(container, rerender) {
    container.querySelectorAll(".b-lang button").forEach((x) => (x.onclick = (e) => {
      e.stopPropagation();
      S.lang = x.dataset.l; store.set("lang", S.lang); rerender();
    }));
  }

  async function renderBriefPage(id) {
    setTop("Why it moved", true);
    setTab("alerts");
    view.innerHTML = `<div class="empty"><b>Loading…</b></div>`;
    let b;
    try { b = await loadBrief(id); } catch { view.innerHTML = `<div class="empty"><b>Brief not found</b>It may still be publishing – try again in a minute.</div>`; return; }
    markBriefSeen(id);
    const draw = () => {
      view.innerHTML = briefBodyHTML(b) + `<div class="actions" style="border:0;padding:4px 16px 16px"><button class="btn small" id="bChart">Open ${esc(b.symbol)} chart</button></div>`;
      bindLang(view, draw);
      $("#bChart").onclick = () => (location.hash = `#/s/${encodeURIComponent(b.symbol)}`);
    };
    draw();
    window.scrollTo(0, 0);
  }

  function markBriefSeen(id) {
    const seen = new Set(store.get("seenBriefs", []));
    seen.add(id);
    store.set("seenBriefs", [...seen].slice(-300));
  }

  // ------------------------------------------------------------------ search
  // Look up any stock, ETF, index, bond yield or crypto without adding it to a list.
  // The symbol directory comes from data/symbols.json (rebuilt daily). Charts for symbols
  // that aren't on your lists are fetched on demand by the "Lookup" GitHub workflow and
  // read back from the `lookup` branch.
  const TYPE = { S: "Stock", E: "ETF", I: "Index", B: "Bond yield", C: "Crypto" };
  const QUICK = [
    ["^SPX", "S&P 500", "I"], ["^NDX", "Nasdaq 100", "I"], ["^DJI", "Dow Jones Industrial Average", "I"],
    ["^RUT", "Russell 2000", "I"], ["^VIX", "Cboe Volatility Index (VIX)", "I"],
    ["US10Y", "US Treasury 10-year yield", "B"], ["US2Y", "US Treasury 2-year yield", "B"],
    ["DE10Y", "German Bund 10-year yield", "B"], ["TLT", "iShares 20+ Year Treasury Bond ETF", "E"],
    ["BTC-USD", "Bitcoin", "C"],
  ];
  const LK_FRESH_MS = 15 * 60e3;
  const LK_TIMEOUT_MS = 180e3;
  const disp = (sym) => String(sym).replace(/^\^/, "");
  const safeName = (sym) => String(sym).replace(/[^A-Za-z0-9.-]/g, "_");
  const onLists = (sym) => (S.config?.stocks || []).some((s) => s.symbol === sym);

  let symbolsP = null;
  function loadSymbols() {
    if (!symbolsP) {
      symbolsP = getJSON(`data/symbols.json?d=${(S.summary?.generated || "").slice(0, 10)}`)
        .then((j) => j.items.map(([s, n, t]) => ({ s, n, t, sl: disp(s).toLowerCase(), nl: n.toLowerCase() })))
        .catch((e) => { symbolsP = null; throw e; });
    }
    return symbolsP;
  }

  function searchSymbols(list, query) {
    const q = query.trim().toLowerCase().replace(/^\^/, "");
    if (!q) return [];
    const hits = [];
    for (let i = 0; i < list.length; i++) {
      const x = list[i];
      let sc = -1;
      if (x.sl === q) sc = 0;
      else if (x.sl.startsWith(q)) sc = 1;
      else if (x.nl.startsWith(q)) sc = 2;
      else if (q.length >= 2 && (x.nl.includes(" " + q) || x.nl.includes("-" + q))) sc = 3;
      else if (q.length >= 2 && x.sl.includes(q)) sc = 4;
      else if (q.length >= 3 && x.nl.includes(q)) sc = 5;
      if (sc >= 0) hits.push([sc, i, x]);
    }
    hits.sort((a, b) => a[0] - b[0] || a[1] - b[1]);   // list is already biggest-first
    return hits.slice(0, 40).map((h) => h[2]);
  }

  function resultHTML(x) {
    const listed = onLists(x.s);
    return `<li class="sr" data-s="${esc(x.s)}" data-n="${esc(x.n)}" data-t="${esc(x.t)}">
      <div class="sr-main"><div class="sym">${esc(disp(x.s))}${TYPE[x.t] ? `<span class="chip t-${esc(x.t)}">${TYPE[x.t]}</span>` : ""}${listed ? '<span class="chip zone">On your lists</span>' : ""}</div>
      <div class="name">${esc(x.n)}</div></div>
      <svg viewBox="0 0 24 24" class="chev"><path d="M9 5l7 7-7 7"/></svg></li>`;
  }

  function openSymbol(s, n, t) {
    S.lookupMeta[s] = { n, t };
    const rec = store.get("recentLookups", []).filter((r) => r.s !== s);
    store.set("recentLookups", [{ s, n, t }, ...rec].slice(0, 8));
    location.hash = onLists(s) ? `#/s/${encodeURIComponent(s)}` : `#/q/${encodeURIComponent(s)}`;
  }

  function renderSearch() {
    setTop("Search", false);
    setTab("search");
    view.innerHTML = `<div class="search-bar">
        <svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/></svg>
        <input id="sq" type="search" enterkeyhint="search" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false"
          placeholder="Stock, ETF, index, bond yield, crypto" value="${esc(S.searchQ)}">
      </div><div id="sres"></div>`;
    const input = $("#sq"), out = $("#sres");
    let results = [], seq = 0;

    const draw = async () => {
      const q = input.value;
      const my = ++seq;
      if (!q.trim()) {
        const rec = store.get("recentLookups", []);
        out.innerHTML = (rec.length ? `<div class="list-head"><h2>Recent</h2><button class="btn small" id="clrRec">Clear</button></div><ul class="rows">${rec.map(resultHTML).join("")}</ul>` : "")
          + `<div class="list-head"><h2>Markets</h2></div><ul class="rows">${QUICK.map(([s, n, t]) => resultHTML({ s, n, t })).join("")}</ul>
          <div class="note s-note">Opens a chart with the same EMA, SMA and gap views as your lists, without adding anything. US stocks, ETFs and ADRs, US &amp; Nasdaq indices, US Treasury and German Bund yields, and major crypto. Non-US stocks and indices like the DAX aren't available from the free data sources.</div>`;
        const c = $("#clrRec");
        if (c) c.onclick = () => { store.set("recentLookups", []); draw(); };
        return;
      }
      let list;
      try {
        if (!symbolsP) out.innerHTML = `<div class="empty">Loading symbol list…</div>`;
        list = await loadSymbols();
      } catch {
        list = null;
      }
      if (my !== seq) return;
      results = list ? searchSymbols(list, q) : [];
      const raw = q.trim().toUpperCase();
      const tickerish = /^[A-Z0-9.^\-]{1,15}$/.test(raw);
      let html = results.length ? `<ul class="rows">${results.map(resultHTML).join("")}</ul>` : "";
      if (!results.length && tickerish) {
        html += `<ul class="rows">${resultHTML({ s: raw, n: list ? "Not in the symbol list – try anyway" : "Symbol list unavailable – look up this ticker", t: "" })}</ul>`;
      }
      if (!html) html = `<div class="empty"><b>No matches</b>Try the ticker symbol or another part of the name.</div>`;
      out.innerHTML = html;
    };

    input.oninput = () => { S.searchQ = input.value; draw(); };
    input.onkeydown = (e) => {
      if (e.key !== "Enter") return;
      const first = out.querySelector(".sr");
      if (first) openSymbol(first.dataset.s, first.dataset.n, first.dataset.t);
    };
    out.onclick = (e) => {
      const li = e.target.closest(".sr");
      if (li) openSymbol(li.dataset.s, li.dataset.n, li.dataset.t);
    };
    draw();
    if (!S.searchQ) input.focus();
  }

  // ------------------------------------------------------------------ lookup (chart without a list)
  async function readLookup(sym) {
    const file = encodeURIComponent(`${safeName(sym)}.json`);
    let r;
    if (S.token && S.repo) {
      r = await fetch(`https://api.github.com/repos/${S.repo}/contents/${file}?ref=lookup`, {
        cache: "no-store",
        headers: { Accept: "application/vnd.github.raw", Authorization: `Bearer ${S.token}`, "X-GitHub-Api-Version": "2022-11-28" },
      });
    } else if (S.repo) {
      r = await fetch(`https://raw.githubusercontent.com/${S.repo}/lookup/${file}?t=${Date.now()}`, { cache: "no-store" });
    } else return null;
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(`GitHub ${r.status}`);
    return r.json();
  }

  function refreshLookup(sym, name, prevGen) {
    if (S.lkPending[sym]) return S.lkPending[sym].p;
    const t0 = Date.now();
    const job = { t0 };
    job.p = (async () => {
      await gh("/actions/workflows/lookup.yml/dispatches", {
        method: "POST",
        body: JSON.stringify({ ref: S.branch, inputs: { symbol: sym, name: name || "" } }),
      });
      await new Promise((ok) => setTimeout(ok, 12000));       // a runner needs ~15 s to start
      while (Date.now() - t0 < LK_TIMEOUT_MS) {
        const d = await readLookup(sym).catch(() => null);
        if (d && d.generated && d.generated !== prevGen && Date.parse(d.generated) > t0 - 120e3) return d;
        await new Promise((ok) => setTimeout(ok, 4000));
      }
      throw new Error("TIMEOUT");
    })().finally(() => { delete S.lkPending[sym]; });
    S.lkPending[sym] = job;
    return job.p;
  }

  async function renderLookup(sym, keepRange, allowFetch) {
    if (onLists(sym)) { location.replace(`#/s/${encodeURIComponent(sym)}`); return; }
    const meta = S.lookupMeta[sym] || store.get("recentLookups", []).find((r) => r.s === sym) || {};
    setTop(disp(sym), true);
    setTab("search");
    const here = () => parseRoute().name === "lookup" && parseRoute().sym === sym;

    let data = S.lookups[sym];
    if (!data) {
      view.innerHTML = lookupShell(sym, meta, null, "Loading…");
      data = await readLookup(sym).catch(() => null);
      if (!here()) return;
      if (data) S.lookups[sym] = data;
    }
    const age = data?.generated ? Date.now() - Date.parse(data.generated) : Infinity;
    const stale = !data || age > LK_FRESH_MS;
    const pending = S.lkPending[sym];

    let status;
    if (pending) status = "updating";
    else if (stale && !(S.token && S.repo)) status = "nokey";
    else if (stale && allowFetch) status = "updating";   // only when you open it, never on auto-refresh
    else if (stale && data) status = "old";
    else if (stale) status = "updating";
    else status = "fresh";
    drawLookup(sym, meta, data, status, keepRange);

    if (status === "updating") {
      const p = pending ? pending.p : refreshLookup(sym, meta.n || data?.summary?.name, data?.generated);
      p.then((d) => {
        S.lookups[sym] = d;
        if (here()) render(true);
      }).catch((e) => {
        if (!here()) return;
        const el = $("#lkStatus");
        const msg = e.message === "NO_TOKEN" ? "Add your GitHub key in Settings to look up new symbols."
          : e.status === 401 || e.status === 403 ? "GitHub key rejected – it needs “Actions: read & write”."
          : e.status === 404 ? "Lookup workflow not found – the app update may still be deploying."
          : e.message === "TIMEOUT" ? "Still no data after 3 min – GitHub may be busy. Try again later."
          : `Could not update (${e.message}).`;
        if (el) { el.className = "lk-status warn"; el.innerHTML = `${esc(msg)} <button class="btn small" id="lkRetry">Retry</button>`; $("#lkRetry").onclick = () => render(false); }
      });
    }
  }

  function lookupShell(sym, meta, row, statusHTML) {
    return `<div class="d-head"><div><div class="muted" style="font-size:13px">${esc(meta.n || row?.name || "")}</div>
      <div class="big num">${row ? priceText(row) : esc(disp(sym))}</div></div></div>
      <div class="lk-status" id="lkStatus">${statusHTML}</div>`;
  }

  const priceText = (row) => (row.close_only ? `${fmt(row.price)}%` : fmt(row.price));
  function changeHTML(row) {
    if (row.close_only && row.prev_close !== null && row.prev_close !== undefined) {
      const bp = Math.round((row.price - row.prev_close) * 100);
      return `<div class="chg num ${cls(bp)}">${bp > 0 ? "+" : bp < 0 ? "−" : "±"}${Math.abs(bp)} bp</div>`;
    }
    return `<div class="chg num ${cls(row.change_pct)}">${sgn(row.change_pct, 2)}</div>`;
  }

  function drawLookup(sym, meta, data, status, keepRange) {
    const updatingTxt = `<span class="dotspin"></span>Fetching the latest data – usually 30–60 s`;
    if (!data || data.error) {
      const err = data?.error && status !== "updating"
        ? `<div class="empty"><b>No data for ${esc(disp(sym))}</b>${esc(data.error)}</div>` : "";
      const st = status === "updating" ? updatingTxt
        : status === "nokey" ? `Add your GitHub key in <a href="#/settings" style="color:var(--accent)">Settings</a> to look up symbols that aren't on your lists.` : "";
      view.innerHTML = lookupShell(sym, meta, null, st) + err;
      return;
    }
    const row = { ...data.summary, list: "lookup", high_conviction: false };
    const d = data.detail;
    const vname = store.get("view", "ema");
    const st = status === "updating" ? updatingTxt
      : status === "nokey" ? `Data from ${timeAgo(data.generated)}. Add your GitHub key in Settings to refresh.`
      : status === "old" ? `Data from ${timeAgo(data.generated)} · <button class="btn small" id="lkRetry">Update</button>`
      : `Updated ${timeAgo(data.generated)} · ${esc(row.source || "")}`;
    view.innerHTML = `
      <div class="d-head">
        <div><div class="muted" style="font-size:13px">${esc(row.name)}${meta.t ? ` · ${TYPE[meta.t] || ""}` : ""}</div>
          <div class="big num">${priceText(row)}</div></div>
        ${changeHTML(row)}
        <div class="spacer"></div>
        <button class="pill" id="addWl">+ Watchlist</button>
      </div>
      <div class="lk-status" id="lkStatus">${st}</div>
      <div class="views"><div class="seg" id="viewSeg">
        ${Object.entries(VIEWS).map(([k, v]) => `<button data-v="${k}" class="${k === vname ? "on" : ""}">${v.name}</button>`).join("")}
      </div>${tfSegHTML()}</div>
      <div class="chart-wrap"><div id="chart"></div><div class="legend num" id="legend"></div></div>
      <div class="ranges" id="ranges">
        ${rangesHTML()}
        <span class="sp"></span>
        <label class="toggle"><input type="checkbox" id="zonesChk" ${S.zones ? "checked" : ""}> Zones ±${S.summary?.settings?.band_pct ?? 1.5}%</label>
      </div>
      <div class="detail-grid">
        <div id="levelsCard"></div>
        <div><div class="card"><h3>Quick look</h3><div class="note">Not on your lists, so no alerts. Tap <b style="color:var(--text)">+ Watchlist</b> to track it with alerts like your other stocks.
          ${row.close_only ? "<br><br>Yields are in percent; the chart shows one value per trading day." : ""}
          <br><br>Data: ${esc(row.source || "–")} · last bar ${esc(row.last_bar || "–")}</div></div></div>
      </div>`;
    if ($("#lkRetry")) $("#lkRetry").onclick = () => render(false);
    $("#addWl").onclick = async () => {
      const b = $("#addWl");
      b.disabled = true;
      const ok = await saveConfig((c) => {
        if (!c.stocks.some((s) => s.symbol === sym)) c.stocks.push({ symbol: sym, name: row.name, list: "watchlist", high_conviction: false, levels: [] });
      }, `Add ${sym}`);
      if (ok) { b.textContent = "✓ On watchlist"; b.classList.add("on"); toast("Added – alerts start with the next check."); } else b.disabled = false;
    };
    if (!S.summary) {   // levelsCardHTML needs settings
      S.summary = { settings: S.config?.settings || {}, stocks: [], generated: null, market: "" };
    }
    buildChart(tfData(d), row, [], vname, keepRange);
    bindChartControls(d);
  }

  // ------------------------------------------------------------------ Fed
  // Current fed funds rate (live from FRED / NY Fed via the price check), a countdown to the
  // next FOMC decision, and Claude's summary of where the Fed stands (fed.json, updated after
  // every decision by the brief task).
  let fedTimer = null;
  const FT = {
    en: { rate: "Fed funds target", eff: "Effective rate", last: "Last move", next: "Next rate decision", d: "days", h: "hours", m: "min", s: "sec",
      yourTime: "your time", stmt: "Statement", pc: "press conference", dots: "with new projections (dot plot)", nodots: "no new projections at this meeting",
      exp: "Markets expect", hold: "no change", focus: "Focus & direction", bs: "Balance sheet", proj: "Fed projections", hist: "Target rate since 2022",
      meet: "Upcoming meetings", src: "Sources", learn: "Learn", outdated: "The rate changed since this summary was written – Claude updates it within the next hour.",
      written: "Summary by Claude, as of", live: "Rate data", chair: "Chair", vote: "vote", decisionDay: "Decision today", soon: "Decision is out – the summary is updated within about an hour.",
      hike: "hike", cut: "cut", unchanged: "unchanged", endYr: "end of", pce: "PCE inflation", target2: "2 % inflation expected in",
      st: { tightening: "Tightening ↑", hold: "On hold", easing: "Easing ↓" },
      bsm: { qt: "Balance sheet: shrinking (QT)", qe: "Balance sheet: buying bonds (QE)", stable: "Balance sheet: stable – ample reserves" } },
    de: { rate: "Leitzins (Zielband)", eff: "Effektiver Zins", last: "Letzte Änderung", next: "Nächster Zinsentscheid", d: "Tage", h: "Std.", m: "Min.", s: "Sek.",
      yourTime: "deine Zeit", stmt: "Statement", pc: "Pressekonferenz", dots: "mit neuen Projektionen (Dot Plot)", nodots: "keine neuen Projektionen bei dieser Sitzung",
      exp: "Märkte erwarten", hold: "keine Änderung", focus: "Fokus & Richtung", bs: "Bilanz", proj: "Projektionen der Fed", hist: "Leitzins seit 2022",
      meet: "Nächste Sitzungen", src: "Quellen", learn: "Dazugelernt", outdated: "Der Zins hat sich seit dieser Zusammenfassung geändert – Claude aktualisiert sie innerhalb der nächsten Stunde.",
      written: "Zusammenfassung von Claude, Stand", live: "Zinsdaten", chair: "Vorsitz", vote: "Abstimmung", decisionDay: "Heute Zinsentscheid", soon: "Der Entscheid ist da – die Zusammenfassung wird in etwa einer Stunde aktualisiert.",
      hike: "Erhöhung", cut: "Senkung", unchanged: "unverändert", endYr: "Ende", pce: "PCE-Inflation", target2: "2 % Inflation erwartet",
      st: { tightening: "Straffung ↑", hold: "Pause", easing: "Lockerung ↓" },
      bsm: { qt: "Bilanz: schrumpft (QT)", qe: "Bilanz: Anleihekäufe (QE)", stable: "Bilanz: stabil – ausreichende Reserven" } },
  };

  const pctTxt = (x, d = 2) => (x === null || x === undefined ? "–" : `${(+x).toFixed(d)}`);
  const dayTxt = (iso, opts) => new Date(iso.length === 10 ? iso + "T12:00:00Z" : iso).toLocaleDateString(S.lang === "de" ? "de-AT" : "en-GB", opts || { day: "numeric", month: "short", year: "numeric" });

  function fedHistorySVG(hist) {
    if (!hist || hist.length < 2) return "";
    const W = 320, H = 120, L = 30, R = 6, T = 8, B = 18;
    const t0 = Date.parse(hist[0][0]), t1 = Math.max(Date.parse(hist[hist.length - 1][0]), Date.now());
    const ups = hist.map((h) => h[2]), los = hist.map((h) => h[1]);
    const lo = Math.floor(Math.min(...los)), hi = Math.ceil(Math.max(...ups));
    const x = (iso) => L + ((Date.parse(iso) - t0) / (t1 - t0 || 1)) * (W - L - R);
    const y = (v) => T + (1 - (v - lo) / (hi - lo || 1)) * (H - T - B);
    let up = "", dn = "";
    hist.forEach((h, i) => {
      const X = x(h[0]).toFixed(1);
      if (i === 0) { up = `M${X},${y(h[2]).toFixed(1)}`; dn = `M${X},${y(h[1]).toFixed(1)}`; return; }
      up += `H${X}V${y(h[2]).toFixed(1)}`; dn += `H${X}V${y(h[1]).toFixed(1)}`;
    });
    const xEnd = (W - R).toFixed(1);
    up += `H${xEnd}`; dn += `H${xEnd}`;
    const grid = [];
    for (let v = lo; v <= hi; v += (hi - lo > 4 ? 2 : 1)) grid.push(`<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" stroke="var(--line)" stroke-width="1"/><text x="${L - 4}" y="${y(v) + 3}" text-anchor="end">${v}%</text>`);
    const years = [];
    for (let yr = new Date(t0).getUTCFullYear() + 1; yr <= new Date(t1).getUTCFullYear(); yr++) {
      const X = x(`${yr}-01-01`);
      years.push(`<text x="${X}" y="${H - 4}" text-anchor="middle">${yr}</text>`);
    }
    return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Fed funds target range history">
      ${grid.join("")}${years.join("")}
      <path d="${up}" fill="none" stroke="${COLORS.ema8}" stroke-width="2" vector-effect="non-scaling-stroke"/>
      <path d="${dn}" fill="none" stroke="${COLORS.ema8}" stroke-width="1" stroke-opacity=".5" vector-effect="non-scaling-stroke"/>
    </svg>`;
  }

  function nextMeeting(f) {
    const now = Date.now();
    return (f.meetings || []).find((m) => Date.parse(m.decision_utc) > now) || null;
  }

  async function renderFed() {
    setTop("Fed", false);
    setTab("fed");
    let f;
    try { f = await getJSON(`data/fed.json?t=${Date.now()}`); } catch {
      view.innerHTML = `<div class="empty"><b>No Fed data yet</b>It appears after the next price check.</div>`;
      return;
    }
    if (parseRoute().name !== "fed") return;
    const L = FT[S.lang] || FT.en;
    const t = f[S.lang]?.summary ? f[S.lang] : f.en;
    const r = f.rate || {};
    const ld = f.last_decision || {};
    const nx = nextMeeting(f);
    const ldTxt = ld.change_bp ? `${ld.change_bp > 0 ? "+" : "−"}${Math.abs(ld.change_bp) / 100} (${ld.change_bp > 0 ? L.hike : L.cut})` : L.unchanged;
    const local = (iso, o) => new Date(iso).toLocaleString(S.lang === "de" ? "de-AT" : "en-GB", o);
    const pr = f.projections || {};
    const exp = f.expectations || {};
    const decisionPassed = f.next && nx && f.next.end !== nx.end;   // a decision happened since the data was built

    const upcoming = (f.meetings || []).filter((m) => Date.parse(m.decision_utc) > Date.now()).slice(0, 6);

    view.innerHTML = `
      <div class="fed-top"><span class="sp"></span>
        <span class="seg b-lang"><button data-l="en" class="${S.lang === "en" ? "on" : ""}">EN</button><button data-l="de" class="${S.lang === "de" ? "on" : ""}">DE</button></span></div>
      <div class="fed-hero">
        <div><div class="lbl">${L.rate}</div>
          <div class="rate num">${pctTxt(r.lower)}–${pctTxt(r.upper)} %</div>
          <div class="sub">${[r.effective !== undefined ? `${L.eff} ${pctTxt(r.effective)} %` : "", ld.date ? `${L.last}: ${ldTxt} · ${dayTxt(ld.date)}` : ""].filter(Boolean).join(" · ")}</div></div>
      </div>
      <div class="fed-chips">
        <span class="chip st-${esc(f.stance || "hold")}">${esc(L.st[f.stance] || f.stance || "")}</span>
        <span class="chip">${esc(L.bsm[f.balance_sheet_mode] || "")}</span>
        ${f.chair ? `<span class="chip">${L.chair}: ${esc(f.chair)}</span>` : ""}
      </div>
      ${f.summary_outdated || decisionPassed ? `<div class="banner warn" style="margin:10px 16px 0">${f.summary_outdated ? L.outdated : L.soon}</div>` : ""}

      ${nx ? `<div class="card fed-card"><h3>${L.next}<span class="sp"></span>${nx.sep ? '<span class="chip t-I">Dot plot</span>' : ""}</h3>
        <div class="cd num" id="fedCd"></div>
        <div class="note" style="padding-top:6px">
          <b style="color:var(--text)">${local(nx.decision_utc, { weekday: "long", day: "numeric", month: "long" })}</b> ·
          ${L.stmt} ${local(nx.decision_utc, { hour: "2-digit", minute: "2-digit" })}, ${L.pc} ${local(new Date(Date.parse(nx.decision_utc) + 30 * 60e3).toISOString(), { hour: "2-digit", minute: "2-digit" })} (${L.yourTime})<br>
          ${nx.sep ? L.dots : L.nodots}${exp.hold_pct && f.next && nx.end === f.next.end ? ` · ${L.exp}: ${L.hold} (≈ ${exp.hold_pct} %)` : ""}
        </div></div>` : ""}

      <div class="card fed-card"><h3>${L.focus}</h3>
        <p class="fed-p"><b>${esc(t.headline || "")}</b><br>${esc(t.summary || "")}</p>
        ${(t.focus || []).map((x) => `<div class="fed-f"><div class="ft">${esc(x.title)}</div><p>${esc(x.text)}</p></div>`).join("")}
      </div>

      <div class="card fed-card"><h3>${L.bs}</h3><p class="fed-p">${esc(t.balance_sheet || "")}</p>
        ${t.learn?.text ? `<div class="learn"><div class="lt">💡 ${L.learn}: ${esc(t.learn.term || "")}</div><p style="margin:0;font-size:14px;line-height:1.5;color:#cdd3de">${esc(t.learn.text)}</p></div>` : ""}
      </div>

      ${pr.rate_2026 !== undefined ? `<div class="card fed-card"><h3>${L.proj}<span class="sp"></span><span style="text-transform:none;letter-spacing:0;font-weight:400">${dayTxt(pr.from)}</span></h3>
        <div class="mt-row" style="border-top:0"><span>${L.rate} · ${L.endYr} 2026</span><b class="num">${pctTxt(pr.rate_2026, 1)} %</b></div>
        <div class="mt-row"><span>${L.rate} · ${L.endYr} 2027</span><b class="num">${pctTxt(pr.rate_2027, 1)} %</b></div>
        <div class="mt-row"><span>${L.pce} 2026 / 2027</span><b class="num">${pctTxt(pr.pce_2026, 1)} % / ${pctTxt(pr.pce_2027, 1)} %</b></div>
        ${pr.target_year ? `<div class="mt-row"><span>${L.target2}</span><b class="num">${esc(pr.target_year)}</b></div>` : ""}
      </div>` : ""}

      ${f.history?.length > 1 ? `<div class="card fed-card"><h3>${L.hist}</h3><div class="fed-chart">${fedHistorySVG(f.history)}</div></div>` : ""}

      ${upcoming.length ? `<div class="card fed-card"><h3>${L.meet}</h3>${upcoming.map((m, i) => `<div class="mt-row ${i === 0 ? "next" : ""}"${i === 0 ? ' style="border-top:0"' : ""}>
          <span>${m.start.slice(0, 7) === m.end.slice(0, 7) ? `${+m.start.slice(8)}–${dayTxt(m.end)}` : `${dayTxt(m.start, { day: "numeric", month: "short" })} – ${dayTxt(m.end)}`}<span class="sub"> · ${local(m.decision_utc, { hour: "2-digit", minute: "2-digit" })}</span></span>
          <span>${m.sep ? '<span class="chip t-I">Dot plot</span>' : ""}</span></div>`).join("")}</div>` : ""}

      ${f.sources?.length ? `<div class="card fed-card"><h3>${L.src}</h3><ul class="heads">${f.sources.map((x) => `<li><a href="${esc(safeUrl(x.url))}" target="_blank" rel="noopener noreferrer">${esc(x.title)}</a><span>${esc(x.publisher || "")}</span></li>`).join("")}</ul></div>` : ""}

      <div class="b-foot" style="padding:12px 16px 20px">${L.written} ${f.as_of ? dayTxt(f.as_of) : "–"} · ${L.live}: ${esc(r.source || "–")}${r.as_of ? ` (${dayTxt(r.as_of)})` : ""} · Not investment advice</div>`;

    view.querySelectorAll(".b-lang button").forEach((b) => (b.onclick = () => { S.lang = b.dataset.l; store.set("lang", S.lang); renderFed(); }));
    const cd = $("#fedCd");
    if (cd && nx) {
      const tick = () => {
        const ms = Date.parse(nx.decision_utc) - Date.now();
        if (ms <= 0) { clearInterval(fedTimer); cd.innerHTML = `<div style="flex:1"><b>${L.decisionDay}</b></div>`; return; }
        const d = Math.floor(ms / 864e5), h = Math.floor(ms / 36e5) % 24, m = Math.floor(ms / 6e4) % 60, s = Math.floor(ms / 1e3) % 60;
        cd.innerHTML = [[d, L.d], [h, L.h], [m, L.m], [s, L.s]].map(([v, l]) => `<div><b>${v}</b><span>${l}</span></div>`).join("");
      };
      tick();
      clearInterval(fedTimer);
      fedTimer = setInterval(() => { if (parseRoute().name !== "fed") return clearInterval(fedTimer); tick(); }, 1000);
    }
  }

  // ------------------------------------------------------------------ alerts
  const KIND_ICON = { ema8: ["8", COLORS.ema8], ema21: ["21", COLORS.ema21], sma50: ["50", COLORS.sma50], sma100: ["100", COLORS.sma100], sma150: ["150", COLORS.sma150], sma200: ["200", COLORS.sma200], extended: ["↑", COLORS.sma150], gap: ["▭", COLORS.up], gapfilled: ["✓", COLORS.up], manual: ["◆", COLORS.zone], mover: ["⚡", COLORS.ema21], brief: ["📰", COLORS.text] };

  function renderAlerts() {
    setTop("Alerts", false);
    setTab("alerts");
    const mode = store.get("alertsMode", "alerts");
    const head = `<div class="list-head"><h2>${mode === "briefs" ? `Briefs · ${S.briefs.length}` : `Recent alerts · ${(S.alerts || []).length}`}</h2>
      <div class="seg" id="alSeg"><button data-m="alerts" class="${mode === "alerts" ? "on" : ""}">Alerts</button><button data-m="briefs" class="${mode === "briefs" ? "on" : ""}">Why it moved</button></div></div>`;
    const bindSeg = () => ($("#alSeg").onclick = (e) => { const m = e.target.closest("button")?.dataset.m; if (m) { store.set("alertsMode", m); renderAlerts(); } });
    if (mode === "briefs") {
      view.innerHTML = head + (S.briefs.length ? S.briefs.map((b) => {
        const t = b[S.lang]?.title ? b[S.lang] : b.en;
        return `<div class="al" data-brief="${esc(b.id)}"><div class="ic">${esc(b.symbol.slice(0, 4))}</div>
          <div class="t">${esc(t.title)}<span class="tm">${esc(b.date)}</span></div>
          <div class="m"><span class="${cls(b.change_pct)}">${sgn(b.change_pct)}</span> · ${esc(t.tldr || "")}</div></div>`;
      }).join("") : `<div class="empty"><b>No briefs yet</b>When a stock moves ±${S.summary.settings?.move_pct ?? 3}% or more, Claude writes a short explainer of the catalyst and it appears here.</div>`);
      view.querySelectorAll("[data-brief]").forEach((el) => (el.onclick = () => (location.hash = `#/brief/${encodeURIComponent(el.dataset.brief)}`)));
      bindSeg();
      return;
    }
    const seen = store.get("seenAlerts", "");
    const items = S.alerts || [];
    view.innerHTML = head + (items.length
      ? items.map((a) => {
        const [ic, col] = KIND_ICON[a.kind] || ["•", COLORS.text];
        return `<div class="al ${a.time > seen ? "new" : ""}" data-sym="${esc(a.symbol)}"${a.brief ? ` data-brief="${esc(a.brief)}"` : ""}>
          <div class="ic" style="color:${col}">${ic}</div>
          <div class="t">${esc(a.title)}<span class="tm">${timeAgo(a.time)}</span></div>
          <div class="m">${esc(a.message)}</div></div>`;
      }).join("")
      : `<div class="empty"><b>No alerts yet</b>When a stock reaches one of its levels you'll get a push on your phone and it shows up here.</div>`);
    view.querySelectorAll(".al").forEach((el) => (el.onclick = () => (location.hash = el.dataset.brief ? `#/brief/${encodeURIComponent(el.dataset.brief)}` : `#/s/${encodeURIComponent(el.dataset.sym)}`)));
    bindSeg();
    if (items[0]) store.set("seenAlerts", items[0].time);
    updateAlertDot();
  }

  // ------------------------------------------------------------------ settings
  function renderSettings() {
    setTop("Settings", false);
    setTab("settings");
    const set = (S.config || S.summary || {}).settings || {};
    const smaAll = new Set(set.sma_alerts_all || []), smaHC = new Set(set.sma_alerts_high_conviction || [200]);
    const s = S.summary || { generated: null, market: "no data yet", stocks: [] };
    const box = (name, n, on) => `<label><input type="checkbox" data-${name}="${n}" ${on ? "checked" : ""}> ${n}</label>`;
    view.innerHTML = `
      <div class="card"><h3>Status</h3><div class="note">
        Last check: <b style="color:var(--text)">${s.generated ? new Date(s.generated).toLocaleString() : "–"}</b> (${timeAgo(s.generated)})<br>
        NYSE: ${esc(s.market)} · ${(s.stocks || []).length} symbols · data: ${esc(s.stocks?.find((x) => x.source)?.source || "–")}<br>
        Checks run about every 5 min while the NYSE is open (Mon–Fri, 15:30–22:00 Vienna time; 14:30–21:00 for the few weeks a year when US and EU clocks change on different dates).
        ${s.errors?.length ? `<br><span style="color:var(--sma150)">No data: ${s.errors.map((e) => esc(e.symbol)).join(", ")}</span>` : ""}
      </div></div>

      <div class="card"><h3>Brief language in the app</h3><div class="form">
        <div class="seg" id="langSeg" style="align-self:start"><button data-l="en" class="${S.lang === "en" ? "on" : ""}">English</button><button data-l="de" class="${S.lang === "de" ? "on" : ""}">Deutsch</button></div>
      </div></div>

      <div class="card"><h3>Alert rules</h3><div class="form">
        <div class="row2">
          <label class="field">Zone around lines (±%)<input id="stBand" type="number" step="0.1" min="0.1" value="${set.band_pct ?? 1.5}"></label>
          <label class="field">“Extended” above 8 EMA (%)<input id="stExt" type="number" step="1" min="0" value="${set.extended_pct ?? 15}"></label>
        </div>
        <label class="field">Minimum gap size (%)<input id="stGap" type="number" step="0.1" min="0" value="${set.min_gap_pct ?? 0.5}"></label>
        <div class="field">SMA alerts for every stock<div class="checks">${[50, 100, 150, 200].map((n) => box("all", n, smaAll.has(n))).join("")}</div></div>
        <div class="field">SMA alerts for ★ high-conviction stocks<div class="checks">${[50, 100, 150, 200].map((n) => box("hc", n, smaHC.has(n))).join("")}</div></div>
        <div class="row2">
          <label class="field">“Why it moved” brief at ±%<input id="stMove" type="number" step="0.5" min="1" value="${set.move_pct ?? 3}"></label>
          <label class="field">Push language<select id="stLangPush"><option value="en">English</option><option value="de">Deutsch</option></select></label>
        </div>
        <div class="checks">
          <label><input type="checkbox" id="stMover" ${set.mover_push !== false ? "checked" : ""}> Instant push on a big move</label>
          <label><input type="checkbox" id="stEma" ${set.ema_alerts !== false ? "checked" : ""}> 8 / 21 EMA entry alerts (in app)</label>
          <label><input type="checkbox" id="stEmaPush" ${set.ema_push ? "checked" : ""}> Push 8 / 21 EMA alerts to phone</label>
          <label><input type="checkbox" id="stGaps" ${set.gap_alerts !== false ? "checked" : ""}> Gap alerts</label>
        </div>
        <button class="btn primary" id="stSave">Save rules</button>
      </div></div>

      <div class="card"><h3>Connection</h3><div class="form">
        <label class="field">GitHub repository<input id="cRepo" value="${esc(S.repo)}" placeholder="username/stock-alerts"></label>
        <label class="field">GitHub key (only stored on this device)<input id="cToken" type="password" value="${esc(S.token)}" placeholder="github_pat_…" autocomplete="off"></label>
        <div class="help">Needed to save lists, levels and rules from the app. Create it once per device:
          <ol><li>GitHub → Settings → Developer settings → Fine-grained tokens → Generate new token</li>
          <li>Repository access: <i>Only select repositories</i> → <code>stock-alerts</code></li>
          <li>Permissions: <i>Contents</i> = Read and write, <i>Actions</i> = Read and write</li>
          <li>Expiration: up to 1 year · copy the token and paste it here</li></ol></div>
        <button class="btn primary" id="cSave">Save connection</button>
        <div style="display:flex;gap:8px;flex-wrap:wrap">
          <button class="btn small" id="cTest">Send test notification</button>
          <button class="btn small" id="cRun">Run a check now</button>
        </div>
      </div></div>

      <div class="card"><h3>Notifications</h3><div class="form">
        <div class="note">Phone: alerts are pushed through the free <b style="color:var(--text)">ntfy</b> app – subscribe to your private topic there (the same text you saved as <code>NTFY_TOPIC</code> on GitHub; never post it anywhere public).</div>
        <div class="checks"><label><input type="checkbox" id="stDesk" ${store.get("deskNotify", false) ? "checked" : ""} ${canNotify() ? "" : "disabled"}> Show alerts as notifications on this device</label></div>
        <div class="help">For the Mac: works while the Pullback app is open (it can sit minimised in the Dock). Tip: right-click the Dock icon → Options → <i>Open at Login</i>. Leave this off on the phone, where ntfy already notifies you.</div>
      </div></div>

      <div class="card"><h3>Method</h3><div class="note">
        Based on Babyfolio's <a style="color:var(--accent)" href="https://edelbridge.substack.com/p/technical-analysis-keeping-it-simple" target="_blank" rel="noopener">“Technical Analysis: Keeping It Simple”</a>:
        8 EMA = first, smaller entry · 21 EMA = second, heavier entry · 200 SMA = big entry on high-conviction names · gaps tend to fill · extended far above the 8 EMA = possible trim. Fundamentals first – the chart only helps choose the price. Not investment advice.<br><br>
        Charts by TradingView Lightweight Charts™.</div></div>`;

    $("#stSave").onclick = () => {
      const all = [...view.querySelectorAll("[data-all]")].filter((x) => x.checked).map((x) => +x.dataset.all);
      const hc = [...view.querySelectorAll("[data-hc]")].filter((x) => x.checked).map((x) => +x.dataset.hc);
      saveConfig((c) => {
        Object.assign(c.settings, {
          band_pct: +$("#stBand").value || 1.5, extended_pct: +$("#stExt").value || 0, min_gap_pct: +$("#stGap").value || 0,
          sma_alerts_all: all, sma_alerts_high_conviction: hc,
          ema_alerts: $("#stEma").checked, ema_push: $("#stEmaPush").checked, gap_alerts: $("#stGaps").checked,
          move_pct: +$("#stMove").value || 3, mover_push: $("#stMover").checked, brief_lang: $("#stLangPush").value,
        });
      }, "Update alert rules");
    };
    $("#cSave").onclick = async () => {
      S.repo = $("#cRepo").value.trim().replace(/^https?:\/\/github\.com\//, "").replace(/\/$/, "");
      S.token = $("#cToken").value.trim();
      store.set("repo", S.repo); store.set("token", S.token);
      try {
        const info = await gh("");
        S.branch = info.default_branch || "main";
        store.set("branch", S.branch);
        await loadConfig(true);
        toast("Connected ✓");
        renderSettings();
      } catch (e) {
        toast(e.message === "NO_TOKEN" ? "Enter repository and key." : `Could not connect (${e.message}).`, 4000);
      }
    };
    $("#stLangPush").value = set.brief_lang || "en";
    $("#langSeg").onclick = (e) => { const l = e.target.closest("button")?.dataset.l; if (l) { S.lang = l; store.set("lang", l); renderSettings(); toast(l === "de" ? "Briefs auf Deutsch" : "Briefs in English"); } };
    $("#stDesk").onchange = async (e) => {
      if (!e.target.checked) { store.set("deskNotify", false); return; }
      const perm = await Notification.requestPermission().catch(() => "denied");
      if (perm !== "granted") {
        e.target.checked = false;
        toast("Notifications are blocked – allow them for this app in System Settings → Notifications.", 4500);
        return;
      }
      store.set("deskNotify", true);
      store.set("notifiedUpTo", S.alerts?.[0]?.time || new Date().toISOString());
      navigator.serviceWorker.ready.then((reg) => reg.showNotification("Pullback notifications are on", { body: "New alerts will show up here while the app is open.", icon: "icons/icon-192.png", data: { url: location.pathname + "#/alerts" } }));
    };
    $("#cTest").onclick = () => runWorkflow(true);
    $("#cRun").onclick = () => runWorkflow(false);
  }

  // ------------------------------------------------------------------ boot
  // Automatic refreshes (every minute, or when the app comes back to the front) update the
  // screen quietly: the list keeps its scroll position, a chart is not rebuilt while you are
  // touching it, and Settings, Search, briefs and lookups are left alone (so typing is never
  // wiped and no new lookup job is started).
  let lastTouch = 0, deferred = false;
  ["pointerdown", "wheel", "touchstart", "keydown"].forEach((ev) =>
    window.addEventListener(ev, () => { lastTouch = Date.now(); }, { passive: true, capture: true }));
  const busy = () => S.sheetOpen || S.picking || Date.now() - lastTouch < 20000
    || ["INPUT", "SELECT", "TEXTAREA"].includes(document.activeElement?.tagName);

  function autoRender() {
    const name = parseRoute().name;
    if (["settings", "search", "lookup", "brief"].includes(name)) return;
    if (busy()) { deferred = true; return; }
    deferred = false;
    render(true, true);
  }
  setInterval(() => { if (deferred && !busy() && !document.hidden) autoRender(); }, 5000);

  async function refresh(manual) {
    const btn = $("#refreshBtn");
    btn.classList.add("spin");
    try {
      const changed = await loadSummary();
      if (manual) await loadConfig(true).catch(() => {});
      if (manual && !S.sheetOpen && parseRoute().name !== "search") await render(true, true);
      else if (changed) autoRender();
      if (manual) toast(changed ? "Updated" : `Up to date · last check ${timeAgo(S.summary.generated)}`);
    } catch (e) {
      if (manual || !S.summary) toast("Offline – showing last saved data.");
    } finally {
      btn.classList.remove("spin");
    }
  }

  $("#refreshBtn").onclick = () => refresh(true);
  $("#backBtn").onclick = () => (history.length > 1 ? history.back() : (location.hash = "#/" + store.get("lastList", "portfolio")));
  window.addEventListener("hashchange", () => render(false));
  document.addEventListener("visibilitychange", () => { if (!document.hidden) refresh(false); });
  // keep checking in the background only when this device shows notifications itself
  setInterval(() => { if (!document.hidden || store.get("deskNotify", false)) refresh(false); }, 60_000);
  setInterval(updateStatus, 30_000);

  // App updates: check for a new version whenever the app comes to the front. When the new
  // version takes over, reload into it – right away if the app just opened, otherwise the next
  // time it comes back to the front (never in the middle of reading a chart).
  if ("serviceWorker" in navigator && location.protocol === "https:") {
    const t0 = Date.now();
    let pendingReload = false;
    const hadController = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.addEventListener("controllerchange", () => {
      if (!hadController) return;                       // very first install: nothing to reload
      if (Date.now() - t0 < 15000 || document.hidden) location.reload();
      else pendingReload = true;
    });
    document.addEventListener("visibilitychange", () => {
      if (document.hidden) return;
      if (pendingReload) { location.reload(); return; }
      navigator.serviceWorker.getRegistration().then((r) => r && r.update()).catch(() => {});
    });
    navigator.serviceWorker.register("sw.js", { updateViaCache: "none" }).catch(() => {});
  }

  (async () => {
    render(false);
    await Promise.all([loadSummary().catch(() => {}), loadConfig(false).catch(() => {})]);
    if (!S.summary) {
      view.innerHTML = `<div class="empty"><b>No data yet</b>The first check runs at the next NYSE session, or start one from Settings → “Run a check now”.</div>`;
      return;
    }
    await render(false);
  })();
})();
