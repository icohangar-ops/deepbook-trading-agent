// ============================================================
// DeepBook Trading Agent — Tool-Approval Receipts for Trade Execution
//
// Port of the canonical scheme in cubiczan-chp-mcp `src/receipt.ts`
// (row 22 of the propagation matrix: "an allowlist is not
// authorization"; ported via the cognitrader-bsc merged
// implementation, including its fail-closed receipt key). A CHP
// gate verdict — even LOCKED — is an allowlist answer.
// Authorization binds the approving decision to:
//   actor + tool + resource + args_hash + policy_version
//   + risk + expiry + nonce
// authenticated with HMAC-SHA256 over the canonical JSON form
// (src/chp/canonical.ts). The executor refuses to move capital
// without a valid, unexpired, unreplayed receipt that hashes the
// exact trade arguments.
//
// Fail-closed: missing, wildcard, or unparseable fields are
// ambiguous and never produce a usable receipt.
// ============================================================

import { createHash, createHmac, randomUUID, timingSafeEqual } from 'crypto';
import { canonicalJson } from './canonical';
import type { ReplayStore } from './replay';
import type { TradingAction, TradingDecision } from '../types';

export const RECEIPT_KIND = 'chp.tool_approval_receipt';
export const RECEIPT_SCHEMA_VERSION = '1';

export const RECEIPT_KEY_ENV = 'DEEPBOOK_CHP_RECEIPT_KEY';

/** Receipt TTL — orders on DeepBook execute promptly; an approval window of 300s bounds reuse. */
export const RECEIPT_TTL_MS = 300_000;

export type ReceiptDecision = 'allow' | 'deny';
export type ReceiptRisk = 'low' | 'medium' | 'high' | 'critical';

export const RECEIPT_RISKS: readonly ReceiptRisk[] = ['low', 'medium', 'high', 'critical'];

/**
 * The trade arguments a receipt binds. Every field that could change
 * what executes on-chain must be covered by args_hash.
 */
export interface TradeReceiptArgs {
  action: TradingAction;
  poolId: string;
  /** The decision's action-specific parameters, exactly as executed. */
  params: Record<string, unknown>;
}

/**
 * Unsigned body. Every field is covered by {@link TradeApprovalReceipt.signature}.
 * Extra keys are rejected at parse time so they cannot silently fall out of the MAC.
 */
export interface TradeApprovalReceiptBody {
  kind: typeof RECEIPT_KIND;
  schema_version: typeof RECEIPT_SCHEMA_VERSION;
  chp_version: string;
  actor: string;
  tool: string;
  resource: string;
  args_hash: string;
  policy_version: string;
  risk: ReceiptRisk;
  issued_at: string;
  expiry: string;
  decision: ReceiptDecision;
  nonce: string;
}

export interface TradeApprovalReceipt extends TradeApprovalReceiptBody {
  /** HMAC-SHA256 hex over canonical JSON of the body (signature omitted). */
  signature: string;
}

/**
 * Resolve the receipt signing key. Fail-closed: there is no committed
 * default — an unset or blank $DEEPBOOK_CHP_RECEIPT_KEY throws, so a
 * live deployment can never sign or verify with a key that is public
 * in source.
 */
export function resolveReceiptKey(explicit?: string): string {
  const key = explicit ?? process.env[RECEIPT_KEY_ENV] ?? '';
  if (key.trim() === '') {
    throw new Error(
      `${RECEIPT_KEY_ENV} is required — execution receipts refuse to sign or verify with a default key`,
    );
  }
  return key;
}

/** SHA-256 over the canonical JSON of the trade arguments. */
export function hashTradeArgs(args: TradeReceiptArgs): string {
  return createHash('sha256').update(canonicalJson(args), 'utf8').digest('hex');
}

export function isReceiptRisk(value: unknown): value is ReceiptRisk {
  return typeof value === 'string' && (RECEIPT_RISKS as readonly string[]).includes(value);
}

const AMBIGUOUS_TOKENS = new Set(['', '*', 'any', 'all', 'unknown', 'undefined', 'null']);

/**
 * Identity / binding slots must be a concrete string. Globs and reserved
 * tokens are treated as ambiguous — deny, do not guess.
 */
export function isAmbiguousBinding(value: unknown): boolean {
  if (typeof value !== 'string') return true;
  const trimmed = value.trim();
  if (AMBIGUOUS_TOKENS.has(trimmed.toLowerCase())) return true;
  if (/[*?[\]{}]/.test(trimmed)) return true;
  return false;
}

export function parseIsoTime(value: unknown): number | undefined {
  if (typeof value !== 'string' || value.trim() === '') return undefined;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : undefined;
}

function signingPayload(body: TradeApprovalReceiptBody): TradeApprovalReceiptBody {
  return {
    kind: RECEIPT_KIND,
    schema_version: RECEIPT_SCHEMA_VERSION,
    chp_version: body.chp_version,
    actor: body.actor,
    tool: body.tool,
    resource: body.resource,
    args_hash: body.args_hash,
    policy_version: body.policy_version,
    risk: body.risk,
    issued_at: body.issued_at,
    expiry: body.expiry,
    decision: body.decision,
    nonce: body.nonce,
  };
}

export function signReceipt(body: TradeApprovalReceiptBody, key: string): string {
  const canonical = canonicalJson(signingPayload(body));
  return createHmac('sha256', key).update(canonical, 'utf8').digest('hex');
}

function safeEqualHex(a: string, b: string): boolean {
  try {
    const left = Buffer.from(a, 'hex');
    const right = Buffer.from(b, 'hex');
    if (left.length === 0 || left.length !== right.length) return false;
    return timingSafeEqual(left, right);
  } catch {
    return false;
  }
}

export function verifyReceiptSignature(receipt: TradeApprovalReceipt, key: string): boolean {
  if (typeof receipt.signature !== 'string' || receipt.signature.length !== 64) {
    return false;
  }
  const expected = signReceipt(signingPayload(receipt), key);
  return safeEqualHex(receipt.signature, expected);
}

export interface IssueTradeReceiptInput {
  /** Who authorized the trade (named confirmer, or the policy engine). */
  actor: string;
  /** Canonical target of the approval, e.g. `deepbook:swap:<poolId>`. */
  resource: string;
  args_hash: string;
  policy_version: string;
  risk: ReceiptRisk;
  decision: ReceiptDecision;
  /** Receipt TTL in ms (issued_at + ttl = expiry). */
  ttlMs: number;
  issued_at?: string;
  nonce?: string;
  chp_version?: string;
}

export function issueTradeReceipt(input: IssueTradeReceiptInput, key: string): TradeApprovalReceipt {
  const issuedAt = input.issued_at ?? new Date().toISOString();
  const body: TradeApprovalReceiptBody = signingPayload({
    kind: RECEIPT_KIND,
    schema_version: RECEIPT_SCHEMA_VERSION,
    chp_version: input.chp_version ?? RECEIPT_SCHEMA_VERSION,
    actor: input.actor,
    tool: 'deepbook_execute',
    resource: input.resource,
    args_hash: input.args_hash,
    policy_version: input.policy_version,
    risk: input.risk,
    issued_at: issuedAt,
    expiry: new Date(Date.parse(issuedAt) + input.ttlMs).toISOString(),
    decision: input.decision,
    nonce: input.nonce ?? randomUUID(),
  });
  return { ...body, signature: signReceipt(body, key) };
}

export function parseTradeReceipt(value: unknown): TradeApprovalReceipt | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  const rec = value as Record<string, unknown>;
  if (rec.kind !== RECEIPT_KIND) return undefined;
  if (rec.schema_version !== RECEIPT_SCHEMA_VERSION) return undefined;
  if (typeof rec.chp_version !== 'string' || rec.chp_version.trim() === '') return undefined;
  if (isAmbiguousBinding(rec.actor)) return undefined;
  if (isAmbiguousBinding(rec.tool)) return undefined;
  if (isAmbiguousBinding(rec.resource)) return undefined;
  if (typeof rec.args_hash !== 'string' || !/^[0-9a-f]{64}$/.test(rec.args_hash)) return undefined;
  if (isAmbiguousBinding(rec.policy_version)) return undefined;
  if (!isReceiptRisk(rec.risk)) return undefined;
  if (parseIsoTime(rec.issued_at) === undefined) return undefined;
  if (parseIsoTime(rec.expiry) === undefined) return undefined;
  if (rec.decision !== 'allow' && rec.decision !== 'deny') return undefined;
  if (typeof rec.nonce !== 'string' || rec.nonce.trim() === '') return undefined;
  if (typeof rec.signature !== 'string') return undefined;

  const allowed = new Set([
    'kind',
    'schema_version',
    'chp_version',
    'actor',
    'tool',
    'resource',
    'args_hash',
    'policy_version',
    'risk',
    'issued_at',
    'expiry',
    'decision',
    'nonce',
    'signature',
  ]);
  if (Object.keys(rec).some((key) => !allowed.has(key))) return undefined;

  return {
    kind: RECEIPT_KIND,
    schema_version: RECEIPT_SCHEMA_VERSION,
    chp_version: rec.chp_version as string,
    actor: rec.actor as string,
    tool: rec.tool as string,
    resource: rec.resource as string,
    args_hash: rec.args_hash as string,
    policy_version: rec.policy_version as string,
    risk: rec.risk,
    issued_at: rec.issued_at as string,
    expiry: rec.expiry as string,
    decision: rec.decision,
    nonce: rec.nonce as string,
    signature: rec.signature as string,
  };
}

export type ReceiptVerification =
  | { ok: true; receipt: TradeApprovalReceipt }
  | { ok: false; reason: string };

/**
 * Full execution-boundary check for a trade receipt. Pure apart from the
 * replay store: parse fail-closed, verify the MAC, enforce expiry and the
 * decision, bind the args hash and policy version, consume the nonce.
 */
export function verifyExecutionReceipt(
  receipt: unknown,
  expected: { argsHash: string; policyVersion: string; key: string },
  replay: ReplayStore,
  nowMs: number = Date.now(),
): ReceiptVerification {
  const parsed = parseTradeReceipt(receipt);
  if (!parsed) return { ok: false, reason: 'unparseable or incomplete receipt' };

  if (!verifyReceiptSignature(parsed, expected.key)) {
    return { ok: false, reason: 'receipt signature verification failed' };
  }
  if (parsed.decision !== 'allow') {
    return { ok: false, reason: `receipt decision is ${parsed.decision}` };
  }
  const expiryMs = parseIsoTime(parsed.expiry);
  if (expiryMs === undefined || nowMs >= expiryMs) {
    return { ok: false, reason: 'receipt expired' };
  }
  if (parsed.args_hash !== expected.argsHash) {
    return { ok: false, reason: 'receipt args_hash does not match the trade args' };
  }
  if (parsed.policy_version !== expected.policyVersion) {
    return { ok: false, reason: `receipt policy_version ${parsed.policy_version} != ${expected.policyVersion}` };
  }
  if (replay.seen(parsed.nonce)) {
    return { ok: false, reason: 'receipt nonce already consumed (replay)' };
  }
  replay.consume({
    nonce: parsed.nonce,
    consumedAt: new Date(nowMs).toISOString(),
    argsHash: parsed.args_hash,
    tool: parsed.tool,
    resource: parsed.resource,
  });
  return { ok: true, receipt: parsed };
}

/** The exact trade arguments a receipt binds for a DeepBook decision. */
export function tradeReceiptArgs(decision: TradingDecision): TradeReceiptArgs {
  return {
    action: decision.action,
    poolId: decision.poolId,
    params: decision.params,
  };
}
