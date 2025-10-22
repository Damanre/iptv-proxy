import http from "http";
import https from "https";
import httpProxy from "http-proxy";
import { URL } from "url";

// ====== ENV ======
const TARGET = process.env.TARGET || "http://45.158.254.11";
const PORT = parseInt(process.env.PORT || "10000", 10);
const MAX_CONCURRENT = parseInt(process.env.MAX_CONCURRENT || "100", 10);  // techo prudente

// ====== Agentes keep-alive ======
const agentHttp  = new http.Agent({  keepAlive: true, maxSockets: 100 });
const agentHttps = new https.Agent({ keepAlive: true, maxSockets: 100 });
const upstreamIsHttps = new URL(TARGET).protocol === "https:";

// ====== Proxy ======
const proxy = httpProxy.createProxyServer({
  target: TARGET,
  changeOrigin: true,
  xfwd: true,
  ws: true,
  secure: false,
  agent: upstreamIsHttps ? agentHttps : agentHttp
});

// ====== Métricas ======
let currentConnections = 0;
let totalConnections = 0;
let totalErrors = 0;

let totalBytesOut = 0; // bytes enviados al cliente
let totalBytesIn  = 0; // bytes recibidos del cliente (poco en GET)
let lastSecondBytesOut = 0;
let ewmaBps = 0;                // bytes/segundo (EWMA ~60s)
const EWMA_ALPHA = 2 / (60 + 1);

// latencias de peticiones completadas (ms)
const lastLatencies = [];   // se recorta a 5000 muestras
const LAT_STORE_MAX = 5000;

// requests activos: id -> {start, bytesOut}
const active = new Map();
let reqSeq = 0;

// tick EWMA
setInterval(() => {
  ewmaBps = ewmaBps + EWMA_ALPHA * (lastSecondBytesOut - ewmaBps);
  lastSecondBytesOut = 0;
}, 1000);

// util latencias
function pushLatency(ms) {
  lastLatencies.push(ms);
  if (lastLatencies.length > LAT_STORE_MAX) lastLatencies.splice(0, lastLatencies.length - LAT_STORE_MAX);
}
function quantile(arr, q) {
  if (!arr.length) return 0;
  const a = [...arr].sort((x,y)=>x-y);
  const idx = Math.min(a.length - 1, Math.max(0, Math.floor(q * (a.length - 1))));
  return a[idx];
}

// ====== Hooks proxy ======
proxy.on("proxyRes", (proxyRes, req, res) => {
  try { res.setHeader("X-Accel-Buffering", "no"); } catch {}
  // contar bytes que vienen del upstream y salen al cliente
  proxyRes.on("data", (chunk) => {
    const len = chunk?.length || 0;
    totalBytesOut += len;
    lastSecondBytesOut += len;
    const id = res.__reqId;
    if (id && active.has(id)) {
      active.get(id).bytesOut += len;
    }
  });
});
proxy.on("error", (err, req, res) => {
  totalErrors++;
  if (res && !res.headersSent) res.writeHead(502, { "Content-Type": "text/plain" });
  try { res.end("Proxy error"); } catch {}
  // cerrar request activo
  const id = res?.__reqId;
  if (id && active.has(id)) {
    active.delete(id);
    currentConnections = Math.max(0, currentConnections - 1);
  }
});

// ====== Servidor HTTP ======
const server = http.createServer((req, res) => {
  // /healthz
  if (req.url === "/healthz") { res.writeHead(200); return res.end("ok"); }

  // /stats: métricas en JSON
  if (req.url === "/stats") {
    const m = process.memoryUsage();
    const detail = {};
    for (const [id, s] of active) {
      detail[id] = {
        secs: Math.round((Date.now() - s.start)/1000),
        kb_out: Math.round(s.bytesOut/1024)
      };
    }
    const p50 = quantile(lastLatencies, 0.50);
    const p90 = quantile(lastLatencies, 0.90);
    const p99 = quantile(lastLatencies, 0.99);
    const body = JSON.stringify({
      target: TARGET,
      uptime_s: Math.round(process.uptime()),
      rss_mb: Math.round(m.rss/1024/1024),
      heapUsed_mb: Math.round(m.heapUsed/1024/1024),
      currentConnections,
      totalConnections,
      totalErrors,
      max_concurrent_limit: MAX_CONCURRENT,
      traffic: {
        total_bytes_out: totalBytesOut,
        total_bytes_in: totalBytesIn,
        ewma_bps: Math.round(ewmaBps),
        ewma_mbps: +((ewmaBps*8)/1e6).toFixed(3)
      },
      latency_ms: { p50, p90, p99, samples: lastLatencies.length },
      active_requests: detail
    });
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(body);
  }

  // Límite global para no “caer”
  if (currentConnections >= MAX_CONCURRENT) {
    res.writeHead(503, { "Retry-After":"2", "Content-Type":"text/plain" });
    return res.end("Server busy, retry");
  }

  // IMPORTANTE: stream puro
  req.socket.setNoDelay(true);

  // tracking de esta request
  const id = ++reqSeq;
  const started = Date.now();
  res.__reqId = id;
  active.set(id, { start: started, bytesOut: 0 });
  currentConnections++;
  totalConnections++;

  // contar bytes que recibimos del cliente (normalmente 0 en GET)
  req.on("data", (chunk) => { totalBytesIn += (chunk?.length || 0); });

  // limpieza/latencia al terminar
  const finish = () => {
    const dur = Date.now() - started;
    pushLatency(dur);
    if (active.has(id)) active.delete(id);
    currentConnections = Math.max(0, currentConnections - 1);
  };
  res.on("close", finish);
  res.on("finish", finish);
  res.on("error", finish);
  req.on("aborted", finish);
  req.on("error", finish);

  // Cabecera anti-buffering (opcional)
  try { res.setHeader("X-Accel-Buffering", "no"); } catch {}

  // Proxy tal cual
  proxy.web(req, res, { target: TARGET });
});

// Conexiones vivas pero con límites
server.keepAliveTimeout = 65000;
server.headersTimeout   = 70000;

server.listen(PORT, () => {
  console.log(`DIPETV proxy escuchando en ${PORT} → ${TARGET} | MAX_CONCURRENT=${MAX_CONCURRENT}`);
});
