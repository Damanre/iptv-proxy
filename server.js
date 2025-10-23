// server.js — timeouts 10s
import http from "http";
import https from "https";
import httpProxy from "http-proxy";

const TARGET = process.env.TARGET || "http://185.243.7.190";
const PORT   = parseInt(process.env.PORT || "10000", 10);

// === Agentes ===
// API / tráfico ligero con keep-alive
const agentKeepHttp  = new http.Agent({  keepAlive: true,  maxSockets: 200, maxFreeSockets: 10, timeout: 10000 });
const agentKeepHttps = new https.Agent({ keepAlive: true,  maxSockets: 200, maxFreeSockets: 10, timeout: 10000 });
// Vídeo (.ts/.m3u8) sin keep-alive para que no queden conexiones colgadas
const agentNoKeepHttp  = new http.Agent({  keepAlive: false, maxSockets: 400, timeout: 10000 });
const agentNoKeepHttps = new https.Agent({ keepAlive: false, maxSockets: 400, timeout: 10000 });

const upstreamIsHttps = TARGET.startsWith("https");
const agentKeep    = upstreamIsHttps ? agentKeepHttps    : agentKeepHttp;
const agentNoKeep  = upstreamIsHttps ? agentNoKeepHttps  : agentNoKeepHttp;

const proxy = httpProxy.createProxyServer({
  target: TARGET,
  changeOrigin: true,
  xfwd: true,
  ws: false,
  secure: false,
  timeout: 10000,       // esperar cabeceras del upstream (10s)
  proxyTimeout: 10000   // inactividad de datos desde upstream (10s)
});

function isVideoPath(p) {
  return /\.m3u8(\?.*)?$/.test(p) || /\.ts(\?.*)?$/.test(p);
}

proxy.on("proxyReq", (proxyReq, req, res) => {
  proxyReq.setHeader("X-Accel-Buffering", "no");
  if (isVideoPath(req.url)) {
    proxyReq.setHeader("Connection", "close");  // no mantener viva en upstream para vídeo
  }
});

proxy.on("proxyRes", (proxyRes, req, res) => {
  res.setHeader("X-Accel-Buffering", "no");
  if (isVideoPath(req.url)) {
    res.setHeader("Connection", "close");       // tampoco con el cliente
  }
  // si no hay datos durante 10s, cortar respuesta al cliente
  res.setTimeout(10000, () => { try { res.destroy(); } catch {} });
});

proxy.on("start", (req, res) => {
  // si el cliente aborta, cortar también upstream
  req.on("aborted", () => { try { res.destroy(); } catch {} });
});

proxy.on("error", (err, req, res) => {
  if (res && !res.headersSent) res.writeHead(502, { "Content-Type": "text/plain" });
  try { res.end("Proxy error"); } catch {}
});

const server = http.createServer((req, res) => {
  if (req.url === "/healthz") { res.writeHead(200); return res.end("ok"); }

  req.socket.setNoDelay(true);
  // si el lado cliente se queda ocioso, cortar en 10s
  req.socket.setTimeout(10000, () => { try { req.destroy(); } catch {} });

  const opts = {
    target: TARGET,
    agent: isVideoPath(req.url) ? agentNoKeep : agentKeep,
    timeout: 10000,
    proxyTimeout: 10000
  };

  try {
    proxy.web(req, res, opts);
  } catch {
    if (!res.headersSent) res.writeHead(502, { "Content-Type": "text/plain" });
    res.end("Proxy error");
  }
});

// límites del servidor para evitar sockets zombi
server.keepAliveTimeout = 5000;   // 5s de keep-alive máximo
server.headersTimeout   = 12000;  // cabeceras totales
server.requestTimeout   = 10000;  // request entera 10s

server.listen(PORT, () => {
  console.log(`IPTV proxy en :${PORT} → ${TARGET} (timeouts 10s)`);
});
