import http from "http";
import https from "https";
import httpProxy from "http-proxy";

const TARGET = process.env.TARGET || "http://185.243.7.190";
const PORT = process.env.PORT || 10000;

// Agentes keep-alive para no abrir sockets nuevos cada vez
const agentHttp  = new http.Agent({  keepAlive: true, maxSockets: 100 });
const agentHttps = new https.Agent({ keepAlive: true, maxSockets: 100 });

const proxy = httpProxy.createProxyServer({
  target: TARGET,
  changeOrigin: true,
  xfwd: true,
  ws: true,
  secure: false,
  agent: TARGET.startsWith("https") ? agentHttps : agentHttp
});

// Opcional: cabecera para evitar buffering en proxies intermedios
proxy.on("proxyRes", (proxyRes, req, res) => {
  res.setHeader("X-Accel-Buffering", "no");
});

proxy.on("error", (err, req, res) => {
  if (!res.headersSent) res.writeHead(502, { "Content-Type": "text/plain" });
  res.end("Proxy error");
});

const server = http.createServer((req, res) => {
  // endpoint de vida para Render
  if (req.url === "/healthz") { res.writeHead(200); return res.end("ok"); }

  // IMPORTANTÍSIMO: no usamos body parsers, ni buffers → stream puro
  req.socket.setNoDelay(true);
  proxy.web(req, res, { target: TARGET });
});

// Mantener conexiones vivas pero finitas
server.keepAliveTimeout = 65000;
server.headersTimeout = 70000;

server.listen(PORT, () => {
  console.log(`DIPETV proxy escuchando en ${PORT} → ${TARGET}`);
});
