/** AI analyst chat routes (all authenticated, scoped to the user). */
import { Router } from "express";

import * as chat from "../controllers/chat.controller.js";
import { asyncHandler } from "../middleware/asyncHandler.js";
import { requireAuth } from "../middleware/auth.js";

export const chatRouter = Router();

chatRouter.use(["/conversations", "/chat"], asyncHandler(requireAuth));

chatRouter.get("/conversations", asyncHandler(chat.listConversations));
chatRouter.post("/conversations", asyncHandler(chat.createConversation));
chatRouter.patch("/conversations/:id", asyncHandler(chat.renameConversation));
chatRouter.delete("/conversations/:id", asyncHandler(chat.deleteConversation));
chatRouter.get("/conversations/:id/messages", asyncHandler(chat.listMessages));
chatRouter.post("/conversations/:id/messages", asyncHandler(chat.sendMessage));
chatRouter.post(
  "/conversations/:id/messages/:messageId/retry",
  asyncHandler(chat.retryMessage),
);
chatRouter.get("/chat/usage", asyncHandler(chat.getUsage));
