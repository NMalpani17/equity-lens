/** Ambient augmentation of the Express Request with auth context. */
import "express";

declare global {
  namespace Express {
    interface Request {
      /** The authenticated user's id, set by `requireAuth`. */
      userId?: string;
      /** True for anonymous demo users, set by `requireAuth`. */
      isAnonymous?: boolean;
    }
  }
}
