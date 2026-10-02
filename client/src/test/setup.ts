import "@testing-library/jest-dom/vitest";

// jsdom doesn't implement the pointer-capture or scroll APIs that Radix menus
// (DropdownMenu) call, so stub them to keep those components testable.
if (!Element.prototype.hasPointerCapture) {
  Element.prototype.hasPointerCapture = () => false;
}
if (!Element.prototype.setPointerCapture) {
  Element.prototype.setPointerCapture = () => {};
}
if (!Element.prototype.releasePointerCapture) {
  Element.prototype.releasePointerCapture = () => {};
}
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}

// vitest.config.ts pins TZ; fail loudly if a runner ever drops it, rather
// than letting time-dependent tests pass or fail by machine.
const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
if (zone !== "America/New_York") {
  throw new Error(`Tests must run with TZ=America/New_York (got ${zone}).`);
}
