/**
 * Keyboard handling for small edit forms. Enter and Escape that belong to an IME
 * composition only finish the composition; they never submit or cancel the form.
 */
export type ImeKeyOptions = {
  escape?: (event: KeyboardEvent) => void;
  /** Called for Enter outside composition; return true when the key was handled. */
  submit?: (event: KeyboardEvent) => boolean | void;
};
export function imeKeys(node: HTMLElement, initial: ImeKeyOptions) {
  let options = initial,
    composing = false,
    ignoreSubmit = false;
  const start = () => (composing = true),
    end = () => {
      composing = false;
      // Chromium dispatches the committing Enter's submit after compositionend.
      ignoreSubmit = true;
      setTimeout(() => (ignoreSubmit = false), 0);
    };
  const keydown = (event: KeyboardEvent) => {
    if (event.isComposing || composing || event.keyCode === 229) {
      if (event.key === 'Enter' || event.key === 'Escape') event.stopPropagation();
      return;
    }
    if (event.key === 'Escape' && options.escape) {
      event.preventDefault();
      event.stopPropagation();
      options.escape(event);
    } else if (event.key === 'Enter') {
      if (options.submit?.(event)) event.preventDefault();
    }
  };
  const submit = (event: Event) => {
    if (composing || ignoreSubmit) {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
  };
  node.addEventListener('keydown', keydown);
  node.addEventListener('compositionstart', start);
  node.addEventListener('compositionend', end);
  node.addEventListener('submit', submit, true);
  return {
    update(next: ImeKeyOptions) {
      options = next;
    },
    destroy() {
      node.removeEventListener('keydown', keydown);
      node.removeEventListener('compositionstart', start);
      node.removeEventListener('compositionend', end);
      node.removeEventListener('submit', submit, true);
    },
  };
}
