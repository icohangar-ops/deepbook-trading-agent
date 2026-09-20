// ============================================================
// DeepBook Trading Agent — canonical JSON (port of chp.canonical,
// consensus-hardening-protocol 0.1.1, via the cognitrader-bsc
// merged port). Deterministic serialization: recursively sorted
// object keys, no insignificant whitespace. Receipt signatures and
// args hashes are SHA-256/HMAC digests over this form so they are
// byte-stable across processes.
// ============================================================

export function canonicalJson(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value !== 'object') return JSON.stringify(value) as string;
  if (Array.isArray(value)) {
    return `[${value.map((v) => canonicalJson(v)).join(',')}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  const pairs = keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`);
  return `{${pairs.join(',')}}`;
}
