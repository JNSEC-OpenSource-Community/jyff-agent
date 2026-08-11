---
name: ai-slop-taste
description: Audit, remove, or intentionally generate AI-slop taste across UI, TUI, agent runtime, state, and code architecture.
user-invocable: true
---

# AI Slop Taste

Use this skill when the user asks to audit, describe, remove, or intentionally create "AI slop" in a software project. Treat AI slop as a taste and architecture diagnosis: code and UX that feel generated, over-expanded, generically branded, state-heavy, fallback-heavy, and thinly grounded in the user's real workflow.

AI slop is a product/code smell, not a claim about authorship. Human-written code can feel sloppy; AI-written code can feel sharp.

## Activation

Use this skill when the request includes any of these intents:

- Audit a project for "AI slop", "slop taste", "vibe-coded smell", "OpenClaw smell", "agent slop", or generic AI-product bloat.
- Make a project feel clean, intentional, boring, direct, high-signal, or low-slop.
- Intentionally create a slopmax prototype, parody, agent control plane, or generated-looking AI product.
- Review web UI, TUI, CLI, agent runtime, state management, config, fallback logic, skills, plugin systems, or orchestration code.

Default mode is `anti-slop`. Use `slopmax` only when the user explicitly asks to create AI slop.

## Calibration: OpenClaw-shaped slop

Use these OpenClaw-inspired reference patterns as calibration examples:

- Web UI super-component: one app surface owns auth, chat, sessions, tools, skills, devices, logs, config, usage, themes, real-time talk, approvals, timers, and sidebars.
- Control-plane renderer: render logic, controller handoffs, local storage preferences, feature tabs, modals, state hydration, and domain-specific UI all live in a broad "app render" layer.
- TUI-as-runtime: the terminal loop coordinates backend connection, session identity, slash commands, input history, key handling, status text, auth flows, local shell fallback, and render scheduling.
- Streaming state fog: `activeRunId`, `pendingRunId`, `optimisticUserMessage`, finalized/completed/post-finalizing maps, watchdog timers, reconnect run ids, and history refresh flags coexist.
- Agent command hub: one orchestration path knows model selection, provider aliases, fallback, auth profiles, session persistence, outbound delivery, plugin manifests, skills, workspaces, usage cost, diagnostics, and run lifecycle events.
- Issue-shaped symptoms: model says changed while runtime uses old model; spinner keeps running while run id is absent; session label and session key drift; typed input during generation bleeds into a future turn; help text loads huge runtime graphs.
- Style-guide contradiction: clean architecture rules emphasize single canonical paths, owner boundaries, strict contracts, fewer fallbacks, and hot-path discipline while implementation accretes timers, resolvers, maps, shims, and catch-all control surfaces.

## Definition

AI slop taste appears when the project optimizes for the appearance of a complete agentic system before the core user flow has a stable ownership model.

Strong slop has these traits:

- Surplus nouns: Gateway, Control Plane, Workspace, Skill, Agent, Runtime, Provider, Capability, Manifest, Session, Device, Workshop, Catalog, Harness, Pipeline.
- Generic surfaces: dashboards, sidebars, health panels, activity feeds, logs, badges, cards, tabs, settings panes, skill browsers, debug panels.
- State fog: many nullable ids, boolean flags, maps, timers, retry counters, pending/finalized/completed sets, and duplicated sources of truth.
- Fallback hydra: every failure path adds another retry, resolver, compatibility shim, local-mode branch, legacy alias, or "safe" polling path.
- Stringly lifecycle: event names, phases, run ids, session keys, and model refs are composed from strings and normalized repeatedly.
- Optimistic mirage: UI claims success, readiness, connection, model switch, or active run before the runtime contract confirms it.
- Adapter lace: thin modules rename fields, coerce strings, normalize ids, re-export helper helpers, and hide boundary uncertainty.
- Control-plane fetish: internal plumbing becomes the product UI.
- Copy sheen: language uses broad AI-product nouns and adjectives instead of user-task nouns and exact outcomes.
- Test shrine: tests preserve accidental complexity instead of pressure-testing the user's main flow.

Low-slop design feels boring, small, typed, owned, and task-shaped. It uses fewer nouns, fewer states, fewer settings, fewer layers, and stronger contracts.

## Audit workflow

When auditing a codebase, follow this sequence:

1. Map the actual user flows.
   - Name 1-3 primary flows in user language.
   - Trace each flow from entrypoint to storage and back to UI.
   - Count surfaces touched: UI, TUI, API, gateway, agent loop, storage, plugin, skill, queue, config.

2. Locate ownership boundaries.
   - Identify the single owner for session identity, run state, model selection, workspace path, delivery, persistence, and cancellation.
   - Mark duplicated owners and cross-layer mutations as slop evidence.

3. Inspect state shape.
   - Search for parallel booleans, nullable ids, maps keyed by run/session/model, timers, `Record<string, unknown>`, and “pending/final/fallback” triplets.
   - Prefer a closed state machine when more than 3 flags describe one lifecycle.

4. Inspect fallback shape.
   - Classify each fallback as product contract, migration, compatibility, retry, offline mode, local mode, or paper-over branch.
   - Slop rises when fallback status has UI copy and runtime branches while the user flow still lacks a crisp success contract.

5. Inspect copy and UX.
   - Replace internal nouns with user verbs.
   - Remove ornamental status text that cannot change user action.
   - Collapse panels that expose implementation plumbing as product features.

6. Inspect tests.
   - Good tests prove the primary user flow and boundary contracts.
   - Slop tests encode internal maps, retry timers, ANSI fragments, magic sentinels, snapshots of accidental strings, and fake backends that bypass the real contract.

7. Produce a scorecard and refactor plan.
   - Give evidence with file paths, symbols, and concrete snippets.
   - Recommend deletion first, then consolidation, then new abstractions.

## Scoring rubric

Rate each category from 0 to 5.

- 0: Sharp. Direct, owned, typed, user-flow-first.
- 1: Pragmatic. Some adapters or flags with clear contracts.
- 2: Slight slop. Minor naming sheen, local fallbacks, manageable state spread.
- 3: Visible AI slop. Generic architecture nouns, growing flags, broad UI panels, unclear ownership.
- 4: OpenClaw-grade slop. God surfaces, fallback hydra, session fog, string lifecycle, runtime/UI mismatch.
- 5: Slopmax. The whole product is an agent control plane for its own plumbing.

Categories:

| Category                 | What to inspect                             | Strong slop evidence                                                         |
| ------------------------ | ------------------------------------------- | ---------------------------------------------------------------------------- |
| Surface stack            | Web UI, TUI, CLI, dashboards                | More surfaces than user flows; debug/control panels as default UX            |
| State & identity         | sessions, runs, models, workspace, agent id | Parallel ids, nullable sentinels, label/key drift, repeated normalization    |
| Orchestration            | command handlers, runtime hubs, gateway     | One file knows every subsystem; feature additions touch many layers          |
| Fallback & compatibility | retries, legacy aliases, polling, shims     | Fallback paths define behavior instead of bounded recovery                   |
| Agent runtime            | tools, skills, plugins, model selection     | Agent loop owns provider policy, delivery, persistence, and UI-facing status |
| Copy & visual taste      | titles, labels, badges, empty states        | Generic AI-product wording, confidence without user-action value             |
| Tests & proof            | fixtures, snapshots, fake backends          | Tests mirror internal confusion instead of user contract                     |

Overall score = average of categories. Treat any category at 5 as a blocker for "clean" taste.

## Web UI slop signals

High-slop WebUI patterns:

- A single app component owns unrelated domains: chat, agents, tools, skills, devices, auth, config, cron, logs, sessions, usage, appearance, approvals.
- Render files import many controllers and domain views, then coordinate feature state directly.
- LocalStorage becomes a shadow config system for UI preferences, workshop modes, session state, drafts, panel sizes, and “last active” fields.
- The UI exposes internal plumbing: gateway status, model fallback, skill eligibility, tool stream, compaction, pairing, node presence, debug logs.
- Panels grow by noun taxonomy: Agents, Skills, Tools, Cron, Devices, Logs, Health, Memory, Usage, Debug, Settings.
- The main chat flow competes with sidebars, activity streams, transcript viewers, tool drawers, full-message panes, and control cards.
- Copy says "connected", "ready", "synced", "model set", or "running" while the runtime contract has no single source of truth.

Slopmax WebUI wireframe:

```text
+--------------------------------------------------------------------------------+
| OpenClaw Control Plane       Agent: main       Session: global       Healthy    |
+------------------+---------------------------+---------------------------------+
| Agents           | Chat                      | Tool Stream                     |
| Skills           | [Gateway Connected]       | [fallback_step] [compaction]    |
| Cron             | [Model Ready]             | [approval pending]              |
| Memory           | [Skill Snapshot Fresh]    |                                 |
| Devices          |                           | Activity Feed                   |
| Logs             | Ask Molty anything...     | run_12 pending/finalizing/done  |
| Debug            | [Send] [Stop] [Retry]     |                                 |
+------------------+---------------------------+---------------------------------+
| Health | Usage | Config | Workshop | Realtime Talk | Pairing | Diagnostics     |
+--------------------------------------------------------------------------------+
```

Low-slop WebUI wireframe:

```text
+----------------------------------------+
| Ask assistant                          |
| [Type a message................] [Send]|
|                                        |
| Latest answer                          |
| [Stop] appears only during a live run   |
+----------------------------------------+
```

Anti-slop WebUI rules:

- One screen starts with the user's verb.
- One owner controls each lifecycle.
- Status appears only when it changes user action.
- Settings exist only for choices users repeatedly make.
- Debug and observability stay behind an explicit debug surface.
- A new panel replaces or deletes an old panel.

## TUI slop signals

High-slop TUI patterns:

- The TUI becomes a second application runtime instead of a thin projection over a runtime contract.
- Keyboard handling knows domain semantics: stop, auth, model picker, session switch, shell mode, overlay, paste, history, multiline, debug refresh.
- Slash command handling becomes a hidden API with `/model`, `/agent`, `/session`, `/auth`, `/goal`, `/think`, `/tools`, `/skills`, `/logs`, `/config`, and local shell escape paths.
- A spinner expresses hope instead of a confirmed run state.
- Input typed during generation has ambiguous semantics: buffer, queue, interrupt, discard, or submit-later.
- Terminal quirks create product logic: paste coalescers, platform-specific key fallbacks, hard-exit timers, ANSI/Unicode gates, fake backend tests.
- Watchdog timers produce reassurance text while the actual transport contract remains unclear.

Slopmax TUI shape:

```text
╭─ OpenClaw TUI ──────────────────────────────────────────────────────╮
│ Gateway: connected | Agent: main | Session: agent:main:main | k2p5   │
├─────────────────────────────────────────────────────────────────────┤
│ Molty is thinking... still waiting... reconnecting... finalizing...  │
│ Tool stream: shell.run pending | browser.open done | fallback active │
├─────────────────────────────────────────────────────────────────────┤
│ /model /agent /session /auth /goal /skills /tools /logs /debug /fix  │
│ >                                                                  │
╰─────────────────────────────────────────────────────────────────────╯
```

Low-slop TUI shape:

```text
> ask: refactor this function
streaming answer...                                      [Esc cancels]
```

Anti-slop TUI rules:

- TUI reads one typed runtime state and renders it.
- Esc always cancels a live cancellable run or says exactly why cancellation is unavailable.
- Input during generation has one documented behavior.
- Help text loads without runtime config, plugin discovery, native modules, or network probes.
- Slash commands remain a small public interface, not a hidden product surface.

## Agent/runtime slop signals

High-slop agent patterns:

- One command path imports or lazily loads provider selection, model aliases, auth profiles, session store, delivery, plugins, skills, workspace, usage, diagnostics, compaction, fallback, and lifecycle events.
- Agent identity, workspace path, and session key are resolved in more than one subsystem.
- `main`, `global`, `unknown`, default workspace, default agent, and legacy session ids become semantic values.
- The run loop owns product policy: delivery retries, channel selection, billing fallback, model fallback, prompt injection, plugin eligibility, and UI-facing lifecycle text.
- Tool/agent lifecycle events are open-ended strings passed through transport, UI, TUI, logs, and tests.
- Model switch, fallback, auth refresh, and session patch mutate different stores and disagree about current state.
- Skills and plugins use broad eligibility snapshots and injected environment while the caller lacks a precise capability contract.

Anti-slop agent/runtime rules:

- One module owns session identity.
- One module owns model selection.
- One module owns workspace resolution.
- One module owns delivery.
- Agent run state is a closed type.
- Fallback is a named policy with a bounded result.
- UI events are projections of domain state, not independent truth.
- The run loop calls domain services; it does not become the product architecture.

## Code pattern examples

Sloppy lifecycle shape:

```ts
type RunFog = {
  activeChatRunId: string | null
  pendingChatRunId: string | null
  reconnectPendingRunId: string | null
  pendingOptimisticUserMessage: boolean
  finalizedRuns: Map<string, number>
  completedRuns: Map<string, number>
  postFinalizingRuns: Map<string, number>
  streamingWatchdogTimer: ReturnType<typeof setTimeout> | null
}
```

Clean lifecycle shape:

```ts
type ChatRun =
  | { kind: "idle" }
  | { kind: "submitting"; runId: RunId; message: DraftMessage }
  | { kind: "streaming"; runId: RunId; text: string; canInterrupt: true }
  | { kind: "completed"; runId: RunId; message: AssistantMessage }
  | { kind: "failed"; runId: RunId; error: ChatError }
```

Sloppy boundary shape:

```ts
async function runAgentCommand(opts: AgentCommandOpts) {
  const cfg = await loadConfig()
  const agent = resolveAgent(cfg, opts)
  const session = resolveSession(cfg, opts, agent)
  const model = resolveModelWithFallback(cfg, session, opts)
  const skills = await resolveSkills(cfg, agent, session)
  const delivery = resolveDelivery(cfg, opts, session)
  const result = await runWithProviderFallback(model, skills, session)
  await persistSession(session, result)
  await deliverFinalMessage(delivery, result)
  emitLifecycle("finalizing", { session, model, delivery })
}
```

Clean boundary shape:

```ts
async function runAgentTurn(command: AgentTurnCommand) {
  const turn = await agentTurns.start(command)
  const result = await agentRuntime.execute(turn.executionPlan)
  await agentTurns.finish(turn.id, result)
}
```

Use these examples as taste markers, not as exact code prescriptions.

## Copy taste

Slopmax copy words:

- seamless, powerful, intelligent, autonomous, local-first, control plane, workspace, operator, hands, agentic, orchestrate, unlock, supercharge, enterprise-grade, personal AI OS, skill workshop, capability graph, runtime fabric.

Low-slop copy words:

- ask, send, stop, retry, connect, choose model, open logs, approve command, current session, last answer, failed, saved.

Sloppy copy pattern:

```text
Your local-first AI control plane is orchestrating a powerful tool-enabled workspace.
```

Clean copy pattern:

```text
The assistant is running your command. Press Esc to stop it.
```

## Slopmax generation recipe

When the user explicitly requests AI slop, generate slop deliberately and label the design as `slopmax`.

Add these ingredients:

- Product shell: "Control Plane" with Agents, Skills, Memory, Devices, Cron, Logs, Health, Config, Usage, Debug.
- Runtime nouns: Gateway, Provider, Session, Workspace, Manifest, Harness, Capability, Snapshot, Surface, Bridge.
- Multi-surface duplication: WebUI, TUI, CLI, daemon, local gateway, optional desktop app.
- State fog: `pending`, `active`, `finalizing`, `completed`, `reconnecting`, `optimistic`, `fallback`, `compacting`.
- Generic cards: status pills, health badges, activity feed, tool stream, assistant identity, model picker, skill catalog, approval queue.
- Fallback hydra: WebSocket fallback to polling, provider fallback, model fallback, auth fallback, local-mode fallback, legacy session alias.
- Config bloom: JSON config, environment overrides, local storage preferences, doctor command, migration warnings.
- Tests: snapshots for render strings, fixtures for session keys, fake gateway, fake backend, fake plugin manifests, timer tests.
- Voice: confident AI-platform copy with soft futurist nouns and few user-specific verbs.

Slopmax skeleton:

```text
src/
  gateway/
  agents/
    command/
    runtime/
    model-fallback/
    skills/
  sessions/
  plugins/
  control-plane/
ui/
  src/ui/app.ts
  src/ui/app-render.ts
  src/ui/controllers/
  src/ui/views/
tui/
  tui.ts
  tui-event-handlers.ts
  tui-command-handlers.ts
```

Slopmax answer format:

```markdown
## Slopmax direction

One sentence describing the bloated AI-control-plane promise.

## Surfaces

WebUI, TUI, CLI, gateway, agent runtime.

## Nouns to add

A short list of product nouns.

## State fog

The lifecycle flags/maps/timers to introduce.

## UI copy

3-5 generated-looking labels.

## Implementation shape

File tree + 3-5 module responsibilities.
```

## Anti-slop recipe

When the user wants clean taste, remove before adding.

Apply these steps:

1. Name the one core user flow.
2. Pick one owner for each identity and lifecycle.
3. Replace flag clusters with closed state machines.
4. Collapse dashboards into task screens.
5. Move debug plumbing behind explicit debug mode.
6. Delete compatibility shims after a migration path exists.
7. Convert string lifecycle events into typed events.
8. Keep fallback policies bounded and visible.
9. Make cancellation/interruption first-class.
10. Test the user flow and the boundary contracts.

Anti-slop answer format:

```markdown
## Verdict

Slop score: X/5 — one direct sentence.

## Strongest slop signals

- File/symbol: concrete smell and user impact.

## Refactor cuts

- Delete/merge/own this specific thing.

## Target shape

Small architecture with named owners.

## Proof

Tests or manual checks that prove the cleaned flow.
```

## Review output template

Use this template for audits:

```markdown
## Verdict

Slop score: X/5. The strongest smell is ...

## Scorecard

| Category                 | Score | Evidence |
| ------------------------ | ----: | -------- |
| Surface stack            |       |          |
| State & identity         |       |          |
| Orchestration            |       |          |
| Fallback & compatibility |       |          |
| Agent runtime            |       |          |
| Copy & visual taste      |       |          |
| Tests & proof            |       |          |

## Evidence

| File/surface | Slop signal | User impact | Fix |
| ------------ | ----------- | ----------- | --- |

## Clean target

Describe the small, boring architecture.

## Slopmax target

Describe how to make it intentionally more AI-sloppy.
```

## Safety and quality boundaries

- Keep intentional slop harmless, satirical, or aesthetic.
- Decline requests that use slop to hide malware, steal credentials, bypass review, impersonate users, or weaken security controls.
- For security-sensitive agent systems, prefer explicit permissions, audit logs, scoped credentials, and human confirmation for destructive operations.
- Do not equate "large" with slop. Large systems can be clean when ownership, contracts, and user flows stay sharp.
- Use evidence: file paths, symbols, user-visible symptoms, and concrete state/flow contradictions.

## Final taste rule

A project feels low-slop when a user action maps to one state machine, one runtime owner, one storage truth, one visible outcome, and one way to recover.

A project feels AI-sloppy when every product noun creates a panel, every panel creates state, every state creates fallback, every fallback creates a resolver, and every resolver receives its own tests, docs, and reassuring copy.
