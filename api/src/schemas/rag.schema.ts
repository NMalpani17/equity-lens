/** Zod schemas for transcript search (RAG) input from the client. */
import { z } from "zod";

import { tickerSchema } from "./holding.schema.js";

export const ragSearchSchema = z.object({
  query: z.string().trim().min(1, "query is required").max(1000),
  ticker: tickerSchema.optional(),
  fiscalYear: z.number().int().min(1990).max(2100).optional(),
  fiscalQuarter: z.number().int().min(1).max(4).optional(),
  topK: z.number().int().min(1).max(20).default(5),
});

export type RagSearchInput = z.infer<typeof ragSearchSchema>;
