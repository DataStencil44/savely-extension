/**
 * One toast at a time, with an optional action (here: undoing a deletion).
 *
 * The toast is not just decoration: it is what counts down the time after which
 * a deletion becomes real. That is why `onExpire` always fires when the toast
 * disappears without the action being used - including a manual dismissal.
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

/** Closes the toast immediately as if the time had run out (on window close, say). */
export function flushToast(host: HTMLElement): void {
  const pending = expire;
  expire = undefined;
  hide(host);
  pending?.();
}
