/** Mounts all route modules under a single router. */
import { Router } from "express";

import { healthRouter } from "./health.routes.js";

export const apiRouter = Router();

apiRouter.use(healthRouter);
