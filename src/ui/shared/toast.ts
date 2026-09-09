/**
 * One toast at a time, with an optional action (the list's Undo).
 *
 * The host element is passed in rather than looked up, so the three pages can
 * each place their own `.toast` in their own markup and still get the same
 * behaviour and the same timing out of it.
 *
 * The toast counts down how long the action stays on offer, not how long until
 * anything happens - a deletion is already in the database by the time the
 * toast appears. `onExpire` fires whenever the toast goes without the action
 * being used, which is how the caller drops what it was holding for it.
 */

export interface ToastAction {
  label: string;
  run: () => void;
}

export interface ToastOptions {
  message: string;
  action?: ToastAction;
  durationMs?: number;
  onExpire?: () => void;
}

const DEFAULT_MS = 5_000;

let timer: number | undefined;
let expire: (() => void) | undefined;

function hide(host: HTMLElement): void {
  if (timer !== undefined) clearTimeout(timer);
  timer = undefined;
  host.hidden = true;
  host.replaceChildren();
}

/** Closes the previous toast (firing its `onExpire`) and shows a new one. */
export function showToast(host: HTMLElement, options: ToastOptions): void {
  flushToast(host);

  const text = document.createElement('span');
  text.className = 'toast__text';
  text.textContent = options.message;
  host.append(text);

  if (options.action !== undefined) {
    const { label, run } = options.action;
    const action = document.createElement('button');
    action.type = 'button';
    action.className = 'toast__action';
    action.textContent = label;
    action.addEventListener('click', () => {
      expire = undefined;
      hide(host);
      run();
    });
    host.append(action);
  }

  host.hidden = false;
  expire = options.onExpire;
  timer = setTimeout(() => {
    const pending = expire;
    expire = undefined;
    hide(host);
    pending?.();
  }, options.durationMs ?? DEFAULT_MS) as unknown as number;
}

/** Closes the toast immediately, as if the time had run out. */
function flushToast(host: HTMLElement): void {
  const pending = expire;
  expire = undefined;
  hide(host);
  pending?.();
}
