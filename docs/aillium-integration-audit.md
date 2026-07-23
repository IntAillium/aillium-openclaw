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
**dead code** or **duplicated across languages**, so the whole never behaves as
one organism.

The three structural issues, in order of leverage:

1. **Dead integration surfaces.** Purpose-built adapters exist but are never
   instantiated (flagship: OpenClaw's `src/aillium/` boundary — fixed in part by
   this change; see below).
2. **Duplicated control plane across languages.** `aillium-core` ships *two*
   runtimes: a Rust daemon and a NestJS API. Only the NestJS one is in the live
   integration path. This is the "different languages" incoherence.
3. **Two unpopulated repos** on the critical path (`Aillium-code` empty,
   `aillium-remote` a docs-only stub).

## Repository status

| Repo | Role | Language / stack | State |
|------|------|------------------|-------|
| `aillium-core` | Control plane (tenancy, RBAC, tasks, approvals, master agent, staff-room, autonomous pulse) | **NestJS + Prisma** (port 3000) **and** a **Rust** 10-crate workspace → `aillium-daemon` (port 4000) | NestJS side is the live control plane (~71 controllers). Rust workspace is a parallel track not in the compose/integration path. |
| `aillium-openclaw` | Runtime / orchestration substrate (agent runtime, browser control, gateway, hooks) | TypeScript (fork of OpenClaw) | Substantial. Aillium boundary in `src/aillium/` existed but was **dead** until this change. |
| `aillium-portal` | Operator dashboard / AI command UI | **React 18 + Vite** (README says Next.js — doc is wrong) | Real UI. `src/pages`, `src/components`, `src/lib`. |
| `aillium-remote-meshcentral` | Remote-support / device session plane | JavaScript (fork of MeshCentral) | Large, real fork with `aillium/` adapter dir. |
| `aillium-schemas` | Shared contracts | JSON Schema + TS package + Python package | Real. Schemas for `core`, `openclaw`, `meshcentral`, `larksuite`, `executor`. |
| `aillium-integrations` | Connectors / workflows (n8n, Lark) | TypeScript | Small but real: `connectors/registry`, `webhooks/events`, `workflows/templates`, `health/check`. |
| `platform` | Docker Compose orchestration + deploy scripts | Compose / shell | Real. Wires core (3000) + portal + TARS worker + OpenClaw + n8n + Postgres. |
| `aillium-remote` | (intended remote piece) | — | **Stub**: only README/LICENSE/guardrails. Real remote lives in `aillium-remote-meshcentral`. |
| `Aillium-code` | Coding agent, "based on opencode" | — | **Empty** on this branch (only `.git`). opencode not yet vendored. |

## Integration seam map

### Connected (working call paths)

- **OpenClaw gateway → Core (mobile avatar).** `src/gateway/server-http.ts`
  proxies `/mobile/avatar` and `/mobile/avatar/interact` to
  `AILLIUM_CORE_URL` (`server-http.ts:1023`, `:1066`). Matches Core's
  `mobile.controller.ts`.
- **Core ← OpenClaw MCP/desktop.** `src/gateway/aillium-mcp-http.ts` serves
  `/api/aillium/mcp/*` and `/api/aillium/desktop/*` for Core to drive runtime
  tools/desktop actions. Wired into `server-http.ts:30`.
- **Boundary contracts vs Core endpoints.** Every endpoint the boundary calls
  exists in Core and the payload shapes match:
  - `POST /master-agent/runtime/operator-sync` ← `master-agent-runtime-sync.controller.ts:12`
  - `POST /master-agent/runtime/context-lifecycle` ← same controller
  - `POST /execution-capsules/runtime/lifecycle` ← `execution-capsules.controller.ts:236`
  - `GET /staff-room/agent-context/:agentId` ← `staff-room-dashboard.controller.ts:45`
  - `GET /staff-room/retrieve` ← `staff-room-dashboard.controller.ts:20`

### Dead (built, never called) — flagship gap

- **OpenClaw's entire `src/aillium/` boundary.** `createLiveAilliumBoundary` /
  `createDefaultAilliumBoundary` (registration, evidence callbacks,
  context-lifecycle, capsule-lifecycle, Staff Room context) were exported from
  `src/aillium/index.ts` and imported **nowhere** in the runtime. Result: Core's
  master-agent continuity/pulse services (`master-agent-continuity.service.ts`,
  `master-agent-pulse.service.ts`) had no runtime feeding them evidence, so the
  "living master agent" could not actually observe the runtime.

  **Fixed here (partial):** added `src/aillium/boundary-runtime.ts` as the single
  composition root (env-driven live/default selection + best-effort helpers) and
  wired a best-effort operator-sync at gateway bind
  (`src/gateway/server-runtime-state.ts`). Remaining call sites below (P0).

### Mismatched (both ends exist, semantics differ)

- **`register()` vs `operator-sync`.** The boundary's
  `RuntimeRegistrationAdapter.register()` reads like "announce a new runtime
  instance", but Core's `operator-sync` *updates an existing* `masterAgentSession`
  (`master-agent-runtime-sync.service.ts` throws `NotFoundException` when
  `runtime_session_key` has no session). So a runtime cannot self-register;
  something must first create the Core session and hand its key to the runtime
  (`AILLIUM_RUNTIME_SESSION_KEY`). Core has **no** generic runtime-instance
  registry endpoint. Decide: add one, or formalize session-key handoff.

### Stubbed / empty

- `Aillium-code` empty — the opencode-based coding agent is unbuilt.
- `aillium-remote` docs-only — superseded in practice by `aillium-remote-meshcentral`.

## Prioritized roadmap

### P0 — make the master agent actually observe its runtime

1. **Session-key handoff.** When Core spawns a master-agent session, pass its
   `openclawSessionKey` to the OpenClaw runtime (env or session metadata) so
   `operator-sync` lands instead of 404ing. (Depends on the register/operator-sync
   decision above.)
2. **Wire the remaining boundary call sites** through
   `getAilliumBoundary()` (all verified against existing Core endpoints):
   - context-engine lifecycle (`afterTurn`/`compact`/`bootstrap`) →
     `contextLifecycle.onContextLifecycle`;
   - evidence emission on tool/turn completion → `evidenceHooks`;
   - execution-capsule transitions → `capsuleLifecycle`;
   - Staff Room context injection at agent bootstrap → `fetchStaffRoomAgentContext`.
3. **End-to-end smoke:** boundary → operator-sync → master-agent session row →
   portal introspection view.

### P1 — coherence and the delegation loop

4. **Resolve the Rust-vs-NestJS core.** Document which is source of truth
   (NestJS, per `IMPLEMENTATION_LOG.md`), and either retire the Rust daemon from
   the runtime path or define a crisp boundary. Right now it is dead weight and a
   source of "different languages" confusion.
5. **Master → department manager → sub-agent delegation.** Verify
   `coordinator-orchestration.service.ts` + `agent-teams` + `departments` +
   `approval-queue` form a closed loop (manager proofs work vs company
   instructions → human/master approval). Fill any dead seams the same way.
6. **Fix portal/docs drift.** README claims Next.js; it is React + Vite. Align
   docs and confirm the portal's Core API base + realtime (WS/SSE) endpoints
   resolve.

### P2 — complete the surface

7. **Populate `Aillium-code`** from latest opencode as a deliberate vendoring
   task (its own session; large external import).
8. **Email/calendar monitoring + self-prompting pulse** end to end
   (`ai-mailbox.controller.ts`, `master-agent-pulse-scheduler.service.ts`,
   `automations`), including OOO cover (`ooo.controller.ts`).
9. **Decommission or formalize `aillium-remote`** in favor of
   `aillium-remote-meshcentral`.

## Key decisions the founder should make

1. **Core runtime of record:** NestJS only, or NestJS + Rust with a defined
   split? (Blocks P1.)
2. **Runtime identity model:** add a Core runtime-registry endpoint, or keep the
   session-key handoff model? (Blocks P0.)
3. **opencode vendoring:** confirm target upstream + license posture before
   populating `Aillium-code`.
