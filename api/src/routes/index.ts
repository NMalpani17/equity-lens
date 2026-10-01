/** Mounts all route modules under a single router. */
import { Router } from "express";

import { healthRouter } from "./health.routes.js";
import { holdingsRouter } from "./holdings.routes.js";
import { portfolioRouter } from "./portfolio.routes.js";
import { accountRouter } from "./account.routes.js";
import { ragRouter } from "./rag.routes.js";

export const apiRouter = Router();

apiRouter.use(healthRouter);
apiRouter.use(holdingsRouter);
apiRouter.use(portfolioRouter);
apiRouter.use(accountRouter);
apiRouter.use(ragRouter);
