/**
 * One-shot flash message handed to the login page across a sign-out redirect
 * (e.g. after deleting an account). Uses sessionStorage so it survives the
 * navigation deterministically, then is consumed exactly once.
 */
const FLASH_KEY = "auth:flash";

/** Store a message to show on the next login-page visit. */
export function setAuthFlash(message: string): void {
  sessionStorage.setItem(FLASH_KEY, message);
}

/** Read and clear the stored flash message, if any. */
export function consumeAuthFlash(): string | null {
  const message = sessionStorage.getItem(FLASH_KEY);
  if (message !== null) {
    sessionStorage.removeItem(FLASH_KEY);
  }
  return message;
}
