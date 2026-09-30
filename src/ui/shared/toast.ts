
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

let timer: ReturnType<typeof setTimeout> | undefined;
let expire: (() => void) | undefined;

function hide(host: HTMLElement): void {
  if (timer !== undefined) clearTimeout(timer);
  timer = undefined;
  host.hidden = true;
  host.replaceChildren();
}

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
  }, options.durationMs ?? DEFAULT_MS);
}

function flushToast(host: HTMLElement): void {
  const pending = expire;
  expire = undefined;
  hide(host);
  pending?.();
}
