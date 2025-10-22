// server.js — DIPETV proxy "VPN-like" estable
// - /live/**: cliente manual con follow redirects (opcional por ENV), UA VLC opcional, Range, métricas de tráfico
// - /player_api.php: petición manual con caché TTL + follow redirects (opcional por ENV)
// - límites por usuario e IP, timeouts holgados, /stats enriquecido

import http from "http";
import https from "https";
import { URL } from "url";
import httpProxy from "http-proxy";

// ======== Config por ENV (Render → Environment) ========
const TARGET                 = process.env.TARGET || "http://45.158.254.11";
const PORT                   = parseInt(process.env.PORT || "10000", 10);

const MAX_CONCURRENT         = parseInt(process.env.MAX_CONCURRENT || "80", 10);
const AGENT_MAX_SOCKETS      = parseInt(process.env.AGENT_MAX_SOCKETS || "64", 10);

const REQUEST_TIMEOUT_MS     = parseInt(process.env.REQUEST_TIMEOUT_MS || "60000", 10);
const IDLE_SOCKET_MS         = parseInt(process.env.IDLE_SOCKET_MS || "60000", 10);

const PER_USER_MAX           = parseInt(process.env.PER_USER_MAX || "1", 10);
const PER_IP_MAX             = parseInt(process.env.PER_IP_MAX || "3", 10);

const API_TTL_MS             = parseInt(process.env.API_TTL_MS || "60000", 10);
const API_MAX_BYTES          = parseInt(process.env.API_MAX_BYTES || (1024 * 1024), 10);
const API_CACHE_MAX_ENTRIES  = parseInt(process.env.API_CACHE_MAX_ENTRIES || "200", 10);

// Flags de comportamiento (true/false)
const FORCE_VLC_UA           = String(process.env.FORCE_VLC_UA || "false").toLowerCase() === "true";
const FOLLOW_REDIRECTS       = String(process.env.FOLLOW_REDIRECTS || "true").toLowerCase() === "true";

// ======== Agentes keep-alive ========
const commonAgentOpts = { keepAlive: true, maxSockets: AGENT_MAX_SOCKETS, maxFreeSockets: 10 };
const agentHttp  = new http.Agent(commonAgentOpts);
const agentHttps = new https.Agent(commonAgentOpts);
const targetUrl  = new URL(TARGET);
const upstreamIsHttps = targetUrl.protocol === "https:";

// ======== Proxy para rutas NO streaming ========
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

// ======== Métricas =========
let currentConnections = 0;
let totalConnections   = 0;

const activeByUser = new Map(); // /live/{user}/{pass}/...
const activeByIp   = new Map(); // por IP

// Tráfico y bitrate (EWMA)
let totalBytesOut = 0;
let totalBytesIn  = 0;
let lastSecondBytes = 0;            // bytes servidos el último segundo
let ewmaBps = 0;                    // bytes/seg (EWMA)
const EWMA_ALPHA = 2 / (60 + 1);    // ~60s ventana
setInterval(() => {
  // Actualiza EWMA una vez por segundo con lo enviado ese segundo
  ewmaBps = ewmaBps + EWMA_ALPHA * (lastSecondBytes - ewmaBps);
  lastSecondBytes = 0;
}, 1000);

// Streams activos para ver duración/MB por stream
const activeStreams = new Map(); // id -> { start, bytesOut }
let streamSeq = 0;

// ======== Caché player_api.php =========
const apiCache = new Map(); // key: req.url → { body: Buffer, status, headers, t }

function apiCacheSet(key, value) {
  apiCache.set(key, value);
  if (apiCache.size > API_CACHE_MAX_ENTRIES) {
    const firstKey = apiCache.keys().next().value;
    if (firstKey) apiCache.delete(firstKey);
  }
}
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of apiCache) {
    if (now - v.t > API_TTL_MS) apiCache.delete(k);
  }
}, Math.max(30000, API_TTL_MS));

// ======== Helpers ========
function once(fn) {
  let called = false;
  return () => { if (!called) { called = true; try { fn(); } catch {} } };
}
function isApi(req) {
  return req.method === "GET" && req.url.startsWith("/player_api.php?");
}
function clientIp(req) {
  const h = req.headers["x-forwarded-for"];
  return (h && String(h).split(",")[0].trim()) || req.socket.remoteAddress || "";
}
function inc(map, key){ map.set(key, (map.get(key)||0)+1); }
function dec(map, key){ const v=(map.get(key)||1)-1; v<=0?map.delete(key):map.set(key,v); }

function buildUpstreamOptions(req) {
  const url = new URL(req.url, TARGET);
  const isLive = /^\/live\/[^/]+\/[^/]+\//.test(req.url);
  const userUA = req.headers["user-agent"] || "Mozilla/5.0";
  const forcedUA = (FORCE_VLC_UA || isLive) ? "VLC/3.0.18 LibVLC/3.0.18" : userUA; // UA VLC en /live o si flag activo

  return {
    protocol: url.protocol,
    hostname: url.hostname,
    port: url.port || (url.protocol === "https:" ? 443 : 80),
    method: req.method,
    path: url.pathname + url.search,
    headers: {
      ...req.headers,
      host: url.host,
      connection: "keep-alive",
      "user-agent": forcedUA,
      "x-forwarded-for": clientIp(req),
      "x-forwarded-proto": "https",
      "accept-encoding": "identity" // sin compresión para binarios .ts
    },
    agent: url.protocol === "https:" ? agentHttps : agentHttp,
    timeout: REQUEST_TIMEOUT_MS
  };
}

// === Helper: FOLLOW REDIRECTS opcional ===
function fetchUpstreamWithRedirects({ opts, req, res, cleanup, maxRedirects = 5, cacheCfg = null, streamMode = false }) {
  const doRequest = (requestOpts, redirectsLeft) => {
    const client = requestOpts.protocol === "https:" ? https : http;
    const upReq = client.request(requestOpts, (upRes) => {
      const status = upRes.statusCode || 200;

      // Redirecciones 3xx (si están habilitadas)
      if (FOLLOW_REDIRECTS && [301, 302, 303, 307, 308].includes(status) && redirectsLeft > 0) {
        const loc = upRes.headers.location;
        if (!loc) {
          try { res.writeHead(status, upRes.headers); } catch {}
          upRes.resume();
          upRes.on("end", () => { try { res.end(); } catch {}; cleanup(); });
          return;
        }
        const currentBase = new URL(requestOpts.protocol + "//" + requestOpts.hostname + (requestOpts.port ? ":" + requestOpts.port : ""));
        const nextUrl = new URL(loc, currentBase);
        const newOpts = {
          protocol: nextUrl.protocol,
          hostname: nextUrl.hostname,
          port: nextUrl.port || (nextUrl.protocol === "https:" ? 443 : 80),
          method: (status === 303) ? "GET" : requestOpts.method,
          path: nextUrl.pathname + nextUrl.search,
          headers: {
            ...requestOpts.headers,
            host: nextUrl.host,
            referer: nextUrl.origin + "/",
            ...(requestOpts.headers.range ? { range: requestOpts.headers.range } : {})
          },
          agent: nextUrl.protocol === "https:" ? agentHttps : agentHttp,
          timeout: requestOpts.timeout
        };
        upRes.resume();
        return doRequest(newOpts, redirectsLeft - 1);
      }

      // Respuesta final
      const headers = { ...upRes.headers };
      try { res.writeHead(status, headers); } catch {}

      if (streamMode) {
        // PIPE para TS/HLS
        upRes.on("data", (chunk) => {
          try { res.write(chunk); } catch {}
          const len = chunk.length || 0;
          totalBytesOut += len;
          lastSecondBytes += len;
        });
        upRes.on("end", () => {
          try { res.end(); } catch {}
          cleanup();
        });
      } else {
        // API: escribir al cliente y buffer para cache
        let buf = Buffer.alloc(0);
        upRes.on("data", (chunk) => {
          try { res.write(chunk); } catch {}
          const len = chunk.length || 0;
          if (cacheCfg && (buf.length + len <= API_MAX_BYTES)) {
            buf = Buffer.concat([buf, chunk]);
          }
        });
        upRes.on("end", () => {
          try { res.end(); } catch {}
          if (cacheCfg && cacheCfg.apiCacheSetFn) {
            try {
              cacheCfg.apiCacheSetFn(cacheCfg.key, {
                body: buf,
                status,
                headers,
                t: Date.now()
              });
            } catch {}
          }
          cleanup();
        });
      }
    });

    upReq.on("timeout", () => { try { upReq.destroy(new Error("upstream timeout")); } catch {} });
    upReq.on("error", () => {
      if (!res.headersSent) {
        try { res.writeHead(502, { "Content-Type": "text/plain" }); } catch {}
      }
      try { res.end("Upstream error"); } catch {}
      cleanup();
    });

    // Consumir datos del cliente (normalmente vacío en GET), para contar bytes_in
    req.on("data", (chunk) => { totalBytesIn += (chunk.length || 0); });
    req.on("end",  () => { try { upReq.end(); } catch {} });
  };

  // Lanza la primera petición
  doRequest(opts, maxRedirects);
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
    const streams = {};
    for (const [id, s] of activeStreams) {
      streams[id] = {
        secs: Math.round((Date.now() - s.start)/1000),
        mb_out: +(s.bytesOut/1024/1024).toFixed(2)
      };
    }
    const body = JSON.stringify({
      uptime_s: Math.round(process.uptime()),
      rss_mb: Math.round(m.rss/1024/1024),
      heapUsed_mb: Math.round(m.heapUsed/1024/1024),
      currentConnections,
      totalConnections,
      perUser: Object.fromEntries(activeByUser),
      perIp: Object.fromEntries(activeByIp),
      cacheSize: apiCache.size,
      traffic: {
        total_bytes_out: totalBytesOut,
        total_bytes_in: totalBytesIn,
        ewma_bps: Math.round(ewmaBps),
        ewma_mbps: +(ewmaBps * 8 / 1e6).toFixed(3)
      },
      live_streams: streams
    });
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(body);
  }

  // Límite global
  if (currentConnections >= MAX_CONCURRENT) {
    res.writeHead(503, { "Retry-After": "2", "Content-Type": "text/plain" });
    return res.end("Server busy, retry");
  }

  // Límite por usuario/IP sólo en /live/{user}/{pass}/...
  let userKey = null;
  const ipKey = clientIp(req);

  const liveMatch = req.url.match(/^\/live\/([^/]+)\/([^/]+)\//);
  if (liveMatch) {
    userKey = liveMatch[1];

    const uNow = activeByUser.get(userKey) || 0;
    if (uNow >= PER_USER_MAX) {
      res.writeHead(429, { "Retry-After": "1", "Content-Type": "text/plain" });
      return res.end("Too many streams for this user");
    }
    const iNow = activeByIp.get(ipKey) || 0;
    if (iNow >= PER_IP_MAX) {
      res.writeHead(429, { "Retry-After": "1", "Content-Type": "text/plain" });
      return res.end("Too many streams from this IP");
    }
    inc(activeByUser, userKey);
    inc(activeByIp, ipKey);
  }

  // Contadores
  currentConnections++;
  totalConnections++;
  // id de stream (solo si es livePath)
  const isLivePath = /^\/live\/[^/]+\/[^/]+\//.test(req.url);
  const streamId = isLivePath ? ++streamSeq : null;
  if (streamId) activeStreams.set(streamId, { start: Date.now(), bytesOut: 0 });

  const cleanup = once(() => {
    currentConnections = Math.max(0, currentConnections - 1);
    if (userKey) dec(activeByUser, userKey);
    if (ipKey)   dec(activeByIp, ipKey);
    if (streamId) activeStreams.delete(streamId);
  });

  // Timeouts en sockets de entrada
  req.socket.setNoDelay(true);
  req.socket.setTimeout(IDLE_SOCKET_MS, () => { try { req.destroy(); } catch {} });
  res.setTimeout(REQUEST_TIMEOUT_MS, () => { try { res.destroy(); } catch {} });

  // Limpieza garantizada
  req.on("aborted", cleanup);
  req.on("close",   cleanup);
  req.on("error",   cleanup);
  res.on("finish",  cleanup);
  res.on("close",   cleanup);
  res.on("error",   cleanup);

  // ------------- player_api.php: petición manual + caché (+ redirects opcional) -------------
  if (isApi(req)) {
    try { res.setHeader("X-Accel-Buffering", "no"); } catch {}

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

    const opts = buildUpstreamOptions(req);
    // limpiar hop-by-hop
    delete opts.headers["proxy-connection"];
    delete opts.headers["transfer-encoding"];

    fetchUpstreamWithRedirects({
      opts,
      req,
      res,
      cleanup,
      maxRedirects: 5,
      cacheCfg: { key: req.url, apiCacheSetFn: apiCacheSet },
      streamMode: false
    });
    return;
  }

  // ------------- /live/... : STREAMING MANUAL (follow redirects opcional) -------------
  if (isLivePath) {
    const opts = buildUpstreamOptions(req);

    // Propaga Range (si lo pide el cliente)
    if (req.headers.range) {
      opts.headers.range = req.headers.range;
    }

    // Cabeceras IPTV-friendly
    opts.headers["accept"] = "*/*";
    opts.headers["referer"] = TARGET + "/";
    opts.headers["accept-encoding"] = "identity";

    // Limpiar hop-by-hop
    delete opts.headers["proxy-connection"];
    delete opts.headers["transfer-encoding"];

    // Envolvemos para medir bytes/stream
    const originalFetch = fetchUpstreamWithRedirects;
    const wrappedRes = new Proxy(res, {
      get(target, prop) { return target[prop]; },
      set(target, prop, value) { target[prop] = value; return true; }
    });

    // Interceptar write para contar bytes del stream actual
    const _write = wrappedRes.write.bind(wrappedRes);
    wrappedRes.write = (chunk, encoding, cb) => {
      const len = Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(chunk || "", encoding || "utf8");
      totalBytesOut += len;
      lastSecondBytes += len;
      if (streamId) {
        const s = activeStreams.get(streamId);
        if (s) s.bytesOut += len;
      }
      return _write(chunk, encoding, cb);
    };

    originalFetch({
      opts,
      req,
      res: wrappedRes,
      cleanup,
      maxRedirects: 5,
      cacheCfg: null,
      streamMode: true
    });
    return;
  }

  // ------------- Resto de rutas → proxy tradicional -------------
  try { proxy.web(req, res, { target: TARGET }); }
  catch (e) {
    if (!res.headersSent) {
      try { res.writeHead(502, { "Content-Type": "text/plain" }); } catch {}
    }
    try { res.end("Proxy error"); } catch {}
    cleanup();
  }
});

// Timeouts del servidor
server.keepAliveTimeout = 60000;
server.headersTimeout   = 65000;
server.requestTimeout   = REQUEST_TIMEOUT_MS;

server.on("connection", (socket) => {
  socket.setTimeout(IDLE_SOCKET_MS, () => { try { socket.destroy(); } catch {} });
});

server.listen(PORT, () => {
  console.log(
    `DIPETV proxy → ${TARGET} | PORT=${PORT} | MAX=${MAX_CONCURRENT} | AGENT=${AGENT_MAX_SOCKETS} | ` +
    `PER_USER_MAX=${PER_USER_MAX} | PER_IP_MAX=${PER_IP_MAX} | FORCE_VLC_UA=${FORCE_VLC_UA} | FOLLOW_REDIRECTS=${FOLLOW_REDIRECTS}`
  );
});
