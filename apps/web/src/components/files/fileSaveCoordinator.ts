import type { AtomCommandResult } from "@t3tools/client-runtime/state/runtime";

export interface FileSaveCoordinatorOptions<A, E> {
  readonly debounceMs: number;
  readonly persist: (contents: string) => Promise<AtomCommandResult<A, E>>;
  readonly onPendingChange: (pending: boolean) => void;
  readonly onConfirmed: (contents: string) => void;
  readonly onSaveFailed?: (result: AtomCommandResult<unknown, unknown>) => void;
}

const RETRY_MIN_DELAY_MS = 1_000;
const RETRY_MAX_DELAY_MS = 15_000;

export class FileSaveCoordinator<A = unknown, E = unknown> {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private latestContents = "";
  private latestRevision = 0;
  private lastChangeAt = 0;
  private saving = false;
  private disposed = false;
  private retryDelayMs = 0;

  constructor(private readonly options: FileSaveCoordinatorOptions<A, E>) {}

  change(contents: string): void {
    this.latestContents = contents;
    this.latestRevision += 1;
    this.lastChangeAt = Date.now();
    this.options.onPendingChange(true);
    this.schedule(this.options.debounceMs);
  }

  dispose(): void {
    this.disposed = true;
    this.clearTimer();
    if (this.latestRevision > 0) void this.persistLatest();
  }

  private schedule(delay: number): void {
    this.clearTimer();
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.persistLatest();
    }, delay);
  }

  private clearTimer(): void {
    if (this.timer === null) return;
    clearTimeout(this.timer);
    this.timer = null;
  }

  private async persistLatest(): Promise<void> {
    if (this.saving || this.latestRevision === 0) return;

    this.saving = true;
    const contents = this.latestContents;
    const revision = this.latestRevision;
    const result = await this.options.persist(contents);
    const succeeded = result._tag === "Success";
    if (succeeded) {
      this.retryDelayMs = 0;
      this.options.onConfirmed(contents);
    }

    this.saving = false;
    if (revision === this.latestRevision) {
      if (succeeded) {
        this.options.onPendingChange(false);
      } else if (!this.disposed) {
        // A failed write must not strand the edit in memory: keep it pending and
        // retry with capped backoff until a write lands or newer contents replace it.
        const firstFailure = this.retryDelayMs === 0;
        this.retryDelayMs = Math.min(
          Math.max(this.retryDelayMs * 2, RETRY_MIN_DELAY_MS),
          RETRY_MAX_DELAY_MS,
        );
        if (firstFailure) this.options.onSaveFailed?.(result);
        this.schedule(this.retryDelayMs);
      }
      return;
    }

    const remainingDebounce = Math.max(
      0,
      this.options.debounceMs - (Date.now() - this.lastChangeAt),
    );
    if (this.disposed) {
      void this.persistLatest();
    } else {
      this.schedule(remainingDebounce);
    }
  }
}
