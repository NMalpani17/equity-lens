/** Zod schemas validating watchlist input (external data). */
import { z } from "zod";

import { tickerSchema } from "./holding.schema.js";

export const addWatchlistItemSchema = z.object({ ticker: tickerSchema }).strict();

export const watchlistTickerParamSchema = tickerSchema;
