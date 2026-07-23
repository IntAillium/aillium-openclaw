# Aillium OS integration audit

Status date: 2026-07-23. Author: automated integration review.

This document maps how the Aillium repositories are *meant* to connect into a
single autonomous business OS, where they actually connect today, and what to
fix (in priority order) to make the system function end to end. It is written to
be picked up across multiple work sessions, so every claim cites file evidence.

## How to read this

- **Connected** — a real call path exists and the contract matches on both ends.
- **Dead** — the code exists on one side but nothing instantiates or calls it.
- **Mismatched** — both ends exist but the contract or semantics do not line up.
- **Stubbed / empty** — the repo or module is a placeholder.

## Executive summary

The system is **not** a dead or empty codebase. It is a large, mostly-real
platform (Aillium Core alone has ~71 NestJS controllers covering exactly the
intended vision: master agent, staff-room memory, autonomous pulse, OOO cover,
approval queue, departments/coordinator, EOD reports). The problem the founder
describes — "features not linking together" — is accurate but specific: the
pieces are built, and many seams are wired, but several high-value seams are
**dead code**, so the whole never behaves as one organism.

The two structural issues, in order of leverage:

1. **Dead integration surfaces.** Purpose-built adapters exist but were never
   instantiated (flagship: OpenClaw's `src/aillium/` boundary — now wired; see
   "Changes landed" below).
2. **Two unpopulated repos** on the critical path (`Aillium-code` empty,
   `aillium-remote` a docs-only stub).

## Architecture: Core is two complementary tiers (not a duplicate)

`aillium-core` ships two services in two languages, and they are **complementary
tiers, not competing control planes** (confirmed from `docker-compose.internal.yml`):

- **`core-api`** — NestJS + Prisma, port 3000, built by `Dockerfile.nestjs`. This
  is the **control plane and system of record**: ~71 controllers (tenancy, RBAC,
  master agent, staff-room, approvals, tasks). The portal, OpenClaw, the Rust
  daemon, and the operator-runtime-worker all integrate against it.
- **`core`** — Rust `aillium-daemon`, port 4000, built by the root `Dockerfile`
  (10-crate workspace: conscious/subconscious runtimes, coordinator, policy, db,
  daemon-rt worker loop). It is a **client of `core-api`**
  (`AILLIUM_CORE_BASE_URL: http://core-api:3000/api`), i.e. the autonomous
  execution/worker tier, not a second source of truth.

**Decision (recorded): the runtime of record is NestJS `core-api`.** The Rust
daemon stays as the autonomous worker tier; do not fold control-plane authority
(tenancy, policy, approvals) into it. The remaining coherence work is to
document the tier boundary and dedupe any overlap between the Rust worker loop
and the NestJS `operator-runtime-worker` (both post to `operator-sync` /
`execution-capsules/runtime/lifecycle`).

## Repository status

| Repo | Role | Language / stack | State |
|------|------|------------------|-------|
| `aillium-core` | Control plane (`core-api`, NestJS, :3000) + autonomous daemon (`core`, Rust, :4000, client of core-api) | NestJS + Prisma **and** Rust workspace | Both real and complementary. `core-api` is the system of record. |
| `aillium-openclaw` | Runtime / orchestration substrate (agent runtime, browser control, gateway, hooks) | TypeScript (fork of OpenClaw) | Substantial. Aillium boundary now wired to Core (this work). |
| `aillium-portal` | Operator dashboard / AI command UI | **React 18 + Vite** (README says Next.js — doc is wrong) | Real UI. `src/pages`, `src/components`, `src/lib`. |
| `aillium-remote-meshcentral` | Remote-support / device session plane | JavaScript (fork of MeshCentral) | Large, real fork with `aillium/` adapter dir. |
| `aillium-schemas` | Shared contracts | JSON Schema + TS package + Python package | Real. Schemas for `core`, `openclaw`, `meshcentral`, `larksuite`, `executor`. |
| `aillium-integrations` | Connectors / workflows (n8n, Lark) | TypeScript | Small but real: `connectors/registry`, `webhooks/events`, `workflows/templates`, `health/check`. |
| `platform` | Docker Compose orchestration + deploy scripts | Compose / shell | Real. Wires core-api + core + portal + OpenClaw + worker + n8n + Postgres. |
| `aillium-remote` | (intended remote piece) | — | **Stub**: only README/LICENSE/guardrails. Real remote lives in `aillium-remote-meshcentral`. |
| `Aillium-code` | Coding agent, "based on opencode" | — | **Empty** on this branch (only `.git`). opencode not yet vendored. |

## Integration seam map

### Connected (working call paths)

- **OpenClaw gateway → Core (mobile avatar).** `src/gateway/server-http.ts`
  proxies `/mobile/avatar` and `/mobile/avatar/interact` to `AILLIUM_CORE_URL`
  (`server-http.ts:1023`, `:1066`). Matches Core's `mobile.controller.ts`.
- **Core ← OpenClaw MCP/desktop.** `src/gateway/aillium-mcp-http.ts` serves
  `/api/aillium/mcp/*` and `/api/aillium/desktop/*` for Core to drive runtime
  tools/desktop actions. Wired into `server-http.ts:30`.
- **Runtime register + sync (NEW this work).** OpenClaw's boundary now registers
  the runtime with Core and can sync state. Endpoints on `core-api`:
  - `POST /master-agent/runtime/register` ← `master-agent-runtime-sync.controller.ts` (new)
  - `POST /master-agent/runtime/operator-sync` ← same controller
  - `POST /master-agent/runtime/context-lifecycle` ← same controller
  - `POST /execution-capsules/runtime/lifecycle` ← `execution-capsules.controller.ts:236`
  - `GET /staff-room/agent-context/:agentId` ← `staff-room-dashboard.controller.ts:45`
  - `GET /staff-room/retrieve` ← `staff-room-dashboard.controller.ts:20`

### Changes landed (this work)

- **OpenClaw's `src/aillium/` boundary is now instantiated.** Added
  `src/aillium/boundary-runtime.ts` (single composition root; env-driven
  live/default selection) and wired a best-effort registration at gateway bind
  (`src/gateway/server-runtime-state.ts`). Runtime signals can now reach Core.
- **Resolved the register/operator-sync mismatch.** Previously the boundary's
  `register()` posted to `operator-sync`, which only *updates an existing*
  master-agent session (it 404s on an unknown key) — so a runtime could not
  self-register. Added `POST /master-agent/runtime/register` on `core-api`
  (`registerRuntime()` in `master-agent-runtime-sync.service.ts`): it resolves
  the tenant's enabled master-agent profile and creates or reactivates a
  `MasterAgentSession`, returning the `runtime_session_key` the runtime then uses
  for `operator-sync`. The boundary now calls this endpoint with `AILLIUM_TENANT_ID`.

### Now wired via the context-engine decorator

`src/aillium/context-engine-forwarding.ts` wraps the resolved context engine
once at the `resolveContextEngine` composition boundary
(`src/context-engine/registry.ts`) and covers three seams from one point:

- **context lifecycle** — `bootstrap` / `afterTurn` / `compact` forward to Core
  `POST /master-agent/runtime/context-lifecycle` via `contextLifecycle`;
- **evidence** — each completed turn emits `context.after_turn` via `evidenceHooks`;
- **Staff Room injection** — `assemble()`'s `systemPromptAddition` is augmented
  with the agent's Staff Room context (cached ~5 min, gated on `AILLIUM_AGENT_ID`).

The wrapper is a faithful decorator: no-op passthrough when Core is unconfigured,
preserves the presence of every optional engine method, and never changes the
underlying engine's return values apart from the Staff Room prompt addition.

### Not an OpenClaw wire: capsule lifecycle

`capsuleLifecycle` in the boundary has **no OpenClaw source** — "execution
capsules" are a Core/worker-tier concept (`execution-capsules.controller.ts`,
the operator-runtime-worker), not something the OpenClaw runtime emits. The
worker already posts capsule transitions to
`POST /execution-capsules/runtime/lifecycle`, so this is correctly owned by the
Core tier, not a missing OpenClaw wire.

### Stubbed / empty

- `Aillium-code` empty — the opencode-based coding agent is unbuilt.
- `aillium-remote` docs-only — superseded in practice by `aillium-remote-meshcentral`.

## Prioritized roadmap

### P0 — make the master agent observe its runtime

1. **Done:** runtime register endpoint + boundary composition + startup register.
2. **Done:** context lifecycle + per-turn evidence + Staff Room injection wired
   via the context-engine decorator. Capsule lifecycle is Core-tier (not an
   OpenClaw wire).
3. **Deploy plumbing (remaining):** set `AILLIUM_TENANT_ID`, the runtime token,
   and optionally `AILLIUM_AGENT_ID` on the OpenClaw service in compose so
   registration and Staff Room injection activate per tenant.
4. **End-to-end smoke (remaining):** register → operator-sync + context-lifecycle
   → master-agent session/journal rows → portal introspection view.

### P1 — coherence and the delegation loop

5. **Document the Core tier boundary** (NestJS control plane vs Rust worker) and
   dedupe the Rust worker loop vs NestJS `operator-runtime-worker` overlap.
6. **Master → department manager → sub-agent delegation.** Verify
   `coordinator-orchestration.service.ts` + `agent-teams` + `departments` +
   `approval-queue` form a closed loop (manager proofs work vs company
   instructions → human/master approval). Fill any dead seams the same way.
7. **Fix portal/docs drift.** README claims Next.js; it is React + Vite.

### P2 — complete the surface

8. **Skill-creation engine (natural language → agent skills).** The OS needs a
   way for a business to *train* its master, department, and sub-agents: take a
   plain-language request ("chase overdue invoices weekly") and turn it into a
   reusable skill bound to the right agent(s). Data model already exists
   (`MasterAgentSkillBinding`, `skills.controller.ts`, `ai-builder.controller.ts`);
   build the NL-to-skill authoring flow + portal UI on top. Founder priority:
   after P0/P1.
9. **Populate `Aillium-code`** from latest opencode (its own session; large
   external import).
10. **Email/calendar monitoring + self-prompting pulse** end to end
    (`ai-mailbox.controller.ts`, `master-agent-pulse-scheduler.service.ts`,
    `automations`), including OOO cover (`ooo.controller.ts`).
11. **Decommission or formalize `aillium-remote`** in favor of
    `aillium-remote-meshcentral`.

## Decisions

1. **Core runtime of record: NestJS `core-api`.** Rust daemon stays as the
   autonomous worker tier (client of core-api); no control-plane authority moves
   into it. (Decided.)
2. **Runtime identity: proper register endpoint added** (`.../runtime/register`),
   rather than overloading operator-sync. (Decided + implemented here.)
3. **opencode vendoring: deferred** to after the skill-creation engine; confirm
   upstream + license posture before populating `Aillium-code`. (Deferred.)
