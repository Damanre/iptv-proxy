// server.js — Reverse proxy con follow-redirects en /live/** y sin X-Forwarded-For
import http from "http";
import https from "https";
import httpProxy from "http-proxy";
import { URL } from "url";

const TARGET = process.env.TARGET || "http://185.243.7.190";
const PORT   = parseInt(process.env.PORT || "10000", 10);

// timeouts y agentes
const PROXY_TIMEOUT_MS = parseInt(process.env.PROXY_TIMEOUT_MS || "90000", 10);
const agentHttp  = new http.Agent({  keepAlive: true, maxSockets: 400, maxFreeSockets: 50, timeout: PROXY_TIMEOUT_MS });
const agentHttps = new https.Agent({ keepAlive: true, maxSockets: 400, maxFreeSockets: 50, timeout: PROXY_TIMEOUT_MS });

const upstreamIsHttps = TARGET.startsWith("https");

// Proxy para rutas NO /live/**
const proxy = httpProxy.createProxyServer({
  target: TARGET,
  changeOrigin: true,
  xfwd: false,              // <- MUY IMPORTANTE: no enviar X-Forwarded-*
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

// Helpers
function isLivePath(u) { return /^\/live\/[^/]+\/[^/]+\//.test(u); }
function buildOptsFromUrl(req, urlStr) {
  const u = new URL(urlStr);
  const headers = { ...req.headers };
  // limpiar cabeceras de “forwarded”
  delete headers["x-forwarded-for"];
  delete headers["x-forwarded-proto"];
  delete headers["x-real-ip"];
  // respetar Host del upstream
  headers["host"] = u.host;
  // no comprimir (para streaming)
  headers["accept-encoding"] = "identity";
  return {
    protocol: u.protocol, hostname: u.hostname, port: u.port || (u.protocol==="https:"?443:80),
    method: req.method, path: u.pathname + u.search,
    headers,
    agent: u.protocol==="https:" ? agentHttps : agentHttp,
    timeout: PROXY_TIMEOUT_MS
  };
}

// Follow redirects para /live/**
function fetchFollow({ initialUrl, req, res, maxRedirects = 5 }) {
  let urlStr = initialUrl;
  const start = Date.now();

  const go = (currentUrl, redirectsLeft) => {
    const opts = buildOptsFromUrl(req, currentUrl);
    if (req.headers.range) opts.headers.range = req.headers.range;

    const client = opts.protocol === "https:" ? https : http;
    const upReq = client.request(opts, (upRes) => {
      const sc = upRes.statusCode || 200;

      // redirecciones
      if ([301,302,303,307,308].includes(sc) && redirectsLeft > 0) {
        const loc = upRes.headers.location;
        upRes.resume();
        if (!loc) { try { res.writeHead(sc); } catch {} ; try { res.end(); } catch {} ; return; }
        const next = new URL(loc, new URL(currentUrl));
        return go(next.toString(), redirectsLeft - 1);
      }

      // cabeceras “friendly” para TS
      const headers = { ...upRes.headers };
      if (!headers["content-type"]) headers["content-type"] = "video/mp2t";
      headers["accept-ranges"] = headers["accept-ranges"] || "bytes";
      headers["cache-control"] = headers["cache-control"] || "no-store, no-transform";
      headers["connection"] = headers["connection"] || "keep-alive";
      headers["x-upstream-status"] = String(sc);
      try { res.writeHead(sc, headers); } catch {}

      upRes.on("data", (chunk) => { try { res.write(chunk); } catch {} });
      upRes.on("end", () => { try { res.end(); } catch {} });
    });

    upReq.on("timeout", () => { try { upReq.destroy(new Error("upstream timeout")); } catch {} });
    upReq.on("error", () => {
      if (!res.headersSent) { try { res.writeHead(502, { "Content-Type":"text/plain" }); } catch {} }
      try { res.end("Upstream error"); } catch {}
    });

    // GET sin body
    upReq.end();
  };

  go(urlStr, maxRedirects);
}

// Servidor HTTP
const server = http.createServer((req, res) => {
  if (req.url === "/healthz") { res.writeHead(200); return res.end("ok"); }

  req.socket.setNoDelay(true);
  req.socket.setTimeout(PROXY_TIMEOUT_MS, () => { try { req.destroy(); } catch {} });
  try { res.setHeader("X-Accel-Buffering", "no"); } catch {}

  if (isLivePath(req.url)) {
    const upstreamUrl = new URL(req.url, TARGET).toString();
    return fetchFollow({ initialUrl: upstreamUrl, req, res, maxRedirects: 5 });
  }

  // resto de rutas → proxy simple (sin xfwd)
  proxy.web(req, res, { target: TARGET });
});

server.keepAliveTimeout = 65000;
server.headersTimeout   = PROXY_TIMEOUT_MS;
server.requestTimeout   = PROXY_TIMEOUT_MS;

server.listen(PORT, () => {
  console.log(`Proxy con follow-redirects (/live) en :${PORT} → ${TARGET}`);
});
