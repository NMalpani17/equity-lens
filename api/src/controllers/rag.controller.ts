/** Transcript search (RAG) controller (HTTP layer). */
import type { Request, Response } from "express";

import * as ragService from "../services/rag.service.js";
import { tickerSchema } from "../schemas/holding.schema.js";
import { ragSearchSchema } from "../schemas/rag.schema.js";

export async function search(req: Request, res: Response): Promise<void> {
  const input = ragSearchSchema.parse(req.body);
  const outcome = await ragService.searchTranscripts(input);
  // 202 tells the client the ticker is being indexed and to poll `pollUrl`.
  res.status(outcome.kind === "indexing" ? 202 : 200).json(outcome.body);
}

export async function getTickerStatus(req: Request, res: Response): Promise<void> {
  const ticker = tickerSchema.parse(req.params.ticker);
  res.status(200).json(await ragService.getTickerStatus(ticker));
}

export async function listTickers(_req: Request, res: Response): Promise<void> {
  res.status(200).json({ tickers: await ragService.listTickerStatuses() });
}
