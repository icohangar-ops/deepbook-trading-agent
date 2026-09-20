/**
 * deepbook-trading-agent — AI Agent Integration
 *
 * Bridges AI agent decision-making with DeepBook execution.
 * Takes a TradingDecision, validates it, executes via PTBs,
 * and stores the result on Walrus for a verifiable audit trail.
 */

import { DeepBookClient } from './deepbook-client.js';
import { PTBTrader, WalrusAuditStore } from './ptb-trading.js';
import {
  MarketMakingStrategy,
  ArbitrageStrategy,
  HedgeStrategy,
  LiquidityStrategy,
} from './strategies.js';
import type {
  TradingDecision,
  TradingSessionConfig,
  TradingReport,
  TradeResult,
  PoolId,
  AuditEntry,
} from './types.js';
import { ChpGate } from './chp/gate.js';
import {
  TradeHardeningGate,
  TradeRejection,
  type ExecutionEvidence,
  type PortfolioStateProvider,
} from './chp/hardening.js';
import {
  RECEIPT_TTL_MS,
  hashTradeArgs,
  issueTradeReceipt,
  resolveReceiptKey,
  tradeReceiptArgs,
  verifyExecutionReceipt,
  type ReceiptRisk,
} from './chp/receipt.js';
import {
  FileReplayStore,
  defaultReplayLogPath,
  type ReplayStore,
} from './chp/replay.js';

/* ─── Agent Trading Session ────────────────────────────────────────── */

export interface AgentSessionOptions {
  client: DeepBookClient;
  config: TradingSessionConfig;
  walrusStore?: WalrusAuditStore;
  /**
   * CHP decision-governance gate. If omitted, a gate is created from
   * config/policy.yaml (falling back to a conservative default policy).
   */
  chpGate?: ChpGate;
  /**
   * CHP hardening gate (R0 + foundation + human lock + decision ledger).
   * If omitted, one is created from DEEPBOOK_CHP_* env defaults.
   */
  chpHardening?: TradeHardeningGate;
  /**
   * Source of balance/portfolio state for R0 solvency and parity evidence.
   * R0 refuses every order when this is absent — a trade cannot be proven
   * solvable from a state nobody can observe.
   */
  portfolioState?: PortfolioStateProvider;
  /**
   * Explicit row-22 receipt signing key. Prefer $DEEPBOOK_CHP_RECEIPT_KEY;
   * this override exists for tests and embedded callers. Execution fails
   * closed when neither is set — no order is signed or placed.
   */
  receiptKey?: string;
  /**
   * Replay store for receipt nonces. Defaults to the JSONL file store
   * (`state/replay-nonces.jsonl`, overridable via $DEEPBOOK_CHP_REPLAY_LOG)
   * so consumed approvals survive a restart.
   */
  receiptReplay?: ReplayStore;
}

/**
 * Connects an AI agent's trading decisions to DeepBook execution.
 *
 * The session:
 * 1. Accepts decisions from an AI agent
 * 2. Validates against session config & risk limits
 * 3. Executes via PTBs
 * 4. Stores every decision + result on Walrus
 * 5. Provides P&L reporting
 */
export class AgentTradingSession {
  private client: DeepBookClient;
  private ptbTrader: PTBTrader;
  private config: TradingSessionConfig;
  private walrusStore: WalrusAuditStore;
  private results: TradeResult[] = [];
  private auditRefs: string[] = [];
  private activeStrategies: Map<string, MarketMakingStrategy | ArbitrageStrategy | HedgeStrategy | LiquidityStrategy> = new Map();
  private chpGate: ChpGate;
  private chpHardening: TradeHardeningGate;
  private portfolioState?: PortfolioStateProvider;
  private readonly receiptKeyOverride?: string;
  private readonly receiptReplay: ReplayStore;

  constructor(options: AgentSessionOptions) {
    this.client = options.client;
    this.ptbTrader = new PTBTrader(options.client);
    this.config = options.config;
    this.walrusStore = options.walrusStore ?? new WalrusAuditStore();
    this.chpGate = options.chpGate ?? new ChpGate();
    this.chpHardening = options.chpHardening ?? new TradeHardeningGate();
    this.portfolioState = options.portfolioState;
    this.receiptKeyOverride = options.receiptKey;
    // Pass the receipt TTL so entries past it are pruned on startup and the
    // log compacted — a nonce older than the TTL cannot be replayed by a
    // valid receipt, so this bounds growth with no security regression.
    this.receiptReplay = options.receiptReplay ?? new FileReplayStore(defaultReplayLogPath(), RECEIPT_TTL_MS);
  }

  /** Expose the CHP gate (e.g. for provenance inspection / human approval). */
  get chp(): ChpGate {
    return this.chpGate;
  }

  /** Expose the CHP hardening gate (session status, ledger, human lock). */
  get hardening(): TradeHardeningGate {
    return this.chpHardening;
  }

  /**
   * Trade decision ledger, re-validated on read (`integrity_valid` /
   * `envelope_valid` per record) — the durable CHP surface for this session.
   */
  getDecisionLedger() {
    return this.chpHardening.records.list();
  }

  get sessionId(): string {
    return this.config.sessionId;
  }

  /**
   * Execute an AI agent's trading decision.
   *
   * Flow:
   * 1. Validate the decision against session config and risk limits
   * 2. CHP R0 gate — solvable/scoped/valid/worth-it, FATAL before the engine
   * 3. CHP spend gate (policy caps; Profile B via @cubiczan/chp)
   * 4. CHP foundation pass + human lock (PROVISIONAL_LOCK -> LOCKED)
   * 5. Seal the decision into the append-only trade decision ledger
   * 6. Execute via the appropriate strategy or direct PTB
   * 7. Store the result on Walrus
   *
   * `opts.confirmedBy` names the human confirmer for the hardening lock.
   */
  async executeAgentDecision(
    decision: TradingDecision,
    opts?: { confirmedBy?: string },
  ): Promise<TradeResult> {
    const timestamp = Date.now();
    const result: TradeResult = {
      decision,
      success: false,
      timestamp,
    };

    try {
      // 1. Validate against session config & risk limits
      this.validateDecision(decision);

      // 2. CHP R0 gate — before the engine. FATAL failures halt the trade:
      //    nothing executed, nothing persisted.
      const notionalUsd = this.deriveNotional(decision);
      const portfolio = this.portfolioState
        ? await this.portfolioState.getPortfolio()
        : undefined;
      const r0 = this.chpHardening.evaluateR0({
        action: decision.action,
        poolId: decision.poolId,
        notionalUsd,
        rationale: decision.reason,
        confidence: decision.confidence,
        portfolio,
        maxNotionalUsd: this.chpGate.getPolicy().maxNotionalUsd,
        maxDailyTrades: this.config.riskLimits.maxDailyTrades,
        allowedPools: this.config.allowedPools,
        allowedActions: this.chpGate.getPolicy().allowedActions,
        minConfidence: this.chpGate.getPolicy().minConfidence,
      });

      // 3. CHP spend gate (Profile B). Blocks or defers capital-moving
      //    decisions whose notional breaches policy before any execution.
      const chp = this.chpGate.evaluate({
        action: decision.action,
        poolId: decision.poolId,
        notionalUsd,
        confidence: decision.confidence,
        rationale: decision.reason,
      });
      if (!chp.allowed) {
        const kind = chp.requiresHuman ? 'requires human approval' : 'blocked';
        throw new Error(
          `CHP gate ${kind} (${chp.state}): ${chp.reason} [decision ${chp.provenance.decisionId}]`,
        );
      }

      // 4. CHP foundation pass (deterministic adversary) + human lock.
      //    Capital movement is not read-only, so the adversary scores the
      //    BOUNDED TRADE PLAN against balance/portfolio state BEFORE the
      //    order is placed (see hardening.ts for the documented divergence
      //    from the ERP reference, where execution is a read-only query).
      const bounded = this.deriveBoundedEvidence(decision);
      const hardened = this.chpHardening.harden({
        action: decision.action,
        poolId: decision.poolId,
        notionalUsd,
        rationale: decision.reason,
        confidence: decision.confidence,
        maxCapitalUsd: Number(this.config.maxCapital),
        evidence: {
          guardrailsPassed: true,
          bounded: bounded.bounded,
          boundedDetail: bounded.detail,
          observedQuoteBalanceUsd:
            portfolio?.quoteBalancesUsd[decision.poolId] ?? portfolio?.totalEquityUsd ?? null,
          notionalUsd,
          maxCapitalUsd: Number(this.config.maxCapital),
        } satisfies ExecutionEvidence,
      });

      const needsConfirmer =
        this.chpHardening.requireHumanLock || !this.chpHardening.canSelfCertify(hardened.assessment);
      if (needsConfirmer) {
        const confirmedBy = opts?.confirmedBy;
        if (!confirmedBy) {
          throw new TradeRejection(
            this.chpHardening.canSelfCertify(hardened.assessment)
              ? 'CHP hardening: human lock required (DEEPBOOK_CHP_REQUIRE_HUMAN_LOCK defaults ON) — name a human confirmer before the order is placed'
              : `CHP hardening: foundation score ${hardened.assessment.score} is below the blockchain/DeFi floor ${this.chpHardening.floor} — the trade cannot self-certify; name a human confirmer`,
            hardened.assessment,
          );
        }
        this.chpHardening.lock(hardened, confirmedBy);
      }

      // 5. Seal the locked decision into the append-only ledger before any
      //    order goes on-chain; the execution outcome surfaces via
      //    TradeResult and the Walrus audit trail.
      const record = this.chpHardening.record(hardened, {
        poolId: decision.poolId,
        action: decision.action,
        r0Verdict: r0.verdict,
        artifacts: {
          reason: decision.reason,
          confidence: decision.confidence,
          params: decision.params,
          modelSignature: decision.modelSignature ?? null,
        },
      });
      result.chpDecisionId = record.decision_id;
      result.chpSessionStatus = record.session_status;

      // 5b. Row-22 tool-approval receipt: a gate verdict — even LOCKED — is
      //     an allowlist answer, not authorization. Issue a receipt binding
      //     actor/tool/resource/exact trade args/policy/risk/expiry/nonce,
      //     then verify it at the execution boundary. Fail-closed:
      //     resolveReceiptKey throws when DEEPBOOK_CHP_RECEIPT_KEY is unset,
      //     and a failed verification refuses the order before capital moves.
      const receiptKey = resolveReceiptKey(this.receiptKeyOverride);
      const receiptArgs = tradeReceiptArgs(decision);
      const argsHash = hashTradeArgs(receiptArgs);
      const receipt = issueTradeReceipt(
        {
          actor: opts?.confirmedBy ?? 'chp:policy-engine',
          resource: `deepbook:execute:${decision.poolId}`,
          args_hash: argsHash,
          policy_version: this.chpGate.getPolicy().version,
          risk: this.receiptRiskFor(notionalUsd),
          decision: 'allow',
          ttlMs: RECEIPT_TTL_MS,
        },
        receiptKey,
      );
      const receiptCheck = verifyExecutionReceipt(
        receipt,
        // Expected policy version comes from the LIVE gate policy, not from
        // the receipt's self-report — comparing the field against itself
        // would make the check vacuous and let a receipt signed under a
        // rotated/deprecated policy pass verification.
        { argsHash, policyVersion: this.chpGate.getPolicy().version, key: receiptKey },
        this.receiptReplay,
      );
      if (!receiptCheck.ok) {
        throw new TradeRejection(
          `CHP receipt verification failed: ${receiptCheck.reason}`,
          hardened.assessment,
        );
      }
      result.receiptActor = receiptCheck.receipt.actor;
      result.receiptNonce = receiptCheck.receipt.nonce;

      switch (decision.action) {
        case 'swap': {
          const amount = decision.params['amount'] as string;
          const minOut = decision.params['minOut'] as string;
          const swapResult = await this.client.swapExactInput(
            decision.poolId,
            amount,
            minOut ?? '0'
          );
          result.txDigest = swapResult.txDigest;
          break;
        }

        case 'market_make': {
          // Start market making strategy if not already running
          const key = `mm-${decision.poolId}`;
          if (!this.activeStrategies.has(key)) {
            const strategy = new MarketMakingStrategy(
              this.client,
              this.ptbTrader,
              {
                poolId: decision.poolId,
                spreadFraction: (decision.params['spreadFraction'] as number) ?? 0.01,
                positionSize: (decision.params['positionSize'] as string) ?? '1000',
                refreshIntervalMs: (decision.params['refreshIntervalMs'] as number) ?? 60000,
                maxPosition: (decision.params['maxPosition'] as string) ?? '100000',
                minProfitThreshold: (decision.params['minProfitThreshold'] as string) ?? '100',
              }
            );
            this.activeStrategies.set(key, strategy);
            await strategy.start();
          }
          break;
        }

        case 'arbitrage': {
          const strategy = new ArbitrageStrategy(
            this.client,
            this.ptbTrader,
            {
              poolIds: (decision.params['poolIds'] as PoolId[]) ?? [decision.poolId],
              minProfitFraction: (decision.params['minProfitFraction'] as number) ?? 0.005,
              maxCapitalPerTrade: (decision.params['maxCapitalPerTrade'] as string) ?? '50000',
              checkIntervalMs: (decision.params['checkIntervalMs'] as number) ?? 30000,
            }
          );
          this.activeStrategies.set(`arb-${Date.now()}`, strategy);
          await strategy.start();
          break;
        }

        case 'hedge': {
          const strategy = new HedgeStrategy(
            this.client,
            this.ptbTrader,
            {
              positionPoolId: decision.poolId,
              hedgePools: (decision.params['hedgePools'] as PoolId[]) ?? [],
              hedgeRatio: (decision.params['hedgeRatio'] as number) ?? 0.5,
              rebalanceThreshold: (decision.params['rebalanceThreshold'] as string) ?? '1000',
            }
          );
          this.activeStrategies.set(`hedge-${decision.poolId}`, strategy);
          await strategy.start();
          break;
        }

        case 'liquidity_provision': {
          const strategy = new LiquidityStrategy(
            this.client,
            this.ptbTrader,
            {
              poolId: decision.poolId,
              totalLiquidity: (decision.params['totalLiquidity'] as string) ?? '100000',
              priceLower: (decision.params['priceLower'] as string) ?? '800',
              priceUpper: (decision.params['priceUpper'] as string) ?? '1200',
              feeTier: (decision.params['feeTier'] as number) ?? 30,
              rebalanceIntervalMs: (decision.params['rebalanceIntervalMs'] as number) ?? 3600000,
            }
          );
          this.activeStrategies.set(`lp-${decision.poolId}`, strategy);
          await strategy.start();
          break;
        }
      }

      result.success = true;

      // 6. Store on Walrus
      try {
        const auditEntry: AuditEntry = {
          sessionId: this.config.sessionId,
          decisionId: `${timestamp}-${decision.poolId.slice(0, 8)}`,
          timestamp,
          decision,
          marketSnapshot: await this.client.getOrderbook(decision.poolId),
          result,
          pnlImpact: '0', // Would be calculated from actual fills
        };

        const blob = new TextEncoder().encode(JSON.stringify(auditEntry));
        const blobId = await this.walrusStore.storeBlob(blob);
        result.walrusBlobId = blobId;
        this.auditRefs.push(blobId);
      } catch (walrusErr) {
        // Non-fatal: if Walrus store fails, execution still succeeded
        console.warn(`Walrus audit store failed: ${(walrusErr as Error).message}`);
      }

      this.results.push(result);
    } catch (err) {
      result.success = false;
      result.error = (err as Error).message;
      this.results.push(result);
    }

    return result;
  }

  /**
   * Deterministic row-22 receipt risk tier from the gated notional and the
   * policy's per-action ceiling: at half the cap or more the approval is
   * high risk, any positive notional is medium, and a zero-notional action
   * is low.
   */
  private receiptRiskFor(notionalUsd: number): ReceiptRisk {
    const cap = this.chpGate.getPolicy().maxNotionalUsd;
    if (notionalUsd >= cap / 2) return 'high';
    if (notionalUsd > 0) return 'medium';
    return 'low';
  }

  /**
   * Derive the notional value (quote asset) of a decision for the CHP gate.
   * Reads the size field that is meaningful for each action type from
   * `decision.params`, defaulting to 0 when no size is supplied.
   */
  private deriveNotional(decision: TradingDecision): number {
    const p = decision.params;
    const candidates = [
      p['amount'],
      p['maxCapitalPerTrade'],
      p['positionSize'],
      p['totalLiquidity'],
      p['notional'],
    ];
    for (const c of candidates) {
      if (c === undefined || c === null) continue;
      const n = typeof c === 'number' ? c : Number(c);
      if (Number.isFinite(n) && n > 0) return n;
    }
    return 0;
  }

  /**
   * Derive bounded-order-plan evidence for the foundation pass: each action
   * must carry an explicit execution bound (a slippage bound for swaps, size
   * caps for strategies). A plan without a bound cannot earn the
   * bounded-result points — an unbounded swap (minOut 0) is unbounded
   * slippage and fails the adversary.
   */
  private deriveBoundedEvidence(decision: TradingDecision): { bounded: boolean; detail: string } {
    const p = decision.params;
    const num = (key: string): number => {
      const v = p[key];
      const n = typeof v === 'number' ? v : Number(v);
      return Number.isFinite(n) ? n : NaN;
    };

    switch (decision.action) {
      case 'swap': {
        const minOut = num('minOut');
        return Number.isFinite(minOut) && minOut > 0
          ? { bounded: true, detail: `minOut ${minOut} bounds slippage` }
          : { bounded: false, detail: `minOut ${p['minOut'] ?? 'unset'} does not bound slippage` };
      }
      case 'market_make': {
        const size = num('positionSize');
        const max = num('maxPosition');
        return size > 0 && max > 0
          ? { bounded: true, detail: `positionSize ${size} within maxPosition ${max}` }
          : { bounded: false, detail: 'missing positionSize/maxPosition bounds' };
      }
      case 'arbitrage': {
        const cap = num('maxCapitalPerTrade');
        return cap > 0
          ? { bounded: true, detail: `maxCapitalPerTrade ${cap} bounds exposure` }
          : { bounded: false, detail: 'missing maxCapitalPerTrade bound' };
      }
      case 'hedge': {
        const ratio = num('hedgeRatio');
        return ratio > 0 && ratio <= 1
          ? { bounded: true, detail: `hedgeRatio ${ratio} within (0, 1]` }
          : { bounded: false, detail: `hedgeRatio ${p['hedgeRatio'] ?? 'unset'} outside (0, 1]` };
      }
      case 'liquidity_provision': {
        const total = num('totalLiquidity');
        return total > 0
          ? { bounded: true, detail: `totalLiquidity ${total} bounds the position` }
          : { bounded: false, detail: 'missing totalLiquidity bound' };
      }
    }
  }

  /**
   * Validate a trading decision against session config and risk limits.
   */
  private validateDecision(decision: TradingDecision): void {
    // Check pool is allowed
    if (!this.config.allowedPools.includes(decision.poolId)) {
      throw new Error(
        `Pool ${decision.poolId} not in allowed pools for this session`
      );
    }

    // Check daily trade limit
    const todayTrades = this.results.filter((r) => {
      const d = new Date(r.timestamp);
      const now = new Date();
      return d.toDateString() === now.toDateString();
    }).length;

    if (todayTrades >= this.config.riskLimits.maxDailyTrades) {
      throw new Error(
        `Daily trade limit reached (${todayTrades}/${this.config.riskLimits.maxDailyTrades})`
      );
    }

    // Validate decision confidence
    if (decision.confidence < 0.5) {
      console.warn(
        `Low confidence decision: ${decision.confidence}. Consider reviewing before execution.`
      );
    }
  }

  /**
   * Generate a comprehensive trading report for this session.
   */
  async getAgentReport(): Promise<TradingReport> {
    const successful = this.results.filter((r) => r.success);
    const failed = this.results.filter((r) => !r.success);

    // Calculate positions from latest orderbook snapshots
    const openPositions: TradingReport['openPositions'] = [];
    for (const poolId of this.config.allowedPools) {
      try {
        const ob = await this.client.getOrderbook(poolId);
        const bestBid = ob.bids[0];
        const bestAsk = ob.asks[0];
        if (bestBid) {
          openPositions.push({
            poolId,
            side: 'bid',
            size: bestBid.quantity,
            entryPrice: bestBid.price,
            unrealizedPnl: '0',
          });
        }
        if (bestAsk) {
          openPositions.push({
            poolId,
            side: 'ask',
            size: bestAsk.quantity,
            entryPrice: bestAsk.price,
            unrealizedPnl: '0',
          });
        }
      } catch {
        // Pool might not be queryable
      }
    }

    return {
      sessionId: this.config.sessionId,
      totalTrades: this.results.length,
      successfulTrades: successful.length,
      failedTrades: failed.length,
      totalPnl: '0', // Would require fill data
      winRate: this.results.length > 0
        ? successful.length / this.results.length
        : 0,
      openPositions,
      tradeHistory: [...this.results],
      walrusAuditRefs: [...this.auditRefs],
      generatedAt: Date.now(),
    };
  }

  /**
   * Stop all active strategies.
   */
  async stopAll(): Promise<void> {
    for (const [name, strategy] of this.activeStrategies) {
      await strategy.stop();
      console.log(`Stopped strategy: ${name}`);
    }
    this.activeStrategies.clear();
  }

  /**
   * Get status of all active strategies.
   */
  getStrategyStatuses(): Record<string, unknown>[] {
    const statuses: Record<string, unknown>[] = [];
    for (const [name, strategy] of this.activeStrategies) {
      statuses.push({
        name,
        ...strategy.getStatus(),
      });
    }
    return statuses;
  }
}
