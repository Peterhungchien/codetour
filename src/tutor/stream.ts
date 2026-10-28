import { TutorContext, TutorResponse, TutorUpdateListener } from "./types";
import { buildPrompt } from "./session";

// A narrow structural view keeps the ESM-only SDK external to webpack.
export interface PiEvent {
  type: string;
  message?: {
    role: string;
    content?: Array<{ type: string; text?: string }>;
    stopReason?: string;
    errorMessage?: string;
  };
  assistantMessageEvent?: { type: string; delta?: string };
  toolCallId?: string;
  toolName?: string;
  args?: Record<string, unknown>;
  isError?: boolean;
  attempt?: number;
}

export interface PiSession {
  prompt(text: string): Promise<void>;
  subscribe(listener: (event: PiEvent) => void): () => void;
  getLastAssistantText(): string | undefined;
  dispose(): void;
}

export function toolSummary(name: string, args?: Record<string, unknown>): string {
  // Never include tool output, file contents, or arbitrary argument JSON.
  const detail = args?.path ?? args?.file_path ?? args?.command ?? args?.pattern ?? args?.query;
  const raw = name + (typeof detail === "string" ? ": " + detail : "");
  const summary = raw.replace(/[\x00-\x1f\x7f]/g, " ").replace(/\s+/g, " ").trim();
  return summary.length > 100 ? summary.slice(0, 99) + "…" : summary;
}

export async function streamPiResponse(
  session: PiSession,
  context: TutorContext,
  onUpdate: TutorUpdateListener = () => {}
): Promise<TutorResponse> {
  const completed: string[] = [];
  const tools = new Map<string, string>();
  let current = "";
  let failure: string | undefined;
  const text = () => [...completed, current].filter(Boolean).join("\n\n");
  const publishText = () => onUpdate({ type: "text", text: text() });
  const status = (fallback: string) => onUpdate({
    type: "status",
    status: tools.size ? "Running " + [...tools.values()].join(" · ") : fallback
  });
  const unsubscribe = session.subscribe(event => {
    if (event.type === "message_start" && event.message?.role === "assistant") {
      current = "";
      failure = undefined;
      status("Thinking…");
    } else if (event.type === "message_update" &&
               event.assistantMessageEvent?.type === "text_delta") {
      current += event.assistantMessageEvent.delta || "";
      publishText();
      status("Writing response…");
    } else if (event.type === "message_end" && event.message?.role === "assistant") {
      const finalText = (event.message.content || [])
        .filter(part => part.type === "text").map(part => part.text || "").join("");
      const interrupted = event.message.stopReason === "error" || event.message.stopReason === "aborted";
      // Some providers send an empty final message on error after text deltas.
      // Keep the partial answer visible instead of replacing it with nothing.
      current = interrupted ? finalText || current : finalText;
      if (interrupted) {
        failure = event.message.errorMessage || "The agent response was interrupted.";
      } else {
        if (current) completed.push(current);
        current = "";
      }
      publishText();
    } else if (event.type === "tool_execution_start") {
      tools.set(event.toolCallId || event.toolName || "tool",
        toolSummary(event.toolName || "tool", event.args));
      status("Working…");
    } else if (event.type === "tool_execution_end") {
      tools.delete(event.toolCallId || event.toolName || "tool");
      status(event.isError ? "Tool failed; agent is continuing…" : "Thinking…");
    } else if (event.type === "auto_retry_start") {
      status("Retrying response" + (event.attempt ? " (attempt " + event.attempt + ")" : "") + "…");
    } else if (event.type === "compaction_start") {
      status("Summarizing conversation…");
    }
  });
  try {
    await session.prompt(buildPrompt(context));
    if (failure) throw new Error(failure);
    const message = text() || session.getLastAssistantText() ||
      "(Pi completed without a text response)";
    onUpdate({ type: "text", text: message });
    return { message };
  } finally {
    unsubscribe();
  }
}
