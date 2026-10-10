import * as vscode from 'vscode';

/**
 * One "the index changed" signal for every surface that shows index data (views,
 * lenses, diagnostics, status bar): fired by the watcher, a rescan, the reference
 * index landing and installed plugins being re-read — debounced, so a burst of
 * changes refreshes each surface once.
 */
export class RefreshBus implements vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly event = this.emitter.event;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly delayMs = 150) {}

  fire(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.emitter.fire();
    }, this.delayMs);
  }

  /** Fire now (initial load, explicit refresh). */
  fireNow(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.emitter.fire();
  }

  dispose(): void {
    if (this.timer) clearTimeout(this.timer);
    this.emitter.dispose();
  }
}

export function setContext(key: string, value: unknown): void {
  void vscode.commands.executeCommand('setContext', key, value);
}
