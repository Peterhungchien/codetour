import { Comment, CommentMode, CommentThread, MarkdownString } from "vscode";
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

  const render = () => {
    if (timer) clearTimeout(timer);
    timer = undefined;
    if (disposed || !isCurrent()) return;
    const messages = session.getMessages(step);
    const visible = messages.filter(message => message.content).map(message => {
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
    thread.comments = [tourComment, ...visible];
    lastCount = messages.length;
    lastStatus = status;
  };
  const unsubscribe = session.subscribe(changedStep => {
    if (changedStep !== step || disposed || !isCurrent()) return;
    // Submissions, tool transitions and completion render synchronously. Only
    // token bursts are coalesced to avoid flooding VS Code's extension IPC.
    if (session.getMessages(step).length !== lastCount ||
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
