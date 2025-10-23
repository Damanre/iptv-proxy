// server.js — proxy simple con timeouts más holgados (60–90 s)
import http from "http";
import https from "https";
import httpProxy from "http-proxy";

const TARGET = process.env.TARGET || "http://185.243.7.190";
const PORT   = parseInt(process.env.PORT || "10000", 10);

const REQUEST_HEADERS_TIMEOUT = parseInt(process.env.REQUEST_HEADERS_TIMEOUT || "90000", 10); // cabeceras
const IDLE_SOCKET_TIMEOUT     = parseInt(process.env.IDLE_SOCKET_TIMEOUT     || "60000", 10); // inactividad
const PROXY_TIMEOUT_MS        = parseInt(process.env.PROXY_TIMEOUT_MS        || "90000", 10); // upstream

const agentHttp  = new http.Agent({  keepAlive: true, maxSockets: 400, maxFreeSockets: 50, timeout: PROXY_TIMEOUT_MS });
const agentHttps = new https.Agent({ keepAlive: true, maxSockets: 400, maxFreeSockets: 50, timeout: PROXY_TIMEOUT_MS });
const upstreamIsHttps = TARGET.startsWith("https");

const proxy = httpProxy.createProxyServer({
  target: TARGET,
  changeOrigin: true,
  xfwd: true,
  ws: false,
  secure: false,
  agent: upstreamIsHttps ? agentHttps : agentHttp,
  timeout: PROXY_TIMEOUT_MS,     // esperar cabeceras del upstream
  proxyTimeout: PROXY_TIMEOUT_MS // inactividad de datos desde upstream
});

proxy.on("proxyRes", (_proxyRes, _req, res) => {
  try { res.setHeader("X-Accel-Buffering", "no"); } catch {}
  // no fuerces 'Connection: close' — deja keep-alive
  res.setTimeout(PROXY_TIMEOUT_MS, () => { try { res.destroy(); } catch {} });
});

proxy.on("error", (_err, _req, res) => {
  if (res && !res.headersSent) res.writeHead(502, { "Content-Type": "text/plain" });
  try { res.end("Proxy error"); } catch {}
});

const server = http.createServer((req, res) => {
  if (req.url === "/healthz") { res.writeHead(200); return res.end("ok"); }
  req.socket.setNoDelay(true);
  // tiempo de inactividad del lado cliente (p. ej. si VLC se queda parado)
  req.socket.setTimeout(IDLE_SOCKET_TIMEOUT, () => { try { req.destroy(); } catch {} });

  try {
    proxy.web(req, res);
  } catch {
    if (!res.headersSent) res.writeHead(502, { "Content-Type": "text/plain" });
    res.end("Proxy error");
  }
});

server.keepAliveTimeout = 65000;           // cuanto mantener viva la conexión HTTP/1.1
server.headersTimeout   = REQUEST_HEADERS_TIMEOUT; // tiempo total para recibir cabeceras
server.requestTimeout   = PROXY_TIMEOUT_MS;        // tiempo total de la request

server.listen(PORT, () => {
  console.log(`IPTV proxy :${PORT} → ${TARGET} (simple, timeouts=${PROXY_TIMEOUT_MS}ms)`);
});
