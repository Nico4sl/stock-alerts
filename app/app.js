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
    repo: detectRepo(),
    token: store.get("token", ""),
    branch: store.get("branch", "main"),
    movers: null, briefs: [], briefCache: {},
    lang: store.get("lang", "en"),
  };

  // ------------------------------------------------------------------ utils
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
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
      mutate(next);
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

  // ------------------------------------------------------------- shell / nav
  function updateStatus() {
    const s = S.summary;
    if (!s) return;
    const open = (s.market || "").startsWith("open");
    $("#status").innerHTML = `<b>${open ? "Market open" : "Market closed"}</b>${clock(s.generated)} · ${timeAgo(s.generated)}`;
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
    if (["portfolio", "watchlist", "alerts", "settings"].includes(a)) return { name: a };
    return { name: store.get("lastList", "portfolio") };
  }

  async function render(keepChartRange) {
    const r = parseRoute();
    let range = null;
    if (keepChartRange && S.chart) range = S.chart.chart.timeScale().getVisibleLogicalRange();
    destroyChart();
    closeSheet();
    if (!S.summary && r.name !== "settings") {
      view.innerHTML = `<div class="empty"><b>Loading…</b></div>`;
      return;
    }
    if (r.name === "detail") return renderDetail(r.sym, range);
    if (r.name === "brief") return renderBriefPage(r.id);
    window.scrollTo(0, 0);
    if (r.name === "alerts") return renderAlerts();
    if (r.name === "settings") return renderSettings();
    store.set("lastList", r.name);
    return renderList(r.name);
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
      <div><div class="sym">${esc(r.symbol)}${r.high_conviction ? '<span class="star" title="High conviction">★</span>' : ""}</div>
        <div class="name">${esc(r.name)}</div><div class="chips">${chips.join("")}</div></div>
      <div class="spark">${spark(r.spark, (r.change_pct ?? 0) >= 0)}</div>
      <div class="px num"><div class="p">${fmt(r.price)}</div><div class="c ${cls(r.change_pct)}">${sgn(r.change_pct, 2)}</div></div>
    </li>`;
  }

  // ------------------------------------------------------------------ detail
  async function renderDetail(sym, keepRange) {
    const row = (S.summary.stocks || []).find((r) => r.symbol === sym);
    const cfg = (S.config?.stocks || []).find((s) => s.symbol === sym) || row || { symbol: sym, levels: [] };
    setTop(sym, true);
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
      </div></div>
      <div class="chart-wrap"><div id="chart"></div><div class="legend num" id="legend"></div>
        <div class="pick-hint" id="pickHint" hidden>Tap the chart at your price</div></div>
      <div class="ranges" id="ranges">
        ${RANGES.map(([l, n]) => `<button data-n="${n}">${l}</button>`).join("")}
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
    buildChart(detail, row, levels, vname, keepRange);

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
    const set = S.summary.settings || {};
    const band = set.band_pct ?? 1.5;
    const L = row.levels || {};
    const line = (key, extra = "") => {
      const val = L[key], d = row.dist?.[key];
      const zone = d !== undefined && Math.abs(d) <= band;
      return `<div class="lv"><span class="sw" style="background:${COLORS[key]}"></span>
        <span>${LABEL[key]}${extra}</span><span class="v num">${fmt(val)}</span>
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
        <div class="note" style="padding-top:10px">${row.high_conviction ? "★ High conviction: 200-day alerts on." : "Mark ★ High conviction to get 200-day alerts."}</div></div>`;
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
      ${gaps.length ? gaps.slice(0, 8).map(gl).join("") : '<div class="note">No open gaps in the last 3 years.</div>'}
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
      handleScale: { axisPressedMouseMove: { time: true, price: true }, pinch: true, mouseWheel: true },
      handleScroll: { vertTouchDrag: false },
      kineticScroll: { touch: true, mouse: false },
    });

    const n = d.t.length;
    const candles = chart.addCandlestickSeries({
      upColor: COLORS.up, downColor: COLORS.down, wickUpColor: COLORS.up, wickDownColor: COLORS.down, borderVisible: false,
      priceFormat: { type: "price", precision: row.price >= 10 ? 2 : 4, minMove: row.price >= 10 ? 0.01 : 0.0001 },
    });
    candles.setData(d.t.map((t, i) => ({ time: t, open: d.o[i], high: d.h[i], low: d.l[i], close: d.c[i] })));

    const vol = chart.addHistogramSeries({ priceScaleId: "vol", priceFormat: { type: "volume" }, lastValueVisible: false, priceLineVisible: false });
    chart.priceScale("vol").applyOptions({ scaleMargins: { top: 0.86, bottom: 0 }, visible: false });
    vol.setData(d.t.map((t, i) => ({ time: t, value: d.v[i], color: d.c[i] >= d.o[i] ? "rgba(38,166,154,.28)" : "rgba(239,83,80,.28)" })));

    const lines = {};
    for (const key of ["ema8", "ema21", "sma50", "sma100", "sma150", "sma200"]) {
      lines[key] = chart.addLineSeries({
        color: COLORS[key], lineWidth: key === "sma200" ? 3 : 2, priceLineVisible: false, lastValueVisible: true,
        crosshairMarkerVisible: false, visible: false, title: "",
      });
      lines[key].setData(d.t.map((t, i) => (d[key][i] === null ? { time: t } : { time: t, value: d[key][i] })));
    }

    // manual levels as price lines (all views)
    for (const m of levels) {
      const t = LEVEL_TYPES[m.type] || LEVEL_TYPES.support;
      candles.createPriceLine({ price: +m.price, color: t.color, lineWidth: 1, lineStyle: LWC.LineStyle.Dashed, axisLabelVisible: true, title: m.note ? m.note.slice(0, 14) : t.label });
    }

    const overlay = new Overlay();
    candles.attachPrimitive(overlay);

    const idx = Object.fromEntries(d.t.map((t, i) => [t, i]));
    const gaps = (d.gaps || []).map((g) => ({
      ...g, i0: idx[g.start] ?? 0, i1: g.filled ? (idx[g.filled_date] ?? n - 1) : null,
      below: g.open_top <= row.price,
    }));

    S.chart = { chart, candles, vol, lines, overlay, gaps, d, row, view: vname, n };

    // legend + chart picking
    const legend = $("#legend");
    const showLegend = (i) => {
      if (i === null || i === undefined || i < 0 || i >= n) i = n - 1;
      const v = S.chart.view;
      const parts = [`<span class="k">${d.t[i]}</span>`];
      if (v === "sma") parts.push(`<span><span class="k">C</span> <i>${fmt(d.c[i])}</i></span>`);
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

  function applyView(v, resetRange) {
    const c = S.chart;
    if (!c) return;
    c.view = v;
    const band = S.summary.settings?.band_pct ?? 1.5;
    for (const [key, s] of Object.entries(c.lines)) s.applyOptions({ visible: VIEWS[v].lines.includes(key) });
    const bands = S.zones ? VIEWS[v].lines.map((key) => ({ values: c.d[key], pct: band, fill: hexA(COLORS[key], key === "sma200" ? 0.08 : 0.1) })) : [];
    c.overlay.set(v === "gaps" ? c.gaps : [], bands);
    c.showLegend(null);
    if (resetRange) setBars(VIEWS[v].bars);
    $("#levelsCard").innerHTML = levelsCardHTML(v, c.row, c.d);
  }

  function setBars(bars) {
    const c = S.chart;
    if (!c) return;
    if (bars >= c.n) c.chart.timeScale().fitContent();
    else c.chart.timeScale().setVisibleLogicalRange({ from: c.n - bars, to: c.n + 3 });
    document.querySelectorAll("#ranges button").forEach((b) => b.classList.toggle("on", +b.dataset.n === bars));
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
    return `<ul class="heads">${list.slice(0, n).map((h) => `<li><a href="${esc(h.url)}" target="_blank" rel="noopener">${esc(h.title)}</a>
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
      ${b.sources?.length ? `<h5>${L.src}</h5><ul class="heads">${b.sources.map((s) => `<li><a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.title)}</a><span>${esc(s.publisher || "")}</span></li>`).join("")}</ul>` : ""}
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

  // pop-up for briefs you have not read yet (last 24 h)
  async function maybePopupBriefs() {
    if (S.sheetOpen || parseRoute().name === "brief" || !S.briefs.length) return;
    if (!store.get("popupInit", false)) {             // first launch: don't pop up the archive
      store.set("popupInit", true);
      store.set("seenBriefs", S.briefs.map((b) => b.id));
      return;
    }
    const seen = new Set(store.get("seenBriefs", []));
    const dayAgo = new Date(Date.now() - 36 * 3600e3).toISOString().slice(0, 10);
    const fresh = S.briefs.filter((b) => !seen.has(b.id) && b.date >= dayAgo);
    if (!fresh.length) return;
    let i = 0;
    const show = async () => {
      const b = await loadBrief(fresh[i].id).catch(() => null);
      if (!b) return;
      markBriefSeen(b.id);
      openSheet(`<div class="pop-h">⚡ Why it moved${fresh.length > 1 ? ` · ${i + 1}/${fresh.length}` : ""}</div>${briefBodyHTML(b)}
        <div class="actions"><button class="btn small" id="pChart">Chart</button><span style="flex:1"></span>
        ${i < fresh.length - 1 ? `<button class="btn primary small" id="pNext">Next: ${esc(fresh[i + 1].symbol)} →</button>` : `<button class="btn primary small" id="pDone">Done</button>`}</div>`, (bg) => {
        bindLang(bg, () => { closeSheet(); show(); });
        $("#pChart", bg).onclick = () => { closeSheet(); location.hash = `#/s/${encodeURIComponent(b.symbol)}`; };
        const nx = $("#pNext", bg), dn = $("#pDone", bg);
        if (nx) nx.onclick = () => { i++; show(); };
        if (dn) dn.onclick = closeSheet;
      });
    };
    show();
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
        Checks run every 10 min while the NYSE is open (Mon–Fri, 15:30–22:00 Vienna time).
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
          <label><input type="checkbox" id="stEma" ${set.ema_alerts !== false ? "checked" : ""}> 8 / 21 EMA entry alerts</label>
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

      <div class="card"><h3>Notifications</h3><div class="note">
        Alerts are pushed through the free <b style="color:var(--text)">ntfy</b> app. In ntfy tap + and subscribe to your private topic (the same text you saved as <code>NTFY_TOPIC</code> on GitHub). On the Mac you can open <code>ntfy.sh/app</code> in the browser and allow notifications.</div></div>

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
          ema_alerts: $("#stEma").checked, gap_alerts: $("#stGaps").checked,
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
    $("#cTest").onclick = () => runWorkflow(true);
    $("#cRun").onclick = () => runWorkflow(false);
  }

  // ------------------------------------------------------------------ boot
  async function refresh(manual) {
    const btn = $("#refreshBtn");
    btn.classList.add("spin");
    try {
      const changed = await loadSummary();
      if (manual) await loadConfig(true).catch(() => {});
      if ((changed || manual) && !S.sheetOpen) await render(true);
      maybePopupBriefs();
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
  setInterval(() => { if (!document.hidden) refresh(false); }, 60_000);
  setInterval(updateStatus, 30_000);

  if ("serviceWorker" in navigator && location.protocol === "https:") {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  }

  (async () => {
    render(false);
    await Promise.all([loadSummary().catch(() => {}), loadConfig(false).catch(() => {})]);
    if (!S.summary) {
      view.innerHTML = `<div class="empty"><b>No data yet</b>The first check runs at the next NYSE session, or start one from Settings → “Run a check now”.</div>`;
      return;
    }
    await render(false);
    maybePopupBriefs();
  })();
})();
