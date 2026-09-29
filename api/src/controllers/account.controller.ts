/** Account controller (HTTP layer). */
import type { Request, Response } from "express";

import * as accountService from "../services/account.service.js";
import { getUserId } from "../middleware/auth.js";

/** DELETE /api/account — permanently delete the authenticated user's account. */
export async function deleteAccount(req: Request, res: Response): Promise<void> {
  const userId = getUserId(req);
  await accountService.deleteAccount(userId);
  res.status(204).send();
}
