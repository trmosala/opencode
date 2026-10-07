import { expect, test } from "bun:test";
import { startServerWithActions } from "./server.mjs";

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
