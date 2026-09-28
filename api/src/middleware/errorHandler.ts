/** Centralized error handling and 404 fallback. */
import type { NextFunction, Request, Response } from "express";
import { ZodError } from "zod";

import { logger } from "../logger.js";
import { HttpError } from "../errors.js";

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
    res.status(422).json({ error: "validation_error", detail: err.flatten() });
    return;
  }

  if (err instanceof HttpError) {
    logger.warn({ err: { code: err.code, message: err.message } }, err.code);
    res.status(err.status).json({ error: err.code, message: err.message });
    return;
  }

  logger.error({ err }, "unhandled error");
  res.status(500).json({ error: "internal_server_error" });
}
