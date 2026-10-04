/**
 * Graceful shutdown on SIGTERM/SIGINT.
 *
 * Node as a container's PID 1 has no default SIGTERM handler, so without this
 * the process ignores the signal until the platform kills it (Cloud Run waits
 * ~10s). Here the server stops accepting connections, idle keep-alive sockets
 * close, in-flight requests get until `timeoutMs` to finish (a chat stream
 * still open then is cut off and saved as interrupted by the client's retry
 * flow), and the process exits.
 */
import type { Server } from "node:http";

import { logger } from "./logger.js";

export interface ShutdownOptions {
  /** Hard limit before exiting with connections still open. */
  timeoutMs?: number;
  /** Cleanup after the server has closed (e.g. disconnect the database). */
  onClose?: () => Promise<void>;
  exit?: (code: number) => void;
}

/** Returns the shutdown function (also registered for SIGTERM and SIGINT). */
export function registerShutdown(
  server: Server,
  {
    timeoutMs = 8000,
    onClose = async () => {},
    exit = process.exit,
  }: ShutdownOptions = {},
): (signal: string) => void {
  let closing = false;
  const shutdown = (signal: string) => {
    if (closing) return;
    closing = true;
    logger.info({ signal }, "shutting down");
    const force = setTimeout(() => {
      logger.warn({ timeoutMs }, "shutdown timed out; exiting with open connections");
      exit(0);
    }, timeoutMs);
    force.unref();
    server.close(() => {
      onClose()
        .catch((error: unknown) =>
          logger.warn({ err: error }, "shutdown cleanup failed"),
        )
        .finally(() => {
          clearTimeout(force);
          exit(0);
        });
    });
    server.closeIdleConnections();
  };
  process.once("SIGTERM", () => shutdown("SIGTERM"));
  process.once("SIGINT", () => shutdown("SIGINT"));
  return shutdown;
}
