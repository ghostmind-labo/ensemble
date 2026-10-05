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
:root{
  --bg:#F7F6F3;--panel:#FFFFFF;--line:#EAEAEA;--ink:#111111;--body:#2F3437;--soft:#787774;--edge:#CFCDC7;
  --red-bg:#FDEBEC;--red:#9F2F2D;--blue-bg:#E1F3FE;--blue:#1F6C9F;--green-bg:#EDF3EC;--green:#346538;--yellow-bg:#FBF3DB;--yellow:#956400;--plain-bg:#F1F0EC;--plain:#5F5E5B;
  --sans:"SF Pro Display","Geist Sans","Helvetica Neue","Switzer",system-ui,sans-serif;
  --serif:"Lyon Text","Newsreader","Instrument Serif","Iowan Old Style","Palatino Linotype",Georgia,serif;
  --mono:"Geist Mono","SF Mono","JetBrains Mono",ui-monospace,Menlo,monospace;
}
@media (prefers-color-scheme:dark){:root{
  --bg:#171614;--panel:#1F1E1B;--line:#33312D;--ink:#F2F1EC;--body:#DAD8D2;--soft:#9A978F;--edge:#4A4843;
  --red-bg:#3A2422;--red:#F0A8A2;--blue-bg:#1E2F3B;--blue:#9CCBEA;--green-bg:#233024;--green:#A9CFA9;--yellow-bg:#3A3020;--yellow:#E6C77A;--plain-bg:#2A2926;--plain:#B5B2AA;
}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--body);font:14px/1.6 var(--sans);-webkit-font-smoothing:antialiased}
a{color:inherit;text-decoration:none}
header{display:flex;gap:24px;align-items:center;padding:14px 28px;border-bottom:1px solid var(--line);position:sticky;top:0;background:color-mix(in srgb,var(--bg) 88%,transparent);backdrop-filter:blur(8px);z-index:2}
header b{font:600 17px/1 var(--serif);letter-spacing:-.02em;color:var(--ink)}
header nav{display:flex;gap:4px}
header nav a{padding:4px 10px;border-radius:6px;color:var(--soft);transition:color .2s}
header nav a:hover{color:var(--ink)}
header nav a.on{background:var(--panel);color:var(--ink);box-shadow:inset 0 0 0 1px var(--line)}
header .where{margin-left:auto;color:var(--soft);font:11px var(--mono);max-width:45vw;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
main{max-width:1040px;margin:0 auto;padding:40px 24px 96px}
h1{font:500 34px/1.1 var(--serif);letter-spacing:-.03em;color:var(--ink);margin:0 0 24px;display:flex;gap:12px;align-items:center;flex-wrap:wrap}
h2{font:500 11px/1 var(--sans);text-transform:uppercase;letter-spacing:.08em;color:var(--soft);margin:0 0 16px}
p{margin:0 0 20px;max-width:64ch}
.card{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:24px;margin:0 0 16px;overflow:hidden}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px;margin:0 0 16px}
.tile{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:16px 20px}
.tile small{display:block;color:var(--soft);font-size:12px;margin-bottom:2px}
.tile b{font:500 22px/1.2 var(--sans);color:var(--ink);font-variant-numeric:tabular-nums;letter-spacing:-.01em}
table{width:100%;border-collapse:collapse}
th{text-align:left;font-weight:500;color:var(--soft);font-size:12px;padding:0 10px 8px}
td{padding:10px;border-top:1px solid var(--line);vertical-align:top}
tr.go{cursor:pointer}
tr.go td{transition:background .2s}
tr.go:hover td{background:color-mix(in srgb,var(--ink) 3%,transparent)}
.num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
.muted{color:var(--soft)}
.mono{font-family:var(--mono);font-size:12px}
.pill{display:inline-flex;align-items:center;gap:6px;padding:2px 9px;border-radius:9999px;font:500 10px/1.6 var(--sans);text-transform:uppercase;letter-spacing:.05em;white-space:nowrap;background:var(--plain-bg);color:var(--plain)}
.pill.ok{background:var(--green-bg);color:var(--green)}.pill.bad{background:var(--red-bg);color:var(--red)}.pill.wait{background:var(--yellow-bg);color:var(--yellow)}.pill.live{background:var(--blue-bg);color:var(--blue)}
.pill.live::before{content:"";width:6px;height:6px;border-radius:50%;background:currentColor;animation:pulse 1.4s ease-in-out infinite}
@keyframes pulse{50%{opacity:.25}}
@media (prefers-reduced-motion:reduce){.pill.live::before,.node.now .box{animation:none}}
pre{margin:0;font:12px/1.6 var(--mono);white-space:pre-wrap;word-break:break-word;max-height:320px;overflow:auto;color:var(--body)}
.kv{display:grid;grid-template-columns:minmax(90px,max-content) 1fr;gap:8px 16px;align-items:start}
.kv > span{font:12px/1.6 var(--mono);color:var(--soft)}
.step{border-top:1px solid var(--line);padding:16px 0}
.step:first-of-type{border-top:0;padding-top:0}
.step:last-child{padding-bottom:0}
.step .head{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
.step .head b{font:500 13px var(--mono);color:var(--ink)}
.step .head .right{margin-left:auto;color:var(--soft);font-variant-numeric:tabular-nums;white-space:nowrap;font-size:12px}
.kind{display:inline-block;padding:1px 7px;border-radius:9999px;font:500 9.5px/1.6 var(--sans);text-transform:uppercase;letter-spacing:.06em;background:var(--plain-bg);color:var(--plain)}
.k-decide{background:var(--yellow-bg);color:var(--yellow)}.k-model{background:var(--blue-bg);color:var(--blue)}.k-mcp,.k-agent{background:var(--green-bg);color:var(--green)}
.answer{margin:10px 0 0}
.answer b{color:var(--ink)}
.bar{display:grid;grid-template-columns:minmax(120px,38%) 1fr 44px;gap:10px;align-items:center;font-size:12px;color:var(--soft)}
.bar > span:first-child{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.bar i{display:block;height:4px;border-radius:2px;background:var(--line);overflow:hidden}
.bar i u{display:block;height:100%;background:var(--ink)}
.error{color:var(--red)}
.card.error{background:var(--red-bg);border-color:transparent}
details summary{cursor:pointer;color:var(--soft);font-size:12px}
.empty{color:var(--soft)}

/* the graph: a canvas you can zoom, pan and rearrange */
.canvas{position:relative;border:1px solid var(--line);border-radius:8px;overflow:hidden;background-color:var(--bg);background-image:radial-gradient(circle,var(--edge) .7px,transparent .8px);background-size:18px 18px}
.canvas svg{display:block;width:100%;touch-action:none;cursor:grab;user-select:none}
.canvas svg.panning{cursor:grabbing}
.tools{position:absolute;top:10px;right:10px;display:flex;gap:4px;align-items:center}
.tools button{font:500 12px/1 var(--mono);min-width:28px;height:26px;padding:0 8px;border:1px solid var(--line);border-radius:5px;background:var(--panel);color:var(--body);cursor:pointer;transition:transform .15s,border-color .2s}
.tools button:hover{border-color:var(--soft)}
.tools button:active{transform:scale(.96)}
.tools output{font:11px var(--mono);color:var(--soft);min-width:38px;text-align:right;margin-right:4px}
.hint{display:flex;gap:14px;flex-wrap:wrap;margin-top:12px;color:var(--soft);font-size:12px}
kbd{font:11px var(--mono);border:1px solid var(--line);border-radius:4px;background:var(--bg);padding:0 5px;color:var(--body)}
svg text{font:500 13px var(--sans);fill:var(--ink)}
svg .sub{font:11px var(--mono);fill:var(--soft)}
svg .tag{font:500 9px var(--sans);letter-spacing:.06em;text-transform:uppercase}
svg .edge{fill:none;stroke:var(--edge);stroke-width:1.25}
svg .edge.took{stroke:var(--ink);stroke-width:1.75}
svg .edge.gate{stroke-dasharray:4 4}
svg .chip{fill:var(--panel);stroke:var(--line)}
svg .lab{font:10.5px var(--mono);fill:var(--soft)}
svg .lab.took{fill:var(--ink)}
.node{cursor:grab}
.node .box{fill:var(--panel);stroke:var(--line);stroke-width:1}
.node.seen .box{stroke:var(--ink);stroke-width:1.5}
.node.now .box{fill:var(--yellow-bg);stroke:var(--yellow);stroke-width:1.5;animation:pulse 1.4s ease-in-out infinite}
.node.failed .box{fill:var(--red-bg);stroke:var(--red);stroke-width:1.5}
.node.sel .box{stroke:var(--blue);stroke-width:2}
.node.dim{opacity:.5}
.node:focus{outline:none}
.node:focus-visible .box{stroke:var(--blue);stroke-width:2}
.t-decide{fill:var(--yellow-bg)}.t-decide + text{fill:var(--yellow)}
.t-model{fill:var(--blue-bg)}.t-model + text{fill:var(--blue)}
.t-mcp,.t-agent{fill:var(--green-bg)}.t-mcp + text,.t-agent + text{fill:var(--green)}
.t-work,.t-code{fill:var(--plain-bg)}.t-work + text,.t-code + text{fill:var(--plain)}
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

/* ── the graph: laid out in layers from the entry, then yours to zoom, pan and rearrange ── */
var NODE_W = 190, NODE_H = 60;
/** Where you left each graph: node positions (kept in this browser, per graph hash) and the view. */
var layouts = {}, views = {};
function savedLayout(hash) {
  if (layouts[hash]) return layouts[hash];
  try { layouts[hash] = JSON.parse(localStorage.getItem("ensemble.layout." + hash) || "{}"); } catch (error) { layouts[hash] = {}; }
  return layouts[hash];
}
function keepLayout(hash) {
  try { localStorage.setItem("ensemble.layout." + hash, JSON.stringify(layouts[hash])); } catch (error) { /* a private window: it lasts until the page closes */ }
}
function forgetLayout(hash) {
  layouts[hash] = {};
  try { localStorage.removeItem("ensemble.layout." + hash); } catch (error) { /* nothing was kept */ }
}
function edgeLabel(edge) {
  if (edge.gate) return edge.gate;
  if (edge.on) return edge.on.option !== undefined ? edge.on.question + " = " + edge.on.option : edge.on.question + " " + edge.on.op + " " + edge.on.value;
  if (edge.when) return String(edge.when.source).replace(/^[^=]*=>\s*/, "").replace(/Number\(s\[?\.?"?(\w+)"?\]?\)/g, "$1").replace(/String\((\w+)\)/g, "$1").slice(0, 30);
  return "";
}
/** Every edge the graph draws: its own, plus a decide node's gate and fallback. */
function allEdges(graph) {
  var edges = graph.edges.map(function (e) { return Object.assign({}, e); });
  graph.nodes.forEach(function (node) {
    var decide = node.decide || {};
    if (decide.gate) edges.push({ id: "gate:" + node.id, from: node.id, to: decide.gate.to, gate: decide.gate.on + " under " + decide.gate.min });
    if (decide.fallback) edges.push({ id: "fallback:" + node.id, from: node.id, to: decide.fallback, gate: "no answer" });
  });
  return edges;
}
/** The starting positions: layers by longest path from the entry, loops left out of the count. */
function autoLayout(graph, edges) {
  var GX = 44, GY = 68, out = {};
  graph.nodes.forEach(function (node) { out[node.id] = []; });
  edges.forEach(function (edge) { if (out[edge.from] && out[edge.to]) out[edge.from].push(edge); });
  var state = {}, order = [], back = {};
  (function walk(id) {
    state[id] = 1;
    out[id].forEach(function (edge) {
      if (state[edge.to] === 1) back[edge.id] = true;
      else if (!state[edge.to]) walk(edge.to);
    });
    state[id] = 2;
    order.unshift(id);
  })(graph.runner.entry in out ? graph.runner.entry : graph.nodes[0].id);
  graph.nodes.forEach(function (node) { if (!state[node.id]) order.push(node.id); });
  var layer = {};
  order.forEach(function (id) {
    if (layer[id] === undefined) layer[id] = 0;
    out[id].forEach(function (edge) { if (!back[edge.id]) layer[edge.to] = Math.max(layer[edge.to] || 0, layer[id] + 1); });
  });
  var rows = [], pos = {};
  order.forEach(function (id) { (rows[layer[id]] = rows[layer[id]] || []).push(id); });
  var widest = Math.max.apply(null, rows.map(function (row) { return row.length; }));
  rows.forEach(function (row, depth) {
    var left = ((widest - row.length) * (NODE_W + GX)) / 2;
    row.forEach(function (id, index) { pos[id] = { x: left + index * (NODE_W + GX), y: depth * (NODE_H + GY) }; });
  });
  return pos;
}
function cubic(p, t) {
  var u = 1 - t;
  return {
    x: u * u * u * p[0] + 3 * u * u * t * p[2] + 3 * u * t * t * p[4] + t * t * t * p[6],
    y: u * u * u * p[1] + 3 * u * u * t * p[3] + 3 * u * t * t * p[5] + t * t * t * p[7],
  };
}
/** A curve from one node to another, chosen by where they sit, and bent round anything in between. */
function routeEdge(a, b, others) {
  var W = NODE_W, H = NODE_H, p;
  var round = function () {
    var side = Math.max(a.x, b.x) + W + 46;
    return [a.x + W, a.y + H / 2, side, a.y + H / 2, side, b.y + H / 2, b.x + W, b.y + H / 2];
  };
  if (b.y >= a.y + H + 12) {
    var mid = (a.y + H + b.y) / 2;
    p = [a.x + W / 2, a.y + H, a.x + W / 2, mid, b.x + W / 2, mid, b.x + W / 2, b.y];
  } else if (b.y + H + 12 <= a.y) {
    if (Math.abs(b.x - a.x) < W * 0.8) return round();
    // Up and across: leave from the side that faces the target, so it does not start where another edge arrives.
    var sx = b.x > a.x ? a.x + W : a.x, lean = b.x > a.x ? 60 : -60;
    p = [sx, a.y + H / 2, sx + lean, a.y + H / 2, b.x + W / 2, b.y + H + 60, b.x + W / 2, b.y + H];
  } else if (b.x >= a.x) {
    var across = (a.x + W + b.x) / 2;
    p = [a.x + W, a.y + H / 2, across, a.y + H / 2, across, b.y + H / 2, b.x, b.y + H / 2];
  } else {
    var over = (b.x + W + a.x) / 2;
    p = [a.x, a.y + H / 2, over, a.y + H / 2, over, b.y + H / 2, b.x + W, b.y + H / 2];
  }
  for (var t = 0.15; t < 0.9; t += 0.07) {
    var at = cubic(p, t);
    for (var i = 0; i < others.length; i++) {
      var o = others[i];
      if (at.x > o.x - 6 && at.x < o.x + W + 6 && at.y > o.y - 6 && at.y < o.y + H + 6) return round();
    }
  }
  return p;
}
function graphCanvas(graph, run, selected, onSelect) {
  var hash = graph.runner.hash, edges = allEdges(graph);
  var auto = autoLayout(graph, edges), moved = savedLayout(hash), pos = {};
  graph.nodes.forEach(function (node) { pos[node.id] = moved[node.id] ? { x: moved[node.id].x, y: moved[node.id].y } : auto[node.id]; });

  var took = {}, seen = {}, failed = null, now = {};
  ((run && run.steps) || []).forEach(function (step) {
    seen[step.node] = true;
    if (step.error) failed = step.node;
    if (step.took === "gate" || step.took === "fallback") took[step.took + ":" + step.node] = true;
    else if (step.took) took[step.took] = true;
    (step.forked || []).forEach(function (id) { took[id] = true; });
  });
  ((run && run.running) || []).forEach(function (id) { now[id] = true; });

  function bounds() {
    var xs = graph.nodes.map(function (n) { return pos[n.id].x; }), ys = graph.nodes.map(function (n) { return pos[n.id].y; });
    return { x: Math.min.apply(null, xs), y: Math.min.apply(null, ys), w: Math.max.apply(null, xs) + NODE_W - Math.min.apply(null, xs), h: Math.max.apply(null, ys) + NODE_H - Math.min.apply(null, ys) };
  }
  var first = bounds();
  var height = Math.max(340, Math.min(640, first.h + 120));
  var root = svg("svg", { height: height, role: "img", "aria-label": "The graph of " + graph.runner.name + ". Drag a node to move it, drag the background to pan." });
  root.appendChild(svg("defs", {}, svg("marker", { id: "arrow", viewBox: "0 0 10 10", refX: 9, refY: 5, markerWidth: 6.5, markerHeight: 6.5, orient: "auto-start-reverse" }, svg("path", { d: "M0 0.8L10 5L0 9.2z", fill: "context-stroke" }))));
  var world = svg("g", {});
  root.appendChild(world);
  var readout = el("output", {}, "100%");
  var view = views[hash];

  function place() {
    world.setAttribute("transform", "translate(" + view.tx + "," + view.ty + ") scale(" + view.k + ")");
    readout.textContent = Math.round(view.k * 100) + "%";
    views[hash] = view;
  }
  function fit() {
    var box = bounds(), width = root.clientWidth || 900, pad = 56;
    var k = Math.min(1, (width - pad * 2) / (box.w + 60), (height - pad * 2) / box.h);
    k = Math.max(0.3, k);
    view = { k: k, tx: (width - box.w * k) / 2 - box.x * k, ty: (height - box.h * k) / 2 - box.y * k };
    place();
  }
  function zoomAt(factor, x, y) {
    var k = Math.max(0.25, Math.min(2.5, view.k * factor));
    view = { k: k, tx: x - ((x - view.tx) * k) / view.k, ty: y - ((y - view.ty) * k) / view.k };
    place();
  }

  function paint() {
    var kids = [];
    edges.forEach(function (edge) {
      var a = pos[edge.from], b = pos[edge.to];
      if (!a || !b) return;
      var others = graph.nodes.filter(function (n) { return n.id !== edge.from && n.id !== edge.to; }).map(function (n) { return pos[n.id]; });
      var p = routeEdge(a, b, others);
      var cls = "edge" + (took[edge.id] ? " took" : "") + (edge.gate ? " gate" : "");
      kids.push(svg("path", { d: "M" + p[0] + " " + p[1] + " C" + p[2] + " " + p[3] + " " + p[4] + " " + p[5] + " " + p[6] + " " + p[7], class: cls, "marker-end": "url(#arrow)" }));
      var text = edgeLabel(edge);
      if (text) {
        // Past the middle, towards where the edge arrives, so edges that fan out keep their labels apart.
        var at = cubic(p, 0.6), w = text.length * 6.4 + 14;
        kids.push(svg("rect", { x: at.x - w / 2, y: at.y - 9, width: w, height: 18, rx: 4, class: "chip" }));
        kids.push(svg("text", { x: at.x, y: at.y + 3.5, "text-anchor": "middle", class: "lab" + (took[edge.id] ? " took" : "") }, text));
      }
    });
    graph.nodes.forEach(function (node) {
      var p = pos[node.id];
      var stateClass = now[node.id] ? " now" : failed === node.id ? " failed" : seen[node.id] ? " seen" : run ? " dim" : "";
      var person = node.kind === "decide" && node.decide.by === "human";
      var tag = person ? "person" : node.kind;
      var sub = node.kind === "decide" ? node.decide.questions.map(function (q) { return q.key; }).join(", ")
        : node.kind === "model" ? (node.model.id || "from " + node.model.from)
        : node.kind === "work" ? node.work.handler
        : node.kind === "mcp" ? node.mcp.server + (node.mcp.tool ? " / " + node.mcp.tool : "")
        : node.kind === "agent" ? node.agent.name
        : "inline";
      var tagWidth = tag.length * 6.1 + 12;
      kids.push(svg("g", { class: "node" + stateClass + (selected === node.id ? " sel" : ""), transform: "translate(" + p.x + "," + p.y + ")", "data-id": node.id, tabindex: 0, role: "button", "aria-label": node.id + ", " + tag }, [
        svg("rect", { class: "box", width: NODE_W, height: NODE_H, rx: 8 }),
        svg("rect", { class: "t-" + node.kind, x: 10, y: 9, width: tagWidth, height: 15, rx: 7.5 }),
        svg("text", { class: "tag", x: 10 + tagWidth / 2, y: 19.6, "text-anchor": "middle" }, tag),
        svg("text", { x: 11, y: 40 }, (node.label || node.id).slice(0, 24)),
        svg("text", { class: "sub", x: 11, y: 53 }, String(sub).length > 25 ? String(sub).slice(0, 24) + "…" : String(sub)),
      ]));
    });
    world.replaceChildren.apply(world, kids);
  }

  /* One set of pointer handlers on the canvas: the nodes are redrawn as they move, so they cannot hold the pointer themselves. */
  var grab = null;
  root.addEventListener("pointerdown", function (event) {
    if (event.button !== 0) return;
    var target = event.target.closest ? event.target.closest("[data-id]") : null;
    grab = { id: target ? target.getAttribute("data-id") : null, x: event.clientX, y: event.clientY, far: false };
    if (grab.id) grab.from = { x: pos[grab.id].x, y: pos[grab.id].y };
    else { grab.from = { x: view.tx, y: view.ty }; root.classList.add("panning"); }
    root.setPointerCapture(event.pointerId);
  });
  root.addEventListener("pointermove", function (event) {
    if (!grab) return;
    var dx = event.clientX - grab.x, dy = event.clientY - grab.y;
    if (!grab.far && Math.abs(dx) + Math.abs(dy) < 4) return;
    grab.far = true;
    if (grab.id) {
      pos[grab.id] = { x: Math.round(grab.from.x + dx / view.k), y: Math.round(grab.from.y + dy / view.k) };
      paint();
    } else {
      view = { k: view.k, tx: grab.from.x + dx, ty: grab.from.y + dy };
      place();
    }
  });
  var release = function () {
    if (!grab) return;
    root.classList.remove("panning");
    if (grab.id && grab.far) {
      layouts[hash][grab.id] = pos[grab.id];
      keepLayout(hash);
    } else if (grab.id) onSelect(selected === grab.id ? null : grab.id);
    grab = null;
  };
  root.addEventListener("pointerup", release);
  root.addEventListener("pointercancel", release);
  // A pinch, or a scroll with Ctrl or Cmd held, zooms about the pointer. A plain scroll still scrolls the page.
  root.addEventListener("wheel", function (event) {
    if (!event.ctrlKey && !event.metaKey) return;
    event.preventDefault();
    var box = root.getBoundingClientRect();
    zoomAt(Math.exp(-event.deltaY * 0.01), event.clientX - box.left, event.clientY - box.top);
  }, { passive: false });
  root.addEventListener("keydown", function (event) {
    var target = event.target.closest ? event.target.closest("[data-id]") : null;
    if (!target) return;
    var id = target.getAttribute("data-id"), step = event.shiftKey ? 40 : 10;
    var by = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[event.key];
    if (by) {
      event.preventDefault();
      pos[id] = { x: pos[id].x + by[0], y: pos[id].y + by[1] };
      layouts[hash][id] = pos[id];
      keepLayout(hash);
      paint();
      var again = world.querySelector('[data-id="' + id.replace(/"/g, "") + '"]');
      if (again) again.focus();
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onSelect(selected === id ? null : id);
    }
  });

  var centre = function (factor) { return function () { zoomAt(factor, (root.clientWidth || 900) / 2, height / 2); }; };
  var tools = el("div", { class: "tools" }, [
    readout,
    el("button", { type: "button", "aria-label": "Zoom out", on: centre(1 / 1.25) }, "−"),
    el("button", { type: "button", "aria-label": "Zoom in", on: centre(1.25) }, "+"),
    el("button", { type: "button", on: fit }, "Fit"),
    el("button", { type: "button", title: "Put every node back where the layout placed it", on: function () { forgetLayout(hash); pos = {}; graph.nodes.forEach(function (node) { pos[node.id] = auto[node.id]; }); paint(); fit(); } }, "Reset"),
  ]);

  paint();
  if (view) place();
  else { view = { k: 1, tx: 40, ty: 40 }; place(); requestAnimationFrame(fit); }
  return el("div", {}, [
    el("div", { class: "canvas" }, [root, tools]),
    el("div", { class: "hint" }, [
      el("span", {}, "Drag a node to move it"),
      el("span", {}, "Drag the background to pan"),
      el("span", {}, [el("kbd", {}, "Ctrl"), " or ", el("kbd", {}, "Cmd"), " + scroll, or pinch, to zoom"]),
      el("span", {}, "Your arrangement is kept in this browser"),
    ]),
  ]);
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
      el("div", { class: "card" }, [el("h2", {}, run ? "Path" : "Graph"), note ? el("p", { class: "muted" }, note) : null, graphCanvas(graph, run, selected, function (id) { selected = id; render(); })]),
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
        el("h1", {}, [el("a", { href: "#/runners/" + encodeURIComponent(run.runner) }, run.runner), el("span", { class: "muted", style: "font:400 15px var(--sans);letter-spacing:0" }, "v" + run.version), pill(run.status)]),
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
