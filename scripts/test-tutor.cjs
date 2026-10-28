const { execFileSync } = require("node:child_process");
const { mkdtempSync, rmSync, symlinkSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const assert = require("node:assert/strict");

(async () => {
  const output = mkdtempSync(join(tmpdir(), "codetour-tests-"));
  try {
    symlinkSync(join(process.cwd(), "node_modules"), join(output, "node_modules"), "dir");
    execFileSync(process.execPath, [
      require.resolve("typescript/bin/tsc"),
      "src/tutor/session.ts", "src/tutor/comments.ts", "src/store/index.ts", "--rootDir", "src", "--module", "commonjs", "--target", "es2020",
      "--moduleResolution", "node", "--strict", "--skipLibCheck", "--outDir", output
    ], { stdio: "inherit" });
    const { TutorSession, buildPrompt } = require(join(output, "tutor/session.js"));
    const context = { workspaceRoot: "/workspace", stepIndex: 0,
      stepDescription: "Step description", file: "src/index.ts", line: 4, userMessage: "Explain this" };
    let created = 0, disposed = 0;
    const session = new TutorSession("/workspace", async root => {
      assert.equal(root, "/workspace");
      created++;
      return { respond: async () => ({ message: "Answer" }), dispose: () => disposed++ };
    });
    assert.equal(created, 0, "normal tours do not initialize the SDK");
    await session.respond(context);
    await session.respond({ ...context, stepIndex: 1 });
    assert.equal(created, 1);
    assert.equal(session.getMessages(0).length, 2);
    assert.equal(session.getMessages(1).length, 2);
    assert.equal(session.getMessages(2).length, 0);
    assert.match(buildPrompt(context), /src\/index.ts/);
    assert.match(buildPrompt(context), /Step description/);
    session.dispose();
    session.dispose();
    await Promise.resolve();
    assert.equal(disposed, 1);
    await assert.rejects(session.respond(context), /ended/);
    await assert.rejects(new TutorSession().respond(context), /local workspace/);

    let attempts = 0;
    const retry = new TutorSession("/workspace", async () => {
      if (++attempts === 1) throw new Error("missing configuration");
      return { respond: async () => ({ message: "Recovered" }), dispose() {} };
    });
    await assert.rejects(retry.respond(context), /configuration/);
    assert.equal(retry.getMessages(0).length, 2);
    assert.match(retry.getMessages(0)[1].content, /Tutor error/);
    await retry.respond(context);
    assert.equal(attempts, 2);
    retry.dispose();

    let finish;
    const pending = new TutorSession("/workspace", async () => ({
      respond: () => new Promise(resolve => { finish = resolve; }), dispose() {}
    }));
    const request = pending.respond(context);
    await Promise.resolve();
    await assert.rejects(pending.respond(context), /wait/);
    pending.dispose();
    finish({ message: "Late reply" });
    await assert.rejects(request, /ended/);
    assert.equal(pending.getMessages(0).length, 0);

    let release, lateDisposed = 0;
    const late = new TutorSession("/workspace", () => new Promise(resolve => { release = resolve; }));
    const initializing = late.respond(context);
    late.dispose();
    release({ respond: async () => ({ message: "unused" }), dispose: () => lateDisposed++ });
    await assert.rejects(initializing, /ended/);
    assert.equal(lateDisposed, 1);
    await require("./test-tutor-stream.cjs")(join(output, "tutor"), context);
    require("./test-tutor-store.cjs")(output);
    console.log("Tutor tests passed: lifecycle, streaming, inline activity, Markdown, navigation, failures and cleanup.");
  } finally {
    rmSync(output, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
