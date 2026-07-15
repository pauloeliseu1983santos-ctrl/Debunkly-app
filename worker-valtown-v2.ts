// Debunkly — proxy de leitura de página + checagem de blacklist (versão Val Town)
// Cole isto substituindo TODO o conteúdo do val existente.
//
// IMPORTANTE: antes de rodar, gere uma Auth-Key gratuita em https://auth.abuse.ch/
// e cadastre ela nas variáveis de ambiente do Val Town (menu de configurações da
// sua conta -> Environment Variables) com o nome: URLHAUS_AUTH_KEY
// Se a variável não existir, a checagem de blacklist é simplesmente pulada
// (o resto do app continua funcionando normalmente).

const MAX_BYTES = 300_000;
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

async function checkUrlhaus(targetUrl) {
  const key = Deno.env.get("URLHAUS_AUTH_KEY");
  if (!key) return { checked: false };

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    const res = await fetch("https://urlhaus-api.abuse.ch/v1/url/", {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Auth-Key": key,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: "url=" + encodeURIComponent(targetUrl),
    });
    clearTimeout(timer);
    const data = await res.json();

    if (data.query_status === "ok") {
      return {
        checked: true,
        listed: true,
        threat: data.threat || null,
        status: data.url_status || null,
      };
    }
    return { checked: true, listed: false };
  } catch (e) {
    return { checked: false };
  }
}

export default async function (req: Request): Promise<Response> {
  const origin = req.headers.get("Origin");

  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders(origin) });
  }

  const reqUrl = new URL(req.url);
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

  const blacklistPromise = checkUrlhaus(parsed.href);

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
    const blacklist = await blacklistPromise;

    return new Response(JSON.stringify({ ok: true, status: upstream.status, text, blacklist }), {
      headers: { "Content-Type": "application/json", ...corsHeaders(origin) },
    });
  } catch (err) {
    clearTimeout(timer);
    const blacklist = await blacklistPromise;
    return new Response(JSON.stringify({ ok: false, error: "fetch_failed", blacklist }), {
      status: 502,
      headers: { "Content-Type": "application/json", ...corsHeaders(origin) },
    });
  }
}
