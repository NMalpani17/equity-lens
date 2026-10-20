/** Zod schemas validating company search input (external data). */
import { z } from "zod";

export const symbolSearchQuerySchema = z.object({
  q: z
    .string({ required_error: "q is required" })
    .trim()
    .min(1, "q is required")
    .max(50, "q must be at most 50 characters"),
});
