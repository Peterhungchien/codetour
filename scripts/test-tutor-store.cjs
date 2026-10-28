const assert = require("node:assert/strict");
const { join } = require("node:path");
const { isObservable, observable, reaction } = require("mobx");

module.exports = output => {
  const { createActiveTour, store } = require(join(output, "store/index.js"));
  let visible = [];
  let updates = 0;
  // Match the real VS Code API: a plain accessor object, not a class instance.
  const nativeThread = {
    get comments() { return visible; },
    set comments(comments) { visible = comments; updates++; },
    dispose() {}
  };
  const oldStore = observable({ thread: null });
  oldStore.thread = nativeThread;
  assert.notEqual(oldStore.thread, nativeThread, "reproduce the previous wrapper/identity bug");

  const session = { dispose() {} };
  store.activeTour = createActiveTour({
    tour: { id: "test", title: "Test", steps: [] }, step: 0,
    thread: null, tutorSession: session
  });
  store.activeTour.thread = nativeThread;
  assert.equal(store.activeTour.thread, nativeThread, "Send must receive the same native thread");
  assert.equal(isObservable(store.activeTour.thread), false);
  assert.equal(store.activeTour.tutorSession, session);
  const reply = { thread: nativeThread, text: "hello" };
  assert.equal(reply.thread, store.activeTour.thread);
  store.activeTour.thread.comments = [{ body: "Visible in VS Code" }];
  assert.equal(updates, 1, "write must reach the native setter");
  assert.equal(visible[0].body, "Visible in VS Code");
  let changes = 0;
  const dispose = reaction(() => store.activeTour.step, () => changes++);
  store.activeTour.step = 1;
  assert.equal(changes, 1, "step navigation must remain observable");
  dispose();
  store.activeTour = null;
};
