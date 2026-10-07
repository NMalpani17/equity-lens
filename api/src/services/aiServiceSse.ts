/**
 * Opening a server-sent-events stream from the ai-service (chat and reports).
 *
 * The request carries the gateway's internal token (and, in production, a
 * Google ID token) through `aiServiceFetch`. A connect timer covers a cold
 * start until the response headers arrive; it never applies to the stream
 * once it has started. The client going away aborts the upstream request,
 * which cancels the ai-service's run.
 */
import { config } from "../config.js";
import { HttpError, ServiceUnavailableError, UpstreamError } from "../errors.js";
import { logger } from "../logger.js";
import { aiServiceFetch, aiServiceUrl } from "./aiServiceClient.js";

export interface SseFrame {
  event: string;
  data: unknown;
}

export interface OpenSseOptions {
  path: string;
  body: unknown;
  signal: AbortSignal;
  connectTimeoutMs: number;
  /** For logs: "chat" or "report". */
  label: string;
  notConfigured: { code: string; message: string };
  unavailable: { code: string; message: string };
  /** The message for any other refusal. */
  unexpectedMessage: string;
  /** Map a refusal (non-2xx) to a specific error; otherwise the defaults. */
  refused?: (
    status: number,
    body: { error?: string; message?: string },
  ) => HttpError | undefined;
}

/** Parse an SSE byte stream into (event, data) pairs. */
export async function* parseSse(
  body: AsyncIterable<Uint8Array>,
): AsyncGenerator<{ event: string; data: string }> {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true }).replace(/\r\n/g, "\n");
    let boundary: number;
    while ((boundary = buffer.indexOf("\n\n")) !== -1) {
      const frame = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      let event = "message";
      const data: string[] = [];
      for (const line of frame.split("\n")) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
      }
      if (data.length > 0) yield { event, data: data.join("\n") };
    }
  }
}

/**
 * Open the upstream stream. Throws an HttpError when the ai-service is
 * unconfigured, unreachable, refuses, or doesn't answer within
 * `connectTimeoutMs`. Yields JSON-decoded frames; non-JSON frames are dropped.
 */
export async function openAiServiceSse(
  options: OpenSseOptions,
): Promise<AsyncGenerator<SseFrame>> {
  const { path, body, signal, connectTimeoutMs, label } = options;
  if (!config.aiServiceInternalToken) {
    throw new ServiceUnavailableError(
      options.notConfigured.code,
      options.notConfigured.message,
    );
  }
  const url = aiServiceUrl(path);
  // One signal for the whole request: aborted by the client going away, or by
  // the connect timer until the response headers arrive.
  const upstream = new AbortController();
  const onClientAbort = () => upstream.abort(signal.reason);
  if (signal.aborted) upstream.abort(signal.reason);
  else signal.addEventListener("abort", onClientAbort, { once: true });
  let timedOut = false;
  const connectTimer = setTimeout(() => {
    timedOut = true;
    upstream.abort(new Error("ai-service connect timeout"));
  }, connectTimeoutMs);
  let response: Response;
  try {
    response = await aiServiceFetch(url, {
      method: "POST",
      signal: upstream.signal,
      headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
      body: JSON.stringify(body),
    });
  } catch (error) {
    if (signal.aborted) throw error;
    if (timedOut) {
      logger.warn(
        { url: url.toString(), connectTimeoutMs },
        `ai-service ${label} did not answer in time`,
      );
    } else {
      logger.warn(
        { url: url.toString(), err: error },
        `failed to reach ai-service ${label}`,
      );
    }
    throw new ServiceUnavailableError(
      options.unavailable.code,
      options.unavailable.message,
    );
  } finally {
    clearTimeout(connectTimer);
  }

  if (!response.ok || !response.body) {
    let refusal: { error?: string; message?: string } = {};
    try {
      refusal = (await response.json()) as typeof refusal;
    } catch {
      // non-JSON error body
    }
    logger.warn(
      { status: response.status, body: refusal },
      `ai-service ${label} refused the request`,
    );
    const specific = options.refused?.(response.status, refusal);
    if (specific) throw specific;
    if (response.status === 401 || response.status === 503) {
      throw new ServiceUnavailableError(
        options.unavailable.code,
        options.unavailable.message,
      );
    }
    throw new UpstreamError(options.unexpectedMessage);
  }

  const stream = response.body;
  return (async function* frames() {
    for await (const frame of parseSse(stream as AsyncIterable<Uint8Array>)) {
      let data: unknown;
      try {
        data = JSON.parse(frame.data);
      } catch {
        logger.warn({ event: frame.event }, `dropping non-JSON ${label} event`);
        continue;
      }
      yield { event: frame.event, data };
    }
  })();
}
