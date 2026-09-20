# DeepBook Trading Agent

> AI-powered, autonomous trading on DeepBook (Sui's on-chain orderbook).
> Reusable TypeScript library for market making, arbitrage, hedging, and liquidity strategies.

[![DeepBook](https://img.shields.io/badge/DeepBook-v3-6b46c1)](https://docs.sui.io/deepbook)
[![License](https://img.shields.io/badge/License-MIT-blue)](LICENSE)

---

## Architecture

```
                     ┌──────────────────────┐
                     │   AI Agent Decision   │
                     │  (deliberation engine) │
                     └──────────┬───────────┘
                                │ trading signal
                                ▼
┌──────────────────────────────────────────────────┐
│              AgentTradingSession                  │
│  ┌──────────┐  ┌──────────┐  ┌───────────────┐   │
│  │ Strategy │→ │  PTB     │→ │ DeepBook      │   │
│  │ Engine   │  │ Builder  │  │ Client        │   │
│  └──────────┘  └──────────┘  └───────┬───────┘   │
│                                       │           │
│  ┌────────────────────────────────────┘           │
│  │              Walrus Audit Trail                 │
│  └────────────────────────────────────────────────┘
└────────────────────────────────────────────────────┘
                         │
                         ▼
┌────────────────────────────────────────────────────┐
│             Sui Network + DeepBook                  │
│  ┌─────────────┐  ┌────────────┐  ┌────────────┐  │
│  │ Outcome     │  │ Orderbook  │  │ Settlement │  │
│  │ Pools       │  │ Engine     │  │ Engine     │  │
│  └─────────────┘  └────────────┘  └────────────┘  │
└────────────────────────────────────────────────────┘
```

## Features

### DeepBook Client (`deepbook-client.ts`)
- **Pool Management** — Create and manage outcome token pools (YES/NO)
- **Order Placement** — Place, cancel, and manage limit orders
- **Market Data** — Fetch orderbook snapshots, market depth, price data
- **Swaps** — Execute market swaps with minimum output protection
- **Balance Queries** — Check pool balances and positions

### Trading Strategies (`strategies.ts`)
- **Market Making**:
  - Configurable spread width and position sizing
  - Automatic bid/ask order placement and refresh
  - Dynamic rebalancing based on market conditions
  - Profit/loss tracking per cycle
- **Arbitrage**:
  - Monitors prediction odds across correlated markets
  - Detects pricing discrepancies and anomalies
  - Executes arbitrage trades atomically via PTBs
  - Configurable thresholds and position limits
- **Hedging**:
  - Hedges prediction market positions against correlated markets
  - Dynamically adjusts hedge ratios
  - Supports multiple hedge targets
- **Liquidity Provision**:
  - Provides liquidity to outcome token pools
  - Earns trading fees
  - Auto-rebalances based on pool composition

### PTB Trading (`ptb-trading.ts`)
- **Atomic Transactions** — Combine trade + stake + storage into one PTB
- **Multi-Pool Swaps** — Trade across multiple pools in one transaction
- **Strategy Execution** — Execute complex strategies as single PTBs
- **Walrus Integration** — Store trade decisions and proofs on chain via PTBs

### Agent Integration (`agent-integration.ts`)
- `AgentTradingSession` — Connects AI agent decisions to DeepBook execution
- `executeAgentDecision()` — Takes an agent's trading decision and executes it
- `getAgentReport()` — Returns P&L, win rate, position summary
- **Verifiable Audit Trail** — All trade decisions stored on Walrus

## Quickstart

### Install

```bash
pnpm add @mysten/sui @mysten/walrus
```

### Basic Usage

```typescript
import { DeepBookClient } from 'deepbook-trading-agent';
import { Ed25519Keypair } from '@mysten/sui/keypairs/ed25519';

// Create a DeepBook client. The keypair is optional; without it,
// only read-only queries (orderbook, depth) are available.
const keypair = Ed25519Keypair.generate();
const db = new DeepBookClient({ network: 'testnet', keypair });

// Get an orderbook snapshot
const orderbook = await db.getOrderbook('0x...pool');
console.log(`Bids: ${orderbook.bids.length}, Asks: ${orderbook.asks.length}`);

// Place a limit order
const order = await db.placeOrder({
  poolId: '0x...pool',
  side: 'bid',
  price: 450,
  quantity: 1000,
});
```

### Running a Strategy

Strategies take the client and a `PTBTrader`, plus a strategy-specific config:

```typescript
import {
  DeepBookClient,
  PTBTrader,
  MarketMakingStrategy,
} from 'deepbook-trading-agent';

const client = new DeepBookClient({ network: 'testnet', keypair });
const ptbTrader = new PTBTrader(client);

const strategy = new MarketMakingStrategy(client, ptbTrader, {
  poolId: '0x...pool',
  spreadFraction: 0.02,      // 2% spread around mid price
  positionSize: '500',
  refreshIntervalMs: 30000,  // refresh every 30s
  maxPosition: '50000',
  minProfitThreshold: '100',
});

await strategy.start();
```

### With AI Agent Integration

`AgentTradingSession` accepts trading decisions produced by an AI agent,
validates them against the session's risk limits, executes them, and stores
each decision on Walrus as a verifiable audit trail.

```typescript
import {
  DeepBookClient,
  AgentTradingSession,
  WalrusAuditStore,
} from 'deepbook-trading-agent';

const client = new DeepBookClient({ network: 'testnet', keypair });
const session = new AgentTradingSession({
  client,
  config: {
    sessionId: 'session-1',
    allowedPools: ['0x...poolYes', '0x...poolNo'],
    maxCapital: '500000',
    riskLimits: {
      maxPositionPerPool: '100000',
      maxDrawdownFraction: 0.15,
      maxDailyTrades: 100,
    },
  },
  walrusStore: new WalrusAuditStore(),
});

// Execute a decision produced by your agent
const result = await session.executeAgentDecision({
  action: 'arbitrage',
  poolId: '0x...poolYes',
  reason: 'Prediction odds diverging from fundamentals',
  confidence: 0.78,
  params: { poolIds: ['0x...poolYes', '0x...poolNo'], minProfitFraction: 0.005 },
});

// Get a performance report
const report = await session.getAgentReport();
console.log(`Win rate: ${(report.winRate * 100).toFixed(1)}%`);
console.log(`Trades: ${report.totalTrades}`);
```

See [`src/demo.ts`](src/demo.ts) for an end-to-end walkthrough.

## API Reference

### `DeepBookClient`

| Method | Description |
| ------ | ----------- |
| `createPool(config)` | Create a new outcome token pool |
| `placeOrder(params)` | Place a limit order |
| `cancelOrder(orderId)` | Cancel an existing order |
| `getOrderbook(poolId)` | Get orderbook snapshot |
| `getDepth(poolId)` | Get market depth |
| `swapExactInput(poolId, amountIn, minOut)` | Execute a market swap |

### Trading Strategies

| Strategy | Class | Description |
| -------- | ----- | ----------- |
| Market Making | `MarketMakingStrategy` | Automated bid/ask order management |
| Arbitrage | `ArbitrageStrategy` | Cross-market arbitrage detection |
| Hedging | `HedgeStrategy` | Position hedging with correlated markets |
| Liquidity | `LiquidityStrategy` | Automated liquidity provision |

### `AgentTradingSession`

| Method | Description |
| ------ | ----------- |
| `executeAgentDecision(decision)` | Validate and execute an agent's decision. Returns a `TradeResult` carrying the audit fields `success`, `chpDecisionId`, `chpSessionStatus`, `receiptActor` (named confirmer or `chp:policy-engine`), and `receiptNonce` (consumed single-use receipt nonce) — record all of them in downstream audit logging. |
| `getAgentReport()` | Get session trading performance report |
| `getStrategyStatuses()` | Get status of all active strategies |
| `stopAll()` | Stop all active strategies |

## Use Cases

### Sui Overflow 2026 — Infra & DevX Track
This library is a **Sui native primitive** for building agentic trading systems:
- **Developer framework** — Build trading bots with 10 lines of code
- **Sui-first** — DeepBook, PTBs, Walrus — all native Sui primitives
- **Verifiable AI** — Every trade decision stored on Walrus for audit

### Other Hackathons
| Hackathon | Track | How to Use |
|-----------|-------|------------|
| EVE Frontier | Agentic Trading | Drop in strategies + Walrus audit |
| Sui Basecamp | DeFi | Market making for any DeepBook pool |
| Solana | Migration* | Adapt PTB patterns to SPM |

*\*Adaptation needed — this library is Sui-native.*

## Decision Governance (CHP gate)

Every capital-moving decision passes through a **CHP-style decision gate**
(`src/chp/`) before execution — a TypeScript port of the Consensus Hardening
Protocol pattern from the `cleanmandate` / `swarmfi-executor` donor repos.

**Policy** lives in [`config/policy.yaml`](./config/policy.yaml):
`max_notional_usd` (hard ceiling), `daily_notional_cap_usd`, `per_asset_limits`
(per-pool caps), a `hitl_threshold_usd` above which human approval is required,
`allowed_actions`, and `min_confidence`. If the file is missing or unparseable
the gate falls back to a conservative built-in default and logs a warning
(non-breaking, no YAML dependency added).

**Gate** (`src/chp/gate.ts`) drives each proposed action through decision states
`EXPLORING → PROVISIONAL → LOCKED` (or `HITL_REQUIRED` / `BLOCKED`), runs a
lightweight adversarial/sanity check (finite non-negative notional, minimum
confidence), and records per-decision provenance (UUID, timestamp, SHA-256
content hash, per-claim results) in an append-only ledger.

It is wired into `AgentTradingSession.executeAgentDecision()`: after the
existing session/risk-limit validation, the decision's notional (derived from
`params.amount` / `maxCapitalPerTrade` / `positionSize` / `totalLiquidity`) is
run through `chpGate.evaluate(action)`. Blocked or HITL-required decisions are
rejected before any PTB is submitted. Pass a custom gate via
`new AgentTradingSession({ client, config, chpGate })`, and inspect provenance
or grant approval via `session.chp`.

```ts
import { ChpGate, AgentTradingSession } from 'deepbook-trading-agent';
const session = new AgentTradingSession({ client, config, chpGate: new ChpGate() });
```

### CHP hardening (R0 · foundation score · human lock · decision ledger)

On top of the spend gate, every order now runs through a full **CHP hardening
pass** (`src/chp/hardening.ts`) — a TypeScript port of the decision-record
pattern proven in `erp-control-plane` (`api/genbi/chp.py`):

1. **R0 gate — before every order**: *is this trade solvable from the current
   balance/portfolio state?* Results use the capitalized keys `Solvable`,
   `Scoped`, `Valid`, `Worth_it`; any `FATAL` refuses the order (a
   `TradeRejection` is thrown before a PTB is built). Portfolio state comes
   from a `PortfolioStateProvider` — `StaticPortfolioStateProvider` wraps a
   snapshot; production deployments should supply a live one. Bounded-plan
   evidence is derived from the decision: swap slippage (`minOut`),
   market-making position caps, arbitrage capital caps, hedge ratios, and LP
   size limits; a swap with `minOut: 0` is treated as unbounded.
2. **Deterministic foundation pass** (no LLM in the loop): guardrails 40 +
   bounded result 30 + parity 30. Parity asserts the observed quote balance /
   portfolio state against the execution plan (or against pinned golden trade
   cases via `DEEPBOOK_CHP_GOLDEN_PATH`); **a parity mismatch is fatal**. The
   blockchain/DeFi domain floors at **85** — below the floor the trade cannot
   self-certify and requires a named human confirmer.
3. **Human lock**: the session starts `EXPLORING`; every hardened trade opens
   `PROVISIONAL_LOCK`, and `confirmed_by` (a named operator) locks it via
   third-party validation before execution. `DEEPBOOK_CHP_REQUIRE_HUMAN_LOCK`
   (default **on**) makes the confirmer mandatory for every order.
4. **Trade decision ledger**: each locked trade seals an append-only JSONL
   record (`.chp/decisions.jsonl`, configurable via `ledgerPath`) with a
   SHA-256 `body_sha256` of the canonical decision body. The payload envelope
   is structure-only; reads re-validate the digest and expose
   `integrity_valid` / `envelope_valid`. Inspect it via
   `session.getDecisionLedger()`.

`executeAgentDecision` returns `chpDecisionId` / `chpSessionStatus` on each
`TradeResult`, plus `receiptActor` / `receiptNonce` when a receipt was
verified at the execution boundary — the full audit key set is
`success`, `chpDecisionId`, `chpSessionStatus`, `receiptActor`,
`receiptNonce`. The demo runs the full loop with a static portfolio snapshot
and names its operator as the confirmer.

```ts
import { TradeHardeningGate, StaticPortfolioStateProvider, AgentTradingSession } from 'deepbook-trading-agent';

const session = new AgentTradingSession({
  client,
  config,
  chpHardening: new TradeHardeningGate({ requireHumanLock: true }),
  portfolioState: new StaticPortfolioStateProvider({ owner: 'my-agent', quoteBalancesUsd: { [poolId]: 250_000 } }),
});
const result = await session.executeAgentDecision(decision, { confirmedBy: 'operator@example.com' });
if (result.success) console.log(result.chpDecisionId, result.chpSessionStatus); // LOCKED
```

### Tool-approval receipts (row 22: an allowlist is not authorization)

A CHP verdict — even a `LOCKED` hardening decision — is an *allowlist
answer*. Authorization to move capital is a separate act:
`executeAgentDecision` (`src/agent-integration.ts`) issues a
**tool-approval receipt** (`src/chp/receipt.ts`, ported from
`cubiczan-chp-mcp` `src/receipt.ts` via the cognitrader-bsc merged port)
binding actor, tool (`deepbook_execute`), resource
(`deepbook:execute:<poolId>`), the exact trade arguments (SHA-256 over the
canonical JSON form — `src/chp/canonical.ts`), policy version, risk tier, a
300s expiry, and a single-use nonce, all HMAC-SHA256-signed. The receipt is
verified at the execution boundary — fail-closed signature, expiry,
args-hash, and policy-version checks with timing-safe comparison — and its
nonce is consumed through the replay store (`src/chp/replay.ts`) before any
order is built; replaying the same receipt is a deny.

- `DEEPBOOK_CHP_RECEIPT_KEY` — HMAC signing key. **Fail-closed**: unset or
  blank refuses every order (`resolveReceiptKey` throws — there is no
  committed default key).
- `DEEPBOOK_CHP_REPLAY_LOG` — nonce replay log (default
  `state/replay-nonces.jsonl`); consumed approvals survive a restart, and a
  corrupt log line is skipped rather than trusted. Entries older than the
  receipt TTL (300s) are **pruned on startup** and the log compacted — a
  nonce past the TTL cannot be replayed by a valid receipt, so this bounds
  startup cost for long-running deployments with no security regression;
  records with an unparseable timestamp are kept, never dropped.

`TradeResult` records `receiptActor` (the named confirmer, or
`chp:policy-engine` for autonomous execution) and `receiptNonce` (the
consumed single-use nonce — the replay audit key).

**Risk tier is audit-only today.** The tier is computed from the trade
notional relative to the policy spending ceiling — `high` at 50% of the
ceiling or above (an arbitrary-but-deterministic boundary), `medium` for
any positive notional, `low` at zero — and is signed into the receipt and
recorded with the trade result. No gate, alert, or HITL trigger behaves
differently for `high` vs `medium` yet; an operator seeing a `high` receipt
should not expect a behavioral consequence. Wiring one (for example, a
HITL trigger at the `high` boundary) is the documented reopening condition.

## Propagation notes (wave B)

- **Row 22 (tool-approval receipts) — adopted.** Signed, single-use
  authorization receipts at the trade-execution boundary:
  `src/chp/receipt.ts` (HMAC-SHA256 over canonical JSON, fail-closed key
  resolution), `src/chp/replay.ts` (persistent nonce replay store),
  `src/chp/canonical.ts` (deterministic serialization), wired into
  `executeAgentDecision` in `src/agent-integration.ts`. See the
  Tool-approval receipts section above.
- **Row 3 (tiered market-data resolution) — reversed.** The agent reads a
  single venue: every price/orderbook path consumes the DeepBook SDK
  (`src/deepbook-client.ts`); there is no independent market-data feed,
  cache/fallback chain, or degradation state to tier. The row's opening
  condition (a second independent source feeding the decision path) is not
  met; re-evaluate if off-chain market data is ever added.

## Development

```bash
pnpm install
pnpm build
pnpm test                              # full suite (includes CHP gate)
pnpm exec vitest run src/__tests__/chp-gate.test.ts   # CHP gate only

# Run demo
pnpm demo
```

## Project Structure

```
deepbook-trading-agent/
├── src/
│   ├── deepbook-client.ts     # Low-level DeepBook client
│   ├── strategies.ts          # Trading strategies (MM, arb, hedge, LP)
│   ├── ptb-trading.ts         # PTB construction for atomic trades
│   ├── agent-integration.ts   # AI agent session management
│   ├── types.ts               # Type definitions
│   ├── demo.ts                # End-to-end demo
│   ├── chp/                   # CHP decision gate + hardening layer
│   │   ├── gate.ts            # Profile B spend gate (normative @cubiczan/chp)
│   │   ├── policy.ts          # Policy loading with safe defaults
│   │   ├── hardening.ts       # R0 + foundation + human lock + ledger
│   │   ├── canonical.ts       # Deterministic canonical JSON (receipt digests)
│   │   ├── receipt.ts         # Row-22 signed tool-approval receipts
│   │   └── replay.ts          # Single-use nonce replay store (JSONL-backed)
│   └── __tests__/             # Test suites
├── config/
│   └── policy.yaml            # CHP spend-gate policy
├── package.json
├── tsconfig.json
└── README.md
```

## License

MIT — build freely.

---

*Built for Sui Overflow 2026. Part of the Cubiczan ecosystem.*
