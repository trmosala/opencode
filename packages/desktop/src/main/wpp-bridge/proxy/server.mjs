import http from "node:http";
import { handleChatCompletions, listModels, writeJson } from "./openaiCompat.mjs";
import { extensionBridge } from "./extensionBridge.mjs";
import { renderStatusPage } from "./statusPage.mjs";
import { shouldIgnoreListenError } from "./server-startup.mjs";

const DEFAULT_HOST = process.env.O1_CODE_PROXY_HOST || "127.0.0.1";
const DEFAULT_PORT = Number(process.env.O1_CODE_PROXY_PORT || 8787);

export async function startServer(options = {}) {
  return startServerWithActions(options);
}

export async function startServerWithActions({ host = DEFAULT_HOST, port = DEFAULT_PORT, openLogin = null } = {}) {
  const server = http.createServer(async (request, response) => {
    try {
      await route(request, response, { openLogin });
    } catch (error) {
      writeJson(response, error.statusCode || 500, {
        error: {
          message: error.message,
          type: error.type || "o1_code_proxy_error"
        }
      });
    }
  });

  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(port, host, () => {
        server.removeListener("error", reject);
        resolve();
      });
    });
  } catch (error) {
    if (shouldIgnoreListenError(error)) {
      console.log(`o1-code-openai-proxy: already running on http://${host}:${port}/ — nothing to do.`);
      return;
    }

    throw error;
  }

  console.log(`o1-code-openai-proxy listening on http://${host}:${port}/v1`);
}

async function route(request, response, actions = {}) {
  const url = new URL(request.url, "http://127.0.0.1");

  if (!enforceBrowserOrigin(request, response)) {
    return;
  }

  if (request.method === "OPTIONS") {
    writeCors(response, request);
    response.writeHead(204);
    response.end();
    return;
  }

  if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/status")) {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(renderStatusPage());
    return;
  }

  if (request.method === "GET" && url.pathname === "/health") {
    writeJson(response, 200, { ok: true });
    return;
  }

  if (request.method === "GET" && url.pathname === "/bridge/health") {
    writeJson(response, 200, extensionBridge.health());
    return;
  }

  if (request.method === "POST" && url.pathname === "/bridge/login") {
    if (typeof actions.openLogin !== "function") {
      writeJson(response, 501, { ok: false, error: "WPP login window is not available." });
      return;
    }

    await actions.openLogin();
    writeJson(response, 200, { ok: true });
    return;
  }

  if (request.method === "GET" && url.pathname === "/v1/models") {
    writeCors(response, request);
    writeJson(response, 200, listModels());
    return;
  }

  if (request.method === "POST" && url.pathname === "/v1/chat/completions") {
    writeCors(response, request);
    const body = await readJson(request);
    await handleChatCompletions(request, response, body);
    return;
  }

  writeJson(response, 404, {
    error: {
      message: `No route for ${request.method} ${url.pathname}`,
      type: "not_found"
    }
  });
}

function enforceBrowserOrigin(request, response) {
  if (isAllowedBrowserRequest(request.headers)) {
    return true;
  }

  const origin = request.headers.origin || "(no origin)";
  const fetchSite = request.headers["sec-fetch-site"] || "(no sec-fetch-site)";

  writeJson(response, 403, {
    error: {
      message: `Browser request is not allowed to access the local O1-Code proxy: origin=${origin}, sec-fetch-site=${fetchSite}`,
      type: "forbidden_origin"
    }
  });
  return false;
}

function writeCors(response, request) {
  const origin = request.headers.origin;

  if (!origin || !isAllowedBrowserOrigin(origin)) {
    return;
  }

  response.setHeader("access-control-allow-origin", origin);
  response.setHeader("access-control-allow-methods", "GET,POST,OPTIONS");
  response.setHeader("access-control-allow-headers", "content-type,authorization");
  response.setHeader("vary", "origin");
}

export function isAllowedBrowserOrigin(origin) {
  if (!origin) {
    return true;
  }

  if (String(origin).startsWith("chrome-extension://")) {
    return true;
  }

  try {
    const url = new URL(origin);

    return url.protocol === "http:" && [
      "localhost",
      "127.0.0.1",
      "::1",
      "[::1]"
    ].includes(url.hostname);
  } catch {
    return false;
  }
}

export function isAllowedBrowserRequest(headers = {}) {
  const origin = headers.origin;
  const fetchSite = headers["sec-fetch-site"];

  if (isAllowedBrowserOrigin(origin) && String(origin || "").startsWith("chrome-extension://")) {
    return true;
  }

  if (fetchSite === "cross-site") {
    return false;
  }

  return isAllowedBrowserOrigin(origin);
}

async function readJson(request) {
  const chunks = [];

  for await (const chunk of request) {
    chunks.push(chunk);
  }

  const raw = Buffer.concat(chunks).toString("utf8");

  if (!raw.trim()) {
    return {};
  }

  try {
    return JSON.parse(raw);
  } catch {
    const error = new Error("Request body must be valid JSON.");
    error.statusCode = 400;
    throw error;
  }
}
