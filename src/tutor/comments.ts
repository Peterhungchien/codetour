import { Comment, CommentMode, CommentThread, MarkdownString } from "vscode";
import { EXTENSION_NAME } from "../constants";
import { TutorSession } from "./session";
import { TutorMessage } from "./types";

export function conversationMarkdown(content: string): MarkdownString {
  const markdown = new MarkdownString(content);
  // Both submitted and generated Markdown are untrusted. Code fences, lists,
  // emphasis and ordinary links render, but command links and HTML cannot run.
  markdown.isTrusted = false;
  // HTML support is left at its disabled default (also works with VS Code 1.60 typings).
  return markdown;
}

/** Bind one visible thread; rebind after navigation to restore live history. */
export function bindTutorComments(
  session: TutorSession,
  step: number,
  thread: CommentThread,
  tourComment: Comment,
  isCurrent: () => boolean
): () => void {
  const comments = new Map<TutorMessage, Comment>();
  const historyControl: Comment = {
    body: "",
    author: { name: "Conversation history" },
    mode: CommentMode.Preview,
    contextValue: "codetour.tutor.history"
  };
  const activity: Comment = {
    body: "",
    author: { name: "Tutor activity" },
    mode: CommentMode.Preview,
    contextValue: "codetour.tutor.status"
  };
  let disposed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let lastCount = -1;
  let lastStatus: string | undefined;
  let lastExpanded = false;

  const render = () => {
    if (timer) clearTimeout(timer);
    timer = undefined;
    if (disposed || !isCurrent()) return;
    const messages = session.getMessages(step);
    const visible = session.getVisibleMessages(step).filter(message => message.content).map(message => {
      let comment = comments.get(message);
      if (!comment) {
        comment = {
          body: "",
          mode: CommentMode.Preview,
          author: { name: message.role === "user" ? "You" : "Tutor" },
          contextValue: "codetour.tutor.message"
        };
        comments.set(message, comment);
      }
      comment.body = conversationMarkdown(message.content);
      return comment;
    });
    const status = session.getStatus(step);
    if (status) {
      const body = new MarkdownString("$(loading~spin) ", true);
      body.appendText(status);
      activity.body = body;
      visible.push(activity);
    }
    const earlierCount = session.getEarlierMessageCount(step);
    const expanded = session.isHistoryExpanded(step);
    if (earlierCount) {
      const label = expanded ? "Hide history" : `Show earlier messages (${earlierCount})`;
      const args = encodeURIComponent(JSON.stringify([session.id, step]));
      const body = new MarkdownString(`[${label}](command:${EXTENSION_NAME}.toggleTutorHistory?${args})`);
      // This control contains only our fixed command and generated label/args.
      // User/agent Markdown continues to be explicitly untrusted.
      body.isTrusted = true;
      historyControl.body = body;
    }
    thread.comments = [tourComment, ...(earlierCount ? [historyControl] : []), ...visible];
    lastCount = messages.length;
    lastStatus = status;
    lastExpanded = expanded;
  };
  const unsubscribe = session.subscribe(changedStep => {
    if (changedStep !== step || disposed || !isCurrent()) return;
    // Submissions, tool transitions and completion render synchronously. Only
    // token bursts are coalesced to avoid flooding VS Code's extension IPC.
    if (session.isHistoryExpanded(step) !== lastExpanded ||
      session.getMessages(step).length !== lastCount ||
      session.getStatus(step) !== lastStatus || !session.getStatus(step)) render();
    else if (!timer) timer = setTimeout(render, 50);
  });
  render();
  return () => {
    disposed = true;
    unsubscribe();
    if (timer) clearTimeout(timer);
  };
}
