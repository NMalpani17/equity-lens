/** Holdings CRUD routes. */
import { Router } from "express";

import * as holdings from "../controllers/holdings.controller.js";
import { asyncHandler } from "../middleware/asyncHandler.js";

export const holdingsRouter = Router();

holdingsRouter.get("/holdings", asyncHandler(holdings.listHoldings));
holdingsRouter.post("/holdings", asyncHandler(holdings.createHolding));
holdingsRouter.get("/holdings/:id", asyncHandler(holdings.getHolding));
holdingsRouter.patch("/holdings/:id", asyncHandler(holdings.updateHolding));
holdingsRouter.delete("/holdings/:id", asyncHandler(holdings.deleteHolding));
