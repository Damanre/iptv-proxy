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
  // si primer salto devuelve 3xx → seguir internamente
  if (proxyRes.statusCode >= 300 && proxyRes.statusCode < 400 && proxyRes.headers.location) {
    const { URL } = await import("url");
    const http  = await import("http");
    const https = await import("https");

    function follow(finalUrl, hops = 0) {
      const u = new URL(finalUrl);
      const isHttps = u.protocol === "https:";
      const client = isHttps ? https : http;

      const headers = {
        ...req.headers,
        host: u.host,
        referer: `${TARGET}${req.url}`,  // Referer al primer salto
        connection: "keep-alive",
      };
      delete headers["accept-encoding"];

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
        if (upRes.statusCode >= 300 && upRes.statusCode < 400 && upRes.headers.location) {
          if (hops >= 3) { res.writeHead(502).end("Too many redirects"); return; }
          upRes.resume();
          const next = new URL(upRes.headers.location, `${u.protocol}//${u.host}`).toString();
          return follow(next, hops + 1);
        }
        const hdrs = { ...upRes.headers };
        delete hdrs["content-encoding"];
        delete hdrs["location"];
        try { res.writeHead(upRes.statusCode || 200, hdrs); } catch {}
        upRes.on("data", c => { try { res.write(c); } catch {} });
        upRes.on("end",  () => { try { res.end(); } catch {} });
      });
      up.on("error", () => { if (!res.headersSent) res.writeHead(502); res.end("Upstream error"); });
      up.end();
    }

    proxyRes.resume();                 // descartamos cuerpo del 3xx
    return follow(new URL(proxyRes.headers.location, TARGET).toString());
  }
  try { res.setHeader("X-Accel-Buffering", "no"); } catch {}
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
