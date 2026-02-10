# aillium-openclaw

## Purpose
`aillium-openclaw` is a **fork of OpenClaw** adapted to act as the orchestration and planning engine for Aillium.

It is responsible for deciding *how* tasks should be executed, not executing them directly.

## What This Repo Does
- Task planning & reasoning
- Policy-aware decision making
- Model usage via LiteLLM
- Execution planning (API vs UI automation)
- Metadata generation for audit & explainability

## What This Repo Does NOT Do
- No UI
- No billing logic
- No credential storage
- No direct remote access

## Architecture Role
Planner / Orchestration Engine

## Integrations
- Aillium Core (tasks & policy)
- LiteLLM (model routing)
- UI-TARS / n8n (execution targets)

## Upstream Notice
This repository is a fork of OpenClaw.
Original licence and notices are preserved.

## Licence
Original upstream licence + Aillium notices

## Upstream Origin

This repository is based on the OpenClaw project.
Original source: https://github.com/<upstream-org>/<openclaw-repo>

This fork contains substantial modifications for the Aillium platform.
