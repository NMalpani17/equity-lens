import { createServer, request, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it, vi } from "vitest";

import { registerShutdown } from "../src/shutdown.js";

function listen(server: Server): Promise<number> {
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () =>
      resolve((server.address() as AddressInfo).port),
    ),
  );
}

afterEach(() => {
  process.removeAllListeners("SIGTERM");
  process.removeAllListeners("SIGINT");
});

describe("registerShutdown", () => {
  it("closes the server, runs cleanup and exits promptly when idle", async () => {
    const server = createServer((_req, res) => res.end("ok"));
    await listen(server);
    const exit = vi.fn();
    const onClose = vi.fn(async () => {});

    const shutdown = registerShutdown(server, { timeoutMs: 5000, onClose, exit });
    shutdown("SIGTERM");

    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0), { timeout: 2000 });
    expect(onClose).toHaveBeenCalledOnce();
    expect(server.listening).toBe(false);
  });

  it("exits at the time limit even while a request (e.g. a chat stream) is open", async () => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(": keepalive\n\n"); // never ends
    });
    const port = await listen(server);
    await new Promise<void>((resolve) => {
      request({ port, host: "127.0.0.1", path: "/" }, () => resolve()).end();
    });
    const exit = vi.fn();
    const started = Date.now();

    registerShutdown(server, { timeoutMs: 150, exit })("SIGTERM");

    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0), { timeout: 2000 });
    expect(Date.now() - started).toBeLessThan(1500);
    server.closeAllConnections();
  });

  it("handles SIGTERM once", async () => {
    const server = createServer((_req, res) => res.end("ok"));
    await listen(server);
    const exit = vi.fn();
    const onClose = vi.fn(async () => {});
    registerShutdown(server, { timeoutMs: 5000, onClose, exit });

    process.emit("SIGTERM");
    process.emit("SIGTERM");

    await vi.waitFor(() => expect(exit).toHaveBeenCalled(), { timeout: 2000 });
    expect(onClose).toHaveBeenCalledOnce();
  });
});
