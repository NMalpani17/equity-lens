/**
 * Cross-navigation hint for the login page.
 *
 * When a demo user taps "Sign up", we sign them out (which routes to the login
 * page) and want that page to open in sign-up mode. A sessionStorage flag
 * survives the navigation deterministically, unlike router state.
 */
const SIGNUP_INTENT_KEY = "auth:intent:signup";

/** Remember that the next login-page visit should open in sign-up mode. */
export function rememberSignupIntent(): void {
  sessionStorage.setItem(SIGNUP_INTENT_KEY, "1");
}

/** Whether a sign-up intent was set. */
export function hasSignupIntent(): boolean {
  return sessionStorage.getItem(SIGNUP_INTENT_KEY) === "1";
}

/** Clear any stored sign-up intent. */
export function clearSignupIntent(): void {
  sessionStorage.removeItem(SIGNUP_INTENT_KEY);
}
