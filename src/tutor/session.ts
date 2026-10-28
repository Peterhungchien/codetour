import { PiTutorProvider } from "./provider";
import { TutorContext, TutorMessage, TutorProvider, TutorResponse } from "./types";

export class TutorSession {
  private conversations = new Map<number, TutorMessage[]>();
  private provider?: Promise<TutorProvider>;
  private disposed = false;
  private pending?: { step: number; status: string };
  private listeners = new Set<(step: number) => void>();

  constructor(
    private readonly workspaceRoot?: string,
    private readonly createProvider: (root: string) => Promise<TutorProvider> = root => PiTutorProvider.create(root)
  ) {}

  get isBusy(): boolean {
    return !!this.pending;
  }

  getStatus(step: number): string | undefined {
    return this.pending?.step === step ? this.pending.status : undefined;
  }

  subscribe(listener: (step: number) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private changed(step: number): void {
    for (const listener of this.listeners) listener(step);
  }

  getMessages(step: number): TutorMessage[] {
    return this.conversations.get(step) ?? [];
  }

  appendMessage(step: number, message: TutorMessage): void {
    this.conversations.set(step, [...this.getMessages(step), message]);
  }

  async respond(context: TutorContext): Promise<TutorResponse> {
    if (this.disposed) throw new Error("This tour has ended.");
    if (!this.workspaceRoot) throw new Error("The tutor needs a local workspace folder.");
    if (this.isBusy) throw new Error("Please wait for the current tutor reply.");
    const step = context.stepIndex;
    const assistant: TutorMessage = { role: "assistant", content: "" };
    const pending = { step, status: "Initializing tutor…" };
    this.pending = pending;
    // Publish before any await: the user's message is visible immediately, even
    // while loading the SDK or waiting for the first model token.
    this.appendMessage(step, { role: "user", content: context.userMessage });
    this.appendMessage(step, assistant);
    try {
      this.changed(step);
      if (!this.provider) {
        this.provider = this.createProvider(this.workspaceRoot).catch(error => {
          this.provider = undefined;
          throw error;
        });
      }
      const provider = await this.provider;
      if (this.disposed) throw new Error("This tour has ended.");
      const response = await provider.respond(context, update => {
        if (this.disposed || this.pending !== pending) return;
        if (update.type === "text") assistant.content = update.text;
        else if (this.pending) this.pending.status = update.status;
        this.changed(step);
      });
      if (this.disposed) throw new Error("This tour has ended.");
      assistant.content = response.message;
      return response;
    } catch (error) {
      if (!this.disposed) {
        // Retain both the submitted message and any partial Markdown on failure.
        // Escape error text instead of allowing it to inject Markdown links.
        const detail = (error instanceof Error ? error.message : String(error))
          .replace(/[\\`*_{}\[\]()<>#!|]/g, "\\$&");
        assistant.content += (assistant.content ? "\n\n---\n" : "") + "**Tutor error:** " + detail;
      }
      throw error;
    } finally {
      this.pending = undefined;
      if (!this.disposed) this.changed(step);
    }
  }

  clear(): void {
    this.conversations.clear();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.pending = undefined;
    this.listeners.clear();
    this.provider?.then(provider => provider.dispose(), () => {});
    this.clear();
  }
}

export function buildPrompt(context: TutorContext): string {
  return `Current editor context:
Workspace: ${context.workspaceRoot}
File: ${context.file ?? "(unknown)"}
Line: ${context.line ?? "(unknown)"}

Current anchored step (${context.stepIndex + 1}):
${context.stepDescription}

The programmer says:
${context.userMessage}

Respond directly to the programmer.`;
}
