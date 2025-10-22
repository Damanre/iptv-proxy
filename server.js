// server.js — Proxy IPTV con follow interno de 302 + Referer y split-tunnel
import http from "http";
import https from "https";
import httpProxy from "http-proxy";
import { URL } from "url";

const TARGET = process.env.TARGET || "http://185.243.7.190";
const PORT   = parseInt(process.env.PORT || "10000", 10);

// Agentes keep-alive
const agentHttp  = new http.Agent({  keepAlive: true, maxSockets: 200 });
const agentHttps = new https.Agent({ keepAlive: true, maxSockets: 200 });

const proxy = httpProxy.createProxyServer({
  target: TARGET,
  changeOrigin: true,
  xfwd: true,
  ws: true,
  secure: false,
  agent: TARGET.startsWith("https") ? agentHttps : agentHttp
});

// Sigue 3xx internamente (con Referer al primer salto) y vuelca al cliente
function followAndPipe(finalUrl, req, res, hops = 0) {
  if (hops > 3) { try { res.writeHead(502).end("Too many redirects"); } catch {} return; }

  const u = new URL(finalUrl);
  const isHttps = u.protocol === "https:";
  const client  = isHttps ? https : http;

  const headers = {
    ...req.headers,
    host: u.host,
    referer: `${TARGET}${req.url}`, // clave para evitar 509 del segundo salto
    connection: "keep-alive",
  };
  delete headers["accept-encoding"]; // evitar compresión sobre TS

  const opts = {
    protocol: u.protocol,
    hostname: u.hostname,
    port: u.port || (isHttps ? 443 : 80),
    method: "GET",
    path: u.pathname + u.search,
    headers,
    agent: isHttps ? agentHttps : agentHttp,
  };

  const up = client.request(opts, (upRes) => {
    // Si vuelve a redirigir, seguimos internamente
    if (upRes.statusCode >= 300 && upRes.statusCode < 400 && upRes.headers.location) {
      const next = new URL(upRes.headers.location, `${u.protocol}//${u.host}`).toString();
      upRes.resume(); // tiramos el cuerpo del 3xx
      return followAndPipe(next, req, res, hops + 1);
    }

    const hdrs = { ...upRes.headers };
    delete hdrs["content-encoding"]; // streaming limpio
    delete hdrs["location"];         // no exponer redirects al cliente

    try { res.writeHead(upRes.statusCode || 200, hdrs); } catch {}
    upRes.on("data", (chunk) => { try { res.write(chunk); } catch {} });
    upRes.on("end",  () => { try { res.end(); } catch {} });
  });

  up.on("error", () => {
    if (!res.headersSent) { try { res.writeHead(502, {"Content-Type":"text/plain"}); } catch {} }
    try { res.end("Upstream error"); } catch {}
  });

  up.end();
}

// Intercepta la respuesta del primer upstream
proxy.on("proxyRes", (proxyRes, req, res) => {
  try { res.setHeader("X-Accel-Buffering", "no"); } catch {}

  const code = proxyRes.statusCode || 0;
  const loc  = proxyRes.headers && proxyRes.headers.location;
  if (code >= 300 && code < 400 && loc) {
    // seguimos internamente y no devolvemos 3xx al cliente
    proxyRes.resume();
    const absolute = new URL(loc, TARGET).toString();
    return followAndPipe(absolute, req, res, 1);
  }
});

proxy.on("error", (_err, _req, res) => {
  if (!res.headersSent) { try { res.writeHead(502, { "Content-Type": "text/plain" }); } catch {} }
  try { res.end("Proxy error"); } catch {}
});

const server = http.createServer((req, res) => {
  if (req.url === "/healthz") { res.writeHead(200); return res.end("ok"); }
  req.socket.setNoDelay(true);
  proxy.web(req, res, { target: TARGET });
});

server.keepAliveTimeout = 65000;
server.headersTimeout   = 70000;

server.listen(PORT, () => {
  console.log(`DIPETV proxy escuchando en ${PORT} → ${TARGET}`);
});
