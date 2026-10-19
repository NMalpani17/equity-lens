/** CSV holdings import controller (HTTP layer). Validates input and delegates. */
import type { Request, Response } from "express";

import { importHoldings, previewImport } from "../services/csvImport.service.js";
import { getUserId } from "../middleware/auth.js";
import { importCommitSchema, importPreviewSchema } from "../schemas/import.schema.js";

/** Validate a CSV and return its rows and row-level errors; writes nothing. */
export async function preview(req: Request, res: Response): Promise<void> {
  const { csv } = importPreviewSchema.parse(req.body);
  res.status(200).json(await previewImport(csv));
}

/** Save the confirmed rows in one transaction (all or nothing). */
export async function commit(req: Request, res: Response): Promise<void> {
  const userId = getUserId(req);
  const input = importCommitSchema.parse(req.body);
  res.status(201).json(await importHoldings(input, userId));
}
