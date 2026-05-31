# DeepBook Trading Agent ⚡

> **AI-powered, autonomous trading on DeepBook (Sui's on-chain orderbook).**
> Reusable TypeScript library for market making, arbitrage, hedging, and liquidity strategies.

[![Sui](https://img.shields.io/badge/Sui-1.73.0-4da2ff?logo=sui)](https://sui.io)
[![DeepBook](https://img.shields.io/badge/DeepBook-v3-6b46c1)](https://docs.sui.io/deepbook)
[![License](https://img.shields.io/badge/License-MIT-blue)](LICENSE)

---

## 🏗️ Architecture

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

## ✨ Features

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

## 🚀 Quickstart

### Install

```bash
npm install @mysten/sui.js
# or
pnpm add @mysten/sui.js
```

### Basic Usage

```typescript
import { DeepBookClient } from './deepbook-client';
import { SuiClient, getFullnodeUrl } from '@mysten/sui.js/client';
import { Ed25519Keypair } from '@mysten/sui.js/keypairs/ed25519';

// Connect to Sui
const suiClient = new SuiClient({ url: getFullnodeUrl('testnet') });
const keypair = Ed25519Keypair.fromSecretKey('...');

// Create DeepBook client
const db = new DeepBookClient(suiClient, keypair);

// Get orderbook
const orderbook = await db.getOrderbook('pool_yes_no_001');
console.log(`Bids: ${orderbook.bids.length}, Asks: ${orderbook.asks.length}`);

// Place a bid
const orderId = await db.placeOrder({
  poolId: 'pool_yes_no_001',
  side: 'bid',
  price: 0.45,
  quantity: 1000
});

// Run a market making strategy
import { MarketMakingStrategy } from './strategies';

const strategy = new MarketMakingStrategy({
  suiClient,
  keypair,
  poolId: 'pool_yes_no_001',
  spreadPercent: 2,
  orderSize: 500,
  refreshInterval: 30000 // 30 seconds
});
await strategy.start();
```

### With AI Agent Integration

```typescript
import { AgentTradingSession } from './agent-integration';
import { WalrusClient } from './walrus-client';

const session = new AgentTradingSession({
  suiClient,
  keypair,
  strategy: 'arbitrage',
  constraints: { maxPosition: 10000, maxSlippage: 0.5 }
});

// Agent deliberates and decides to trade
const decision = await session.deliberate({
  marketData: orderbook,
  analysis: {
    sentiment: 'bullish',
    confidence: 0.78,
    reasoning: 'Prediction odds diverging from fundamentals...'
  }
});

// Execute agent decision atomically
const result = await session.executeAgentDecision(decision);

// Get performance report
const report = await session.getAgentReport();
console.log(`Win Rate: ${report.winRate}%`);
console.log(`Total P&L: ${report.totalPnL} SUI`);
```

## 📚 API Reference

### `DeepBookClient`

| Method | Description |
| ------ | ----------- |
| `createPool(config)` | Create a new outcome token pool |
| `placeOrder(params)` | Place a limit order |
| `cancelOrder(orderId)` | Cancel an existing order |
| `getOrderbook(poolId)` | Get orderbook snapshot |
| `getDepth(poolId, levels)` | Get market depth |
| `swapExactInput(params)` | Execute a market swap |

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
| `deliberate(context)` | AI agent analyzes market and decides |
| `executeAgentDecision(decision)` | Execute agent's decision atomically |
| `getAgentReport(sessionId)` | Get agent trading performance report |
| `getPositionSummary()` | Get current position snapshot |

## 🎯 Use Cases

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

## 🛠️ Development

```bash
pnpm install
pnpm build
pnpm test

# Run demo
pnpm tsx src/demo.ts
```

## 📦 Project Structure

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

## 📄 License

MIT — build freely.

---

*Built for Sui Overflow 2026. Part of the Cubiczan ecosystem.*
