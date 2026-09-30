import { required } from '@/ui/shared/dom';

export function createConfirm(): (title: string, message: string) => Promise<boolean> {
  const dialog = required<HTMLDialogElement>('#confirm-dialog');
  const heading = required<HTMLHeadingElement>('#confirm-title');
  const text = required<HTMLParagraphElement>('#confirm-text');
  const ok = required<HTMLButtonElement>('#confirm-ok');
  const cancel = required<HTMLButtonElement>('#confirm-cancel');

  return (title, message) => {
    heading.textContent = title;
    text.textContent = message;

    return new Promise<boolean>((resolve) => {
      const controller = new AbortController();
      const finish = (value: boolean): void => {
        controller.abort();
        dialog.close();
        resolve(value);
      };

      ok.addEventListener('click', () => {
        finish(true);
      }, { signal: controller.signal });
      cancel.addEventListener('click', () => {
        finish(false);
      }, { signal: controller.signal });
      dialog.addEventListener('close', () => {
        finish(false);
      }, { signal: controller.signal });

      dialog.showModal();
    });
  };
}
