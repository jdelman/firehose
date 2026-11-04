const TAP_SLOP_PX = 12;
const COMPATIBILITY_CLICK_MS = 750;

/** Activate touch buttons without waiting for an emulated mouse click. */
export function bindButtonActivation(button: HTMLButtonElement, activate: () => void): void {
  let touch: { id: number; x: number; y: number } | null = null;
  let suppressClickUntil = -Infinity;

  button.addEventListener('pointerdown', event => {
    // A real mouse interaction must still work immediately after a touch.
    if (event.pointerType === 'mouse') suppressClickUntil = -Infinity;
    if (event.pointerType !== 'touch' || !event.isPrimary || button.disabled) return;
    touch = { id: event.pointerId, x: event.clientX, y: event.clientY };
  });
  button.addEventListener('pointermove', event => {
    if (touch?.id === event.pointerId
      && Math.hypot(event.clientX - touch.x, event.clientY - touch.y) > TAP_SLOP_PX) {
      touch = null;
    }
  });
  button.addEventListener('pointercancel', () => { touch = null; });
  button.addEventListener('pointerup', event => {
    if (touch?.id !== event.pointerId) return;
    const start = touch;
    touch = null;
    const bounds = button.getBoundingClientRect();
    if (button.disabled || Math.hypot(event.clientX - start.x, event.clientY - start.y) > TAP_SLOP_PX
      || event.clientX < bounds.left || event.clientX > bounds.right
      || event.clientY < bounds.top || event.clientY > bounds.bottom) return;
    suppressClickUntil = performance.now() + COMPATIBILITY_CLICK_MS;
    activate();
  });
  button.addEventListener('click', event => {
    // Safari can label a touch-generated click as a mouse event. Keep keyboard
    // and assistive-technology clicks (detail = 0), but swallow the duplicate.
    if (event.detail !== 0 && performance.now() < suppressClickUntil) {
      event.preventDefault();
      return;
    }
    if (!button.disabled) activate();
  });
}
