/** Typed application errors mapped to HTTP responses by the error handler. */

/** Base class for errors that carry an HTTP status and a machine-readable code. */
export class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message?: string,
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
