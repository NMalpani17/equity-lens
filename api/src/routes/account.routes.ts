/** Account routes. */
import { Router } from "express";

import { deleteAccount } from "../controllers/account.controller.js";
import { asyncHandler } from "../middleware/asyncHandler.js";
import { requireAuth } from "../middleware/auth.js";

export const accountRouter = Router();

// The account route is user-specific and requires authentication.
accountRouter.use(asyncHandler(requireAuth));

accountRouter.delete("/account", asyncHandler(deleteAccount));
