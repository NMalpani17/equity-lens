/** Server-sent events over an Express response (chat and research reports). */
import type { Response } from "express";

import { config } from "../config.js";
import type { EventSink } from "../types.js";

export type { EventSink };

const SSE_HEADERS = {
  "Content-Type": "text/event-stream",
  "Cache-Control": "no-cache, no-transform",
  Connection: "keep-alive",
  "X-Accel-Buffering": "no",
};

export function sseSink(res: Response): EventSink {
  return {
    send(event, data) {
      // A client that has gone away gets nothing (a report run carries on).
      if (!res.writableEnded && !res.destroyed) {
        res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      }
    },
  };
}

/** Start the event stream; from here on, errors are sent as `error` events. */
export function startSse(res: Response): EventSink {
  res.status(200).set(SSE_HEADERS);
  res.flushHeaders();
  return sseSink(res);
}

/**
 * Write an SSE comment every `keepaliveMs` until stopped. Browsers ignore
 * comments; they keep proxies from closing a connection that is waiting on a
 * cold ai-service or a slow tool.
 */
export function startKeepalive(res: Response, keepaliveMs = config.chat.keepaliveMs) {
  const timer = setInterval(() => {
    if (!res.writableEnded && !res.destroyed) res.write(": keepalive\n\n");
  }, keepaliveMs);
  timer.unref();
  return () => clearInterval(timer);
}

/**
 * Abort signal for "the client went away". Attach it before any await: a
 * Stop clicked while the request is still being set up must not be missed.
 */
export function watchClient(res: Response): AbortController {
  const abort = new AbortController();
  res.on("close", () => {
    if (!res.writableEnded) abort.abort();
  });
  return abort;
}
