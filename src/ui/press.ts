/**
 * The one way a mouse control acts: it presses the key it names. A synthetic keydown goes to the
 * window, where the page's key handler (keys.ts `handleKey`, listened for by App.tsx) takes it as
 * it takes a real one, so a button, a menu item or the selection bar does exactly what its key does
 * and no action has a second implementation.
 */
export function press(key: string, shift = false) {
  // "A-h": Alt with that key, by its place on the keyboard as the keymap reads it.
  if (key.startsWith("A-")) {
    const k = key.slice(2);
    return void window.dispatchEvent(new KeyboardEvent("keydown", { key: k, code: k.length === 1 ? `Key${k.toUpperCase()}` : k, altKey: true, shiftKey: shift, bubbles: true, cancelable: true }));
  }
  window.dispatchEvent(new KeyboardEvent("keydown", { key, shiftKey: shift, bubbles: true, cancelable: true }));
}
