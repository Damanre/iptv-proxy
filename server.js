import express from "express";
import fetch from "node-fetch";

const app = express();
const PORT = process.env.PORT || 10000;
const TARGET = process.env.TARGET || "http://45.158.254.11";

// Para requests grandes (listas, segmentos TS, etc.)
app.use(express.raw({ type: "*/*", limit: "200mb" }));

app.use(async (req, res) => {
  try {
    // Construimos la URL de destino, preservando path y querystring
    const url = new URL(req.url, TARGET);

    // Filtramos algunos headers que no conviene reenviar tal cual
    const hopByHop = new Set([
      "host",
      "connection",
      "keep-alive",
      "proxy-authenticate",
      "proxy-authorization",
      "te",
      "trailer",
      "transfer-encoding",
      "upgrade",
      "content-length", // la calcula node-fetch si hace falta
      "accept-encoding" // que el destino no nos responda comprimido raro
    ]);
    const headers = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (!hopByHop.has(k.toLowerCase())) headers[k] = v;
    }

    const response = await fetch(url.toString(), {
      method: req.method,
      headers,
      body: ["GET", "HEAD"].includes(req.method) ? undefined : req.body
    });

    // Pasamos status y headers relevantes al cliente
    res.status(response.status);
    response.headers.forEach((value, key) => {
      if (!hopByHop.has(key.toLowerCase())) res.setHeader(key, value);
    });

    // Pipe del body (importante para m3u8/ts/tsv/etc.)
    if (response.body) {
      response.body.on("error", () => {
        // Evita que Render marque fallo por socket roto
        if (!res.headersSent) res.status(502);
        try { res.end(); } catch {}
      });
      response.body.pipe(res);
    } else {
      res.end();
    }
  } catch (err) {
    if (!res.headersSent) res.status(502).send("Proxy error hacia IPTV");
    else try { res.end(); } catch {}
  }
});

app.listen(PORT, () => {
  console.log(`Proxy IPTV escuchando en puerto ${PORT}, destino ${TARGET}`);
});
