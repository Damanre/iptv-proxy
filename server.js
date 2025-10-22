// server.js — DIPETV proxy estable (con cleanup garantizado)
import http from "http";
import https from "https";
import httpProxy from "http-proxy";

const TARGET = process.env.TARGET || "http://45.158.254.11";
const PORT = parseInt(process.env.PORT || "10000", 10);

// Límites (ajústalos por ENV en Render)
const MAX_CONCURRENT      = parseInt(process.env.MAX_CONCURRENT      || "20", 10);
const AGENT_MAX_SOCKETS   = parseInt(process.env.AGENT_MAX_SOCKETS   || "16", 10);
const REQUEST_TIMEOUT_MS  = parseInt(process.env.REQUEST_TIMEOUT_MS  || "15000", 10);
const IDLE_SOCKET_MS      = parseInt(process.env.IDLE_SOCKET_MS      || "10000", 10);
const PER_USER_MAX        = parseInt(process.env.PER_USER_MAX        || "1", 10); // 1 stream por usuario

// Agentes keep-alive con límites y timeouts
const commonAgentOpts = { keepAlive: true, maxSockets: AGENT_MAX_SOCKETS, maxFreeSockets: 10 };
const agentHttp  = new http.Agent({  ...commonAgentOpts });
const agentHttps = new https.Agent({ ...commonAgentOpts });

const proxy = httpProxy.createProxyServer({
  target: TARGET,
  changeOrigin: true,
  xfwd: true,
  ws: true,
  secure: false,
  agent: TARGET.startsWith("https") ? agentHttps : agentHttp,
  timeout: REQUEST_TIMEOUT_MS,     // tiempo esperando headers desde upstream
  proxyTimeout: REQUEST_TIMEOUT_MS // inactividad de datos desde upstream
});

// Métricas básicas
let currentConnections = 0;
let totalConnections   = 0;

// Control por usuario (evita 2 streams con la misma cuenta)
const activeByUser = new Map();

// Utilidad: cleanup garantizado por request (solo se ejecuta una vez)
function onceCleanup(fn) {
  let done = false;
  return () => { if (!done) { done = true; try { fn(); } catch {} } };
}

proxy.on("proxyRes", (proxyRes, req, res) => {
  res.setHeader("X-Accel-Buffering", "no");
  // corta si upstream se queda mudo
  res.setTimeout(REQUEST_TIMEOUT_MS, () => { try { res.destroy(); } catch {} });
});

proxy.on("error", (err, req, res) => {
  if (res && !res.headersSent) {
    try { res.writeHead(502, { "Content-Type": "text/plain" }); } catch {}
  }
  try { res.end("Proxy error"); } catch {}
});

const server = http.createServer((req, res) => {
  // Endpoints ligeros
  if (req.url === "/healthz") { res.writeHead(200); return res.end("ok"); }
  if (req.url === "/stats") {
    const m = process.memoryUsage();
    const out = {
      uptime_s: Math.round(process.uptime()),
      rss_mb: Math.round(m.rss/1024/1024),
      heapUsed_mb: Math.round(m.heapUsed/1024/1024),
      currentConnections,
      totalConnections
    };
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify(out));
  }

  // Límite global (mejor 503 que colgarse)
  if (currentConnections >= MAX_CONCURRENT) {
    res.writeHead(503, { "Retry-After": "2", "Content-Type": "text/plain" });
    return res.end("Server busy, retry");
  }

  // Límite por usuario: /live/{user}/{pass}/...
  let userKey = null;
  const m = req.url.match(/^\/live\/([^/]+)\/([^/]+)\//);
  if (m) {
    userKey = m[1]; // username
    const now = (activeByUser.get(userKey) || 0);
    if (now >= PER_USER_MAX) {
      res.writeHead(429, { "Retry-After": "1", "Content-Type": "text/plain" });
      return res.end("Too many streams for this user");
    }
    activeByUser.set(userKey, now + 1);
  }

  // Contabilizar conexión activa
  currentConnections++;
  totalConnections++;

  // Cleanup único para esta request
  const cleanup = onceCleanup(() => {
    currentConnections = Math.max(0, currentConnections - 1);
    if (userKey) {
      const v = (activeByUser.get(userKey) || 1) - 1;
      if (v <= 0) activeByUser.delete(userKey); else activeByUser.set(userKey, v);
    }
  });

  // Timeouts en sockets entrantes/salientes
  req.socket.setNoDelay(true);
  req.socket.setTimeout(IDLE_SOCKET_MS, () => { try { req.destroy(); } catch {} });

  res.setTimeout(REQUEST_TIMEOUT_MS, () => { try { res.destroy(); } catch {} });

  // Si el cliente aborta o hay error → cleanup
  req.on("aborted", cleanup);
  req.on("close",   cleanup);
  req.on("error",   cleanup);
  res.on("finish",  cleanup);
  res.on("close",   cleanup);
  res.on("error",   cleanup);

  // También limpiar si el proxy falla (MUY IMPORTANTE)
  const onProxyError = () => cleanup();
  proxy.once("error", onProxyError);

  // Hacer el proxy
  proxy.web(req, res, { target: TARGET }, () => {
    // manejado por proxy.on('error'), pero aseguramos cleanup
    cleanup();
  });
});

server.keepAliveTimeout = 10000;
server.headersTimeout   = 12000;
server.requestTimeout   = REQUEST_TIMEOUT_MS; // Node 18+: timeout total de request

server.on("connection", (socket) => {
  socket.setTimeout(IDLE_SOCKET_MS, () => { try { socket.destroy(); } catch {} });
});

server.listen(PORT, () => {
  console.log(`DIPETV proxy → ${TARGET} | PORT=${PORT} | MAX=${MAX_CONCURRENT} | AGENT=${AGENT_MAX_SOCKETS}`);
});
