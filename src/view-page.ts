/**
 * The viewer's one page, as a string.
 *
 * It is text in a module, not a file beside one, so the build has nothing to
 * copy and the package has no asset to lose: `tsc` ships it like any other
 * constant. It is written without a framework, a bundler or a dependency on
 * purpose (see `view.ts`); what it gives up for that is polish, and that trade
 * is the point. Most reading of runs is done by an agent through the CLI's
 * JSON, so this page only has to let a person see a run at a glance.
 *
 * Everything from a run is put on the page as text, never as markup: a run
 * record holds whatever a model wrote.
 */
export const PAGE = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>ensemble · runs</title>
<style>
:root{--bg:#f6f5f1;--panel:#fff;--line:#dedbd2;--ink:#1c1b18;--soft:#6b675e;--accent:#1f5c47;--warn:#a15c00;--bad:#a8261b;--decide:#b7791f;--model:#6b4fbb;--work:#2f2e2a;--code:#6b675e;--mcp:#0b6e99;--agent:#a23b72;--took:#1f5c47;--mono:ui-monospace,SFMono-Regular,Menlo,monospace}
@media (prefers-color-scheme:dark){:root{--bg:#141413;--panel:#1d1d1b;--line:#33322e;--ink:#ecebe6;--soft:#9b978c;--accent:#6fcfa9;--warn:#e0a44a;--bad:#f08a7e;--decide:#e0a44a;--model:#b29cf2;--work:#ecebe6;--code:#9b978c;--mcp:#6cc3e6;--agent:#e58ab8;--took:#6fcfa9}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif}
a{color:inherit;text-decoration:none}
header{display:flex;gap:20px;align-items:center;padding:12px 20px;border-bottom:1px solid var(--line);position:sticky;top:0;background:var(--bg);z-index:2}
header b{font-size:15px}
header nav a{padding:5px 10px;border-radius:6px;color:var(--soft)}
header nav a.on{background:var(--panel);color:var(--ink);border:1px solid var(--line)}
header .where{margin-left:auto;color:var(--soft);font:12px var(--mono);max-width:45vw;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
main{max-width:1080px;margin:0 auto;padding:20px 16px 60px}
h1{font-size:22px;margin:4px 0 14px}
h2{font-size:13px;text-transform:uppercase;letter-spacing:.06em;color:var(--soft);margin:0 0 10px}
.card{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:14px 16px;margin:0 0 14px;overflow:hidden}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin:0 0 14px}
.tile{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:10px 14px}
.tile small{display:block;color:var(--soft)}
.tile b{font-size:19px;font-variant-numeric:tabular-nums}
table{width:100%;border-collapse:collapse}
th{text-align:left;font-weight:500;color:var(--soft);font-size:12px;padding:4px 8px}
td{padding:7px 8px;border-top:1px solid var(--line);vertical-align:top}
tr.go{cursor:pointer}
tr.go:hover td{background:color-mix(in srgb,var(--ink) 4%,transparent)}
.num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
.muted{color:var(--soft)}
.mono{font-family:var(--mono);font-size:12px}
.pill{display:inline-block;padding:1px 8px;border-radius:99px;border:1px solid currentColor;font-size:12px;white-space:nowrap}
.pill.ok{color:var(--accent)}.pill.bad{color:var(--bad)}.pill.wait{color:var(--warn)}.pill.live{color:var(--accent)}
.pill.live::before{content:"";display:inline-block;width:7px;height:7px;border-radius:50%;background:currentColor;margin-right:6px;animation:pulse 1.2s infinite}
@keyframes pulse{50%{opacity:.25}}
@media (prefers-reduced-motion:reduce){.pill.live::before,.node.now rect{animation:none}}
pre{margin:0;font:12px/1.5 var(--mono);white-space:pre-wrap;word-break:break-word;max-height:320px;overflow:auto}
.kv{display:grid;grid-template-columns:minmax(90px,max-content) 1fr;gap:6px 12px;align-items:start}
.kv > span{font:12px var(--mono);color:var(--soft);padding-top:1px}
.step{border-top:1px solid var(--line);padding:10px 0}
.step:first-of-type{border-top:0;padding-top:0}
.step .head{display:flex;gap:8px;align-items:baseline;flex-wrap:wrap}
.step .head b{font-family:var(--mono)}
.step .head .right{margin-left:auto;color:var(--soft);font-variant-numeric:tabular-nums;white-space:nowrap}
.kind{font:11px var(--mono);text-transform:uppercase;letter-spacing:.04em}
.k-decide{color:var(--decide)}.k-model{color:var(--model)}.k-work{color:var(--work)}.k-code{color:var(--code)}.k-mcp{color:var(--mcp)}.k-agent{color:var(--agent)}
.answer{margin:8px 0 0}
.bar > span:first-child{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bar{display:grid;grid-template-columns:minmax(120px,38%) 1fr 44px;gap:8px;align-items:center;font-size:12px;color:var(--soft)}
.bar i{display:block;height:6px;border-radius:3px;background:var(--line);overflow:hidden}
.bar i u{display:block;height:100%;background:var(--decide)}
.error{color:var(--bad)}
.graph{overflow:auto}
svg text{font:12px var(--mono);fill:var(--ink)}
svg .sub{font-size:10px;fill:var(--soft)}
svg .edge{fill:none;stroke:var(--line);stroke-width:1.5}
svg .edge.took{stroke:var(--took);stroke-width:2.5}
svg .edge.gate{stroke-dasharray:5 4}
svg .lab{font-size:10px;fill:var(--soft)}
svg .lab.took{fill:var(--took)}
.node rect{fill:var(--panel);stroke:var(--line);stroke-width:1.5}
.node.seen rect{stroke:var(--took);stroke-width:2.5}
.node.now rect{stroke:var(--warn);stroke-width:2.5;animation:pulse 1.2s infinite}
.node.failed rect{stroke:var(--bad);stroke-width:2.5}
.node{cursor:pointer}
.node.sel rect{fill:color-mix(in srgb,var(--accent) 12%,var(--panel))}
details summary{cursor:pointer;color:var(--soft)}
.empty{color:var(--soft);padding:6px 0}
</style>
</head>
<body>
<header>
  <b>ensemble</b>
  <nav><a href="#/runs" id="nav-runs">Runs</a> <a href="#/runners" id="nav-runners">Runners</a></nav>
  <span class="where" id="where"></span>
</header>
<main id="main"></main>
<script>
"use strict";
var main = document.getElementById("main");
var timer = null;

/* ── building the page: text is always text ── */
function el(tag, attrs, kids) {
  var node = document.createElement(tag);
  for (var key in attrs || {}) {
    if (key === "class") node.className = attrs[key];
    else if (key === "on") node.addEventListener("click", attrs[key]);
    else node.setAttribute(key, attrs[key]);
  }
  [].concat(kids === undefined ? [] : kids).forEach(function (kid) {
    if (kid === null || kid === undefined || kid === false) return;
    node.appendChild(typeof kid === "object" ? kid : document.createTextNode(String(kid)));
  });
  return node;
}
/** Replace a node's children, leaving out whatever is absent. */
function put(parent) {
  var kids = [].slice.call(arguments, 1).filter(function (kid) { return kid !== null && kid !== undefined && kid !== false; });
  parent.replaceChildren.apply(parent, kids);
}
function svg(tag, attrs, kids) {
  var node = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (var key in attrs || {}) node.setAttribute(key, attrs[key]);
  [].concat(kids === undefined ? [] : kids).forEach(function (kid) {
    if (kid === null || kid === undefined || kid === false) return;
    node.appendChild(typeof kid === "object" ? kid : document.createTextNode(String(kid)));
  });
  return node;
}

/* ── how numbers and times read ── */
function usd(value) {
  var n = Number(value);
  if (!isFinite(n)) return "–";
  if (n === 0) return "$0";
  if (n < 0.0001) return "$" + n.toFixed(6);
  if (n < 1) return "$" + n.toFixed(4);
  return "$" + n.toFixed(2);
}
function dur(ms) {
  if (ms === null || ms === undefined || !isFinite(ms)) return "–";
  if (ms < 1000) return Math.round(ms) + " ms";
  if (ms < 60000) return (ms / 1000).toFixed(1) + " s";
  return Math.floor(ms / 60000) + " min " + Math.round((ms % 60000) / 1000) + " s";
}
function ago(iso) {
  var s = (Date.now() - Date.parse(iso)) / 1000;
  if (!isFinite(s)) return "–";
  if (s < 45) return "just now";
  if (s < 3600) return Math.round(s / 60) + " min ago";
  if (s < 86400) return Math.round(s / 3600) + " h ago";
  if (s < 86400 * 14) return Math.round(s / 86400) + " d ago";
  return new Date(iso).toLocaleDateString();
}
function show(value) {
  return typeof value === "string" ? value : JSON.stringify(value, null, 2);
}
function pill(status) {
  var tone = status === "running" ? "live" : status === "completed" ? "ok" : status === "paused" ? "wait" : "bad";
  var label = { completed: "done", paused: "waiting for an answer", budget: "over budget", maxSteps: "step limit" }[status] || status;
  return el("span", { class: "pill " + tone }, label);
}
function value(v) {
  if (typeof v === "string" && v.indexOf("data:image/") === 0) return el("img", { src: v, alt: "an image the run produced", style: "max-width:220px;border-radius:6px" });
  if (Array.isArray(v) && v.length && v.every(function (x) { return typeof x === "string" && x.indexOf("data:image/") === 0; })) return el("div", {}, v.map(value));
  return el("pre", {}, show(v));
}
function kv(object) {
  var keys = Object.keys(object || {});
  if (!keys.length) return el("div", { class: "empty" }, "nothing");
  return el("div", { class: "kv" }, keys.reduce(function (all, key) { return all.concat([el("span", {}, key), value(object[key])]); }, []));
}

/* ── data ── */
function get(path) {
  return fetch(path).then(function (response) {
    return response.json().then(function (body) {
      if (!response.ok) throw new Error(body.error || "HTTP " + response.status);
      return body;
    });
  });
}
function every(ms, load) {
  clearInterval(timer);
  load();
  timer = setInterval(load, ms);
}
function fail(error) {
  put(main, el("div", { class: "card error" }, error.message));
}

/* ── tables ── */
function runsTable(rows, withRunner) {
  if (!rows.length) return el("div", { class: "empty" }, "No run yet.");
  return el("table", {}, [
    el("tr", {}, [el("th", {}, "Status"), el("th", {}, withRunner ? "Runner" : "Version"), el("th", {}, "Goal"), el("th", {}, "Started"), el("th", { class: "num" }, "Duration"), el("th", { class: "num" }, "Steps"), el("th", { class: "num" }, "Cost")]),
  ].concat(rows.map(function (row) {
    return el("tr", { class: "go", on: function () { location.hash = "#/runs/" + encodeURIComponent(row.id); } }, [
      el("td", {}, pill(row.status)),
      el("td", {}, [withRunner ? row.runner + " " : "", el("span", { class: "muted" }, "v" + row.version)]),
      el("td", { class: "muted" }, (row.goal || "").slice(0, 70)),
      el("td", { class: "muted", title: row.started }, ago(row.started)),
      el("td", { class: "num" }, dur(row.ms)),
      el("td", { class: "num" }, row.steps),
      el("td", { class: "num" }, usd(row.cost)),
    ]);
  })));
}

/* ── the graph: layers from the entry, the path a run took drawn over it ── */
function edgeLabel(edge) {
  if (edge.gate) return "gate: " + edge.gate;
  if (edge.on) return edge.on.option !== undefined ? edge.on.question + "=" + edge.on.option : edge.on.question + " " + edge.on.op + " " + edge.on.value;
  if (edge.when) return "when " + String(edge.when.source).replace(/^[^=]*=>\s*/, "").slice(0, 26);
  return "";
}
function drawGraph(graph, run, selected, onSelect) {
  var W = 176, H = 44, GX = 34, GY = 62;
  var edges = graph.edges.map(function (e) { return Object.assign({}, e); });
  graph.nodes.forEach(function (node) {
    var decide = node.decide || {};
    if (decide.gate) edges.push({ id: "gate:" + node.id, from: node.id, to: decide.gate.to, gate: decide.gate.on + " < " + decide.gate.min });
    if (decide.fallback) edges.push({ id: "fallback:" + node.id, from: node.id, to: decide.fallback, gate: "no answer" });
  });
  var out = {};
  graph.nodes.forEach(function (node) { out[node.id] = []; });
  edges.forEach(function (edge) { if (out[edge.from] && out[edge.to]) out[edge.from].push(edge); });

  // Loops go backwards: found by walking from the entry, and left out of the layering.
  var state = {}, order = [];
  (function walk(id) {
    state[id] = 1;
    out[id].forEach(function (edge) {
      if (state[edge.to] === 1) edge.back = true;
      else if (!state[edge.to]) walk(edge.to);
    });
    state[id] = 2;
    order.unshift(id);
  })(graph.runner.entry in out ? graph.runner.entry : graph.nodes[0].id);
  graph.nodes.forEach(function (node) { if (!state[node.id]) order.push(node.id); });
  var layer = {};
  order.forEach(function (id) { if (layer[id] === undefined) layer[id] = 0; out[id].forEach(function (edge) { if (!edge.back) layer[edge.to] = Math.max(layer[edge.to] || 0, layer[id] + 1); }); });

  var rows = [];
  order.forEach(function (id) { (rows[layer[id]] = rows[layer[id]] || []).push(id); });
  var widest = Math.max.apply(null, rows.map(function (row) { return row.length; }));
  // Room on the right for the edges routed round the side, and their labels.
  var width = widest * (W + GX) + GX + 190, pos = {};
  rows.forEach(function (row, depth) {
    var left = (width - 150 - (row.length * (W + GX) - GX)) / 2;
    row.forEach(function (id, index) { pos[id] = { x: left + index * (W + GX), y: 24 + depth * (H + GY) }; });
  });
  var height = 24 + rows.length * (H + GY);

  var took = {}, seen = {}, failed = null;
  ((run && run.steps) || []).forEach(function (step) {
    seen[step.node] = true;
    if (step.error) failed = step.node;
    if (step.took === "gate" || step.took === "fallback") took[step.took + ":" + step.node] = true;
    else if (step.took) took[step.took] = true;
    (step.forked || []).forEach(function (id) { took[id] = true; });
  });
  var now = {};
  ((run && run.running) || []).forEach(function (id) { now[id] = true; });

  var root = svg("svg", { width: width, height: height, viewBox: "0 0 " + width + " " + height, role: "img", "aria-label": "The graph of " + graph.runner.name });
  // One arrowhead, drawn in whatever colour the edge it ends has.
  root.appendChild(svg("defs", {}, svg("marker", { id: "arrow", viewBox: "0 0 10 10", refX: 9, refY: 5, markerWidth: 7, markerHeight: 7, orient: "auto-start-reverse" }, svg("path", { d: "M0 0L10 5L0 10z", fill: "context-stroke" }))));
  edges.forEach(function (edge) {
    var a = pos[edge.from], b = pos[edge.to];
    if (!a || !b) return;
    var d, lx, ly, anchor = "middle";
    // An edge that goes back, or skips a layer, is routed round the side so it does not cross the nodes between.
    if (edge.back || b.y <= a.y || layer[edge.to] - layer[edge.from] > 1) {
      var side = Math.max(a.x, b.x) + W + 28;
      d = "M" + (a.x + W) + " " + (a.y + H / 2) + " C" + side + " " + (a.y + H / 2) + " " + side + " " + (b.y + H / 2) + " " + (b.x + W) + " " + (b.y + H / 2);
      lx = side - 14; ly = (a.y + b.y) / 2 + H / 2; anchor = "start";
    } else {
      var x1 = a.x + W / 2, y1 = a.y + H, x2 = b.x + W / 2, y2 = b.y, mid = (y1 + y2) / 2;
      d = "M" + x1 + " " + y1 + " C" + x1 + " " + mid + " " + x2 + " " + mid + " " + x2 + " " + y2;
      // The label sits just above where the edge arrives, so edges that fan out do not write over each other.
      lx = x2; ly = y2 - 7;
    }
    var cls = "edge" + (took[edge.id] ? " took" : "") + (edge.gate ? " gate" : "");
    root.appendChild(svg("path", { d: d, class: cls, "marker-end": "url(#arrow)" }));
    var text = edgeLabel(edge);
    if (text) root.appendChild(svg("text", { x: lx, y: ly, "text-anchor": anchor, class: "lab" + (took[edge.id] ? " took" : "") }, text));
  });
  graph.nodes.forEach(function (node) {
    var p = pos[node.id];
    if (!p) return;
    var cls = "node" + (now[node.id] ? " now" : failed === node.id ? " failed" : seen[node.id] ? " seen" : "") + (selected === node.id ? " sel" : "");
    var sub = node.kind === "decide" ? (node.decide.by === "human" ? "a person" : "decide") + " · " + node.decide.questions.length + "q"
      : node.kind === "model" ? (node.model.id || "from " + node.model.from)
      : node.kind === "work" ? "work · " + node.work.handler
      : node.kind === "mcp" ? "mcp · " + node.mcp.server
      : node.kind === "agent" ? "agent · " + node.agent.name
      : "code";
    var group = svg("g", { class: cls, transform: "translate(" + p.x + "," + p.y + ")", tabindex: 0, role: "button", "aria-label": node.id + ", " + node.kind }, [
      svg("rect", { width: W, height: H, rx: node.kind === "decide" ? 22 : 8 }),
      svg("text", { x: 12, y: 19 }, (node.label || node.id).slice(0, 22)),
      svg("text", { x: 12, y: 34, class: "sub" }, String(sub).slice(0, 28)),
    ]);
    var pick = function () { onSelect(selected === node.id ? null : node.id); };
    group.addEventListener("click", pick);
    group.addEventListener("keydown", function (event) { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); pick(); } });
    root.appendChild(group);
  });
  return el("div", { class: "graph" }, root);
}
function nodeDetails(graph, id) {
  var node = graph.nodes.filter(function (n) { return n.id === id; })[0];
  if (!node) return null;
  var parts = [el("h2", {}, node.id + " · " + node.kind), el("div", { class: "kv" }, [el("span", {}, "reads"), el("pre", {}, node.reads.join(", ") || "nothing"), el("span", {}, "writes"), el("pre", {}, node.writes.join(", ") || "nothing")])];
  if (node.decide) node.decide.questions.forEach(function (q) {
    var choices = q.options ? q.options.map(function (o) { return o.name; }).join(" · ") : q.levels ? q.levels.length + " levels" : "yes / no";
    parts.push(el("div", { class: "answer" }, [el("b", { class: "mono" }, q.key + " "), el("span", { class: "muted" }, q.type + ": " + choices), el("pre", {}, show(q.instructions))]));
  });
  if (node.model) parts.push(el("div", { class: "answer" }, el("pre", {}, show(node.model))));
  return el("div", { class: "card" }, parts);
}
function graphCard(graph, run, note) {
  var holder = el("div", {});
  var selected = null;
  function render() {
    put(holder, 
      el("div", { class: "card" }, [el("h2", {}, run ? "Path" : "Graph"), note ? el("div", { class: "muted", style: "margin-bottom:8px" }, note) : null, drawGraph(graph, run, selected, function (id) { selected = id; render(); })]),
      selected ? nodeDetails(graph, selected) : null
    );
  }
  render();
  return holder;
}

/* ── pages ── */
function pageRuns() {
  every(3000, function () {
    get("/api/overview").then(function (data) {
      document.getElementById("where").textContent = data.runsDir;
      var all = data.live.concat(data.runs);
      var cost = data.runs.reduce(function (sum, row) { return sum + Number(row.cost || 0); }, 0);
      var failures = data.runs.filter(function (row) { return row.status !== "completed" && row.status !== "paused"; }).length;
      put(main, 
        el("h1", {}, "Runs"),
        el("div", { class: "tiles" }, [
          el("div", { class: "tile" }, [el("small", {}, "Recorded"), el("b", {}, data.runs.length)]),
          el("div", { class: "tile" }, [el("small", {}, "Live now"), el("b", {}, data.live.length)]),
          el("div", { class: "tile" }, [el("small", {}, "Total cost"), el("b", {}, usd(cost))]),
          el("div", { class: "tile" }, [el("small", {}, "Did not complete"), el("b", {}, failures)]),
        ]),
        el("div", { class: "card" }, all.length ? runsTable(all, true) : el("div", { class: "empty" }, [
          "Nothing has run here yet. The viewer reads " + data.runsDir + (data.found ? "" : ", which does not exist yet") + ". Start one with: ",
          el("span", { class: "mono" }, "npx ensemble run <file> \"goal\" --budget 0.05"),
        ]))
      );
    }).catch(fail);
  });
}
function pageRunners() {
  every(4000, function () {
    get("/api/overview").then(function (data) {
      document.getElementById("where").textContent = data.runsDir;
      put(main, 
        el("h1", {}, "Runners"),
        el("div", { class: "card" }, data.runners.length ? el("table", {}, [
          el("tr", {}, [el("th", {}, "Runner"), el("th", {}, "What it does"), el("th", { class: "num" }, "Versions"), el("th", { class: "num" }, "Runs"), el("th", { class: "num" }, "Cost"), el("th", {}, "Last run")]),
        ].concat(data.runners.map(function (runner) {
          return el("tr", { class: "go", on: function () { location.hash = "#/runners/" + encodeURIComponent(runner.name); } }, [
            el("td", {}, [el("b", {}, runner.name), runner.live ? el("span", { class: "pill live", style: "margin-left:8px" }, runner.live + " live") : null]),
            el("td", { class: "muted" }, runner.description),
            el("td", { class: "num" }, runner.versions),
            el("td", { class: "num" }, runner.runs),
            el("td", { class: "num" }, usd(runner.cost)),
            el("td", { class: "muted" }, runner.last ? ago(runner.last) : "–"),
          ]);
        }))) : el("div", { class: "empty" }, "No runner has run here yet."))
      );
    }).catch(fail);
  });
}
function pageRunner(name) {
  var built = null;
  every(4000, function () {
    get("/api/runner?name=" + encodeURIComponent(name)).then(function (data) {
      // The graph is drawn once: redrawing it every few seconds would drop the node you have open.
      var hash = data.graph ? data.graph.runner.hash : "none";
      if (!built || built.hash !== hash) built = { hash: hash, node: data.graph ? graphCard(data.graph, null, null) : el("div", { class: "card muted" }, "Its runs recorded no graph.json, so there is no graph to draw.") };
      put(main, 
        el("h1", {}, name),
        data.description ? el("p", { class: "muted" }, data.description) : null,
        built.node,
        el("div", { class: "card" }, [el("h2", {}, "Runs"), runsTable(data.live.concat(data.runs), false)]),
        el("div", { class: "card" }, [el("h2", {}, "Versions"), el("table", {}, [el("tr", {}, [el("th", {}, "Version"), el("th", {}, "Graph hash"), el("th", { class: "num" }, "Runs")])].concat(data.versions.map(function (v) {
          return el("tr", {}, [el("td", {}, "v" + v.version), el("td", { class: "mono" }, v.hash), el("td", { class: "num" }, v.runs)]);
        }))), el("div", { class: "muted", style: "margin-top:8px" }, "A version is a distinct graph: when the graph changes its hash changes. The graph above is the latest.")])
      );
    }).catch(fail);
  });
}
function stepView(step, graph) {
  var edge = graph && graph.edges.filter(function (e) { return e.id === step.took; })[0];
  var went = step.error ? null : step.took === "gate" ? "gate: not confident enough" : step.took === "fallback" ? "no answer: took the fallback" : edge ? "then " + edge.to : step.took ? step.took : "end of this lane";
  var kids = [el("div", { class: "head" }, [
    el("span", { class: "muted" }, step.n),
    el("b", {}, step.node),
    el("span", { class: "kind k-" + step.kind }, step.kind),
    went ? el("span", { class: "muted" }, "→ " + went) : null,
    el("span", { class: "right" }, dur(step.ms) + " · " + usd(step.cost)),
  ])];
  Object.keys(step.answers || {}).forEach(function (key) {
    var a = step.answers[key];
    var said = a.type === "noul" ? (Number(a.value) >= 0.5 ? "yes" : "no") + "  (P yes " + Number(a.value).toFixed(2) + ")" : String(a.value);
    var block = [el("div", {}, [el("b", { class: "mono" }, key + " "), said, a.confidence !== undefined ? el("span", { class: "muted" }, "  confidence " + Math.round(a.confidence * 100) + "%") : null])];
    Object.keys(a.probabilities || {}).forEach(function (option) {
      var p = Number(a.probabilities[option]) || 0;
      var fill = el("u", {});
      fill.style.width = Math.round(p * 100) + "%";
      // A score's legend describes each level; a description is text or an object with a "what".
      var meaning = a.legend && a.legend[option];
      var label = !meaning ? option : option + " · " + (typeof meaning === "string" ? meaning : meaning.what || meaning.summary || JSON.stringify(meaning));
      block.push(el("div", { class: "bar" }, [el("span", { title: label }, label), el("i", {}, fill), el("span", { class: "num" }, Math.round(p * 100) + "%")]));
    });
    kids.push(el("div", { class: "answer" }, block));
  });
  if (step.error) kids.push(el("div", { class: "answer error" }, step.error));
  if (step.writes && Object.keys(step.writes).length) kids.push(el("details", { class: "answer" }, [el("summary", {}, "wrote " + Object.keys(step.writes).join(", ")), kv(step.writes)]));
  if (step.asked && Object.keys(step.asked).length) kids.push(el("details", { class: "answer" }, [el("summary", {}, "was given " + Object.keys(step.asked).join(", ")), kv(step.asked)]));
  return el("div", { class: "step" }, kids);
}
function pageRun(id) {
  var built = null;
  function load() {
    get("/api/run?id=" + encodeURIComponent(id)).then(function (run) {
      if (!run.live && run.status !== "paused") clearInterval(timer);
      // Redraw the graph only when the run has moved on, so a node you opened stays open.
      var key = run.steps.length + "|" + run.running.join(",") + "|" + run.status;
      if (!built || built.key !== key) built = { key: key, node: run.graph ? graphCard(run.graph, run, run.graphFrom ? "Drawn on " + run.graphFrom + ": a live run has not written its own graph yet." : null) : el("div", { class: "card muted" }, "No graph was recorded for this run.") };
      put(main, 
        el("h1", {}, [el("a", { href: "#/runners/" + encodeURIComponent(run.runner) }, run.runner), " ", el("span", { class: "muted", style: "font-size:14px" }, "v" + run.version), "  ", pill(run.status)]),
        el("div", { class: "tiles" }, [
          el("div", { class: "tile" }, [el("small", {}, run.live ? "Cost so far" : "Cost"), el("b", {}, usd(run.cost))]),
          el("div", { class: "tile" }, [el("small", {}, run.live ? "Running for" : "Duration"), el("b", {}, dur(run.ms))]),
          el("div", { class: "tile" }, [el("small", {}, "Steps"), el("b", {}, run.steps.length)]),
          el("div", { class: "tile" }, [el("small", {}, run.live ? "Now at" : "Run"), el("b", { class: "mono", style: "font-size:12px" }, run.live ? (run.running.join(", ") || "between nodes") : run.id)]),
        ]),
        run.error ? el("div", { class: "card error" }, [el("h2", {}, "Why it stopped"), run.error]) : null,
        run.pending ? el("div", { class: "card" }, [el("h2", {}, "Waiting for an answer at " + run.pending.node), el("div", { class: "muted" }, "Answer in a terminal, with the paused.json in this run's folder:"), el("pre", {}, "npx ensemble resume <runner file> .ensemble/runs/" + run.id + "/paused.json " + run.pending.questions.map(function (q) { return "--answer " + q.key + "=…"; }).join(" ")), kv(run.pending.asked)]) : null,
        run.result !== null && run.result !== undefined ? el("div", { class: "card" }, [el("h2", {}, "Result"), value(run.result)]) : null,
        built.node,
        el("div", { class: "card" }, [el("h2", {}, "Steps")].concat(run.steps.length ? run.steps.map(function (step) { return stepView(step, run.graph); }) : [el("div", { class: "empty" }, run.live ? "Waiting for the first step." : "No step ran.")])),
        el("div", { class: "card" }, [el("h2", {}, run.live ? "State so far" : "Inputs"), kv(run.live ? run.state : run.inputs)])
      );
    }).catch(function (error) {
      // A live run that ended has moved to its record: go and find it.
      if (id.indexOf("live:") === 0) { location.hash = "#/runs"; return; }
      fail(error);
    });
  }
  every(2000, load);
}

function route() {
  clearInterval(timer);
  var parts = location.hash.replace(/^#\/?/, "").split("/").map(decodeURIComponent);
  document.getElementById("nav-runs").className = parts[0] !== "runners" ? "on" : "";
  document.getElementById("nav-runners").className = parts[0] === "runners" ? "on" : "";
  if (parts[0] === "runners" && parts[1]) pageRunner(parts[1]);
  else if (parts[0] === "runners") pageRunners();
  else if (parts[0] === "runs" && parts[1]) pageRun(parts.slice(1).join("/"));
  else pageRuns();
}
window.addEventListener("hashchange", route);
route();
</script>
</body>
</html>
`;
