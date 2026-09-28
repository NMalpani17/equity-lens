/**
 * Wraps an async route handler so rejected promises are forwarded to Express's
 * error-handling middleware. Express 4 does not catch async errors on its own.
 */
import type { NextFunction, Request, Response } from "express";

type AsyncRouteHandler = (
  req: Request,
  res: Response,
  next: NextFunction,
) => Promise<unknown>;

export function asyncHandler(handler: AsyncRouteHandler) {
  return (req: Request, res: Response, next: NextFunction): void => {
    handler(req, res, next).catch(next);
  };
}
