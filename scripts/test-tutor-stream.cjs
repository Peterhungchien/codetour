const assert = require("node:assert/strict");
const { join } = require("node:path");
const Module = require("node:module");

module.exports = async (output, context) => {
  const { TutorSession } = require(join(output, "session.js"));
  const { streamPiResponse, toolSummary } = require(join(output, "stream.js"));

  // SDK event adapter: multiple assistant turns, tools, authoritative final text.
  let unsubscribed = 0;
  const updates = [];
  let listener;
  const sdk = {
    subscribe(fn) { listener = fn; return () => unsubscribed++; },
    async prompt() {
      listener({ type: "message_start", message: { role: "assistant" } });
      listener({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "private reasoning" } });
      listener({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "**Checking**" } });
      listener({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "**Checking** files" }] } });
      listener({ type: "tool_execution_start", toolCallId: "a", toolName: "read", args: { path: "src/main.ts" } });
      listener({ type: "tool_execution_start", toolCallId: "b", toolName: "bash", args: { command: "npm test\n--verbose" } });
      listener({ type: "tool_execution_end", toolCallId: "a", toolName: "read" });
      listener({ type: "tool_execution_end", toolCallId: "b", toolName: "bash", isError: true });
      listener({ type: "auto_retry_start", attempt: 2 });
      listener({ type: "compaction_start" });
      listener({ type: "message_start", message: { role: "assistant" } });
      listener({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "\`done\`" } });
      listener({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "\`done\`" }] } });
    },
    getLastAssistantText() { return "wrong fallback"; }, dispose() {}
  };
  const response = await streamPiResponse(sdk, context, update => updates.push(update));
  assert.equal(response.message, "**Checking** files\n\n\`done\`");
  assert.equal(unsubscribed, 1);
  assert.ok(updates.some(u => u.type === "text" && u.text === "**Checking**"));
  assert.ok(updates.some(u => u.status?.includes("read: src/main.ts")));
  assert.ok(updates.some(u => u.status?.includes("bash: npm test --verbose")));
  assert.ok(updates.some(u => u.status?.includes("Tool failed")));
  assert.ok(updates.some(u => u.status?.includes("Retrying")));
  assert.ok(!JSON.stringify(updates).includes("private reasoning"));
  assert.ok(toolSummary("write", { path: "a".repeat(200), content: "secret" }).length <= 100);
  assert.ok(!toolSummary("write", { content: "secret" }).includes("secret"));
  sdk.prompt = async () => { throw new Error("network failed"); };
  await assert.rejects(streamPiResponse(sdk, context), /network failed/);
  assert.equal(unsubscribed, 2);
  sdk.prompt = async () => {
    listener({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "Partial before error" } });
    listener({ type: "message_end", message: {
      role: "assistant", stopReason: "error", errorMessage: "model failed", content: []
    } });
  };
  const errorUpdates = [];
  await assert.rejects(streamPiResponse(sdk, context, update => errorUpdates.push(update)), /model failed/);
  assert.equal(errorUpdates.filter(u => u.type === "text").pop().text, "Partial before error");
  assert.equal(unsubscribed, 3);
  sdk.prompt = async () => {};
  assert.equal((await streamPiResponse(sdk, context)).message, "wrong fallback");

  // A small vscode mock verifies the actual comment binding without a GUI.
  class MarkdownString {
    constructor(value = "", supportThemeIcons = false) {
      this.value = value; this.supportThemeIcons = supportThemeIcons;
    }
    appendText(value) { this.value += value.replace(/[\[\]()*_`]/g, "\\$&"); return this; }
  }
  const originalLoad = Module._load;
  let bindTutorComments, conversationMarkdown;
  try {
    Module._load = function(name, ...rest) {
      return name === "vscode" ? { MarkdownString, CommentMode: { Preview: 0 }, Uri: { parse: value => value } } :
        originalLoad.call(this, name, ...rest);
    };
    ({ bindTutorComments, conversationMarkdown } = require(join(output, "comments.js")));
  } finally { Module._load = originalLoad; }
  const markdown = conversationMarkdown("**bold**\n\n\`\`\`ts\nconst n = 1;\n\`\`\`\n[link](https://example.com)");
  assert.ok(markdown instanceof MarkdownString);
  assert.equal(markdown.isTrusted, false);
  assert.notEqual(markdown.supportHtml, true);
  assert.ok(markdown.value.includes("**bold**"));

  let emit, finish, ready;
  const providerReady = new Promise(resolve => { ready = resolve; });
  const live = new TutorSession("/workspace", async () => ({
    respond(_context, onUpdate) {
      emit = onUpdate;
      ready();
      return new Promise(resolve => { finish = resolve; });
    }, dispose() {}
  }));
  const tourComment = { body: "Tour instructions" };
  const thread = { comments: [] };
  let current = true;
  const unbind = bindTutorComments(live, 0, thread, tourComment, () => current);
  const request = live.respond({ ...context, userMessage: "**hello**" });
  assert.equal(thread.comments[1].author.name, "You", "submission is synchronous");
  assert.equal(thread.comments[1].body.value, "**hello**");
  assert.match(thread.comments[2].body.value, /Initializing/);
  assert.equal(live.isBusy, true);
  await providerReady;
  emit({ type: "text", text: "Partial **answer**" });
  emit({ type: "status", status: "Running read: file.ts" });
  assert.equal(thread.comments[2].author.name, "Tutor");
  assert.equal(thread.comments[2].body.value, "Partial **answer**");
  assert.match(thread.comments[3].body.value, /file.ts/);
  emit({ type: "text", text: "Partial **answer**, more text" });
  await new Promise(resolve => setTimeout(resolve, 75));
  assert.equal(thread.comments[2].body.value, "Partial **answer**, more text");

  // Navigation detaches the old thread. A newly visible thread restores the
  // partial reply and stays subscribed until finalization.
  emit({ type: "text", text: "Queued update before navigation" });
  unbind();
  current = false;
  const oldComments = thread.comments;
  const returned = { comments: [] };
  const detach = bindTutorComments(live, 0, returned, tourComment, () => true);
  const elsewhere = { comments: [] };
  const detachOther = bindTutorComments(live, 1, elsewhere, tourComment, () => true);
  emit({ type: "text", text: "Final **answer**" });
  finish({ message: "Final **answer**" });
  await request;
  assert.equal(thread.comments, oldComments);
  assert.equal(returned.comments[2].body.value, "Final **answer**");
  assert.equal(returned.comments.length, 3, "activity disappears on completion");
  assert.equal(elsewhere.comments.length, 1, "other steps receive no response");
  assert.equal(live.getStatus(0), undefined);
  assert.equal(live.isBusy, false);
  emit({ type: "text", text: "Late update after completion" });
  assert.equal(live.getMessages(0)[1].content, "Final **answer**");
  detach(); detachOther(); live.dispose();

  // Failed responses retain the submitted message and partial Markdown.
  const failed = new TutorSession("/workspace", async () => ({
    async respond(_context, update) {
      update({ type: "text", text: "**Partial**" });
      throw new Error("[unsafe](command:bad)");
    }, dispose() {}
  }));
  await assert.rejects(failed.respond(context), /unsafe/);
  assert.equal(failed.getMessages(0)[0].content, context.userMessage);
  assert.match(failed.getMessages(0)[1].content, /Partial/);
  assert.ok(failed.getMessages(0)[1].content.includes("\\[unsafe\\]"));
  assert.equal(failed.getStatus(0), undefined);
  failed.dispose();

  // Updates delivered by a provider after disposal are ignored.
  let updateLate, finishLate, lateReady;
  const lateProviderReady = new Promise(resolve => { lateReady = resolve; });
  const late = new TutorSession("/workspace", async () => ({
    respond(_context, update) { updateLate = update; lateReady(); return new Promise(resolve => { finishLate = resolve; }); },
    dispose() {}
  }));
  const lateRequest = late.respond(context);
  await lateProviderReady;
  late.dispose();
  updateLate({ type: "text", text: "Too late" });
  finishLate({ message: "Too late" });
  await assert.rejects(lateRequest, /ended/);
  assert.equal(late.getMessages(0).length, 0);
};
