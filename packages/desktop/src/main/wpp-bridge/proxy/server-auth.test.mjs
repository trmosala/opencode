import { expect, test } from "bun:test";
import net from "node:net";
import { startServerWithActions } from "./server.mjs";

// fetch() always sends the real Host header, so a raw request stands in for a DNS-rebinding page.
function statusWithHost(port, path, host) {
  const crlf = String.fromCharCode(13, 10);
  return new Promise((resolve, reject) => {
    let reply = "";
    const socket = net.connect(port, "127.0.0.1", () => {
      socket.write([`GET ${path} HTTP/1.1`, `Host: ${host}`, "Connection: close", "", ""].join(crlf));
    });
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => { reply += chunk; });
    socket.on("end", () => resolve(Number(reply.split(" ")[1])));
    socket.on("error", reject);
  });
}

test("every route rejects a rebinding Host and extension origins", async () => {
  let login = 0;
  const server = await startServerWithActions({
    host: "127.0.0.1", port: 0,
    checkAuth: async () => ({ status: "signed-in" }),
    openLogin: async () => { login++; },
  });
  const port = server.address().port;
  try {
    for (const path of ["/status", "/health", "/bridge/health", "/bridge/auth", "/v1/models"]) {
      expect(await statusWithHost(port, path, "rebind.example:" + port)).toBe(403);
      expect(await statusWithHost(port, path, "127.0.0.1:" + port)).toBe(200);
      expect(await statusWithHost(port, path, "localhost:" + port)).toBe(200);
    }
    const extension = { method: "POST", headers: { Origin: "chrome-extension://abcdefghijklmnop" } };
    expect((await fetch("http://127.0.0.1:" + port + "/bridge/login", extension)).status).toBe(403);
    expect(login).toBe(0);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("live auth probe discloses only status, enforces origin checks and opens sign-in", async () => {
  let status = "signed-out";
  let login = 0;
  const server = await startServerWithActions({
    host: "127.0.0.1", port: 0,
    checkAuth: async () => ({ status, expires_at: 123, access_token: "must-not-be-disclosed" }),
    openLogin: async () => { login++; },
  });
  const url = "http://127.0.0.1:" + server.address().port;
  try {
    expect(await (await fetch(url + "/bridge/auth")).json()).toEqual({ status: "signed-out" });
    status = "signed-in";
    expect(await (await fetch(url + "/bridge/auth")).json()).toEqual({ status: "signed-in" });
    expect((await fetch(url + "/bridge/auth", { headers: { Origin: "https://untrusted.example" } })).status).toBe(403);
    expect((await fetch(url + "/bridge/login", { method: "POST" })).status).toBe(200);
    expect(login).toBe(1);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("missing auth probe reports unknown", async () => {
  const server = await startServerWithActions({ host: "127.0.0.1", port: 0 });
  try {
    const response = await fetch("http://127.0.0.1:" + server.address().port + "/bridge/auth");
    expect(await response.json()).toEqual({ status: "unknown" });
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});
