/**
 * The one way a mouse control acts: it presses the key it names. A synthetic keydown goes to the
 * window, where the page's key handler (keys.ts `handleKey`, listened for by App.tsx) takes it as
 * it takes a real one, so a button, a menu item or the selection bar does exactly what its key does
 * and no action has a second implementation.
 */
export function press(key: string, shift = false) {
  window.dispatchEvent(new KeyboardEvent("keydown", { key, shiftKey: shift, bubbles: true, cancelable: true }));
}
