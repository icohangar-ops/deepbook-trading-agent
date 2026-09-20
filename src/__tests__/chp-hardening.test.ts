/**
 * Tests for the CHP hardening layer (src/chp/hardening.ts), mirroring the
 * erp-control-plane CHP suite (tests/test_genbi_chp.py):
 *
 * - the trade-shaped R0 gate refuses ill-posed trades before the engine;
 * - the deterministic adversary scores guardrails + bounded plan + parity
 *   against the blockchain/DeFi floor of 85 (a parity mismatch is fatal);
 * - the hardening session opens EXPLORING, every hardened case opens
 *   PROVISIONAL_LOCK, and a named confirmer locks it through third-party
 *   validation;
 * - every locked trade seals a payload envelope into the append-only trade
 *   decision ledger, whose reads re-validate envelope + body integrity;
 * - the AgentTradingSession loop enforces all of the above before any order.
 */
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { DeepBookClient } from '../deepbook-client.js';
import { WalrusAuditStore } from '../ptb-trading.js';
import { AgentTradingSession } from '../agent-integration.js';
import { ChpGate } from '../chp/gate.js';
import type { RiskPolicy } from '../chp/policy.js';
import { InMemoryReplayStore } from '../chp/replay.js';
import {
  TradeHardeningGate,
  TradeRejection,
  StaticPortfolioStateProvider,
  applyThirdPartyValidation,
  evaluateR0Gate,
  assessFoundation,
  DEFI_FLOOR,
  type GoldenTradeCase,
  type PortfolioSnapshot,
  type R0GateInput,
  type ExecutionEvidence,
} from '../chp/hardening.js';
import type { TradingDecision, TradingSessionConfig } from '../types.js';

const CONFIRMER = 'sam@cubiczan.com';
const POOL = '0xpool1';
const OTHER_POOL = '0xpool2';

function snapshot(balances: Record<string, number> = { [POOL]: 1_000_000 }): PortfolioSnapshot {
  return {
    owner: 'test-agent',
    quoteBalancesUsd: balances,
    totalEquityUsd: 2_000_000,
    capturedAt: Date.now(),
  };
}

function goldenCase(expected = 1_000_000, pool = POOL): GoldenTradeCase {
  return {
    id: `${pool}-swap-balance`,
    poolId: pool,
    action: 'swap',
    metric: 'available_quote_usd',
    unit: 'usd',
    expected,
    tolerance: 0.005,
  };
}

function r0Input(overrides: Partial<R0GateInput> = {}): R0GateInput {
  return {
    action: 'swap',
    poolId: POOL,
    notionalUsd: 5000,
    rationale: 'Executing arbitrage: price discrepancy detected between venues',
    confidence: 0.9,
    portfolio: snapshot(),
    maxNotionalUsd: 50000,
    maxDailyTrades: 10,
    allowedPools: [POOL, OTHER_POOL],
    allowedActions: ['swap', 'market_make', 'arbitrage', 'hedge', 'liquidity_provision'],
    minConfidence: 0.5,
    ...overrides,
  };
}

function evidence(overrides: Partial<ExecutionEvidence> = {}): ExecutionEvidence {
  return {
    guardrailsPassed: true,
    bounded: true,
    boundedDetail: 'minOut 4750 bounds slippage',
    observedQuoteBalanceUsd: 1_000_000,
    notionalUsd: 5000,
    maxCapitalUsd: 100_000,
    ...overrides,
  };
}

function tmpLedgerPath(): string {
  return join(mkdtempSync(join(tmpdir(), 'chp-ledger-')), 'decisions.jsonl');
}

function makeGate(opts: { requireHumanLock?: boolean; goldenCases?: GoldenTradeCase[] } = {}): TradeHardeningGate {
  return new TradeHardeningGate({ ledgerPath: tmpLedgerPath(), ...opts });
}

/* --------------------------------------------------------------------- R0 */

describe('R0 gate', () => {
  it('refuses a non-metric trade before execution', () => {
    const evaluation = evaluateR0Gate(r0Input({ rationale: 'hello there' }));
    expect(evaluation.results.Worth_it).toBe('FATAL');
    expect(evaluation.verdict).toBe('HALT');
  });

  it('refuses an unsized trade', () => {
    const evaluation = evaluateR0Gate(r0Input({ notionalUsd: 0 }));
    expect(evaluation.results.Scoped).toBe('FATAL');
    expect(evaluation.verdict).toBe('HALT');
  });

  it('refuses a trade not solvable from the current balance', () => {
    const evaluation = evaluateR0Gate(r0Input({ portfolio: snapshot({ [POOL]: 1000 }) }));
    expect(evaluation.results.Solvable).toBe('FATAL');
  });

  it('refuses a trade with no portfolio state at all', () => {
    const evaluation = evaluateR0Gate(r0Input({ portfolio: undefined }));
    expect(evaluation.results.Solvable).toBe('FATAL');
  });

  it('refuses an unpermitted pool', () => {
    const evaluation = evaluateR0Gate(r0Input({ poolId: '0xunauthorized', portfolio: snapshot({ '0xunauthorized': 1_000_000 }) }));
    expect(evaluation.results.Valid).toBe('FATAL');
  });

  it('accepts analytical and golden-matched trades', () => {
    expect(evaluateR0Gate(r0Input()).verdict).toBe('PASS');
    // A golden-set match makes even a non-analytical rationale worth it.
    expect(evaluateR0Gate(r0Input({ rationale: 'hello there', goldenCases: [goldenCase()] })).verdict).toBe('PASS');
  });

  it('evaluateR0 throws a TradeRejection naming the failed keys', () => {
    const gate = makeGate();
    expect(() => gate.evaluateR0(r0Input({ rationale: 'hello there', notionalUsd: 0 }))).toThrow(TradeRejection);
    expect(() => gate.evaluateR0(r0Input({ rationale: 'hello there', notionalUsd: 0 }))).toThrow(/Scoped, Worth_it/);
  });
});

/* ------------------------------------------------------------ foundation */

describe('foundation pass', () => {
  it('portfolio-state parity scores a full foundation', () => {
    const assessment = assessFoundation({ poolId: POOL, action: 'swap', evidence: evidence() });
    expect(assessment.domain).toBe('blockchain/defi');
    expect(assessment.score).toBe(100);
    expect(assessment.parity?.withinTolerance).toBe(true);
    expect(assessment.goldenMatched).toBe(false);
  });

  it('golden parity scores a full foundation', () => {
    const assessment = assessFoundation({
      poolId: POOL,
      action: 'swap',
      evidence: evidence(),
      goldenCases: [goldenCase()],
    });
    expect(assessment.score).toBe(100);
    expect(assessment.goldenMatched).toBe(true);
  });

  it('a trade without parity evidence cannot self-certify (70 < 85)', () => {
    const assessment = assessFoundation({
      poolId: POOL,
      action: 'swap',
      evidence: evidence({ observedQuoteBalanceUsd: null }),
    });
    expect(assessment.score).toBe(70);
    expect(assessment.score).toBeLessThan(DEFI_FLOOR);
    expect(assessment.parity).toBeNull();
  });

  it('an unbounded plan cannot self-certify (70 < 85)', () => {
    const assessment = assessFoundation({
      poolId: POOL,
      action: 'swap',
      evidence: evidence({ bounded: false, boundedDetail: 'minOut 0 does not bound slippage' }),
    });
    expect(assessment.score).toBe(70);
    expect(assessment.parity?.withinTolerance).toBe(true);
  });

  it('guardrail failure cannot self-certify', () => {
    const assessment = assessFoundation({
      poolId: POOL,
      action: 'swap',
      evidence: evidence({ guardrailsPassed: false }),
    });
    // 0 guardrails + 30 bounded + 30 parity = 60.
    expect(assessment.score).toBe(60);
  });

  it('golden parity mismatch is fatal', () => {
    const gate = makeGate({ goldenCases: [goldenCase(999.0)] });
    expect(() =>
      gate.harden({
        action: 'swap',
        poolId: POOL,
        notionalUsd: 5000,
        rationale: 'arbitrage',
        confidence: 0.9,
        maxCapitalUsd: 100_000,
        evidence: evidence(),
      }),
    ).toThrow(/MISMATCH/);
  });
});

/* ------------------------------------------------------------- lock flow */

describe('human lock flow', () => {
  it('a hardened trade opens provisional and locks with a confirmer', () => {
    const gate = makeGate();
    expect(gate.sessionStatus).toBe('EXPLORING');

    const hardened = gate.harden({
      action: 'swap',
      poolId: POOL,
      notionalUsd: 5000,
      rationale: 'arbitrage',
      confidence: 0.9,
      maxCapitalUsd: 100_000,
      evidence: evidence(),
    });
    expect(hardened.case.status).toBe('PROVISIONAL_LOCK');
    expect(hardened.case.confirmedBy).toBeNull();
    expect(gate.sessionStatus).toBe('PROVISIONAL_LOCK');

    expect(gate.lock(hardened, CONFIRMER)).toBe('LOCKED');
    expect(hardened.case.status).toBe('LOCKED');
    expect(hardened.case.confirmedBy).toBe(CONFIRMER);
    expect(gate.sessionStatus).toBe('LOCKED');
  });

  it('third-party validation requires a provisional case', () => {
    const gate = makeGate();
    const hardened = gate.harden({
      action: 'swap',
      poolId: POOL,
      notionalUsd: 5000,
      rationale: 'arbitrage',
      confidence: 0.9,
      maxCapitalUsd: 100_000,
      evidence: evidence(),
    });
    gate.lock(hardened, CONFIRMER);
    expect(() =>
      applyThirdPartyValidation(hardened.case, {
        validator: CONFIRMER,
        item: hardened.case.decisionId,
        challenge: 'confirm',
        result: 'CONFIRM',
        rationale: 'double-confirm',
      }),
    ).toThrow(/PROVISIONAL_LOCK/);
  });

  it('a rejected validation reframes the case', () => {
    const gate = makeGate();
    const hardened = gate.harden({
      action: 'swap',
      poolId: POOL,
      notionalUsd: 5000,
      rationale: 'arbitrage',
      confidence: 0.9,
      maxCapitalUsd: 100_000,
      evidence: evidence(),
    });
    expect(
      applyThirdPartyValidation(hardened.case, {
        validator: CONFIRMER,
        item: hardened.case.decisionId,
        challenge: 'confirm',
        result: 'REJECT',
        rationale: 'not solvable from current state',
      }),
    ).toBe('REFRAME');
  });
});

/* ---------------------------------------------------------------- ledger */

describe('trade decision ledger', () => {
  it('seals an envelope and round-trips', () => {
    const gate = makeGate();
    const hardened = gate.harden({
      action: 'swap',
      poolId: POOL,
      notionalUsd: 5000,
      rationale: 'arbitrage',
      confidence: 0.9,
      maxCapitalUsd: 100_000,
      evidence: evidence(),
    });
    gate.lock(hardened, CONFIRMER);
    const record = gate.record(hardened, {
      poolId: POOL,
      action: 'swap',
      r0Verdict: 'PASS',
      artifacts: { reason: 'arbitrage' },
    });

    const listing = gate.records.list();
    expect(listing).toHaveLength(1);
    expect(listing[0].envelope_valid).toBe(true);
    expect(listing[0].integrity_valid).toBe(true);
    expect(listing[0].decision_id).toBe(record.decision_id);
    expect(listing[0].confirmed_by).toBe(CONFIRMER);
    expect(listing[0].session_status).toBe('LOCKED');

    expect(gate.records.get(record.decision_id)?.body_sha256).toBe(record.body_sha256);
    expect(gate.records.get('trade-missing')).toBeUndefined();
  });

  it('tampered records read as integrity-invalid, envelope-valid', () => {
    const gate = makeGate();
    const hardened = gate.harden({
      action: 'swap',
      poolId: POOL,
      notionalUsd: 5000,
      rationale: 'arbitrage',
      confidence: 0.9,
      maxCapitalUsd: 100_000,
      evidence: evidence(),
    });
    gate.lock(hardened, CONFIRMER);
    gate.record(hardened, { poolId: POOL, action: 'swap', r0Verdict: 'PASS', artifacts: {} });

    // Tamper with the sealed payload body: inflate the foundation score.
    const lines = readFileSync(gate.records.path, 'utf8').split('\n');
    const entry = JSON.parse(lines[0]) as { body: string };
    entry.body = entry.body.replace('"foundation_score":100', '"foundation_score":70');
    lines[0] = JSON.stringify(entry);
    writeFileSync(gate.records.path, lines.join('\n'), 'utf8');

    const record = gate.records.list()[0];
    expect(record.integrity_valid).toBe(false);
    expect(record.envelope_valid).toBe(true); // the envelope checks structure only
  });
});

/* ------------------------------------------------------------ human lock */

describe('human lock enforcement', () => {
  it('defaults ON', () => {
    expect(makeGate().requireHumanLock).toBe(true);
  });

  it('DEEPBOOK_CHP_REQUIRE_HUMAN_LOCK=0 disables it', () => {
    const previous = process.env.DEEPBOOK_CHP_REQUIRE_HUMAN_LOCK;
    try {
      process.env.DEEPBOOK_CHP_REQUIRE_HUMAN_LOCK = '0';
      expect(makeGate().requireHumanLock).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.DEEPBOOK_CHP_REQUIRE_HUMAN_LOCK;
      else process.env.DEEPBOOK_CHP_REQUIRE_HUMAN_LOCK = previous;
    }
  });
});

/* ------------------------------------------------- trading-loop wiring */

function makePolicy(overrides: Partial<RiskPolicy> = {}): RiskPolicy {
  return {
    version: 'test',
    maxNotionalUsd: 50000,
    dailyNotionalCapUsd: 250000,
    hitlThresholdUsd: 25000,
    allowedActions: ['swap', 'market_make', 'arbitrage', 'hedge', 'liquidity_provision'],
    perAssetLimits: {},
    minConfidence: 0.5,
    ...overrides,
  };
}

function decision(overrides: Partial<TradingDecision> = {}): TradingDecision {
  return {
    action: 'swap',
    poolId: POOL,
    reason: 'Executing arbitrage: price discrepancy detected between venues',
    confidence: 0.9,
    params: { amount: '5000', minOut: '4750' },
    ...overrides,
  };
}

describe('AgentTradingSession CHP hardening wiring', () => {
  const config: TradingSessionConfig = {
    sessionId: 'chp-hardening-session',
    allowedPools: [POOL, OTHER_POOL],
    maxCapital: '100000',
    riskLimits: { maxPositionPerPool: '50000', maxDrawdownFraction: 0.1, maxDailyTrades: 10 },
  };

  function makeSession(opts: {
    gate: TradeHardeningGate;
    portfolio?: StaticPortfolioStateProvider;
    stubExecution?: boolean;
  }) {
    const client = new DeepBookClient({ network: 'testnet' });
    const walrusStore = new WalrusAuditStore();
    if (opts.stubExecution) {
      // Offline execution doubles: the gates run for real; the swap itself
      // succeeds without a signer or network.
      Object.assign(client, {
        swapExactInput: async () => ({
          poolId: POOL,
          amountIn: '5000',
          amountOut: '4750',
          price: '1',
          fee: '1',
          txDigest: '0xtestdigest',
          timestamp: Date.now(),
        }),
        getOrderbook: async () => ({ poolId: POOL, bids: [], asks: [], timestamp: Date.now() }),
      });
      Object.assign(walrusStore, { storeBlob: async () => 'test-blob-id' });
    }
    return new AgentTradingSession({
      client,
      config,
      walrusStore,
      chpGate: new ChpGate(makePolicy()),
      chpHardening: opts.gate,
      portfolioState: opts.portfolio ?? new StaticPortfolioStateProvider(snapshot()),
      // Row-22 boundary: execution now requires a receipt key and a
      // single-use nonce store; tests stay in memory.
      receiptKey: 'test-receipt-key',
      receiptReplay: new InMemoryReplayStore(),
    });
  }

  it('R0 refusal leaves nothing executed or persisted', async () => {
    const gate = makeGate();
    const session = makeSession({ gate });
    // Unsized decision (params empty => notional 0) — R0 Scoped is FATAL.
    const result = await session.executeAgentDecision(decision({ params: {} }));
    expect(result.success).toBe(false);
    expect(result.error).toContain('CHP R0 gate');
    expect(gate.records.list()).toHaveLength(0);
  });

  it('the human lock refuses an unconfirmed trade before execution', async () => {
    const gate = makeGate(); // requireHumanLock defaults ON
    const session = makeSession({ gate });
    const result = await session.executeAgentDecision(decision());
    expect(result.success).toBe(false);
    expect(result.error).toContain('human lock required');
    expect(gate.records.list()).toHaveLength(0);
  });

  it('a floor failure cannot self-certify even with the lock flag off', async () => {
    const gate = makeGate({ requireHumanLock: false });
    const session = makeSession({ gate });
    // minOut 0 => unbounded plan => foundation 70 < 85 => needs a confirmer.
    const result = await session.executeAgentDecision(decision({ params: { amount: '5000', minOut: '0' } }));
    expect(result.success).toBe(false);
    expect(result.error).toContain('cannot self-certify');
    expect(gate.records.list()).toHaveLength(0);
  });

  it('a named confirmer locks the trade and seals the ledger', async () => {
    const gate = makeGate();
    const session = makeSession({ gate, stubExecution: true });
    const result = await session.executeAgentDecision(decision(), { confirmedBy: CONFIRMER });
    expect(result.success).toBe(true);
    expect(result.chpDecisionId).toBeDefined();
    expect(result.chpSessionStatus).toBe('LOCKED');

    const listing = gate.records.list();
    expect(listing).toHaveLength(1);
    expect(listing[0].integrity_valid).toBe(true);
    expect(listing[0].confirmed_by).toBe(CONFIRMER);
    expect(listing[0].foundation_score).toBe(100);
    expect(listing[0].r0_verdict).toBe('PASS');
    // The session surface exposes the same ledger.
    expect(session.getDecisionLedger()[0].decision_id).toBe(result.chpDecisionId);
  });

  it('a golden parity mismatch refuses the order in-loop', async () => {
    const gate = makeGate({ requireHumanLock: false, goldenCases: [goldenCase(999.0)] });
    const session = makeSession({ gate });
    const result = await session.executeAgentDecision(decision(), { confirmedBy: CONFIRMER });
    expect(result.success).toBe(false);
    expect(result.error).toContain('MISMATCH');
    expect(gate.records.list()).toHaveLength(0);
  });
});
