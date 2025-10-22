// server.js — Proxy IPTV con follow interno de 302 + Referer (selfHandleResponse)
// Ejecuta: node >=18

import http from "http";
import https from "https";
import httpProxy from "http-proxy";
import { URL } from "url";

const TARGET = process.env.TARGET || "http://185.243.7.190";
const PORT   = parseInt(process.env.PORT || "10000", 10);

// Agentes keep-alive
const agentHttp  = new http.Agent({  keepAlive: true, maxSockets: 200 });
const agentHttps = new https.Agent({ keepAlive: true, maxSockets: 200 });

// MUY IMPORTANTE: selfHandleResponse=true para controlar lo que se manda al cliente
const proxy = httpProxy.createProxyServer({
  target: TARGET,
  changeOrigin: true,
  xfwd: true,
  ws: true,
  secure: false,
  agent: TARGET.startsWith("https") ? agentHttps : agentHttp,
  selfHandleResponse: true
});

// sigue (hasta 3) redirecciones de forma interna y vuelca el resultado al cliente
function followAndPipe(finalUrl, req, res, hops = 0) {
  if (hops > 3) { try { res.writeHead(502).end("Too many redirects"); } catch {} return; }

  const u = new URL(finalUrl);
  const isHttps = u.protocol === "https:";
  const client  = isHttps ? https : http;

  const headers = {
    ...req.headers,
    host: u.host,
    referer: `${TARGET}${req.url}`,    // clave para evitar 509/anti-hotlink
    connection: "keep-alive",
  };
  delete headers["accept-encoding"];   // evitar compresión sobre TS

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
    // encadena más redirecciones si aparecen
    if (upRes.statusCode >= 300 && upRes.statusCode < 400 && upRes.headers.location) {
      const next = new URL(upRes.headers.location, `${u.protocol}//${u.host}`).toString();
      upRes.resume();
      return followAndPipe(next, req, res, hops + 1);
    }

    // respuesta final → copiar headers (sanear) y volcar cuerpo
    const hdrs = { ...upRes.headers };
    delete hdrs["content-encoding"];
    delete hdrs["location"]; // nunca exponer redirecciones al cliente
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

// manejamos SIEMPRE la respuesta del primer upstream
proxy.on("proxyRes", (proxyRes, req, res) => {
  try { res.setHeader("X-Accel-Buffering", "no"); } catch {}

  const code = proxyRes.statusCode || 0;
  const loc  = proxyRes.headers && proxyRes.headers.location;

  if (code >= 300 && code < 400 && loc) {
    // 3xx del primer salto → seguir internamente y devolver 200/206 al cliente
    proxyRes.resume(); // no enviar este 3xx al cliente
    const absolute = new URL(loc, TARGET).toString();
    return followAndPipe(absolute, req, res, 1);
  }

  // caso normal (no redirección): reenvía headers+cuerpo al cliente
  const hdrs = { ...proxyRes.headers };
  // no toques Location aquí (no debería venir en 2xx)
  try { res.writeHead(code || 200, hdrs); } catch {}
  proxyRes.on("data", (chunk) => { try { res.write(chunk); } catch {} });
  proxyRes.on("end",  () => { try { res.end(); } catch {} });
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
