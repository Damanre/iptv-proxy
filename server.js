// server.js — follow-redirects en /live/** + idle + per-user (opcional) + anti-stall + métricas
import http from "http";
import https from "https";
import httpProxy from "http-proxy";
import { URL } from "url";
import events from "events";

/* ====== Config ====== */
const TARGET = process.env.TARGET || "http://185.243.7.190";
const PORT   = parseInt(process.env.PORT || "10000", 10);

// Tiempos
const PROXY_TIMEOUT_MS = parseInt(process.env.PROXY_TIMEOUT_MS || "90000", 10);    // timeouts generales
const CLIENT_IDLE_MS   = parseInt(process.env.CLIENT_IDLE_MS   || "20000", 10);    // sin bytes al cliente -> cortar
const MAX_STREAM_MS    = parseInt(process.env.MAX_STREAM_MS    || "14400000", 10); // 4h

// Límite por usuario (URL /live/{user}/{pass}/...)
// 0 = sin límite
const PER_USER_MAX     = parseInt(process.env.PER_USER_MAX     || "2", 10);

// (Opcional) No aplicar límite a rangos pequeños (tests HLS tipo .ts parciales)
const SKIP_LIMIT_TINY_RANGE = (process.env.SKIP_LIMIT_TINY_RANGE || "false").toLowerCase() === "true";
const TINY_RANGE_MAX_BYTES  = parseInt(process.env.TINY_RANGE_MAX_BYTES || String(2 * 1024 * 1024), 10);

// Anti-stall (opcional)
const RECONNECT_ON_STALL = (process.env.RECONNECT_ON_STALL || "false").toLowerCase() === "true";
const UPSTREAM_STALL_MS  = parseInt(process.env.UPSTREAM_STALL_MS || "4000", 10);  // 4s sin bytes = consideramos stall
const UPSTREAM_STALL_MAX = parseInt(process.env.UPSTREAM_STALL_MAX || "3", 10);    // reintentos por stream

// Métricas / privacidad
const MAX_ACTIVE_RETURN = parseInt(process.env.MAX_ACTIVE_RETURN || "200", 10);
const HIDE_IPS          = (process.env.HIDE_IPS || "true").toLowerCase() !== "false";

/* ====== Listener limits (evitar MaxListenersExceededWarning) ====== */
events.defaultMaxListeners = 0;

/* ====== Agentes ====== */
const agentHttp  = new http.Agent({  keepAlive: true, keepAliveMsecs: 10000, maxSockets: 400, maxFreeSockets: 50, timeout: PROXY_TIMEOUT_MS });
const agentHttps = new https.Agent({ keepAlive: true, keepAliveMsecs: 10000, maxSockets: 400, maxFreeSockets: 50, timeout: PROXY_TIMEOUT_MS });

const upstreamIsHttps = TARGET.startsWith("https");

/* ====== Proxy simple para rutas NO /live/** ====== */
const proxy = httpProxy.createProxyServer({
  target: TARGET,
  changeOrigin: true,
  xfwd: false, // NO enviamos IP real al upstream
  ws: false,
  secure: false,
  agent: upstreamIsHttps ? agentHttps : agentHttp,
  timeout: PROXY_TIMEOUT_MS,
  proxyTimeout: PROXY_TIMEOUT_MS
});

proxy.on("proxyRes", (_pr, req, res) => {
  try { res.setHeader("X-Accel-Buffering", "no"); } catch {}
  try { req.setMaxListeners(0); } catch {}
  try { res.setMaxListeners(0); } catch {}
  res.setTimeout(PROXY_TIMEOUT_MS, () => { try { res.destroy(); } catch {} });
});
proxy.on("error", (_err, _req, res) => {
  if (res && !res.headersSent) res.writeHead(502, { "Content-Type":"text/plain" });
  try { res.end("Proxy error"); } catch {}
});

/* ====== Helpers ====== */
function isLivePath(u) { return /^\/live\/[^/]+\/[^/]+\//.test(u); }
function parseUser(u) { const m = u.match(/^\/live\/([^/]+)\/([^/]+)\//); return m ? decodeURIComponent(m[1]) : null; }

function buildOptsFromUrl(req, urlStr) {
  const u = new URL(urlStr);
  const headers = { ...req.headers };
  delete headers["x-forwarded-for"];
  delete headers["x-forwarded-proto"];
  delete headers["x-real-ip"];
  headers["host"] = u.host;
  headers["accept-encoding"] = "identity"; // evita compresión que rompa rangos/TS
  return {
    protocol: u.protocol,
    hostname: u.hostname,
    port: u.port || (u.protocol==="https:"?443:80),
    method: req.method,
    path: u.pathname + u.search,
    headers,
    agent: u.protocol==="https:" ? agentHttps : agentHttp,
    timeout: PROXY_TIMEOUT_MS
  };
}
function maskIp(ip) {
  if (!ip) return "";
  if (!HIDE_IPS) return ip;
  if (ip.includes(".")) { const p = ip.split("."); if (p.length===4) p[3] = "x"; return p.join("."); }
  if (ip.includes(":")) { const p = ip.split(":"); return p.slice(0,4).join(":") + "::"; }
  return ip;
}
function isTinyRange(req) {
  const r = (req.headers.range || "").toString().trim();
  const m = /^bytes=(\d+)-(\d+)$/.exec(r);
  if (!m) return false;
  const start = +m[1], end = +m[2];
  const sz = (end - start + 1);
  return Number.isFinite(sz) && sz > 0 && sz <= TINY_RANGE_MAX_BYTES;
}

/* ====== Métricas y sesiones activas ====== */
let curConns = 0, totalConns = 0, totalBytes = 0, totalErrors = 0;
let stallEvents = 0, stallReconnects = 0;
let reqIdSeq = 0;
const active = new Map(); // id -> session

function startSession(req) {
  const id = ++reqIdSeq;
  const s = {
    id,
    ip: maskIp((req.headers["x-forwarded-for"] || "").toString().split(",")[0].trim() || req.socket.remoteAddress || ""),
    path: req.url,
    user: parseUser(req.url),
    started_at: Date.now(),
    last_write_at: null,
    bytes: 0,
    upstream_status: null
  };
  active.set(id, s);
  curConns++; totalConns++;
  return { id, s };
}
function finishSession(id) {
  if (active.has(id)) active.delete(id);
  curConns = Math.max(0, curConns - 1);
}

/* ====== Control de sesiones activas por usuario ====== */
const activeByUser = new Map(); // user -> count
function incUser(user) {
  if (!user) return true;
  if (PER_USER_MAX <= 0) return true;
  const n = activeByUser.get(user) || 0;
  if (n >= PER_USER_MAX) return false;
  activeByUser.set(user, n + 1);
  return true;
}
function decUser(user) {
  if (!user) return;
  const n = (activeByUser.get(user) || 1) - 1;
  if (n <= 0) activeByUser.delete(user); else activeByUser.set(user, n);
}

/* ====== Follow-redirects para /live/** + anti-stall ====== */
function fetchFollow({ initialUrl, req, res, maxRedirects = 5, session }) {
  let lastClientWrite = Date.now();
  let lastUpstreamData = Date.now();
  let reconnects = 0;

  // Si el cliente no recibe datos durante CLIENT_IDLE_MS, cortamos
  const idleTimer = setInterval(() => {
    if (res.writableEnded || res.destroyed) return;
    if (Date.now() - lastClientWrite > CLIENT_IDLE_MS) {
      try { res.destroy(new Error("client idle timeout")); } catch {}
    }
  }, Math.min(5000, CLIENT_IDLE_MS));

  // Límite duro de duración por stream
  const maxTimer = setTimeout(() => {
    try { res.destroy(new Error("max stream duration reached")); } catch {}
  }, MAX_STREAM_MS);

  const cleanup = () => { clearInterval(idleTimer); clearTimeout(maxTimer); };
  res.on("close", cleanup);
  res.on("finish", cleanup);
  res.on("error", cleanup);

  const RES_BP_KEY = Symbol.for("res.backpressure"); // marca en la respuesta

  const go = (currentUrl, left) => {
    const opts = buildOptsFromUrl(req, currentUrl);
    if (req.headers.range) opts.headers.range = req.headers.range;

    const client = opts.protocol === "https:" ? https : http;
    const upReq = client.request(opts, (upRes) => {
      try { upRes.socket?.setNoDelay?.(true); } catch {}
      const sc = upRes.statusCode || 200;
      session.upstream_status = sc;

      // Redirecciones 3xx
      if ([301,302,303,307,308].includes(sc) && left > 0) {
        const loc = upRes.headers.location;
        upRes.resume();
        if (!loc) { try { res.writeHead(sc); res.end(); } catch {} ; return; }
        const next = new URL(loc, new URL(currentUrl));
        return go(next.toString(), left - 1);
      }

      // Cabeceras hacia el cliente
      const headers = { ...upRes.headers };
      if (!headers["content-type"]) headers["content-type"] = "video/mp2t";
      headers["accept-ranges"] = headers["accept-ranges"] || "bytes";
      headers["cache-control"] = headers["cache-control"] || "no-store, no-transform";
      headers["connection"] = headers["connection"] || "keep-alive";
      headers["x-upstream-status"] = String(sc);
      try { res.writeHead(sc, headers); } catch {}

      // Vigilancia anti-stall
      let stallCheck = null;
      if (RECONNECT_ON_STALL) {
        stallCheck = setInterval(() => {
          if (res.writableEnded || res.destroyed) return;
          const gap = Date.now() - lastUpstreamData;
          if (gap > UPSTREAM_STALL_MS && reconnects < UPSTREAM_STALL_MAX) {
            stallEvents++;
            reconnects++;
            try { upReq.destroy(new Error("upstream stall")); } catch {}
            try { clearInterval(stallCheck); } catch {}
            // Reintentamos misma URL (o la que toque si redirige)
            setTimeout(() => {
              stallReconnects++;
              go(currentUrl, maxRedirects); // reabrimos
            }, 50);
          }
        }, Math.min(1000, UPSTREAM_STALL_MS));
      }

      upRes.on("data", (chunk) => {
        const now = Date.now();
        lastClientWrite = now;
        lastUpstreamData = now;
        session.last_write_at = now;
        session.bytes += chunk.length;
        totalBytes += chunk.length;

        try {
          const ok = res.write(chunk);
          if (ok === false) {
            if (!res[RES_BP_KEY]) {
              res[RES_BP_KEY] = {
                timer: setTimeout(() => {
                  if (!res.writableEnded && !res.destroyed) {
                    try { res.destroy(new Error("client backpressure timeout")); } catch {}
                  }
                }, CLIENT_IDLE_MS)
              };
              res.once("drain", () => {
                const bp = res[RES_BP_KEY];
                if (bp?.timer) clearTimeout(bp.timer);
                res[RES_BP_KEY] = null;
              });
            }
          }
        } catch {}
      });

      upRes.on("end", () => {
        try { clearInterval(stallCheck); } catch {}
        try { res.end(); } catch {}
      });
    });

    upReq.on("timeout", () => { try { upReq.destroy(new Error("upstream timeout")); } catch {} });
    upReq.on("error", () => {
      totalErrors++;
      if (!res.headersSent) { try { res.writeHead(502, { "Content-Type":"text/plain" }); } catch {} }
      try { res.end("Upstream error"); } catch {}
    });

    // Si el cliente aborta, cancelamos upstream
    req.on("aborted", () => { try { upReq.destroy(new Error("client aborted")); } catch {} });
    res.on("close",      () => { try { upReq.destroy(new Error("res closed")); } catch {} });

    upReq.end();
  };

  go(initialUrl, maxRedirects);
}

/* ====== Servidor HTTP ====== */
const server = http.createServer((req, res) => {
  try { req.setMaxListeners(0); } catch {}
  try { res.setMaxListeners(0); } catch {}

  // Endpoints control / métricas
  if (req.url === "/healthz") { res.writeHead(200); return res.end("ok"); }
  if (req.url === "/version") { res.writeHead(200); return res.end("follow-redirects+idle+stats+listenersfix2+antistall"); }
  if (req.url === "/stats") {
    const m = process.memoryUsage();
    const body = JSON.stringify({
      target: TARGET,
      uptime_s: Math.round(process.uptime()),
      rss_mb: Math.round(m.rss/1024/1024),
      heapUsed_mb: Math.round(m.heapUsed/1024/1024),
      curConns, totalConns, totalErrors, totalBytes,
      stallEvents, stallReconnects
    });
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(body);
  }
  if (req.url.startsWith("/stats/active")) {
    const now = Date.now();
    const list = Array.from(active.values())
      .sort((a,b)=>a.started_at-b.started_at)
      .slice(-MAX_ACTIVE_RETURN)
      .map(s => ({
        id: s.id,
        ip: s.ip,
        user: s.user,
        path: s.path,
        age_s: Math.round((now - s.started_at)/1000),
        idle_s: s.last_write_at ? Math.round((now - s.last_write_at)/1000) : null,
        bytes_kb: Math.round(s.bytes/1024),
        upstream_status: s.upstream_status
      }));
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ count: active.size, showing: list.length, sessions: list }));
  }

  req.socket.setNoDelay(true);
  req.socket.setTimeout(PROXY_TIMEOUT_MS, () => { try { req.destroy(); } catch {} });
  try { res.setHeader("X-Accel-Buffering", "no"); } catch {}

  // Sesión para métricas
  const { id, s } = startSession(req);
  const endSession = () => finishSession(id);
  res.on("close", endSession);
  res.on("finish", endSession);
  res.on("error", endSession);

  if (isLivePath(req.url)) {
    const user = s.user;
    const skipLimit = SKIP_LIMIT_TINY_RANGE && isTinyRange(req);

    if (!skipLimit) {
      if (!incUser(user)) {
        res.writeHead(429, { "Content-Type":"text/plain", "Retry-After":"2" });
        res.end("Too many streams for this user");
        return;
      }
      res.on("close", () => decUser(user));
      res.on("finish", () => decUser(user));
    }

    const upstreamUrl = new URL(req.url, TARGET).toString();
    return fetchFollow({ initialUrl: upstreamUrl, req, res, maxRedirects: 5, session: s });
  }

  // Resto de rutas → proxy normal
  proxy.web(req, res, { target: TARGET });
});

server.keepAliveTimeout = 65000;
server.headersTimeout   = PROXY_TIMEOUT_MS;
server.requestTimeout   = PROXY_TIMEOUT_MS;

// Errores globales
process.on("uncaughtException", (e) => { totalErrors++; console.error("uncaughtException", e?.message); });
process.on("unhandledRejection", (e) => { totalErrors++; console.error("unhandledRejection", e); });

server.listen(PORT, () => {
  console.log(`Proxy en :${PORT} → ${TARGET} | features: follow-redirects(/live), idle, per-user(skipTiny=${SKIP_LIMIT_TINY_RANGE}), anti-stall=${RECONNECT_ON_STALL}, stats`);
});
