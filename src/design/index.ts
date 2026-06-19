/**
 * `@avatarsd-llc/strawberry-cli/design` — the browser-safe, transport-free model
 * subpath (ADR-0066 D6/D8). These are PURE blueprints (Control Box, grow.types,
 * unit-design, controller-kinds, ...) with no WS/DI/codec dependency, so the SPA
 * tree-shakes them and the CLI / Pulumi provider reuse them verbatim.
 *
 * SAFE first-slice scaffold: the seam is declared but no model has been moved yet.
 * Phase 0 of doc/device-client-extraction-plan.md moves the pure leaf models here
 * behind SPA re-export shims; the proof-of-seam leaf is control-box.ts.
 */

// TODO(phase-0): export * from './control-box.js';
// TODO(phase-0): export * from './grow.types.js';
// TODO(phase-1): export * from './unit-design.js';   // gated on the proto codec move
// TODO(phase-1): export * from './controller-kinds.js';
// TODO(phase-4): export * from './device-design.js'; // new whole-device envelope

export {};
