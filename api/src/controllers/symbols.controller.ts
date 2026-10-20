/** Company search controller (HTTP layer). */
import type { Request, Response } from "express";

import { symbolSearchQuerySchema } from "../schemas/symbol.schema.js";
import { searchSymbols } from "../services/symbols.service.js";

/** GET /api/symbols/search?q= — suggestions for Add holding and the watchlist. */
export async function search(req: Request, res: Response): Promise<void> {
  const { q } = symbolSearchQuerySchema.parse(req.query);
  res.status(200).json(await searchSymbols(q));
}
