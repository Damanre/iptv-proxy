// server.js — Proxy “VPN-like” con follow-redirects en /live y métricas
import http from "http";
import https from "https";
import httpProxy from "http-proxy";
import { URL } from "url";

// ====== ENV ======
const TARGET = process.env.TARGET || "http://45.158.254.11";
const PORT = parseInt(process.env.PORT || "10000", 10);
const MAX_CONCURRENT = parseInt(process.env.MAX_CONCURRENT || "100", 10);
const REQUEST_TIMEOUT_MS = parseInt(process.env.REQUEST_TIMEOUT_MS || "60000", 10);

// ====== Agentes keep-alive ======
const agentHttp  = new http.Agent({  keepAlive: true, maxSockets: 100, maxFreeSockets: 10 });
const agentHttps = new https.Agent({ keepAlive: true, maxSockets: 100, maxFreeSockets: 10 });
const upstreamIsHttps = new URL(TARGET).protocol === "https:";

// ====== Proxy para rutas NO /live ======
const proxy = httpProxy.createProxyServer({
  target: TARGET,
  changeOrigin: true,
  xfwd: true,
  ws: false,
  secure: false,
  agent: upstreamIsHttps ? agentHttps : agentHttp,
  timeout: REQUEST_TIMEOUT_MS,
  proxyTimeout: REQUEST_TIMEOUT_MS
});
proxy.on("proxyRes", (_pr, _req, res) => { try{ res.setHeader("X-Accel-Buffering","no"); }catch{} });
proxy.on("error", (_err, _req, res) => {
  if (res && !res.headersSent) res.writeHead(502, { "Content-Type":"text/plain", "X-Proxy-Error":"proxy" });
  try{ res.end("Proxy error"); }catch{}
});

// ====== Métricas ======
let currentConnections = 0, totalConnections = 0, totalErrors = 0;
let totalBytesOut = 0, totalBytesIn = 0, lastSecondBytesOut = 0;
let ewmaBps = 0; const EWMA_ALPHA = 2/(60+1);
const lastLatencies = []; const LAT_STORE_MAX = 5000;
const active = new Map(); let reqSeq = 0;
setInterval(()=>{ ewmaBps = ewmaBps + EWMA_ALPHA*(lastSecondBytesOut - ewmaBps); lastSecondBytesOut = 0; },1000);
function pushLatency(ms){ lastLatencies.push(ms); if(lastLatencies.length>LAT_STORE_MAX) lastLatencies.splice(0,lastLatencies.length-LAT_STORE_MAX); }
function q(arr,p){ if(!arr.length) return 0; const a=[...arr].sort((x,y)=>x-y); const i=Math.min(a.length-1,Math.max(0,Math.floor(p*(a.length-1)))); return a[i]; }
function isLivePath(u){ return /^\/live\/[^/]+\/[^/]+\//.test(u); }
function buildOpts(req, urlStr){
  const u = new URL(urlStr);
  return {
    protocol: u.protocol, hostname: u.hostname, port: u.port || (u.protocol==="https:"?443:80),
    method: req.method, path: u.pathname + u.search,
    headers: {
      ...req.headers,
      host: u.host,
      connection: "keep-alive",
      "user-agent": "VLC/3.0.18 LibVLC/3.0.18",
      "accept": "*/*",
      "accept-encoding": "identity"
    },
    agent: u.protocol==="https:"?agentHttps:agentHttp,
    timeout: REQUEST_TIMEOUT_MS
  };
}

// === fetch con follow-redirects (para /live) ===
function fetchFollow({ initialUrl, req, res, cleanup, maxRedirects=5 }){
  let currentUrl = initialUrl;
  const start = Date.now();

  const go = (urlStr, redirectsLeft) => {
    const opts = buildOpts(req, urlStr);
    if (req.headers.range) opts.headers.range = req.headers.range;

    const client = opts.protocol==="https:"?https:http;
    const upReq = client.request(opts, (upRes) => {
      const sc = upRes.statusCode || 200;

      // redirecciones
      if ([301,302,303,307,308].includes(sc) && redirectsLeft>0) {
        const loc = upRes.headers.location;
        upRes.resume();
        if (!loc) { try{ res.writeHead(sc, upRes.headers); }catch{}; try{ res.end(); }catch{}; return cleanup(); }
        const next = new URL(loc, new URL(urlStr));
        return go(next.toString(), redirectsLeft-1);
      }

      // cabeceras “VLC friendly” si faltan
      const headers = { ...upRes.headers };
      if (!headers["content-type"]) headers["content-type"] = "video/mp2t";
      headers["accept-ranges"] = headers["accept-ranges"] || "bytes";
      headers["cache-control"] = headers["cache-control"] || "no-store, no-transform";
      headers["connection"] = headers["connection"] || "keep-alive";
      headers["x-upstream-status"] = String(sc);
      try { res.writeHead(sc, headers); } catch {}

      upRes.on("data", (chunk) => {
        const len = chunk?.length || 0;
        totalBytesOut += len; lastSecondBytesOut += len;
        try { res.write(chunk); } catch {}
      });
      upRes.on("end", () => {
        try { res.end(); } catch {}
        pushLatency(Date.now()-start);
        cleanup();
      });
    });

    upReq.on("timeout", ()=>{ try{ upReq.destroy(new Error("upstream timeout")); }catch{} });
    upReq.on("error", ()=> {
      totalErrors++;
      if (!res.headersSent) { try{ res.writeHead(502, { "Content-Type":"text/plain","X-Proxy-Error":"upstream" }); }catch{} }
      try{ res.end("Upstream error"); }catch{}
      pushLatency(Date.now()-start);
      cleanup();
    });

    // consumir (casi nunca hay body en GET)
    req.on("data",(c)=>{ totalBytesIn += (c?.length||0); });
    req.on("end", ()=>{ try{ upReq.end(); }catch{} });
  };

  go(currentUrl, maxRedirects);
}

// ====== Servidor HTTP ======
const server = http.createServer((req, res) => {
  // endpoints utilitarios
  if (req.url === "/healthz") { res.writeHead(200); return res.end("ok"); }
  if (req.url === "/stats") {
    const m = process.memoryUsage();
    const body = JSON.stringify({
      target: TARGET,
      uptime_s: Math.round(process.uptime()),
      rss_mb: Math.round(m.rss/1024/1024),
      heapUsed_mb: Math.round(m.heapUsed/1024/1024),
      currentConnections, totalConnections, totalErrors,
      max_concurrent_limit: MAX_CONCURRENT,
      traffic: { total_bytes_out: totalBytesOut, total_bytes_in: totalBytesIn, ewma_bps: Math.round(ewmaBps), ewma_mbps: +((ewmaBps*8)/1e6).toFixed(3) },
      latency_ms: { p50: q(lastLatencies,0.50), p90: q(lastLatencies,0.90), p99: q(lastLatencies,0.99), samples: lastLatencies.length },
      active_requests: Object.fromEntries([...active.entries()].map(([id,s])=>[id,{secs:Math.round((Date.now()-s.start)/1000),kb_out:Math.round(s.bytesOut/1024)}]))
    });
    res.writeHead(200, { "Content-Type":"application/json" });
    return res.end(body);
  }

  // límite global
  if (currentConnections >= MAX_CONCURRENT) {
    res.writeHead(503, { "Retry-After":"2", "Content-Type":"text/plain", "X-Proxy-Error":"limit" });
    return res.end("Server busy, retry");
  }

  req.socket.setNoDelay(true);
  const id = ++reqSeq; const started = Date.now();
  active.set(id, { start: started, bytesOut: 0 });
  currentConnections++; totalConnections++;

  const finish = () => {
    const s = active.get(id);
    if (s) active.delete(id);
    currentConnections = Math.max(0, currentConnections - 1);
    pushLatency(Date.now()-started);
  };
  res.on("close", finish); res.on("finish", finish); res.on("error", finish);
  req.on("aborted", finish); req.on("error", finish);

  try{ res.setHeader("X-Accel-Buffering","no"); }catch{}

  // /live/** → seguir redirecciones y servir bytes (VPN egress real)
  if (isLivePath(req.url)) {
    const upstreamUrl = new URL(req.url, TARGET).toString();
    fetchFollow({ initialUrl: upstreamUrl, req, res, cleanup: finish, maxRedirects: 5 });
    return;
  }

  // resto → proxy transparente
  proxy.web(req, res, { target: TARGET });
});

// timeouts servidor
server.keepAliveTimeout = 65000;
server.headersTimeout   = 70000;
server.requestTimeout   = REQUEST_TIMEOUT_MS;

server.listen(PORT, () => {
  console.log(`DIPETV proxy on ${PORT} → ${TARGET} | MAX=${MAX_CONCURRENT}`);
});
