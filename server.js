// server.js
import http from "http";
import https from "https";
import httpProxy from "http-proxy";
import { URL } from "url";

const TARGET = process.env.TARGET || "http://185.243.7.190";
const PORT   = parseInt(process.env.PORT || "10000", 10);

// === Agentes ===
// 1) keep-alive para API y cosas ligeras
const agentKeepHttp  = new http.Agent({  keepAlive: true,  maxSockets: 200, maxFreeSockets: 10, timeout: 15000 });
const agentKeepHttps = new https.Agent({ keepAlive: true,  maxSockets: 200, maxFreeSockets: 10, timeout: 15000 });
// 2) sin keep-alive para vídeo (TS/M3U8): una request = una conexión
const agentNoKeepHttp  = new http.Agent({  keepAlive: false, maxSockets: 400, timeout: 15000 });
const agentNoKeepHttps = new https.Agent({ keepAlive: false, maxSockets: 400, timeout: 15000 });

const upstreamIsHttps = TARGET.startsWith("https");
const agentKeep    = upstreamIsHttps ? agentKeepHttps    : agentKeepHttp;
const agentNoKeep  = upstreamIsHttps ? agentNoKeepHttps  : agentNoKeepHttp;

const proxy = httpProxy.createProxyServer({
  target: TARGET,
  changeOrigin: true,
  xfwd: true,
  ws: false,
  secure: false,

  // timeouts base (se pueden sobreescribir por-request)
  timeout: 15000,       // esperar cabeceras del upstream
  proxyTimeout: 15000   // inactividad de datos desde upstream
});

// helper: decide si es vídeo
function isVideoPath(p) {
  return /\.m3u8(\?.*)?$/.test(p) || /\.ts(\?.*)?$/.test(p);
}
function isApiPath(p) {
  return p.startsWith("/player_api.php");
}

proxy.on("proxyReq", (proxyReq, req, res, options) => {
  // Cabeceras útiles
  proxyReq.setHeader("X-Accel-Buffering", "no");
  if (isVideoPath(req.url)) {
    // Para segmentos de vídeo pedimos cierre al upstream
    proxyReq.setHeader("Connection", "close");
  }
});

proxy.on("proxyRes", (proxyRes, req, res) => {
  // Evita buffering en cadenas intermedias y pide cierre al cliente en vídeo
  res.setHeader("X-Accel-Buffering", "no");
  if (isVideoPath(req.url)) {
    res.setHeader("Connection", "close");
    // si no hay datos durante 8s, corta respuesta al cliente
    res.setTimeout(8000, () => { try { res.destroy(); } catch {} });
  } else {
    // API puede tolerar algo más
    res.setTimeout(15000, () => { try { res.destroy(); } catch {} });
  }
});

proxy.on("error", (err, req, res) => {
  if (res && !res.headersSent) {
    res.writeHead(502, { "Content-Type": "text/plain" });
  }
  try { res.end("Proxy error"); } catch {}
});

// si el cliente se va, corta también el lado upstream
proxy.on("start", (req, res) => {
  req.on("aborted", () => { try { res.destroy(); } catch {} });
});

const server = http.createServer((req, res) => {
  if (req.url === "/healthz") { res.writeHead(200); return res.end("ok"); }

  req.socket.setNoDelay(true);
  // si el cliente se queda ocioso, corta rápido
  req.socket.setTimeout(isVideoPath(req.url) ? 8000 : 15000, () => { try { req.destroy(); } catch {} });

  // agente y timeouts por tipo de recurso
  const opts = { target: TARGET };
  if (isVideoPath(req.url)) {
    opts.agent = agentNoKeep;
    opts.timeout = 10000;
    opts.proxyTimeout = 10000;
  } else {
    opts.agent = agentKeep;
    opts.timeout = 15000;
    opts.proxyTimeout = 15000;
  }

  try {
    proxy.web(req, res, opts);
  } catch {
    if (!res.headersSent) {
      res.writeHead(502, { "Content-Type": "text/plain" });
    }
    res.end("Proxy error");
  }
});

// timeouts de servidor → evita sockets zombi del lado cliente
server.keepAliveTimeout = 5000;   // cuanto mantener keep-alive del cliente
server.headersTimeout   = 12000;  // límite total de cabeceras
server.requestTimeout   = 15000;  // request entera

server.listen(PORT, () => {
  console.log(`IPTV proxy en :${PORT} → ${TARGET}`);
});
