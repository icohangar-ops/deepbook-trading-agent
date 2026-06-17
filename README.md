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
| `executeAgentDecision(decision)` | Validate and execute an agent's decision |
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

## Development

```bash
pnpm install
pnpm build
pnpm test

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
│   └── __tests__/             # Test suites
├── package.json
├── tsconfig.json
└── README.md
```

## License

MIT — build freely.

---

*Built for Sui Overflow 2026. Part of the Cubiczan ecosystem.*
