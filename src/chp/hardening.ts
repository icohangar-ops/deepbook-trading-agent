/**
 * deepbook-trading-agent — CHP Hardening (Consensus Hardening Protocol)
 *
 * TypeScript port of the erp-control-plane GenBI promotion gate
 * (api/genbi/chp.py, commit 70678cc), reshaped for order placement.
 * Four hardening stages wrap every capital-moving decision:
 *
 * 1. **R0 gate — before the engine.** `evaluateR0Gate` refuses a trade that
 *    is not solvable from the current balance/portfolio state, is unsized or
 *    unbounded, targets an unpermitted pool/action, or carries no
 *    metric-bearing rationale. Result keys are capitalized (Solvable,
 *    Scoped, Valid, Worth_it); any FATAL verdict halts the trade before
 *    anything is executed or persisted.
 * 2. **Foundation pass — the deterministic adversary.** Scores the trade
 *    plan out of 100: 40 for pre-trade guardrails (R0 + policy spend gate +
 *    session validation), 30 for a bounded order plan (an explicit execution
 *    bound), and 30 for parity against balance/portfolio state. The
 *    blockchain/DeFi floor is 85: without parity evidence the trade cannot
 *    self-certify and needs a named human confirmer. A pinned-parity
 *    MISMATCH is fatal — no confirmer can wave it through.
 * 3. **Human lock.** The hardening session opens EXPLORING; every hardened
 *    trade case opens PROVISIONAL_LOCK; a named confirmer locks it through
 *    `applyThirdPartyValidation` (LOCKED). DEEPBOOK_CHP_REQUIRE_HUMAN_LOCK
 *    defaults ON — a confirmer is mandatory for every order unless the
 *    operator explicitly sets the flag to '0'.
 * 4. **Decision record.** The locked decision is sealed into a payload
 *    envelope (structure-only) and appended to the trade decision ledger —
 *    append-only JSONL carrying this repo's own SHA-256 body digest
 *    (`body_sha256`), re-validated on every read (`integrity_valid`).
 *
 * Divergences from the erp-control-plane reference (documented honestly):
 * - **Parity evidence is a balance/portfolio state assertion.** The ERP gate
 *   compares an executed answer against a dbt-pinned golden set. No pinned
 *   golden trade set exists for this repo, so parity by default asserts the
 *   observed portfolio state against the session's pinned capital truth
 *   (deployable balance covers the notional within session maxCapital).
 *   Optional `GoldenTradeCase` entries restore pinned-truth parity.
 * - **The published `@cubiczan/chp` package (0.1.1) ships the Profile B
 *   spend gate and canonical hashing only** — the R0 gate, foundation
 *   scoring, lock state machine, and payload envelope here are ported from
 *   the reference implementation. `@cubiczan/chp` supplies the Profile B
 *   spend-gate engine (see gate.ts) and canonical JSON serialization.
 * - **The foundation pass runs before order submission.** The ERP gate scores
 *   an already-executed (read-only) query; capital movement is not
 *   read-only, so the adversary scores the bounded trade plan against the
 *   portfolio state before the order is placed, and the ledger record is
 *   written at lock time. Execution outcome surfaces through TradeResult
 *   and the Walrus audit trail.
 */

import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { canonicalJson } from '@cubiczan/chp';
import type { ChpAction } from './policy.js';

/* ─── Session status / R0 ─────────────────────────────────────────────── */

/** CHP session lifecycle for the hardening layer. */
export type SessionStatus = 'EXPLORING' | 'PROVISIONAL_LOCK' | 'LOCKED' | 'REFRAME';

/** The capitalized R0 result keys (mirrors the reference `evaluation.results`). */
export type R0Key = 'Solvable' | 'Scoped' | 'Valid' | 'Worth_it';

/** Per-key R0 verdicts. FATAL is fatal: the trade never reaches the engine. */
export type R0VerdictValue = 'PASS' | 'FATAL';

export interface R0Evaluation {
  results: Record<R0Key, R0VerdictValue>;
  verdict: 'PASS' | 'HALT';
}

/** CHP refused a trade (R0 HALT, parity mismatch, or lock requirement). */
export class TradeRejection extends Error {
  constructor(
    reason: string,
    public readonly evaluation?: R0Evaluation | FoundationAssessment,
  ) {
    super(reason);
    this.name = 'TradeRejection';
  }
}

/* ─── Portfolio state ─────────────────────────────────────────────────── */

/**
 * A snapshot of the balance/portfolio state a trade must be solvable from.
 * Quote balances are USD-equivalent notional keyed by pool id (per-pool
 * deployable quote balance) or by asset identifier.
 */
export interface PortfolioSnapshot {
  owner: string;
  /** USD-equivalent available quote balance, keyed by pool id or asset. */
  quoteBalancesUsd: Record<string, number>;
  totalEquityUsd?: number;
  capturedAt: number;
}

/** Source of truth for balance/portfolio state, consumed by R0 and parity. */
export interface PortfolioStateProvider {
  getPortfolio(): Promise<PortfolioSnapshot>;
}

/** Deterministic provider for static/demo/test state. */
export class StaticPortfolioStateProvider implements PortfolioStateProvider {
  constructor(private readonly snapshot: Omit<PortfolioSnapshot, 'capturedAt'> & { capturedAt?: number }) {}

  async getPortfolio(): Promise<PortfolioSnapshot> {
    return { ...this.snapshot, capturedAt: this.snapshot.capturedAt ?? Date.now() };
  }
}

/* ─── R0 gate (before the engine) ─────────────────────────────────────── */

/** Metric-bearing trade phrasing — the deterministic Worth_it proxy. */
const METRIC_BEARING =
  /\b(spread|arbitrage|arb\b|hedge|hedging|liquidity|market\s*making|profit|edge|fees?|rebalance|rebalancing|swap|buy|sell|execute|executing|captur\w*|discrepanc\w*|sentiment|volatility|momentum|basis|slippage|price|maker|taker)\b/i;

export interface R0GateInput {
  action: ChpAction;
  poolId: string;
  notionalUsd: number;
  rationale: string;
  confidence: number;
  /** Current balance/portfolio state. Absent => the trade is not solvable. */
  portfolio?: PortfolioSnapshot;
  /** Per-trade notional bound from the risk policy. */
  maxNotionalUsd: number;
  /** Session-level daily trade-count bound. */
  maxDailyTrades: number;
  allowedPools: readonly string[];
  allowedActions: readonly ChpAction[];
  minConfidence: number;
  goldenCases?: readonly GoldenTradeCase[];
}

/**
 * The pre-execution gate: HALT before the engine sees the trade.
 * - Solvable: the trade is computable from the current balance/portfolio
 *   state — the pool's deployable quote balance covers the notional.
 * - Scoped: the order is sized and execution is bounded by configured caps.
 * - Valid: a permitted action on a permitted pool (well-formed backing).
 * - Worth_it: a metric-bearing rationale, or a pinned golden case matches.
 */
export function evaluateR0Gate(input: R0GateInput): R0Evaluation {
  const goldenMatch = matchGoldenCase(input.poolId, input.action, input.goldenCases) !== undefined;

  const balance =
    input.portfolio === undefined
      ? undefined
      : portfolioBalanceFor(input.portfolio, input.poolId);

  const solvable =
    input.poolId.length > 0 &&
    Number.isFinite(input.notionalUsd) &&
    input.notionalUsd >= 0 &&
    balance !== undefined &&
    balance >= input.notionalUsd;

  const scoped =
    Number.isFinite(input.notionalUsd) &&
    input.notionalUsd > 0 &&
    input.maxNotionalUsd > 0 &&
    input.maxDailyTrades > 0;

  const valid = input.allowedActions.includes(input.action) && input.allowedPools.includes(input.poolId);

  const worthIt = goldenMatch || METRIC_BEARING.test(input.rationale);

  const results: Record<R0Key, R0VerdictValue> = {
    Solvable: solvable ? 'PASS' : 'FATAL',
    Scoped: scoped ? 'PASS' : 'FATAL',
    Valid: valid ? 'PASS' : 'FATAL',
    Worth_it: worthIt ? 'PASS' : 'FATAL',
  };
  const verdict = Object.values(results).every((v) => v === 'PASS') ? 'PASS' : 'HALT';
  return { results, verdict };
}

/** Balance relevant to a pool trade: the pool's own entry, else the owner's total. */
function portfolioBalanceFor(portfolio: PortfolioSnapshot, poolId: string): number | undefined {
  if (portfolio.quoteBalancesUsd[poolId] !== undefined) return portfolio.quoteBalancesUsd[poolId];
  return portfolio.totalEquityUsd;
}

/* ─── Foundation pass (deterministic adversary) ────────────────────────── */

// Deterministic adversary scoring (out of 100). The blockchain/DeFi floor is
// 85, so only a trade with parity evidence (40 + 30 + 30 = 100) can
// self-certify; guardrails + a bounded plan alone score 70 and require a
// named human confirmer.
export const GUARDRAIL_POINTS = 40;
export const BOUNDED_RESULT_POINTS = 30;
export const PARITY_POINTS = 30;
export const FULL_SCORE = GUARDRAIL_POINTS + BOUNDED_RESULT_POINTS + PARITY_POINTS;

/** The CHP floor for this repo's domain. */
export const DEFI_FLOOR = 85;
export const DEFI_DOMAIN = 'blockchain/defi';

export interface GoldenTradeCase {
  id: string;
  poolId: string;
  action: ChpAction;
  /** Only balance parity is defined for trades. */
  metric: 'available_quote_usd';
  unit: 'usd';
  expected: number;
  tolerance: number;
}

export interface ParityEvidence {
  caseId: string;
  metric: string;
  unit: string;
  expected: number;
  tolerance: number;
  /** Observed balance; null when no state evidence is available. */
  actual: number | null;
  withinTolerance: boolean | null;
}

export interface FoundationAssessment {
  score: number;
  domain: string;
  findings: string[];
  parity: ParityEvidence | null;
  goldenMatched: boolean;
}

/** Post-gate, pre-submission evidence for the deterministic adversary. */
export interface ExecutionEvidence {
  /** R0 + policy spend gate + session validation all passed. */
  guardrailsPassed: boolean;
  /** The order plan carries an explicit execution bound. */
  bounded: boolean;
  boundedDetail: string;
  /** Observed available quote balance (USD-equivalent) for the pool, if known. */
  observedQuoteBalanceUsd: number | null;
  notionalUsd: number;
  /** Pinned session capital bound (TradingSessionConfig.maxCapital). */
  maxCapitalUsd: number;
}

export interface FoundationInput {
  poolId: string;
  action: ChpAction;
  evidence: ExecutionEvidence;
  goldenCases?: readonly GoldenTradeCase[];
}

/** The deterministic adversary scores the trade plan (0-100). */
export function assessFoundation(input: FoundationInput): FoundationAssessment {
  const { evidence } = input;
  const findings: string[] = [];
  let score = 0;

  if (evidence.guardrailsPassed) {
    score += GUARDRAIL_POINTS;
    findings.push('guardrails passed: R0 gate, policy spend gate, and session validation');
  } else {
    findings.push('pre-trade guardrails did not all pass — no guardrail evidence');
  }

  if (evidence.bounded) {
    score += BOUNDED_RESULT_POINTS;
    findings.push(`bounded order plan: ${evidence.boundedDetail}`);
  } else {
    findings.push(`unbounded order plan: ${evidence.boundedDetail} — no bounded-result evidence`);
  }

  const goldenCase = matchGoldenCase(input.poolId, input.action, input.goldenCases);
  let parity: ParityEvidence | null = null;

  if (goldenCase) {
    const actual = evidence.observedQuoteBalanceUsd;
    parity = {
      caseId: goldenCase.id,
      metric: goldenCase.metric,
      unit: goldenCase.unit,
      expected: goldenCase.expected,
      tolerance: goldenCase.tolerance,
      actual,
      withinTolerance: actual === null ? null : Math.abs(actual - goldenCase.expected) <= goldenCase.tolerance,
    };
    if (parity.withinTolerance) {
      score += PARITY_POINTS;
      findings.push(
        `golden parity: ${goldenCase.id} (${goldenCase.metric}) expected ${goldenCase.expected} ± ${goldenCase.tolerance} ${goldenCase.unit}, got ${parity.actual}`,
      );
    } else {
      findings.push(
        `golden parity MISMATCH: ${goldenCase.id} (${goldenCase.metric}) expected ${goldenCase.expected} ± ${goldenCase.tolerance} ${goldenCase.unit}, got ${parity.actual}`,
      );
    }
  } else if (evidence.observedQuoteBalanceUsd !== null) {
    // Documented divergence: no pinned golden trade set exists in-repo, so
    // the balance/portfolio state assertion serves as parity evidence — the
    // observed deployable balance must cover the notional within the
    // session's pinned capital truth.
    const within =
      evidence.observedQuoteBalanceUsd - evidence.notionalUsd >= 0 &&
      evidence.notionalUsd <= evidence.maxCapitalUsd;
    parity = {
      caseId: 'portfolio-state-assertion',
      metric: 'available_quote_usd',
      unit: 'usd',
      expected: evidence.observedQuoteBalanceUsd,
      tolerance: 0,
      actual: evidence.observedQuoteBalanceUsd,
      withinTolerance: within,
    };
    if (within) {
      score += PARITY_POINTS;
      findings.push(
        `portfolio-state parity: observed balance ${evidence.observedQuoteBalanceUsd} covers notional ${evidence.notionalUsd} within session maxCapital ${evidence.maxCapitalUsd} (no pinned golden case — state assertion serves as parity evidence)`,
      );
    } else {
      findings.push(
        `portfolio-state parity MISMATCH: observed balance ${evidence.observedQuoteBalanceUsd} does not reconcile with notional ${evidence.notionalUsd} within session maxCapital ${evidence.maxCapitalUsd}`,
      );
    }
  } else {
    findings.push(
      'no golden-set case matches this trade and no balance/portfolio state was observed — parity evidence unavailable',
    );
  }

  return {
    score: Math.min(score, FULL_SCORE),
    domain: DEFI_DOMAIN,
    findings,
    parity,
    goldenMatched: goldenCase !== undefined,
  };
}

/** Match a pinned golden case by pool + action (exact keys). */
export function matchGoldenCase(
  poolId: string,
  action: ChpAction,
  cases?: readonly GoldenTradeCase[],
): GoldenTradeCase | undefined {
  if (!cases || cases.length === 0) return undefined;
  return cases.find((c) => c.poolId === poolId && c.action === action && c.metric === 'available_quote_usd');
}

/**
 * Load pinned golden trade cases from a JSON file
 * (`{ "cases": [...] }`). An unusable file disables parity evidence — it
 * never blocks a trade on its own (mirrors the reference golden handling).
 */
export function loadGoldenCases(path: string | undefined): GoldenTradeCase[] {
  if (!path) return [];
  if (!existsSync(path)) {
    console.warn(`[CHP] golden trade file not found at ${path} — parity evidence disabled`);
    return [];
  }
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as { cases?: GoldenTradeCase[] };
    const cases = Array.isArray(parsed.cases) ? parsed.cases : [];
    return cases.filter(
      (c): c is GoldenTradeCase =>
        typeof c?.id === 'string' &&
        typeof c?.poolId === 'string' &&
        typeof c?.action === 'string' &&
        c.metric === 'available_quote_usd' &&
        c.unit === 'usd' &&
        typeof c?.expected === 'number' &&
        typeof c?.tolerance === 'number',
    );
  } catch (err) {
    console.warn(
      `[CHP] failed to parse golden trade file ${path} (${err instanceof Error ? err.message : String(err)}) — parity evidence disabled`,
    );
    return [];
  }
}

/* ─── Hardened case + human lock ───────────────────────────────────────── */

/** A hardened trade case opened by the gate (mirrors the reference DecisionCase). */
export interface HardenedTradeCase {
  decisionId: string;
  title: string;
  domain: string;
  createdAt: string;
  owner: string;
  highStakes: boolean;
  status: SessionStatus;
  foundationScore: number;
  lockedDecisions: string[];
  confirmedBy: string | null;
}

export interface HardenedTrade {
  case: HardenedTradeCase;
  assessment: FoundationAssessment;
}

export interface ThirdPartyValidation {
  validator: string;
  item: string;
  challenge: string;
  result: 'CONFIRM' | 'REJECT';
  rationale: string;
}

/**
 * Third-party confirmation: PROVISIONAL_LOCK -> LOCKED (or REFRAME on
 * reject). The confirmer is recorded on the case before anything executes.
 */
export function applyThirdPartyValidation(
  tradeCase: HardenedTradeCase,
  validation: ThirdPartyValidation,
): SessionStatus {
  if (tradeCase.status !== 'PROVISIONAL_LOCK') {
    throw new TradeRejection(
      `CHP third-party validation: case ${tradeCase.decisionId} is ${tradeCase.status}, expected PROVISIONAL_LOCK`,
    );
  }
  if (validation.result === 'CONFIRM') {
    tradeCase.status = 'LOCKED';
    tradeCase.confirmedBy = validation.validator;
    tradeCase.lockedDecisions.push(validation.item);
    return 'LOCKED';
  }
  tradeCase.status = 'REFRAME';
  return 'REFRAME';
}

/* ─── Payload envelope (structure-only) ────────────────────────────────── */

/**
 * CHP payload envelope. The published @cubiczan/chp 0.1.1 ships the Profile B
 * gate and canonical hashing only, so the Profile A envelope is ported here.
 * The envelope validates STRUCTURE only — it deliberately does not commit to
 * body content; content integrity is the ledger's own `body_sha256`.
 */
export interface PayloadEnvelope {
  envelope_version: '1.0';
  route: 'PLACE_ORDER';
  created_at: string;
  serializer: 'chp-canonical-json-v1';
  body_length: number;
}

export function buildPayloadEnvelope(body: string, now: string = new Date().toISOString()): PayloadEnvelope {
  return {
    envelope_version: '1.0',
    route: 'PLACE_ORDER',
    created_at: now,
    serializer: 'chp-canonical-json-v1',
    body_length: body.length,
  };
}

export function validatePayloadEnvelope(envelope: unknown): boolean {
  if (typeof envelope !== 'object' || envelope === null) return false;
  const e = envelope as Record<string, unknown>;
  return (
    e.envelope_version === '1.0' &&
    e.route === 'PLACE_ORDER' &&
    typeof e.created_at === 'string' &&
    e.created_at.length > 0 &&
    e.serializer === 'chp-canonical-json-v1' &&
    typeof e.body_length === 'number' &&
    Number.isInteger(e.body_length) &&
    (e.body_length as number) >= 0
  );
}

/* ─── Trade decision ledger ────────────────────────────────────────────── */

/** A sealed trade decision record (snake_case, mirroring the reference ledger). */
export interface TradeDecisionRecord {
  decision_id: string;
  created_at: string;
  pool_id: string;
  action: string;
  session_status: SessionStatus;
  r0_verdict: 'PASS' | 'HALT';
  foundation_verdict: 'PASS' | 'REFRAME';
  foundation_score: number;
  confirmed_by: string | null;
  artifacts: Record<string, unknown>;
  body: string;
  body_sha256: string;
  envelope: PayloadEnvelope;
}

/** A record as returned by reads: envelope and body integrity re-validated. */
export type TradeDecisionRecordView = TradeDecisionRecord & {
  envelope_valid: boolean;
  integrity_valid: boolean;
};

/**
 * Append-only JSONL of CHP trade decision records; envelope structure and
 * body digest re-checked on every read. A tampered record reads as
 * `integrity_valid: false` — the envelope checks structure only, so the
 * ledger carries its own SHA-256 digest over the sealed body.
 */
export class TradeDecisionLedger {
  readonly path: string;

  constructor(path: string) {
    this.path = resolve(path);
  }

  append(entry: TradeDecisionRecord): void {
    const line = JSON.stringify(entry);
    mkdirSync(dirname(this.path), { recursive: true });
    appendFileSync(this.path, line + '\n', 'utf8');
  }

  /** Newest-first records, each re-validated on read. */
  list(limit: number = 100): TradeDecisionRecordView[] {
    return this.readAll()
      .slice(-limit)
      .reverse()
      .map((entry) => TradeDecisionLedger.checked(entry));
  }

  get(decisionId: string): TradeDecisionRecordView | undefined {
    for (const entry of [...this.readAll()].reverse()) {
      if (entry.decision_id === decisionId) return TradeDecisionLedger.checked(entry);
    }
    return undefined;
  }

  private readAll(): TradeDecisionRecord[] {
    if (!existsSync(this.path)) return [];
    const lines = readFileSync(this.path, 'utf8').split('\n');
    return lines
      .filter((line) => line.trim() !== '')
      .map((line) => JSON.parse(line) as TradeDecisionRecord);
  }

  private static checked(entry: TradeDecisionRecord): TradeDecisionRecordView {
    const digest = createHash('sha256').update(entry.body, 'utf8').digest('hex');
    return {
      ...entry,
      envelope_valid: validatePayloadEnvelope(entry.envelope),
      integrity_valid: digest === entry.body_sha256,
    };
  }
}

/* ─── Trade hardening gate ─────────────────────────────────────────────── */

export interface TradeHardeningOptions {
  /** Ledger file. Defaults to $DEEPBOOK_CHP_LEDGER_PATH or .chp/decisions.jsonl. */
  ledgerPath?: string;
  /** Require a named confirmer for every order. Defaults to $DEEPBOOK_CHP_REQUIRE_HUMAN_LOCK (default ON). */
  requireHumanLock?: boolean;
  /** Pinned golden trade cases (parity truth). Defaults to $DEEPBOOK_CHP_GOLDEN_PATH. */
  goldenCases?: GoldenTradeCase[];
  /** Foundation floor. Defaults to the blockchain/DeFi floor (85). */
  floor?: number;
}

export interface HardenTradeInput {
  action: ChpAction;
  poolId: string;
  notionalUsd: number;
  rationale: string;
  confidence: number;
  maxCapitalUsd: number;
  evidence: ExecutionEvidence;
  goldenCases?: readonly GoldenTradeCase[];
}

/**
 * Runs a trade through CHP hardening: R0 -> foundation -> human lock ->
 * record. The spend-policy layer lives in `ChpGate` (Profile B via
 * `@cubiczan/chp`); this gate owns the Profile A hardening flow.
 */
export class TradeHardeningGate {
  readonly records: TradeDecisionLedger;
  readonly floor: number;
  readonly requireHumanLock: boolean;
  readonly goldenCases: GoldenTradeCase[];
  private status: SessionStatus = 'EXPLORING';

  constructor(options: TradeHardeningOptions = {}) {
    this.records = new TradeDecisionLedger(
      options.ledgerPath ?? process.env.DEEPBOOK_CHP_LEDGER_PATH ?? resolve(process.cwd(), '.chp', 'decisions.jsonl'),
    );
    this.requireHumanLock = options.requireHumanLock ?? parseRequireHumanLock(process.env.DEEPBOOK_CHP_REQUIRE_HUMAN_LOCK);
    this.floor = options.floor ?? DEFI_FLOOR;
    this.goldenCases = options.goldenCases ?? loadGoldenCases(process.env.DEEPBOOK_CHP_GOLDEN_PATH);
  }

  /** The hardening session opens EXPLORING; harden() moves it per case. */
  get sessionStatus(): SessionStatus {
    return this.status;
  }

  /**
   * The pre-execution gate: HALT before the engine sees the trade. Throws
   * TradeRejection on any FATAL R0 result.
   */
  evaluateR0(input: R0GateInput): R0Evaluation {
    const evaluation = evaluateR0Gate(input);
    if (evaluation.verdict !== 'PASS') {
      const failed = (Object.keys(evaluation.results) as R0Key[])
        .filter((k) => evaluation.results[k] !== 'PASS')
        .sort();
      throw new TradeRejection(
        `CHP R0 gate: the trade failed ${failed.join(', ')}`,
        evaluation,
      );
    }
    return evaluation;
  }

  /** The deterministic adversary scores the bounded trade plan (0-100). */
  assessFoundation(input: FoundationInput): FoundationAssessment {
    return assessFoundation(input);
  }

  /**
   * Run the foundation pass and open the case as PROVISIONAL_LOCK. A parity
   * MISMATCH is fatal — a trade contradicting pinned portfolio truth must
   * not be placed, and no confirmer can wave it through.
   */
  harden(input: HardenTradeInput): HardenedTrade {
    const assessment = this.assessFoundation({
      poolId: input.poolId,
      action: input.action,
      evidence: input.evidence,
      goldenCases: input.goldenCases ?? this.goldenCases,
    });
    if (assessment.parity !== null && assessment.parity.withinTolerance === false) {
      throw new TradeRejection(
        `CHP foundation: ${assessment.findings[assessment.findings.length - 1]} — a trade contradicting pinned portfolio state must not be placed; fix the plan or the portfolio state.`,
        assessment,
      );
    }

    const tradeCase: HardenedTradeCase = {
      decisionId: `trade-${randomUUID()}`,
      title: `${input.action} ${input.poolId} for notional ${input.notionalUsd}`,
      domain: assessment.domain,
      createdAt: new Date().toISOString(),
      owner: 'deepbook-trading-agent',
      highStakes: true,
      status: 'PROVISIONAL_LOCK',
      foundationScore: assessment.score,
      lockedDecisions: [],
      confirmedBy: null,
    };
    this.status = 'PROVISIONAL_LOCK';
    return { case: tradeCase, assessment };
  }

  /** Foundation below the floor: the trade cannot self-certify. */
  canSelfCertify(assessment: FoundationAssessment): boolean {
    return assessment.score >= this.floor;
  }

  /**
   * Third-party confirmation: PROVISIONAL_LOCK -> LOCKED. The named
   * confirmer is recorded on the case before the order is placed.
   */
  lock(hardened: HardenedTrade, confirmedBy: string): SessionStatus {
    const status = applyThirdPartyValidation(hardened.case, {
      validator: confirmedBy,
      item: hardened.case.decisionId,
      challenge: 'Confirm the trade is solvable from the current balance/portfolio state and bounded per policy',
      result: 'CONFIRM',
      rationale: 'Named confirmer approved the trade via the AgentTradingSession',
    });
    this.status = status;
    return status;
  }

  /**
   * Seal the locked decision into a payload envelope and append the ledger.
   * The body is canonical JSON (`@cubiczan/chp` canonicalJson) so its
   * SHA-256 digest is deterministic.
   */
  record(
    hardened: HardenedTrade,
    meta: {
      poolId: string;
      action: ChpAction;
      r0Verdict: 'PASS' | 'HALT';
      artifacts: Record<string, unknown>;
    },
  ): TradeDecisionRecord {
    const tradeCase = hardened.case;
    const body = canonicalJson({
      decision_id: tradeCase.decisionId,
      title: tradeCase.title,
      domain: tradeCase.domain,
      foundation_score: tradeCase.foundationScore,
      adversary_findings: hardened.assessment.findings,
      parity: hardened.assessment.parity,
      artifacts: meta.artifacts,
      locked_decisions: [...tradeCase.lockedDecisions],
    });
    const entry: TradeDecisionRecord = {
      decision_id: tradeCase.decisionId,
      created_at: tradeCase.createdAt,
      pool_id: meta.poolId,
      action: meta.action,
      session_status: tradeCase.status,
      r0_verdict: meta.r0Verdict,
      foundation_verdict: hardened.assessment.score >= this.floor ? 'PASS' : 'REFRAME',
      foundation_score: tradeCase.foundationScore,
      confirmed_by: tradeCase.confirmedBy,
      artifacts: meta.artifacts,
      body,
      body_sha256: createHash('sha256').update(body, 'utf8').digest('hex'),
      envelope: buildPayloadEnvelope(body),
    };
    this.records.append(entry);
    return entry;
  }
}

/** DEEPBOOK_CHP_REQUIRE_HUMAN_LOCK: default ON; '0'/'false' disables. */
function parseRequireHumanLock(value: string | undefined): boolean {
  if (value === undefined || value === '') return true;
  return !['0', 'false'].includes(value.toLowerCase());
}
