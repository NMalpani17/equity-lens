/** Transcript search (RAG) routes. */
import { Router } from "express";

import * as rag from "../controllers/rag.controller.js";
import { asyncHandler } from "../middleware/asyncHandler.js";
import { requireAuth } from "../middleware/auth.js";

export const ragRouter = Router();

// Search spends upstream quota (embeddings, reranking, ingestion), so every
// route requires a valid Supabase JWT.
ragRouter.use("/rag", asyncHandler(requireAuth));

ragRouter.post("/rag/search", asyncHandler(rag.search));
ragRouter.get("/rag/tickers", asyncHandler(rag.listTickers));
ragRouter.get("/rag/tickers/:ticker", asyncHandler(rag.getTickerStatus));
