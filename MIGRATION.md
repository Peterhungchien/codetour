# Microsoft CodeTour + tutor migration

## Base and upstream review

Cloned https://github.com/microsoft/codetour into `~/codetour`.
Microsoft main: `29955a0`. This is already the common base of the original
working repository. Microsoft has no newer commits missing from that checkout.

Also fetched the current fork https://github.com/trcoffman/codetour,
main `35d8769` (the working checkout was `d929ea8`).

Bug fixes reviewed:
- `89af49c`: keeps step windows visible for long selections/scrolloff.
  Neovim only; not applicable to Microsoft's VS Code extension.
- `ceabe4d`: scrolls step windows with code. Neovim only; not applicable.
- `d929ea8`: excludes fork-specific .jj, tmp, and cli directories from VSIX.
  Those directories do not exist in this clone; not needed here.
- `5ced626`: asks before executing tour shell commands in Neovim (security
  hardening). No Neovim plugin is included here; not applicable.
- The CLI/core extraction in `f0eae9b` also catches invalid anchor regular
  expressions and invalid tour `when` expressions. These are useful defensive
  fixes, but they are mixed with the CLI/core refactor; no wholesale refactor
  was imported. Microsoft's existing behavior is unchanged.

Excluded new features: Neovim support, CLI/authoring skill, content-step editor
pages, CodeTour+ branding/command renaming, and `last-edit` tour refs
(`6f9b1fb`). Version-only changes were not copied.

## Ported work

The uncommitted `src/tutor` provider/session/types, reply command, step history
rendering, and active-tour ownership were adapted to Microsoft's existing
`codetour` namespace and type definitions.

Compatibility repairs:
- Initialize the provider only on the first tutor message. Normal recording,
  standalone tours, and playback do not require credentials.
- Scope Pi's resource loader and tools to the tour workspace, not the extension
  host's current directory.
- Dispose provider sessions when tours are replaced or ended.
- Handle initialization/reply errors, reject concurrent replies, and avoid
  writing late responses into another step's thread.
- Require workspace trust before invoking the agent.
- Load the ESM-only SDK with native dynamic import, keeping native/runtime
  assets external instead of trying to bundle them for the web worker.
- Retain production node_modules in extension packaging for SDK runtime assets.

## Credentials

The real config is outside both repositories:

`~/.config/codetour/tutor.json`

It contains `provider`, `model`, and `apiKey` and is restricted to mode 0600.
Use `tutor.config.example.json` as a template. Optionally set
`CODETOUR_TUTOR_CONFIG` in the extension host environment to another file.
A root-level `tutor.config.json` is gitignored; do not put secrets in examples.

The existing key was moved out of the original checkout's tutor provider too.
The original checkout's .comments session log still contains a previous copy;
that log was not copied or modified. Rotate the key.

## Validation and limitations

Run `npm install`, `npm test`, and `npm run build`.
Tests exercise lazy initialization, per-step history, prompt context,
initialization retry, concurrent replies, disposal during initialization, and
late responses. Native SDK import and configured model lookup were also checked.
A bundled provider smoke test initialized a real SDK session using the private
config and disposed it successfully without sending a model request.

Tutor execution requires a desktop extension host running Node >=22.19
(the SDK requirement). Older hosts and the browser can still play normal tours;
tutor requests report an error. The model can use coding tools; workspace trust
and the prompt are not a sandbox.

Final validation passed: npm test, production builds for Node and web,
git diff --check, and vsce file-list checks confirming that the SDK/runtime
assets are included and the private config is excluded.

No paid model request was sent. `npm run test:vscode` launches an isolated real
VS Code instance and exercises the actual Send button and rendered comment DOM
with a deterministic streaming provider; see README for headless execution.
Model-provider behavior still requires a test with your credentials.

### Native thread identity regression

VS Code returns CommentThread as a plain accessor object. MobX's default deep
conversion wrapped it, causing `reply.thread !== activeTour.thread` and silently
rejecting Send before a request began. Active tours now use `observable.ref` for
both the native thread and the tutor session while keeping navigation observable.
The regression suite reproduces the old wrapper behavior and verifies that writes
reach the original thread setter. The original mock-only tests missed this.
