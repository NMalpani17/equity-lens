/** Typed application errors mapped to HTTP responses by the error handler. */

/** Base class for errors that carry an HTTP status and a machine-readable code. */
export class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message?: string,
    /** Extra machine-readable fields merged into the JSON error body. */
    public readonly details: Record<string, unknown> = {},
  ) {
    super(message ?? code);
    this.name = new.target.name;
  }
}

/** 401 — the request lacks a valid authentication token. */
export class UnauthorizedError extends HttpError {
  constructor(message = "authentication required") {
    super(401, "unauthorized", message);
  }
}

/** 404 — the requested resource does not exist. */
export class NotFoundError extends HttpError {
  constructor(message = "resource not found") {
    super(404, "not_found", message);
  }
}

/** 502 — an upstream dependency failed or returned an unusable response. */
export class UpstreamError extends HttpError {
  constructor(message = "upstream service error") {
    super(502, "upstream_error", message);
  }
}

/** 422 — a submitted ticker is not recognized by the market-data service. */
export class InvalidTickerError extends HttpError {
  constructor(message = "unrecognized ticker symbol") {
    super(422, "invalid_ticker", message);
  }
}

/** 409 — the conversation already has a turn in progress. */
export class TurnInProgressError extends HttpError {
  constructor(message = "a reply is still being generated in this conversation") {
    super(409, "turn_in_progress", message);
  }
}

/** 429 — a chat message cap (per user or global) has been reached. */
export class ChatLimitError extends HttpError {
  constructor(
    scope: "user" | "global",
    limit: number,
    resetsAt: string,
    message: string,
  ) {
    super(429, "chat_limit_reached", message, { scope, limit, resetsAt });
  }
}

/** 503 — a feature's upstream dependency is not configured or unavailable. */
export class ServiceUnavailableError extends HttpError {
  constructor(code: string, message: string) {
    super(503, code, message);
  }
}
