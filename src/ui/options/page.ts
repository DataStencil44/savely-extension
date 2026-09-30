export interface Page {
  toast(message: string): void;
  ask(title: string, message: string): Promise<boolean>;
  refresh(): Promise<void>;
}

export interface Section {
  refresh(): Promise<void>;
}

export const numbers = new Intl.NumberFormat('en-US');

export function formatWhen(at: number): string {
  return new Date(at).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' });
}
