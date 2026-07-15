// Debunkly — proxy de leitura de página
// Deploy: painel da Cloudflare -> Workers & Pages -> Create Worker -> cole este código -> Deploy.
// Depois copie a URL gerada (ex: https://debunkly-proxy.SEU-USUARIO.workers.dev)
// e cole em PROXY_URL no topo do <script> do index.html.

const MAX_BYTES = 300_000; // limite de leitura por página (evita páginas gigantes travando o app)
const TIMEOUT_MS = 8000;
const BLOCKED_HOST_PATTERNS = [
  /^localhost$/i,
  /^127\./,
  /^10\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[0-1])\./,
  /^0\.0\.0\.0$/,
  /^\[?::1\]?$/,
  /\.local$/i,
];

function corsHeaders(origin) {
  return {
    "Access-Control-Allow-Origin": origin || "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  };
}

function isBlockedHost(hostname) {
  return BLOCKED_HOST_PATTERNS.some((re) => re.test(hostname));
}

export default {
  async fetch(request) {
    const origin = request.headers.get("Origin");

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders(origin) });
    }

    const reqUrl = new URL(request.url);
    const target = reqUrl.searchParams.get("url");

    if (!target) {
      return new Response(JSON.stringify({ error: "missing url param" }), {
        status: 400,
        headers: { "Content-Type": "application/json", ...corsHeaders(origin) },
      });
    }

    let parsed;
    try {
      parsed = new URL(target);
    } catch (e) {
      return new Response(JSON.stringify({ error: "invalid url" }), {
        status: 400,
        headers: { "Content-Type": "application/json", ...corsHeaders(origin) },
      });
    }

    if (!["http:", "https:"].includes(parsed.protocol)) {
      return new Response(JSON.stringify({ error: "protocol not allowed" }), {
        status: 400,
        headers: { "Content-Type": "application/json", ...corsHeaders(origin) },
      });
    }

    if (isBlockedHost(parsed.hostname)) {
      return new Response(JSON.stringify({ error: "host not allowed" }), {
        status: 400,
        headers: { "Content-Type": "application/json", ...corsHeaders(origin) },
      });
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

    try {
      const upstream = await fetch(parsed.href, {
        redirect: "follow",
        signal: controller.signal,
        headers: {
          "User-Agent": "Mozilla/5.0 (compatible; DebunklyBot/1.0; +MVP)",
          Accept: "text/html",
        },
      });

      const reader = upstream.body.getReader();
      let received = 0;
      const chunks = [];
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        received += value.length;
        if (received > MAX_BYTES) break;
        chunks.push(value);
      }
      clearTimeout(timer);

      const bytes = new Uint8Array(received > MAX_BYTES ? MAX_BYTES : received);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk.subarray(0, Math.min(chunk.length, bytes.length - offset)), offset);
        offset += chunk.length;
        if (offset >= bytes.length) break;
      }
      const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);

      return new Response(JSON.stringify({ ok: true, status: upstream.status, text }), {
        headers: { "Content-Type": "application/json", ...corsHeaders(origin) },
      });
    } catch (err) {
      clearTimeout(timer);
      return new Response(JSON.stringify({ ok: false, error: "fetch_failed" }), {
        status: 502,
        headers: { "Content-Type": "application/json", ...corsHeaders(origin) },
      });
    }
  },
};
