/** Express application factory. */
import express, { type Express } from "express";
import cors from "cors";
import { pinoHttp } from "pino-http";

import { config } from "./config.js";
import { logger } from "./logger.js";
import { apiRouter } from "./routes/index.js";
import { errorHandler, notFoundHandler } from "./middleware/errorHandler.js";

export function createApp(): Express {
  const app = express();

  app.use(pinoHttp({ logger }));
  // An array of strings: the cors package allows an origin only on an exact match.
  app.use(cors({ origin: config.clientOrigins }));
  // CSV imports carry the file's text, so they get a larger body limit (JSON
  // escaping can double it); the schema enforces the file-size limit itself.
  // Parsed here first, the default parser below skips these bodies.
  app.use(
    "/api/holdings/import",
    express.json({ limit: config.holdings.importMaxFileBytes * 2 + 1024 }),
  );
  app.use(express.json());

  // All API routes are mounted under /api.
  app.use("/api", apiRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
