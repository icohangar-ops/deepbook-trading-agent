/**
 * Tests for row-22 tool-approval receipts (src/chp/receipt.ts,
 * src/chp/replay.ts) and their execution-boundary wiring in
 * AgentTradingSession (src/agent-integration.ts).
 *
 * The contract under test: a CHP gate verdict — even LOCKED — is an
 * allowlist answer, not authorization. Capital moves only when a signed
 * receipt binds the exact trade arguments, the policy version, an expiry
 * window, and a single-use nonce; any mismatch, replay, or missing key
 * refuses the order fail-closed.
 */
import { describe, it, expect, afterEach } from 'vitest';
import {
  RECEIPT_KEY_ENV,
  hashTradeArgs,
  issueTradeReceipt,
  parseTradeReceipt,
  resolveReceiptKey,
  tradeReceiptArgs,
  verifyExecutionReceipt,
  type TradeApprovalReceipt,
  type TradeReceiptArgs,
} from '../chp/receipt.js';
import {
  FileReplayStore,
  InMemoryReplayStore,
} from '../chp/replay.js';
import { AgentTradingSession } from '../agent-integration.js';
import { ChpGate } from '../chp/gate.js';
import {
  StaticPortfolioStateProvider,
  TradeHardeningGate,
  type PortfolioSnapshot,
} from '../chp/hardening.js';
import type { RiskPolicy } from '../chp/policy.js';
import { DeepBookClient } from '../deepbook-client.js';
import { WalrusAuditStore } from '../ptb-trading.js';
import type { TradingDecision, TradingSessionConfig } from '../types.js';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const KEY = 'test-receipt-key-0189ac1e';

const args: TradeReceiptArgs = {
  action: 'swap',
  poolId: '0xpool1',
  params: { amount: '100', minOut: '95' },
};

function issueAllow(overrides?: Partial<Parameters<typeof issueTradeReceipt>[0]>) {
  return issueTradeReceipt(
    {
      actor: 'human:shyam',
      resource: 'deepbook:execute:0xpool1',
      args_hash: hashTradeArgs(args),
      policy_version: '1.0-default',
      risk: 'medium',
      decision: 'allow',
      ttlMs: 300_000,
      ...overrides,
    },
    KEY,
  );
}

afterEach(() => {
  delete process.env[RECEIPT_KEY_ENV];
});

describe('resolveReceiptKey — fail closed', () => {
  it('throws when the env var is unset', () => {
    delete process.env[RECEIPT_KEY_ENV];
    expect(() => resolveReceiptKey()).toThrow(RECEIPT_KEY_ENV);
  });

  it('throws when the env var is blank', () => {
    process.env[RECEIPT_KEY_ENV] = '   ';
    expect(() => resolveReceiptKey()).toThrow(RECEIPT_KEY_ENV);
  });

  it('uses the env var when set and the explicit override when given', () => {
    process.env[RECEIPT_KEY_ENV] = 'env-key';
    expect(resolveReceiptKey()).toBe('env-key');
    expect(resolveReceiptKey('explicit-key')).toBe('explicit-key');
  });
});

describe('hashTradeArgs — canonical binding', () => {
  it('is stable under key reordering of params', () => {
    const reordered: TradeReceiptArgs = {
      action: 'swap',
      poolId: '0xpool1',
      params: { minOut: '95', amount: '100' },
    };
    expect(hashTradeArgs(reordered)).toBe(hashTradeArgs(args));
  });

  it('changes when any executed argument changes', () => {
    const changed: TradeReceiptArgs = { ...args, params: { ...args.params, minOut: '94' } };
    expect(hashTradeArgs(changed)).not.toBe(hashTradeArgs(args));
  });
});

describe('verifyExecutionReceipt — allow / deny', () => {
  it('accepts a freshly issued receipt and returns it', () => {
    const receipt = issueAllow();
    const verdict = verifyExecutionReceipt(
      receipt,
      { argsHash: receipt.args_hash, policyVersion: receipt.policy_version, key: KEY },
      new InMemoryReplayStore(),
    );
    expect(verdict.ok).toBe(true);
    if (verdict.ok) {
      expect(verdict.receipt.actor).toBe('human:shyam');
      expect(verdict.receipt.tool).toBe('deepbook_execute');
    }
  });

  it('rejects a tampered signature', () => {
    const receipt = issueAllow();
    const tampered: TradeApprovalReceipt = {
      ...receipt,
      signature: receipt.signature.slice(0, 62) + (receipt.signature.endsWith('a') ? 'b' : 'a'),
    };
    const verdict = verifyExecutionReceipt(
      tampered,
      { argsHash: receipt.args_hash, policyVersion: receipt.policy_version, key: KEY },
      new InMemoryReplayStore(),
    );
    expect(verdict).toEqual({ ok: false, reason: 'receipt signature verification failed' });
  });

  it('rejects receipts whose args hash does not match the executed args', () => {
    const receipt = issueAllow();
    const verdict = verifyExecutionReceipt(
      receipt,
      { argsHash: hashTradeArgs({ ...args, params: { amount: '999' } }), policyVersion: receipt.policy_version, key: KEY },
      new InMemoryReplayStore(),
    );
    expect(verdict).toEqual({ ok: false, reason: 'receipt args_hash does not match the trade args' });
  });

  it('rejects an expired receipt', () => {
    const receipt = issueAllow({ ttlMs: -1_000 });
    const verdict = verifyExecutionReceipt(
      receipt,
      { argsHash: receipt.args_hash, policyVersion: receipt.policy_version, key: KEY },
      new InMemoryReplayStore(),
      Date.parse(receipt.expiry) + 1,
    );
    expect(verdict).toEqual({ ok: false, reason: 'receipt expired' });
  });

  it('rejects a policy-version mismatch', () => {
    const receipt = issueAllow({ policy_version: '1.0-default' });
    const verdict = verifyExecutionReceipt(
      receipt,
      { argsHash: receipt.args_hash, policyVersion: '2.0-other', key: KEY },
      new InMemoryReplayStore(),
    );
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toContain('policy_version');
  });

  it('the boundary compares the LIVE gate policy version, not the receipt self-report', () => {
    // Regression for the prelint finding: the execution boundary passed
    // `receipt.policy_version` as the expected version — a vacuous
    // self-comparison that would let a receipt signed under a rotated
    // policy pass verification. The gate policy is the source of truth.
    const stale = issueAllow({ policy_version: '0.9-legacy' });
    const gatePolicyVersion = '1.0-default'; // what this.chpGate.getPolicy().version returns
    const verdict = verifyExecutionReceipt(
      stale,
      { argsHash: stale.args_hash, policyVersion: gatePolicyVersion, key: KEY },
      new InMemoryReplayStore(),
    );
    expect(verdict).toEqual({
      ok: false,
      reason: `receipt policy_version 0.9-legacy != ${gatePolicyVersion}`,
    });
  });

  it('consumes the nonce exactly once — replay is a deny', () => {
    const replay = new InMemoryReplayStore();
    const receipt = issueAllow();
    const expected = { argsHash: receipt.args_hash, policyVersion: receipt.policy_version, key: KEY };
    expect(verifyExecutionReceipt(receipt, expected, replay).ok).toBe(true);
    const second = verifyExecutionReceipt(receipt, expected, replay);
    expect(second).toEqual({ ok: false, reason: 'receipt nonce already consumed (replay)' });
  });
});

describe('parseTradeReceipt — fail-closed parsing', () => {
  it('rejects unknown extra keys (they would fall out of the MAC)', () => {
    const receipt = issueAllow() as unknown as Record<string, unknown>;
    receipt['sneaky'] = 'injection';
    expect(parseTradeReceipt(receipt)).toBeUndefined();
  });

  it('rejects ambiguous bindings (wildcards, blanks, reserved tokens)', () => {
    for (const actor of ['*', '', 'any', null]) {
      const receipt = issueAllow({ actor: actor as string }) as unknown as Record<string, unknown>;
      if (actor === null) receipt['actor'] = null;
      expect(parseTradeReceipt(receipt)).toBeUndefined();
    }
  });

  it('rejects a deny-decision receipt at verification', () => {
    const deny = issueTradeReceipt(
      {
        actor: 'human:shyam',
        resource: 'deepbook:execute:0xpool1',
        args_hash: hashTradeArgs(args),
        policy_version: '1.0-default',
        risk: 'medium',
        decision: 'deny',
        ttlMs: 300_000,
      },
      KEY,
    );
    const verdict = verifyExecutionReceipt(
      deny,
      { argsHash: deny.args_hash, policyVersion: deny.policy_version, key: KEY },
      new InMemoryReplayStore(),
    );
    expect(verdict).toEqual({ ok: false, reason: 'receipt decision is deny' });
  });
});

describe('FileReplayStore — restart persistence', () => {
  it('persists consumed nonces across instances and skips corrupt lines', () => {
    const dir = mkdtempSync(join(tmpdir(), 'deepbook-replay-'));
    try {
      const logPath = join(dir, 'state', 'replay-nonces.jsonl');
      mkdirSync(join(dir, 'state'), { recursive: true });
      writeFileSync(logPath, '{"nonce":"broken-line",\n', 'utf-8');
      const first = new FileReplayStore(logPath);
      first.consume({ nonce: 'n-1', consumedAt: 't', argsHash: 'h', tool: 't', resource: 'r' });
      const second = new FileReplayStore(logPath);
      expect(second.seen('n-1')).toBe(true);
      expect(second.seen('n-2')).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('prunes entries older than maxAgeMs on load and compacts the log — no false deny', () => {
    const dir = mkdtempSync(join(tmpdir(), 'deepbook-replay-prune-'));
    try {
      const logPath = join(dir, 'state', 'replay-nonces.jsonl');
      mkdirSync(join(dir, 'state'), { recursive: true });
      const fresh = {
        nonce: 'fresh-nonce', consumedAt: new Date().toISOString(),
        argsHash: 'h', tool: 't', resource: 'r',
      };
      const stale = {
        nonce: 'stale-nonce', consumedAt: new Date(Date.now() - 2 * 300_000).toISOString(),
        argsHash: 'h', tool: 't', resource: 'r',
      };
      const unparseable = {
        nonce: 'odd-nonce', consumedAt: 'not-a-timestamp',
        argsHash: 'h', tool: 't', resource: 'r',
      };
      writeFileSync(
        logPath,
        [fresh, stale, unparseable].map((r) => JSON.stringify(r)).join('\n') + '\n',
        'utf-8',
      );
      const pruned = new FileReplayStore(logPath, 300_000);
      // Stale is forgotten (it cannot be replayed by a valid receipt — it
      // is expired); fresh and unparseable-timestamp records survive.
      expect(pruned.seen('stale-nonce')).toBe(false);
      expect(pruned.seen('fresh-nonce')).toBe(true);
      expect(pruned.seen('odd-nonce')).toBe(true);
      // The log is compacted on disk: a fresh instance agrees.
      const reopened = new FileReplayStore(logPath, 300_000);
      expect(reopened.seen('stale-nonce')).toBe(false);
      expect(reopened.seen('fresh-nonce')).toBe(true);
      expect(reopened.seen('odd-nonce')).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('without maxAgeMs the store keeps every entry regardless of age', () => {
    const dir = mkdtempSync(join(tmpdir(), 'deepbook-replay-keepall-'));
    try {
      const logPath = join(dir, 'state', 'replay-nonces.jsonl');
      mkdirSync(join(dir, 'state'), { recursive: true });
      const stale = {
        nonce: 'stale-nonce', consumedAt: new Date(Date.now() - 10 * 300_000).toISOString(),
        argsHash: 'h', tool: 't', resource: 'r',
      };
      writeFileSync(logPath, JSON.stringify(stale) + '\n', 'utf-8');
      const store = new FileReplayStore(logPath);
      expect(store.seen('stale-nonce')).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('AgentTradingSession — receipt wiring at the execution boundary', () => {
  const POOL = '0xpool1';
  const config: TradingSessionConfig = {
    sessionId: 'receipt-session',
    allowedPools: [POOL],
    maxCapital: '100000',
    riskLimits: {
      maxPositionPerPool: '50000',
      maxDrawdownFraction: 0.1,
      maxDailyTrades: 10,
    },
  };

  const swapDecision: TradingDecision = {
    action: 'swap',
    poolId: POOL,
    reason: 'Executing arbitrage: price discrepancy detected between venues',
    confidence: 0.9,
    params: { amount: '100', minOut: '95' },
  };

  const policy: RiskPolicy = {
    version: 'test',
    maxNotionalUsd: 50000,
    dailyNotionalCapUsd: 250000,
    hitlThresholdUsd: 25000,
    allowedActions: ['swap', 'market_make', 'arbitrage', 'hedge', 'liquidity_provision'],
    perAssetLimits: {},
    minConfidence: 0.5,
  };

  const portfolio: PortfolioSnapshot = {
    owner: 'test-agent',
    quoteBalancesUsd: { [POOL]: 1_000_000 },
    totalEquityUsd: 2_000_000,
    capturedAt: Date.now(),
  };

  /** Offline harness: real gates, successful offline swap (mirrors the
   * chp-hardening harness). `requireHumanLock: false` exercises the
   * autonomous (policy-engine) path; the default keeps the lock ON. */
  function makeSession(opts: { receiptKey?: string; requireHumanLock?: boolean } = {}) {
    const ledgerPath = join(mkdtempSync(join(tmpdir(), 'deepbook-receipt-')), 'ledger.jsonl');
    const client = new DeepBookClient({ network: 'testnet' });
    const walrusStore = new WalrusAuditStore();
    Object.assign(client, {
      swapExactInput: async () => ({
        poolId: POOL,
        amountIn: '100',
        amountOut: '95',
        price: '1',
        fee: '1',
        txDigest: '0xtestdigest',
        timestamp: Date.now(),
      }),
      getOrderbook: async () => ({ poolId: POOL, bids: [], asks: [], timestamp: Date.now() }),
    });
    Object.assign(walrusStore, { storeBlob: async () => 'test-blob-id' });
    return new AgentTradingSession({
      client,
      config,
      walrusStore,
      chpGate: new ChpGate(policy),
      chpHardening: new TradeHardeningGate({
        ledgerPath,
        ...(opts.requireHumanLock === false ? { requireHumanLock: false } : {}),
      }),
      portfolioState: new StaticPortfolioStateProvider(portfolio),
      receiptKey: opts.receiptKey,
      receiptReplay: new InMemoryReplayStore(),
    });
  }

  it('fails closed when no receipt key is configured — nothing executes', async () => {
    delete process.env[RECEIPT_KEY_ENV];
    const session = makeSession({ requireHumanLock: false });
    const result = await session.executeAgentDecision(swapDecision);
    expect(result.success).toBe(false);
    expect(result.error).toContain(RECEIPT_KEY_ENV);
  });

  it('verifies the receipt before execution and records actor + consumed nonce', async () => {
    const session = makeSession({ receiptKey: KEY });
    const result = await session.executeAgentDecision(swapDecision, { confirmedBy: 'human:shyam' });
    expect(result.success).toBe(true);
    expect(result.receiptActor).toBe('human:shyam');
    expect(result.receiptNonce).toEqual(expect.any(String));
    expect(result.receiptNonce!.length).toBeGreaterThan(0);
    expect(result.txDigest).toBe('0xtestdigest');
  });

  it('records the policy-engine actor for autonomous execution', async () => {
    const session = makeSession({ receiptKey: KEY, requireHumanLock: false });
    const result = await session.executeAgentDecision(swapDecision);
    expect(result.success).toBe(true);
    expect(result.receiptActor).toBe('chp:policy-engine');
  });

  it('mints a fresh nonce per approval so a second execution cannot reuse the first', async () => {
    const session = makeSession({ receiptKey: KEY, requireHumanLock: false });
    const first = await session.executeAgentDecision(swapDecision);
    const second = await session.executeAgentDecision(swapDecision);
    expect(first.receiptNonce).toBeDefined();
    expect(second.receiptNonce).toBeDefined();
    expect(first.receiptNonce).not.toBe(second.receiptNonce);
  });
});
