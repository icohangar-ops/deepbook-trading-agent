/**
 * deepbook-trading-agent — Public API barrel
 *
 * Exports all public types, classes, and functions.
 */

export {
  DeepBookClient,
  DeepBookError,
  OrderNotFoundError,
  PoolNotFoundError,
  InsufficientLiquidityError,
  DEEPBOOK_PACKAGE,
  DEEPBOOK_REGISTRY,
} from './deepbook-client.js';
export type {
  DeepBookClientConfig,
} from './deepbook-client.js';

export {
  PTBTrader,
  WalrusAuditStore,
} from './ptb-trading.js';
export type {
  MarketOrderPTBParams,
  StrategyPTBParams,
  HedgePTBParams,
  WalrusStoreConfig,
} from './ptb-trading.js';

export {
  MarketMakingStrategy,
  ArbitrageStrategy,
  HedgeStrategy,
  LiquidityStrategy,
  BaseStrategy,
} from './strategies.js';
export type {
  StrategyState,
} from './strategies.js';

export {
  AgentTradingSession,
} from './agent-integration.js';
export type {
  AgentSessionOptions,
} from './agent-integration.js';

export {
  ChpGate,
} from './chp/gate.js';
export type {
  ChpAction,
  ChpState,
  ProposedAction,
  ChpDecision,
  Provenance,
  RiskPolicy,
} from './chp/gate.js';
export {
  loadPolicy,
  defaultPolicy,
  defaultPolicyPath,
  toGatePolicy,
} from './chp/policy.js';

export {
  TradeHardeningGate,
  TradeDecisionLedger,
  StaticPortfolioStateProvider,
  TradeRejection,
  applyThirdPartyValidation,
  evaluateR0Gate,
  assessFoundation,
  matchGoldenCase,
  loadGoldenCases,
  buildPayloadEnvelope,
  validatePayloadEnvelope,
  DEFI_FLOOR,
  DEFI_DOMAIN,
  GUARDRAIL_POINTS,
  BOUNDED_RESULT_POINTS,
  PARITY_POINTS,
  FULL_SCORE,
} from './chp/hardening.js';
export type {
  SessionStatus,
  R0Key,
  R0VerdictValue,
  R0Evaluation,
  R0GateInput,
  PortfolioSnapshot,
  PortfolioStateProvider,
  GoldenTradeCase,
  ParityEvidence,
  FoundationAssessment,
  ExecutionEvidence,
  HardenedTradeCase,
  HardenedTrade,
  ThirdPartyValidation,
  PayloadEnvelope,
  TradeDecisionRecord,
  TradeDecisionRecordView,
  TradeHardeningOptions,
  HardenTradeInput,
} from './chp/hardening.js';

export type {
  PoolId,
  OrderId,
  OrderSide,
  PoolConfig,
  OrderbookLevel,
  OrderbookSnapshot,
  DepthLevel,
  OrderParams,
  OrderResult,
  SwapResult,
  MarketMakingConfig,
  ArbitrageConfig,
  HedgeConfig,
  LiquidityConfig,
  TradingAction,
  TradingDecision,
  TradeResult,
  TradingSessionConfig,
  TradingReport,
  AuditEntry,
} from './types.js';
