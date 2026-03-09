# OMP Copilot Gateway Provider Plugin

This repository contains a local OMP extension package that registers a custom GitHub Copilot provider path through `pi.registerProvider(...)`.

The point of this scaffold is to keep Copilot request-shaping logic out of OMP core and move it into a provider path we control. The long-term behavioral reference is **VS Code Copilot Chat**.

This revision now targets a separate custom provider id:

- `github-copilot-vscode`

So the intended split is:

- official OMP Copilot auth semantics
- custom VS Code-like request/call shaping

## Repo path

- `/home/zahid/work/labs/omp-copilot-provider-plugin`

## Why this path was chosen

OMP already supports runtime provider registration from extensions.

- supported: extension modules + `pi.registerProvider(...)`
- supported: package-directory extension loading via `package.json` `omp.extensions`
- not ideal today: relying on OMP core’s built-in `github-copilot` provider for agent continuation semantics
- important caveat: OMP’s plugin manager currently auto-wires **tools**, not extension modules, so the cleanest dev workflow is to load this package as an **extension path**

## Plugin structure

- `package.json`
  - declares `omp.extensions: ["./src/extension.ts"]`
- `src/extension.ts`
  - OMP extension entrypoint
- `src/provider.ts`
  - registers provider `github-copilot-vscode`
  - mirrors official `github-copilot` auth into the live session and exposes a small cheap model list for testing
- `src/official-copilot.ts`
  - contains a self-contained Copilot login / refresh / base-url bridge
- `src/gateway-client.ts`
  - custom `streamSimple` transport
  - maintains provider session state for conversation / interaction / task identity
  - emits a gateway request envelope shaped for future VS Code-like Copilot semantics
- `src/event-stream.ts`
  - minimal assistant event stream implementation used by the custom transport
- `scripts/smoke.ts`
  - plugin-only smoke test
- `scripts/verify-omp.ts`
  - integration smoke test against OMP’s real `ModelRegistry.registerProvider(...)` path

## Registered provider

- provider id: `github-copilot-vscode`
- custom api id: `omp-copilot-gateway-chat`
- models:
  - `github-copilot-vscode/claude-haiku-4.5`
  - `github-copilot-vscode/gpt-5.1-codex-mini`

The transport is intentionally **gateway-oriented** rather than pretending to be OMP’s built-in Copilot provider.

It already carries forward the state needed for later Copilot request shaping:

- `conversationId`
- `interactionId`
- `agentTaskId`
- `turnIndex`
- `initiator` (`user` vs `agent`)
- `isNewInteraction`

## Environment variables

- `OMP_COPILOT_GATEWAY_BASE_URL`
  - default: `http://127.0.0.1:8787`
- `OMP_COPILOT_GATEWAY_MOCK=1`
  - enables mock transport mode so the provider can be tested without a live gateway
- `OMP_COPILOT_LOCAL_OMP_REPO`
  - optional path to a local OMP source checkout used for delegated real-Copilot transport

## Auth behavior

This plugin is designed to follow official OMP Copilot auth behavior as closely as possible while using a custom provider id.

- official Copilot credentials are read from `github-copilot`
- the current Copilot access token is injected into the custom provider config for the live session
- Copilot OAuth login/refresh/base-url helpers are implemented locally in the plugin
- the plugin also registers an OAuth bridge for `github-copilot-vscode` so `/login` can work directly if needed

This version no longer depends on the sibling OMP source tree for model definitions.

## Recommended local dev install/load path

### Option A: direct extension path (recommended)

Use the package directory directly as an extension path.

CLI:

- `omp -e /home/zahid/work/labs/omp-copilot-provider-plugin`

Global config:

```yaml
extensions:
  - /home/zahid/work/labs/omp-copilot-provider-plugin
```

Because the directory contains `package.json` with `omp.extensions`, OMP will resolve `./src/extension.ts` automatically.

### Option B: plugin-link package + explicit extension path

If you want OMP’s plugin manager to own the package symlink:

- `omp plugin link /home/zahid/work/labs/omp-copilot-provider-plugin`

Then point `extensions` at the linked package directory:

```yaml
extensions:
  - ~/.omp/plugins/node_modules/omp-copilot-provider-plugin
```

This works, but **Option A is simpler** during development because the current plugin manager runtime path does not automatically activate extension modules.

## Local smoke tests

### 1. Plugin-only smoke test

- `OMP_COPILOT_GATEWAY_MOCK=1 bun run ./scripts/smoke.ts`

This verifies:

- the extension entry loads
- `registerProvider(...)` is called
- the custom stream handler returns assistant events

### 2. OMP integration smoke test

- `OMP_COPILOT_GATEWAY_MOCK=1 bun run ./scripts/verify-omp.ts`

This verifies:

- the extension registers the provider through OMP’s real model registry path
- the provider id is `github-copilot-vscode`
- official `github-copilot` OAuth is mirrored into the custom provider session
- OMP reports the provider as available and resolves Copilot OAuth credentials correctly

## Verified status

What is verified in this repo:

- extension loads
- custom provider registration works at `ModelRegistry.registerProvider(...)`
- Copilot OAuth credentials resolve correctly through the custom provider
- custom transport receives the request
- real Copilot requests can delegate through OMP's official provider streamers from a local OMP source checkout

## Actual OMP CLI smoke test

For a real end-to-end local check with mock mode:

- `OMP_COPILOT_GATEWAY_MOCK=1 omp --model github-copilot-vscode/claude-haiku-4.5 -p "hello"`

In this environment, the installed global `omp` binary successfully enters the custom transport path for the custom provider when using the command above.

For a local source-run check against real GitHub Copilot upstream transport:

- `OMP_COPILOT_LOCAL_OMP_REPO=/home/zahid/work/labs/oh-my-pi bun /home/zahid/work/labs/oh-my-pi/packages/coding-agent/src/cli.ts --extension /home/zahid/work/labs/omp-copilot-provider-plugin --model github-copilot-vscode/gpt-5.1-codex-mini -p "hello"`

## Auth integration status

This scaffold now bridges to official-style Copilot login / refresh / base-url behavior using a self-contained implementation in the plugin.

Current behavior:

- preserves official Copilot login semantics
- preserves official refresh semantics for the custom provider
- preserves official enterprise/base-url resolution logic

## Remaining work

This scaffold now delegates real requests into OMP's official Copilot provider streamers when the base URL resolves to GitHub Copilot. The next layer is to enrich the transport with:

- Copilot-specific headers (`X-Initiator`, interaction/task headers)
- continuation chaining (`previous_response_id` or equivalent)
- tool-result / retry / resume semantics aligned with VS Code Copilot Chat
- richer tool-call streaming

## Runtime observability

Use these flags when validating that OMP is routing requests into the plugin:

- `OMP_COPILOT_PROVIDER_OBSERVE=1`
- `OMP_COPILOT_PROVIDER_OBSERVE_FILE=/tmp/omp-copilot-provider.ndjson`
- `OMP_COPILOT_PROVIDER_OBSERVE_STDERR=1`

For a successful routed request you should see `transport.start` in the log.