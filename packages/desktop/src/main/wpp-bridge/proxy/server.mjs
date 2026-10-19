import http from "node:http";
import { handleChatCompletions, listModels, writeJson } from "./openaiCompat.mjs";
import { extensionBridge } from "./extensionBridge.mjs";
import { renderStatusPage } from "./statusPage.mjs";
import { shouldIgnoreListenError } from "./server-startup.mjs";

const DEFAULT_HOST = process.env.O1_CODE_PROXY_HOST || "127.0.0.1";
const DEFAULT_PORT = Number(process.env.O1_CODE_PROXY_PORT || 8787);
export const MAX_REQUEST_BODY_BYTES = 64 * 1024 * 1024;

export async function startServer(options = {}) {
  return startServerWithActions(options);
}

export async function startServerWithActions({ host = DEFAULT_HOST, port = DEFAULT_PORT, openLogin = null, checkAuth = null, chatMode = "assistant" } = {}) {
  extensionBridge.setChatMode(chatMode);
  if (typeof openLogin === "function") extensionBridge.onAuthRequired = openLogin;
  const server = http.createServer(async (request, response) => {
    try {
      await route(request, response, { openLogin, checkAuth }, host);
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
  return server;
}

async function route(request, response, actions = {}, bindHost = DEFAULT_HOST) {
  const url = new URL(request.url, "http://127.0.0.1");

  if (!enforceBrowserOrigin(request, response, bindHost)) {
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

  if (request.method === "GET" && url.pathname === "/bridge/auth") {
    const state = typeof actions.checkAuth === "function" ? await actions.checkAuth() : { status: "unknown" };
    writeJson(response, 200, { status: state.status });
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
    const controller = new AbortController();
    const abort = () => {
      if (!response.writableEnded) controller.abort();
    };
    request.once("aborted", abort);
    response.once("close", abort);
    try {
      const body = await readJson(request);
      await handleChatCompletions(request, response, body, { signal: controller.signal });
    } finally {
      request.removeListener("aborted", abort);
      response.removeListener("close", abort);
    }
    return;
  }

  writeJson(response, 404, {
    error: {
      message: `No route for ${request.method} ${url.pathname}`,
      type: "not_found"
    }
  });
}

function enforceBrowserOrigin(request, response, bindHost) {
  // DNS rebinding points an attacker's hostname at this port. Its requests are same-origin to the
  // attacker's page, so a GET carries no Origin and would pass the origin checks below.
  if (!isAllowedHost(request.headers.host, bindHost)) {
    writeJson(response, 403, {
      error: {
        message: "Request host is not allowed to access the local O1-Code proxy.",
        type: "forbidden_host"
      }
    });
    return false;
  }

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

// Rebinding needs a hostname the attacker controls, so IP literals and localhost are safe. The
// configured bind host stays allowed for an O1_CODE_PROXY_HOST that names this machine.
export function isAllowedHost(host, bindHost = DEFAULT_HOST) {
  // Browsers send a bare host and optional port. Reject anything URL parsing could reinterpret.
  if (!host || /[/@?#\\\s]/.test(host)) {
    return false;
  }

  try {
    const name = new URL(`http://${host}`).hostname.toLowerCase();

    // URL parsing leaves an IPv4 literal in dotted-decimal form and an IPv6 literal in brackets.
    return name === "localhost" ||
      name === bindHost.toLowerCase() ||
      name.startsWith("[") ||
      /^\d+\.\d+\.\d+\.\d+$/.test(name);
  } catch {
    return false;
  }
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
  if (headers["sec-fetch-site"] === "cross-site") {
    return false;
  }

  return isAllowedBrowserOrigin(headers.origin);
}

export async function readJson(request, maxBytes = MAX_REQUEST_BODY_BYTES) {
  const chunks = [];
  let totalBytes = 0;

  const contentLength = Number(request.headers?.["content-length"]);
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw requestTooLarge(maxBytes);
  }

  for await (const chunk of request) {
    totalBytes += chunk.length;
    if (totalBytes > maxBytes) {
      throw requestTooLarge(maxBytes);
    }
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

function requestTooLarge(maxBytes) {
  const error = new Error(`Request body exceeds the ${maxBytes} byte limit.`);
  error.statusCode = 413;
  error.type = "request_too_large";
  return error;
}
