const vscode = require("vscode");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(fn, label, timeout = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const result = await fn();
    if (result) return result;
    await delay(75);
  }
  throw new Error("Timed out: " + label);
}
async function connectRenderer() {
  const port = process.env.CODETOUR_RENDER_TEST_PORT;
  const target = await waitFor(async () => {
    const targets = await (await fetch("http://127.0.0.1:" + port + "/json/list")).json();
    return targets.find(target => target.type === "page" && /workbench/.test(target.url));
  }, "renderer CDP target");
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.addEventListener("open", resolve); socket.addEventListener("error", reject); });
  let id = 0;
  const pending = new Map();
  socket.addEventListener("message", event => {
    const message = JSON.parse(event.data);
    if (pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id); pending.delete(message.id);
      message.error ? reject(new Error(JSON.stringify(message.error))) : resolve(message.result);
    }
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const requestId = ++id; pending.set(requestId, { resolve, reject });
    socket.send(JSON.stringify({ id: requestId, method, params }));
  });
  return {
    send,
    async evaluate(expression) {
      const response = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
      if (response.exceptionDetails) throw new Error(JSON.stringify(response.exceptionDetails));
      return response.result.value;
    },
    close() { socket.close(); }
  };
}

exports.run = async () => {
  const directory = process.env.CODETOUR_RENDER_TEST_DIR;
  let renderer;
  try {
    const extension = vscode.extensions.getExtension("local.codetour-render-test");
    assert.ok(extension, "development extension loaded");
    const api = await extension.activate();
    const { __test: { store, TutorSession } } = require(path.join(extension.extensionPath, "extension-node.js"));
    const root = vscode.workspace.workspaceFolders[0].uri;
    const tour = { id: vscode.Uri.joinPath(root, "test.tour").toString(), title: "Rendering test", steps: [
      { file: "sample.ts", line: 2, description: "FIRST_STEP_RENDER_TEST" },
      { file: "sample.ts", line: 4, description: "SECOND_STEP_RENDER_TEST" }
    ] };
    let update, complete;
    api.startTour(tour, 0, root);
    store.activeTour.tutorSession = new TutorSession(root.fsPath, async () => ({
      respond(_context, onUpdate) {
        update = onUpdate;
        return new Promise(resolve => { complete = resolve; });
      }, dispose() {}
    }));
    await waitFor(() => store.activeTour?.thread, "native comment thread");
    renderer = await connectRenderer();
    await vscode.commands.executeCommand("workbench.action.closeSidebar");
    await vscode.commands.executeCommand("workbench.action.closePanel");
    await vscode.commands.executeCommand("workbench.action.closeAuxiliaryBar");
    const body = async () => (await renderer.evaluate("document.body.innerText")).replace(/\u00a0/g, " ");
    await waitFor(async () => (await body()).includes("FIRST_STEP_RENDER_TEST"), "visible tour comment");
    // Focus the real comment editor, type through Chromium's input pipeline,
    // and click the contributed Send button. VS Code supplies CommentReply.thread.
    const sendMessage = async text => {
      const previousUpdate = update;
      await renderer.evaluate("document.querySelector('.review-thread-reply-button')?.click()");
      await waitFor(() => renderer.evaluate(`(() => {
        const editors = [...document.querySelectorAll('.review-widget .monaco-editor textarea, .review-widget .monaco-editor [contenteditable="true"], .review-widget .monaco-editor [role="textbox"]')];
        const editor = editors.find(element => element.getBoundingClientRect().height > 0);
        if (!editor) return false;
        editor.focus(); return true;
      })()`), "comment reply editor");
      await renderer.send("Input.insertText", { text });
      await waitFor(() => renderer.evaluate(`(() => {
        const button = [...document.querySelectorAll('.review-widget button, .review-widget .monaco-button')]
          .find(element => element.textContent.trim() === 'Send' && element.getAttribute('aria-disabled') !== 'true');
        if (!button) return false;
        button.click(); return true;
      })()`), "Send button");
      await waitFor(() => update && update !== previousUpdate, "Send reaching tutor provider (native thread identity)");
    };
    const clickHistory = async label => {
      await waitFor(() => renderer.evaluate(`(() => {
        const link = [...document.querySelectorAll('.review-widget .rendered-markdown a')]
          .find(element => element.textContent === ${JSON.stringify(label)});
        if (!link) return false;
        link.click(); return true;
      })()`), label + " link");
    };
    await sendMessage("**USER_MARKDOWN**");
    await waitFor(() => renderer.evaluate("[...document.querySelectorAll('.review-widget .rendered-markdown strong')].some(e => e.textContent === 'USER_MARKDOWN')"), "user Markdown rendered before response");
    update({ type: "text", text: "**PARTIAL_MARKDOWN**" });
    update({ type: "status", status: "Running read: sample.ts" });
    await waitFor(() => renderer.evaluate("[...document.querySelectorAll('.review-widget .rendered-markdown strong')].some(e => e.textContent === 'PARTIAL_MARKDOWN')"), "streamed assistant Markdown");
    await waitFor(async () => (await body()).includes("Running read: sample.ts"), "visible tool activity");
    const screenshot = await renderer.send("Page.captureScreenshot", { format: "png" });
    fs.writeFileSync(path.join(directory, "rendered.png"), Buffer.from(screenshot.data, "base64"));
    complete({ message: "**FINAL_MARKDOWN**\n\n```ts\nconst rendered = true;\n```" });
    await waitFor(() => !store.activeTour.tutorSession.isBusy, "completed response");
    await waitFor(() => renderer.evaluate("[...document.querySelectorAll('.review-widget .rendered-markdown pre, .review-widget .rendered-markdown code, .review-widget .monaco-tokenized-source')].some(e => e.textContent.includes('const rendered = true'))"), "rendered fenced code");
    await waitFor(async () => !(await body()).includes("Running read: sample.ts"), "activity removed");

    await sendMessage("**SECOND_USER**");
    await waitFor(async () => {
      const text = await body();
      return text.includes("SECOND_USER") && text.includes("Show earlier messages (2)") &&
        !text.includes("USER_MARKDOWN") && !text.includes("FINAL_MARKDOWN");
    }, "new user hides the entire previous exchange before agent text arrives");
    assert.equal(store.activeTour.tutorSession.getMessages(0).length, 4);
    await vscode.commands.executeCommand("codetour.toggleTutorHistory", "stale-session", 0);
    assert.equal(store.activeTour.tutorSession.isHistoryExpanded(0), false);
    await clickHistory("Show earlier messages (2)");
    await waitFor(async () => {
      const text = await body();
      return text.includes("Hide history") && text.includes("USER_MARKDOWN") && text.includes("FINAL_MARKDOWN");
    }, "Show earlier messages restores both old messages while response is pending");
    await clickHistory("Hide history");
    await waitFor(async () => !(await body()).includes("FINAL_MARKDOWN"), "Hide history removes old messages");
    update({ type: "text", text: "**SECOND_PARTIAL**" });
    update({ type: "status", status: "Running read: latest.ts" });
    await waitFor(async () => {
      const text = await body();
      return text.includes("SECOND_PARTIAL") && text.includes("latest.ts") && !text.includes("FINAL_MARKDOWN");
    }, "streaming and activity continue in compact mode");
    complete({ message: "**SECOND_FINAL**" });
    await waitFor(async () => {
      const text = await body();
      return text.includes("SECOND_FINAL") && !text.includes("latest.ts") && !text.includes("FINAL_MARKDOWN");
    }, "only the latest exchange remains on completion");
    assert.equal(store.activeTour.tutorSession.getMessages(0).length, 4, "full agent history remains intact");
    const compactScreenshot = await renderer.send("Page.captureScreenshot", { format: "png" });
    fs.writeFileSync(path.join(directory, "history-collapsed.png"), Buffer.from(compactScreenshot.data, "base64"));
    await vscode.commands.executeCommand("codetour.nextTourStep");
    await waitFor(async () => { const text = await body(); return text.includes("SECOND_STEP_RENDER_TEST") && !text.includes("SECOND_FINAL"); }, "other step does not receive reply");
    await vscode.commands.executeCommand("codetour.previousTourStep");
    await waitFor(async () => {
      const text = await body();
      return text.includes("SECOND_FINAL") && !text.includes("FINAL_MARKDOWN") && text.includes("Show earlier messages (2)");
    }, "compact history restored after returning");
    await clickHistory("Show earlier messages (2)");
    await waitFor(async () => (await body()).includes("FINAL_MARKDOWN"), "history can be expanded after navigation");
    const expandedScreenshot = await renderer.send("Page.captureScreenshot", { format: "png" });
    fs.writeFileSync(path.join(directory, "history-expanded.png"), Buffer.from(expandedScreenshot.data, "base64"));
    await vscode.commands.executeCommand("codetour.nextTourStep");
    await waitFor(async () => (await body()).includes("SECOND_STEP_RENDER_TEST"), "navigate away from expanded history");
    await vscode.commands.executeCommand("codetour.previousTourStep");
    await waitFor(async () => {
      const text = await body();
      return text.includes("Hide history") && text.includes("FINAL_MARKDOWN") && text.includes("SECOND_FINAL");
    }, "expanded choice survives navigation");
    await api.endCurrentTour();
    fs.writeFileSync(path.join(directory, "result.json"), JSON.stringify({ passed: true }));
  } catch (error) {
    const detail = { passed: false, error: error.stack || String(error) };
    if (renderer) {
      detail.dom = await renderer.evaluate("document.body.innerText").catch(() => "unavailable");
      detail.markdown = await renderer.evaluate("[...document.querySelectorAll('.review-widget .rendered-markdown')].map(e => e.outerHTML)").catch(() => []);
      detail.inputs = await renderer.evaluate("[...document.querySelectorAll('textarea, [contenteditable], button, .monaco-button')].map(e => ({tag:e.tagName,cls:e.className,label:e.getAttribute('aria-label'),text:e.textContent.slice(0,80)}))").catch(() => []);
    }
    fs.writeFileSync(path.join(directory, "result.json"), JSON.stringify(detail, null, 2));
    throw error;
  } finally { renderer?.close(); }
};
