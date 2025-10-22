// server.js — DIPETV proxy estable con caché de API y limpieza garantizada
import http from "http";
import https from "https";
import { URL } from "url";
import httpProxy from "http-proxy";

// ======== Config por ENV (Render → Environment) ========
const TARGET              = process.env.TARGET || "http://45.158.254.11";
const PORT                = parseInt(process.env.PORT || "10000", 10);
const MAX_CONCURRENT      = parseInt(process.env.MAX_CONCURRENT || "20", 10);  // conexiones totales permitidas
const AGENT_MAX_SOCKETS   = parseInt(process.env.AGENT_MAX_SOCKETS || "16", 10);
const REQUEST_TIMEOUT_MS  = parseInt(process.env.REQUEST_TIMEOUT_MS || "15000", 10);
const IDLE_SOCKET_MS      = parseInt(process.env.IDLE_SOCKET_MS || "10000", 10);
const PER_USER_MAX        = parseInt(process.env.PER_USER_MAX || "1", 10);     // 1 stream por usuario
const API_TTL_MS          = parseInt(process.env.API_TTL_MS || "60000", 10);   // TTL caché player_api (ms)
const API_MAX_BYTES       = parseInt(process.env.API_MAX_BYTES || (1024 * 1024).toString(), 10); // máx 1MB

// ======== Agentes keep-alive ========
const commonAgentOpts = { keepAlive: true, maxSockets: AGENT_MAX_SOCKETS, maxFreeSockets: 10 };
const agentHttp  = new http.Agent(commonAgentOpts);
const agentHttps = new https.Agent(commonAgentOpts);
const targetUrl  = new URL(TARGET);
const upstreamIsHttps = targetUrl.protocol === "https:";

// ======== Proxy para todo lo que no sea player_api ========
const proxy = httpProxy.createProxyServer({
  target: TARGET,
  changeOrigin: true,
  xfwd: true,
  ws: true,
  secure: false,
  agent: upstreamIsHttps ? agentHttps : agentHttp,
  timeout: REQUEST_TIMEOUT_MS,     // esperando cabeceras
  proxyTimeout: REQUEST_TIMEOUT_MS // inactividad de datos
});

// ======== Métricas básicas ========
let currentConnections = 0;
let totalConnections   = 0;

// Por-usuario activos en /live/{user}/{pass}/...
const activeByUser = new Map();

// ======== Caché muy simple para player_api.php ========
const apiCache = new Map(); // key: req.url → { body: Buffer, status, headers, t }

// ======== Helpers ========
function once(fn) {
  let called = false;
  return () => { if (!called) { called = true; try { fn(); } catch {} } };
}
function isApi(req) {
  return req.method === "GET" && req.url.startsWith("/player_api.php?");
}
function buildUpstreamOptions(req) {
  // Construye request al upstream conservando path+query
  const url = new URL(req.url, TARGET);
  const opts = {
    protocol: url.protocol,
    hostname: url.hostname,
    port: url.port || (url.protocol === "https:" ? 443 : 80),
    method: req.method,
    path: url.pathname + url.search,
    headers: {
      ...req.headers,
      host: url.host,
      connection: "keep-alive",
      "x-forwarded-for": req.socket.remoteAddress,
      "x-forwarded-proto": "https",
    },
    agent: url.protocol === "https:" ? agentHttps : agentHttp,
    timeout: REQUEST_TIMEOUT_MS
  };
  return opts;
}

// ======== Proxy events ========
proxy.on("proxyRes", (proxyRes, req, res) => {
  try { res.setHeader("X-Accel-Buffering", "no"); } catch {}
  res.setTimeout(REQUEST_TIMEOUT_MS, () => { try { res.destroy(); } catch {} });
});
proxy.on("error", (err, req, res) => {
  if (res && !res.headersSent) {
    try { res.writeHead(502, { "Content-Type": "text/plain" }); } catch {}
  }
  try { res.end("Proxy error"); } catch {}
});

// ======== Servidor HTTP ========
const server = http.createServer((req, res) => {
  // Endpoints ligeros
  if (req.url === "/healthz") { res.writeHead(200); return res.end("ok"); }
  if (req.url === "/stats") {
    const m = process.memoryUsage();
    const body = JSON.stringify({
      uptime_s: Math.round(process.uptime()),
      rss_mb: Math.round(m.rss/1024/1024),
      heapUsed_mb: Math.round(m.heapUsed/1024/1024),
      currentConnections,
      totalConnections
    });
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(body);
  }

  // Límite global: mejor 503 que colgarse
  if (currentConnections >= MAX_CONCURRENT) {
    res.writeHead(503, { "Retry-After": "2", "Content-Type": "text/plain" });
    return res.end("Server busy, retry");
  }

  // Límite por usuario solo en /live/{user}/{pass}/...
  let userKey = null;
  const liveMatch = req.url.match(/^\/live\/([^/]+)\/([^/]+)\//);
  if (liveMatch) {
    userKey = liveMatch[1];
    const now = activeByUser.get(userKey) || 0;
    if (now >= PER_USER_MAX) {
      res.writeHead(429, { "Retry-After": "1", "Content-Type": "text/plain" });
      return res.end("Too many streams for this user");
    }
    activeByUser.set(userKey, now + 1);
  }

  // Contadores
  currentConnections++;
  totalConnections++;
  const cleanup = once(() => {
    currentConnections = Math.max(0, currentConnections - 1);
    if (userKey) {
      const v = (activeByUser.get(userKey) || 1) - 1;
      if (v <= 0) activeByUser.delete(userKey); else activeByUser.set(userKey, v);
    }
  });

  // Timeouts en sockets de entrada
  req.socket.setNoDelay(true);
  req.socket.setTimeout(IDLE_SOCKET_MS, () => { try { req.destroy(); } catch {} });
  res.setTimeout(REQUEST_TIMEOUT_MS, () => { try { res.destroy(); } catch {} });

  // Limpieza garantizada pase lo que pase
  req.on("aborted", cleanup);
  req.on("close",   cleanup);
  req.on("error",   cleanup);
  res.on("finish",  cleanup);
  res.on("close",   cleanup);
  res.on("error",   cleanup);

  // ------------- Rama player_api: ir directo al upstream con caché -------------
  if (isApi(req)) {
    try { res.setHeader("X-Accel-Buffering", "no"); } catch {}

    // Sirve desde caché si válido
    const hit = apiCache.get(req.url);
    const now = Date.now();
    if (hit && (now - hit.t) < API_TTL_MS) {
      try {
        res.writeHead(hit.status, hit.headers || { "Content-Type": "application/json" });
        res.end(hit.body);
      } finally {
        cleanup();
      }
      return;
    }

    // Petición manual al upstream
    const opts = buildUpstreamOptions(req);
    const client = opts.protocol === "https:" ? https : http;
    const upReq = client.request(opts, (upRes) => {
      // Clonar cabeceras mínimas y enviar al cliente
      const headers = { ...upRes.headers };
      try { res.writeHead(upRes.statusCode || 200, headers); } catch {}

      // Bufferizar hasta API_MAX_BYTES para cache
      let buf = Buffer.alloc(0);
      upRes.on("data", (chunk) => {
        try { res.write(chunk); } catch {}
        if (buf.length + chunk.length <= API_MAX_BYTES) {
          buf = Buffer.concat([buf, chunk]);
        }
      });
      upRes.on("end", () => {
        try { res.end(); } catch {}
        // Guardar en caché
        try {
          apiCache.set(req.url, {
            body: buf,
            status: upRes.statusCode || 200,
            headers,
            t: Date.now()
          });
        } catch {}
        cleanup();
      });
    });

    upReq.on("timeout", () => { try { upReq.destroy(new Error("upstream timeout")); } catch {} });
    upReq.on("error",   () => {
      if (!res.headersSent) {
        try { res.writeHead(502, { "Content-Type": "text/plain" }); } catch {}
      }
      try { res.end("Upstream error"); } catch {}
      cleanup();
    });

    upReq.end(); // GET sin body
    return; // fin rama API
  }

  // ------------- Resto de rutas → proxy streaming -------------
  try { proxy.web(req, res, { target: TARGET }); }
  catch (e) {
    // Por si salta síncrono (raro), responder y limpiar
    if (!res.headersSent) {
      try { res.writeHead(502, { "Content-Type": "text/plain" }); } catch {}
    }
    try { res.end("Proxy error"); } catch {}
    cleanup();
  }
});

// Timeouts en servidor para evitar sockets zombi
server.keepAliveTimeout = 10000;
server.headersTimeout   = 12000;
server.requestTimeout   = REQUEST_TIMEOUT_MS;

server.on("connection", (socket) => {
  socket.setTimeout(IDLE_SOCKET_MS, () => { try { socket.destroy(); } catch {} });
});

server.listen(PORT, () => {
  console.log(`DIPETV proxy → ${TARGET} | PORT=${PORT} | MAX=${MAX_CONCURRENT} | AGENT=${AGENT_MAX_SOCKETS} | PER_USER_MAX=${PER_USER_MAX}`);
});
