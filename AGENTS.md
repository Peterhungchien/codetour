# Agent guide

## Project scope

This repository is Microsoft's CodeTour VS Code extension with an inline Pi-based
programming tutor. Preserve the `codetour` command namespace and existing `.tour`
file compatibility. Do not import the fork's unrelated CLI, Neovim integration,
branding, or tour-format features without an explicit request.

Read `README.md` for behavior and setup, `CONTRIBUTING.md` for contribution guidance,
and `MIGRATION.md` for the upstream comparison and migration decisions.

## Code map

- `src/extension.ts`: activation and extension-owned cleanup.
- `src/player/`: tour rendering, comments, commands, and navigation.
- `src/store/`: MobX tour state and lifecycle actions.
- `src/tutor/provider.ts`: lazy SDK loading, model configuration, and credentials.
- `src/tutor/stream.ts`: SDK events translated into text and activity updates.
- `src/tutor/session.ts`: per-step conversations, request lifecycle, and history visibility.
- `src/tutor/comments.ts`: conversation state projected onto native comment threads.
- `scripts/test-tutor*.cjs`: unit and regression coverage.
- `scripts/run-vscode-render-test.cjs` and `scripts/vscode-render-suite.cjs`:
  isolated real VS Code UI tests.
- `webpack.config.js`: desktop and web extension bundles.

## Development and validation

Use Node.js 22.19 or newer for the tutor SDK. Install dependencies with `npm install`.
Keep `package.json` and `package-lock.json` together when dependencies change.

For product changes, run:

```sh
npm test
npm run typecheck
npm run build
git diff --check
```

`typecheck` uses the repository's pinned compiler and skips legacy declaration-file
conflicts; application source remains checked. Production builds must support both
desktop and web playback, even though the tutor itself requires a desktop host.

For changes to comment rendering, reply commands, streaming, or history controls,
also run `npm run test:vscode`. On headless Linux, use
`xvfb-run -a npm run test:vscode`. VS Code must be installed; `CODE_EXECUTABLE` can
override the `code` executable. The UI suite uses a deterministic provider and
must not make paid model requests. Report separately which checks ran, and never
claim actual UI rendering was verified based only on mocked objects.

## Important invariants

- A VS Code `CommentThread` is a plain accessor object. Store it using
  `observable.ref`; deep MobX conversion breaks identity with `CommentReply.thread`.
  Keep tutor sessions by reference too, while leaving tour navigation observable.
- Updating message state is not sufficient to render a reply. The binding must
  publish updates through the native thread's `comments` setter.
- Keep the full conversation when hiding older exchanges. History expansion is
  per-step UI state, not a mutation of the agent transcript.
- Publish submitted messages before asynchronous initialization. Coalesce token
  bursts, but render submissions, tool transitions, and completion promptly.
- Reject concurrent requests per tour, ignore stale callbacks, and dispose sessions,
  subscriptions, and timers when their owners end or are replaced.
- User and agent Markdown is untrusted. Only extension-generated controls may use
  trusted command links, with validated session and step arguments.
- The Pi SDK is ESM-only and loads via native dynamic import. Preserve that boundary;
  do not pull its native modules into the web bundle. Its production dependencies
  and runtime assets must remain available in VSIX packaging.

## Credentials and safety

The real tutor configuration lives at `~/.config/codetour/tutor.json`, or at the
path specified by `CODETOUR_TUTOR_CONFIG`. Never commit, print, or copy its API key
into source, fixtures, logs, or examples. `tutor.config.example.json` contains only
a placeholder; local `tutor.config.json` is ignored and excluded from packaging.

Require workspace trust before running the agent. The agent has coding tools:
workspace trust and the system prompt are not a security sandbox. Use deterministic
providers for automated tests and obtain authorization before paid/live model tests.
