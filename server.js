// server.js — follow-redirects en /live/** con control de inactividad y duración
import http from "http";
import https from "https";
import httpProxy from "http-proxy";
import { URL } from "url";

/* ====== Config ====== */
const TARGET = process.env.TARGET || "http://185.243.7.190";
const PORT   = parseInt(process.env.PORT || "10000", 10);

// Tiempos
const PROXY_TIMEOUT_MS = parseInt(process.env.PROXY_TIMEOUT_MS || "90000", 10);   // timeouts generales (upstream/cliente)
const CLIENT_IDLE_MS   = parseInt(process.env.CLIENT_IDLE_MS   || "20000", 10);   // sin enviar bytes al cliente -> cortar
const MAX_STREAM_MS    = parseInt(process.env.MAX_STREAM_MS    || "14400000", 10); // duración máxima de un stream (4h por defecto)

// Límite por usuario (si la URL es /live/{user}/{pass}/...)
const PER_USER_MAX     = parseInt(process.env.PER_USER_MAX     || "2", 10);

/* ====== Agentes ====== */
const agentHttp  = new http.Agent({  keepAlive: true, maxSockets: 400, maxFreeSockets: 50, timeout: PROXY_TIMEOUT_MS });
const agentHttps = new https.Agent({ keepAlive: true, maxSockets: 400, maxFreeSockets: 50, timeout: PROXY_TIMEOUT_MS });

const upstreamIsHttps = TARGET.startsWith("https");

/* ====== Proxy simple para rutas NO /live/** ====== */
const proxy = httpProxy.createProxyServer({
  target: TARGET,
  changeOrigin: true,
  xfwd: false,          // NO filtrar IP real al upstream
  ws: false,
  secure: false,
  agent: upstreamIsHttps ? agentHttps : agentHttp,
  timeout: PROXY_TIMEOUT_MS,
  proxyTimeout: PROXY_TIMEOUT_MS
});

proxy.on("proxyRes", (_pr, _req, res) => {
  try { res.setHeader("X-Accel-Buffering", "no"); } catch {}
  res.setTimeout(PROXY_TIMEOUT_MS, () => { try { res.destroy(); } catch {} });
});
proxy.on("error", (_err, _req, res) => {
  if (res && !res.headersSent) res.writeHead(502, { "Content-Type":"text/plain" });
  try { res.end("Proxy error"); } catch {}
});

/* ====== Helpers ====== */
function isLivePath(u) { return /^\/live\/[^/]+\/[^/]+\//.test(u); }
function parseUser(u) {
  const m = u.match(/^\/live\/([^/]+)\/([^/]+)\//);
  return m ? m[1] : null;
}
function buildOptsFromUrl(req, urlStr) {
  const u = new URL(urlStr);
  const headers = { ...req.headers };
  delete headers["x-forwarded-for"];
  delete headers["x-forwarded-proto"];
  delete headers["x-real-ip"];
  headers["host"] = u.host;
  headers["accept-encoding"] = "identity";
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

/* ====== Control de sesiones activas por usuario ====== */
const activeByUser = new Map(); // user -> count

function incUser(user) {
  if (!user) return true;
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

/* ====== Follow-redirects para /live/** con cortes por inactividad ====== */
function fetchFollow({ initialUrl, req, res, maxRedirects = 5 }) {
  const startedAt = Date.now();
  let lastClientWrite = Date.now(); // para detectar clientes inactivos

  // Si el cliente no recibe datos durante CLIENT_IDLE_MS, cortamos
  const idleTimer = setInterval(() => {
    if (res.writableEnded || res.destroyed) return;
    if (Date.now() - lastClientWrite > CLIENT_IDLE_MS) {
      try { res.destroy(new Error("client idle timeout")); } catch {}
    }
  }, Math.min(5000, CLIENT_IDLE_MS)); // chequeo frecuente pero barato

  // Límite duro de duración por stream
  const maxTimer = setTimeout(() => {
    try { res.destroy(new Error("max stream duration reached")); } catch {}
  }, MAX_STREAM_MS);

  // Si el cliente cierra, limpiamos
  const cleanup = () => {
    clearInterval(idleTimer);
    clearTimeout(maxTimer);
  };
  res.on("close", cleanup);
  res.on("finish", cleanup);
  res.on("error", cleanup);

  const go = (currentUrl, left) => {
    const opts = buildOptsFromUrl(req, currentUrl);
    if (req.headers.range) opts.headers.range = req.headers.range;

    const client = opts.protocol === "https:" ? https : http;
    const upReq = client.request(opts, (upRes) => {
      const sc = upRes.statusCode || 200;

      // Redirecciones 3xx
      if ([301,302,303,307,308].includes(sc) && left > 0) {
        const loc = upRes.headers.location;
        upRes.resume(); // descartamos cuerpo
        if (!loc) { try { res.writeHead(sc); res.end(); } catch {} ; return; }
        const next = new URL(loc, new URL(currentUrl));
        return go(next.toString(), left - 1);
      }

      // Cabeceras finales hacia el cliente
      const headers = { ...upRes.headers };
      if (!headers["content-type"]) headers["content-type"] = "video/mp2t";
      headers["accept-ranges"] = headers["accept-ranges"] || "bytes";
      headers["cache-control"] = headers["cache-control"] || "no-store, no-transform";
      headers["connection"] = headers["connection"] || "keep-alive";
      headers["x-upstream-status"] = String(sc);
      try { res.writeHead(sc, headers); } catch {}

      // Cada chunk que enviamos al cliente actualiza "lastClientWrite"
      upRes.on("data", (chunk) => {
        lastClientWrite = Date.now();
        try {
          const ok = res.write(chunk);
          // Si el cliente no lee (backpressure fuerte), cerramos pronto
          if (ok === false) {
            // Si en ~CLIENT_IDLE_MS el cliente no drena, cortamos
            const t = setTimeout(() => {
              if (!res.writableEnded && !res.destroyed) {
                try { res.destroy(new Error("client backpressure timeout")); } catch {}
              }
            }, CLIENT_IDLE_MS);
            res.once("drain", () => clearTimeout(t));
          }
        } catch {}
      });

      upRes.on("end", () => { try { res.end(); } catch {} });
    });

    upReq.on("timeout", () => { try { upReq.destroy(new Error("upstream timeout")); } catch {} });
    upReq.on("error", () => {
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
  // Endpoints ligeros
  if (req.url === "/healthz") { res.writeHead(200); return res.end("ok"); }
  if (req.url === "/version") { res.writeHead(200); return res.end("follow-redirects+idle"); }

  req.socket.setNoDelay(true);
  req.socket.setTimeout(PROXY_TIMEOUT_MS, () => { try { req.destroy(); } catch {} });
  try { res.setHeader("X-Accel-Buffering", "no"); } catch {}

  if (isLivePath(req.url)) {
    const user = parseUser(req.url);
    if (!incUser(user)) {
      res.writeHead(429, { "Content-Type":"text/plain", "Retry-After":"2" });
      return res.end("Too many streams for this user");
    }
    res.on("close", () => decUser(user));
    res.on("finish", () => decUser(user));

    const upstreamUrl = new URL(req.url, TARGET).toString();
    return fetchFollow({ initialUrl: upstreamUrl, req, res, maxRedirects: 5 });
  }

  // Resto de rutas → proxy normal
  proxy.web(req, res, { target: TARGET });
});

server.keepAliveTimeout = 65000;
server.headersTimeout   = PROXY_TIMEOUT_MS;
server.requestTimeout   = PROXY_TIMEOUT_MS;

server.listen(PORT, () => {
  console.log(`Follow-redirects (/live) + idle control en :${PORT} → ${TARGET}`);
});
