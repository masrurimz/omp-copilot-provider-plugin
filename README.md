# OMP Copilot Gateway Provider Plugin

This repository contains a local OMP extension package that registers a custom GitHub Copilot provider path through `pi.registerProvider(...)`.

The point of this scaffold is to keep Copilot request-shaping logic out of OMP core and move it into a provider path we control. The long-term behavioral reference is **VS Code Copilot Chat**.

This revision now targets the same provider id as official OMP Copilot:

- `github-copilot`

So the intended split is:

- official OMP Copilot auth/model semantics
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
  - overrides provider `github-copilot`
  - reuses the official Copilot model surface and auth bridge
- `src/official-copilot.ts`
  - loads official Copilot helpers from the sibling OMP repo during local development
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

- provider id: `github-copilot`
- custom api id: `omp-copilot-gateway-chat`
- models: the plugin loads the same bundled GitHub Copilot model surface used by the local OMP source tree

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

## Auth behavior

This plugin is designed to follow official OMP Copilot auth behavior as closely as possible while overriding transport.

- provider id stays `github-copilot`
- Copilot OAuth login/refresh/base-url helpers are delegated to official OMP source helpers
- the plugin registers an OAuth bridge so the overridden provider still satisfies OMP runtime validation and token refresh expectations

### Local-dev assumption

For now this plugin expects the sibling OMP repo to exist at:

- `/home/zahid/work/labs/oh-my-pi`

That is how it reuses the official Copilot helpers without patching OMP core.

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
- the provider id remains `github-copilot`
- the official Copilot model surface is replaced with the custom transport-backed version
- OMP reports the provider as available and resolves Copilot OAuth credentials correctly

## Verified status

What is verified in this repo:

- extension loads
- same-id provider override works at `ModelRegistry.registerProvider(...)`
- official Copilot model ids are present
- Copilot OAuth credentials resolve correctly through the overridden provider
- custom transport receives the request

## Actual OMP CLI smoke test

For a real end-to-end local check with mock mode:

- `OMP_COPILOT_GATEWAY_MOCK=1 omp -e /home/zahid/work/labs/omp-copilot-provider-plugin --model github-copilot/gpt-5 -p "hello"`

In this environment, the source-level integration is verified, but the currently installed global `omp` binary still does not appear to honor the override transport early enough for a full CLI end-to-end proof. Use the repo smoke tests plus a local/newer OMP build for reliable validation.

## Auth integration status

This scaffold now bridges to the **official Copilot login / refresh / base-url helpers** from the local OMP repo.

Current behavior:

- preserves provider id `github-copilot`
- preserves official Copilot login semantics
- preserves official refresh semantics for the overridden provider
- preserves official enterprise/base-url resolution logic

## What still remains

This scaffold intentionally stops short of full Copilot shaping. The next layer is to connect it to the real Copilot adapter/gateway and enrich the transport with:

- Copilot-specific headers (`X-Initiator`, interaction/task headers)
- continuation chaining (`previous_response_id` or equivalent)
- tool-result / retry / resume semantics aligned with VS Code Copilot Chat
- richer tool-call streaming

## Same-id override caveat

Because OMP runtime provider validation expects auth metadata for providers that define models, this plugin currently registers an OAuth bridge for the same provider id (`github-copilot`).

That is intentional so the overridden provider can keep using official Copilot auth semantics. In practice this should be safe for the transport override path, but some raw provider-list UIs may still show duplicate provider metadata until OMP’s extension/runtime UX is tightened upstream.