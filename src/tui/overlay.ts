import {
  type Component,
  type Focusable,
  Input,
  matchesKey,
  Text,
  truncateToWidth,
} from "@earendil-works/pi-tui";
import type { BtwThreadState } from "../contract.js";
export interface OverlayActions {
  state(): BtwThreadState | null;
  transcript(): string;
  ask(question: string): Promise<void>;
  abort(): void;
  dismiss(): void;
  render(): void;
}
export class BtwOverlay implements Component, Focusable {
  readonly input = new Input({
    prompt: "BTW > ",
    placeholder: "Ask a side question",
  });
  private pending = false;
  private error: string | null = null;
  constructor(private actions: OverlayActions) {
    this.input.onSubmit = (question) => {
      if (!question.trim() || this.pending) return;
      this.pending = true;
      this.error = null;
      void actions
        .ask(question)
        .then(
          () => this.input.setValue(""),
          (error: unknown) => {
            this.error = error instanceof Error ? error.message : String(error);
          },
        )
        .finally(() => {
          this.pending = false;
          actions.render();
        });
    };
  }
  get focused(): boolean {
    return this.input.focused;
  }
  set focused(value: boolean) {
    this.input.focused = value;
  }
  handleInput(data: string): void {
    if (matchesKey(data, "escape")) {
      if (this.actions.state()?.status === "running") this.actions.abort();
      else this.actions.dismiss();
      return;
    }
    this.input.handleInput(data);
  }
  invalidate(): void {
    this.input.invalidate();
  }
  render(width: number): string[] {
    const state = this.actions.state();
    const pin = state?.boundary.parentTurnIndex ?? "none";
    const ahead = state?.parentAhead
      ? ` · next question uses turn ${Number(pin) + state.parentAhead}`
      : "";
    const header = `BTW · ${state?.status ?? "idle"} · pinned turn ${pin}${ahead}`;
    const transcript = new Text(this.actions.transcript(), 0, 0)
      .render(width)
      .slice(-12);
    const error = this.error ?? state?.error;
    return [
      truncateToWidth(header, width),
      ...transcript,
      ...new Text(
        error ?? "Esc: stop BTW, then dismiss · main agent continues",
        0,
        0,
      ).render(width),
      ...this.input.render(width),
    ];
  }
}
