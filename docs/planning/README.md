# Clawdfather — Architecture Planning

Mobile-first account-based SSH orchestration for Clawdfather. This package contains the complete architecture and implementation plan for transforming Clawdfather from an SSH-first flow to an OAuth-based mobile experience with server-side key management.

---

## Documents

| # | Document | Description |
|---|----------|-------------|
| 1 | [Product & UX Flow Specification](./01-product-ux-flow.md) | User journeys, mobile-first UX constraints, and comprehensive error/edge-case flows |
| 2 | [Data Model & Schema Draft](./02-data-model.md) | PostgreSQL DDL for all tables, indexes, lifecycle state machines, and sensitive field protection notes |
| 3 | [API Surface Draft](./03-api-surface.md) | Complete REST API with auth, keys, connections, sessions, and audit endpoints — including request/response examples and WebSocket protocol |
| 4 | [Security Model & Threat Model](./04-security-model.md) | Key management (Ed25519 + AES-256-GCM), host key verification, OAuth hardening, audit logging, and 12-entry threat model table |
| 5 | [Execution Architecture](./05-execution-architecture.md) | Agent runtime binding, ControlMaster process model, reconnect semantics, timeout strategy, and observability requirements |
| 6 | [Phased Implementation Plan](./06-phased-implementation.md) | Four-phase rollout (Foundation → Keys/Connections → Sessions → Hardening), migration strategy, and testing plan |
| 7 | [PR-Ready Engineering Breakdown](./07-engineering-breakdown.md) | Seven epics with 29 issues, story point estimates, dependency map, PR structure, and risk mitigations |

---

## Quick Reference

- **Total estimate:** ~128 story points / ~11 weeks (2 engineers)
- **Tech stack:** TypeScript, Node.js, PostgreSQL, Ed25519, AES-256-GCM, WebSocket
- **Phases:** 0 (Auth) → 1 (Keys + Connections) → 2 (Sessions) → 3 (Hardening + Migration)
- **Migration:** SSH-first flow continues working through Phase 2, deprecated in Phase 3
