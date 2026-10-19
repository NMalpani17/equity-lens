/** Zod schemas validating portfolio query input (external data). */
import { z } from "zod";

import { PERFORMANCE_RANGES } from "../types.js";

export const performanceQuerySchema = z.object({
  range: z
    .string()
    .trim()
    .toUpperCase()
    .pipe(
      z.enum(PERFORMANCE_RANGES, { message: "range must be 1M, 3M, 6M, 1Y or ALL" }),
    )
    .default("1Y"),
});
