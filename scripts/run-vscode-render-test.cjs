// Run with `npm run test:vscode`. Requires VS Code on PATH and a display
// (on headless Linux: xvfb-run -a npm run test:vscode). No model calls are made.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const net = require("node:net");
const { spawn } = require("node:child_process");
const webpack = require("webpack");

(async () => {
  const root = path.resolve(__dirname, "..");
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "codetour-vscode-render-"));
  const extension = path.join(tmp, "extension");
  const workspace = path.join(tmp, "workspace");
  fs.mkdirSync(extension); fs.mkdirSync(workspace);
  fs.mkdirSync(path.join(workspace, ".vscode"));
  fs.writeFileSync(path.join(workspace, ".vscode/settings.json"), JSON.stringify({
    "codetour.promptForWorkspaceTours": false,
    "workbench.startupEditor": "none",
    "editor.accessibilitySupport": "on"
  }));
  fs.writeFileSync(path.join(workspace, "sample.ts"), "// rendering test\nconst first = 1;\n\nconst second = 2;\n");
  const manifest = require(path.join(root, "package.json"));
  fs.writeFileSync(path.join(extension, "package.json"), JSON.stringify({
    ...manifest, publisher: "local", name: "codetour-render-test", main: "./extension-node.js",
    browser: undefined, scripts: undefined, dependencies: undefined, devDependencies: undefined
  }));
  fs.cpSync(path.join(root, "images"), path.join(extension, "images"), { recursive: true });
  fs.copyFileSync(path.join(root, "schema.json"), path.join(extension, "schema.json"));
  const entry = path.join(tmp, "entry.cjs");
  fs.writeFileSync(entry, `exports.activate = require(${JSON.stringify(path.join(root, "src/extension.ts"))}).activate;
exports.__test = { store: require(${JSON.stringify(path.join(root, "src/store/index.ts"))}).store,
TutorSession: require(${JSON.stringify(path.join(root, "src/tutor/session.ts"))}).TutorSession };`);
  const base = require(path.join(root, "webpack.config.js"))[0];
  await new Promise((resolve, reject) => webpack({
    ...base, context: root, mode: "development", entry, devtool: false,
    output: { ...base.output, path: extension }
  }, (error, stats) => error || stats.hasErrors() ?
    reject(error || new Error(stats.toString({ all: false, errors: true }))) : resolve()));
  const port = await new Promise(resolve => {
    const server = net.createServer();
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port; server.close(() => resolve(port));
    });
  });
  console.log("VS Code rendering test artifacts: " + tmp);
  const child = spawn(process.env.CODE_EXECUTABLE || "code", [
    "--new-window", "--wait", "--no-sandbox", "--disable-gpu", "--disable-workspace-trust",
    "--skip-welcome", "--skip-release-notes", "--disable-extensions",
    "--user-data-dir=" + path.join(tmp, "profile"),
    "--extensions-dir=" + path.join(tmp, "installed-extensions"),
    "--extensionDevelopmentPath=" + extension,
    "--extensionTestsPath=" + path.join(root, "scripts/vscode-render-suite.cjs"),
    "--remote-debugging-port=" + port, workspace
  ], {
    stdio: "inherit", env: { ...process.env, CODETOUR_RENDER_TEST_DIR: tmp, CODETOUR_RENDER_TEST_PORT: String(port) }
  });
  const watchdog = setTimeout(() => { child.kill(); }, 120000);
  const code = await new Promise((resolve, reject) => {
    child.once("error", reject); child.once("exit", resolve);
  });
  clearTimeout(watchdog);
  const resultPath = path.join(tmp, "result.json");
  const result = fs.existsSync(resultPath) ? JSON.parse(fs.readFileSync(resultPath, "utf8")) : {};
  if (code !== 0 || !result.passed) throw new Error(result.error || "VS Code rendering test did not complete; see " + tmp);
  console.log("PASS: actual Send, streamed Markdown, tool activity, compact history, Show/Hide links and navigation.");
  console.log("Screenshot: " + path.join(tmp, "rendered.png"));
  fs.rmSync(path.join(tmp, "profile"), { recursive: true, force: true });
})().catch(error => { console.error(error); process.exitCode = 1; });
