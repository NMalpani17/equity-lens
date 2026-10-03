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
  app.use(express.json());

  // All API routes are mounted under /api.
  app.use("/api", apiRouter);

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
