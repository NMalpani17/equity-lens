/** Centralized error handling and 404 fallback. */
import type { NextFunction, Request, Response } from "express";
import { ZodError } from "zod";

import { logger } from "../logger.js";
import { HttpError } from "../errors.js";

interface BodyParserError {
  type: string;
  status: number;
}

function isBodyParserError(err: unknown): err is BodyParserError {
  if (typeof err !== "object" || err === null) return false;
  const { type, status } = err as Partial<BodyParserError>;
  return (
    (type === "entity.too.large" || type === "entity.parse.failed") &&
    (status === 413 || status === 400)
  );
}

export function notFoundHandler(_req: Request, res: Response): void {
  res.status(404).json({ error: "not_found" });
}

/**
 * Express error-handling middleware. Must keep the 4-arg signature so Express
 * recognizes it as an error handler.
 */
export function errorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction,
): void {
  if (err instanceof ZodError) {
    logger.warn({ err: err.flatten() }, "validation error");
    // `message` is the first problem in plain words, like every other error body.
    res.status(422).json({
      error: "validation_error",
      message: err.issues[0]?.message ?? "Invalid request.",
      detail: err.flatten(),
    });
    return;
  }

  if (err instanceof HttpError) {
    logger.warn({ err: { code: err.code, message: err.message } }, err.code);
    res
      .status(err.status)
      .json({ ...err.details, error: err.code, message: err.message });
    return;
  }

  // body-parser's own errors (a body over the size limit, malformed JSON).
  if (isBodyParserError(err)) {
    logger.warn(
      { err: { type: err.type, status: err.status } },
      "invalid request body",
    );
    const tooLarge = err.status === 413;
    res.status(err.status).json({
      error: tooLarge ? "payload_too_large" : "invalid_body",
      message: tooLarge
        ? "The request is too large."
        : "The request body isn't valid JSON.",
    });
    return;
  }

  logger.error({ err }, "unhandled error");
  res.status(500).json({ error: "internal_server_error" });
}
