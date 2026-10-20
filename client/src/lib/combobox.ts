/**
 * For a dialog's onEscapeKeyDown: Escape first closes an open suggestion list
 * (a combobox with aria-expanded="true"), not the dialog. The dialog's
 * handler runs before the field's, while the list is still expanded.
 */
export function keepOpenForSuggestions(event: KeyboardEvent): void {
  const target = event.target;
  if (
    target instanceof HTMLElement &&
    target.getAttribute("aria-expanded") === "true"
  ) {
    event.preventDefault();
  }
}
