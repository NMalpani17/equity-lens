/**
 * Wake the ai-service (it scales to zero) so it's starting up before the
 * user's first question. Called once a session exists: on load when already
 * signed in, and right after login or demo sign-in.
 */
import { API_URL } from "./api";

/** The API allows one warm-up per user per minute; don't ask more often. */
const MIN_INTERVAL_MS = 60_000;

let lastWarmUpAt: number | null = null;

/** Fire-and-forget: never awaited by the UI, never throws, errors ignored. */
export function warmUp(accessToken: string, now: () => number = Date.now): void {
  const time = now();
  if (lastWarmUpAt !== null && time - lastWarmUpAt < MIN_INTERVAL_MS) return;
  lastWarmUpAt = time;
  fetch(`${API_URL}/api/warmup`, {
    method: "POST",
    keepalive: true,
    headers: { Authorization: `Bearer ${accessToken}` },
  }).catch(() => {
    // Best effort: a failed warm-up only means a slower first answer.
  });
}

/** Forget the last warm-up (tests). */
export function resetWarmUp(): void {
  lastWarmUpAt = null;
}
