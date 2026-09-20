/**
 * deepbook-trading-agent — CHP Decision Gate (Profile B spend gate)
 *
 * Spend-policy evaluation now delegates to the normative `@cubiczan/chp`
 * engine (`evaluateGate` / `approveHuman`, spec §6.3/§6.5) — the same engine
 * the clearance-gate example consumes. This class keeps the repo's public
 * surface and adds the session state the pure engine needs:
 *   - loads a risk policy (config/policy.yaml, conservative default fallback)
 *   - tracks the rolling daily committed notional and passes it as
 *     `committedToday`
 *   - records per-decision provenance (an append-only in-memory ledger) with
 *     the engine's canonical content hash
 *
 * Normative semantics (supersede the earlier in-tree port):
 *   - notional must be finite and > 0 (`sane-notional`) — an unsized action
 *     is BLOCKED, not waved through
 *   - hard violations collect first → BLOCKED; a clean action at/above the
 *     HITL threshold (inclusive) → HITL_REQUIRED; otherwise LOCKED
 *
 * The Profile A hardening flow (R0 gate, foundation scoring, human lock,
 * decision ledger) lives in `src/chp/hardening.ts` (ported from the
 * erp-control-plane GenBI promotion gate). Capital-moving decisions must
 * pass BOTH gates before submission.
 */

import { randomUUID } from 'node:crypto';
import { evaluateGate as chpEvaluateGate, approveHuman as chpApproveHuman } from '@cubiczan/chp';
import type { Claim } from '@cubiczan/chp';
import { loadPolicy, defaultPolicyPath, toGatePolicy, type RiskPolicy, type ChpAction } from './policy.js';

export type { ChpAction } from './policy.js';
export type { RiskPolicy } from './policy.js';

/** Lifecycle states a proposed action moves through. */
export type ChpState =
  | 'EXPLORING'
  | 'PROVISIONAL'
  | 'LOCKED'
  | 'HITL_REQUIRED'
  | 'BLOCKED';

/** A capital-moving action proposed to the gate. */
export interface ProposedAction {
  /** DeepBook trading action (swap, market_make, ...). */
  action: ChpAction;
  /** Pool the action targets (used for per-pool caps + provenance). */
  poolId: string;
  /** Notional value of the action in the quote asset. */
  notionalUsd: number;
  /** Decision confidence 0..1 (adversarial input). */
  confidence?: number;
  /** Free-form rationale carried into provenance. */
  rationale?: string;
}

export interface Provenance {
  decisionId: string;
  timestamp: string;
  action: ProposedAction;
  state: ChpState;
  contentHash: string;
  claims: Claim[];
}

export interface ChpDecision {
  allowed: boolean;
  requiresHuman: boolean;
  state: ChpState;
  reason: string;
  provenance: Provenance;
}

export class ChpGate {
  private policy: RiskPolicy;
  private ledger: Provenance[] = [];
  private dailyNotionalUsd = 0;
  private dailyWindowStart = Date.now();

  constructor(policy?: RiskPolicy, policyPath: string = defaultPolicyPath()) {
    this.policy = policy ?? loadPolicy(policyPath);
  }

  getPolicy(): RiskPolicy {
    return this.policy;
  }

  /** Append-only provenance ledger (per-decision records). */
  getLedger(): readonly Provenance[] {
    return this.ledger;
  }

  /**
   * Evaluate a proposed capital-moving action through the normative engine.
   * On LOCKED the engine's committed_delta is folded into the rolling daily
   * total; BLOCKED and HITL_REQUIRED commit nothing.
   */
  evaluate(proposed: ProposedAction): ChpDecision {
    this.rollDailyWindow();
    const result = chpEvaluateGate(this.toEngineAction(proposed), toGatePolicy(this.policy), this.dailyNotionalUsd);
    if (result.state === 'LOCKED') this.dailyNotionalUsd += result.committed_delta;
    return this.finalize(proposed, result);
  }

  /**
   * Register an explicit human approval for a HITL-gated action, promoting it
   * to LOCKED. Mirrors the donor `principal_approve` / engine `approveHuman`:
   * approval may cross the HITL threshold, never the hard rules.
   */
  approveHuman(proposed: ProposedAction, approver: string): ChpDecision {
    this.rollDailyWindow();
    const result = chpApproveHuman(this.toEngineAction(proposed), toGatePolicy(this.policy), approver, this.dailyNotionalUsd);
    if (result.state === 'LOCKED') this.dailyNotionalUsd += result.committed_delta;
    return this.finalize(proposed, result);
  }

  // ── Internals ──────────────────────────────────────────────

  private toEngineAction(proposed: ProposedAction) {
    return {
      action: proposed.action,
      asset: proposed.poolId,
      notional: proposed.notionalUsd,
      confidence: proposed.confidence ?? null,
      rationale: proposed.rationale,
    };
  }

  private rollDailyWindow(): void {
    const DAY_MS = 24 * 60 * 60 * 1000;
    if (Date.now() - this.dailyWindowStart >= DAY_MS) {
      this.dailyWindowStart = Date.now();
      this.dailyNotionalUsd = 0;
    }
  }

  private finalize(action: ProposedAction, result: {
    state: 'LOCKED' | 'HITL_REQUIRED' | 'BLOCKED';
    allowed: boolean;
    requires_human: boolean;
    reason: string;
    claims: Claim[];
    content_hash: string;
  }): ChpDecision {
    const provenance: Provenance = {
      decisionId: randomUUID(),
      timestamp: new Date().toISOString(),
      action,
      state: result.state,
      contentHash: result.content_hash,
      claims: result.claims,
    };
    this.ledger.push(provenance);
    return {
      allowed: result.allowed,
      requiresHuman: result.requires_human,
      state: result.state,
      reason: result.reason,
      provenance,
    };
  }
}
