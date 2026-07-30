// Validation primitives and the params rule matcher for Module 3.
// Everything here throws rather than coercing: a malformed or missing params
// entry must fail loudly, never silently downgrade a flag.
import { isSeverity, type Severity } from "./types.ts";

// ---------------------------------------------------------------- primitives

export function asRecord(v: unknown, path: string): Record<string, unknown> {
  if (v === null || typeof v !== "object" || Array.isArray(v)) {
    throw new Error(`usconnect params: ${path} must be an object`);
  }
  return v as Record<string, unknown>;
}

export function asArray(v: unknown, path: string): unknown[] {
  if (!Array.isArray(v)) throw new Error(`usconnect params: ${path} must be an array`);
  return v;
}

export function asString(v: unknown, path: string): string {
  if (typeof v !== "string" || v.length === 0)
    throw new Error(`usconnect params: ${path} must be a non-empty string`);
  return v;
}

export function asNumber(v: unknown, path: string): number {
  if (typeof v !== "number" || !Number.isFinite(v))
    throw new Error(`usconnect params: ${path} must be a finite number`);
  return v;
}

export function asStringArray(v: unknown, path: string): string[] {
  return asArray(v, path).map((x, i) => asString(x, `${path}[${i}]`));
}

export function asSeverity(v: unknown, path: string): Severity {
  if (!isSeverity(v))
    throw new Error(`usconnect params: ${path} is not a known severity (${String(v)})`);
  return v;
}

/** Walk a dotted path, throwing with the full path on the first missing hop. */
export function pick(doc: unknown, dotted: string, label: string): unknown {
  let node: unknown = doc;
  const parts = dotted.split(".");
  for (let i = 0; i < parts.length; i++) {
    const key = parts[i] as string;
    const rec = asRecord(node, `${label}.${parts.slice(0, i).join(".")}`);
    if (!Object.hasOwn(rec, key))
      throw new Error(`usconnect params: ${label} is missing ${dotted}`);
    node = rec[key];
  }
  return node;
}

/** A sourced parameter entry: `{ value, source, status }`. */
export function entry(
  doc: unknown,
  dotted: string,
  label: string
): { value: unknown; source: string } {
  const rec = asRecord(pick(doc, dotted, label), `${label}.${dotted}`);
  return { value: rec["value"], source: asString(rec["source"], `${label}.${dotted}.source`) };
}

// -------------------------------------------------------------- rule matcher

/** The facts a `when` clause may be evaluated against. */
export interface RuleSubject {
  type: string;
  domicile: string | null;
  wrapper: string;
  metadata_confirmed: boolean;
  us_registered: boolean;
  hmrc_reporting_fund: boolean;
}

type BooleanKey = "metadata_confirmed" | "us_registered" | "hmrc_reporting_fund";

/**
 * Evaluate one params `when` clause. Every supported key is enumerated here;
 * an unrecognised key throws, so a rule can never silently fail to bite.
 *
 * Conservative readings baked in:
 *  - a boolean key is matched against `field === true`, so a *missing*
 *    `metadata_confirmed` is unconfirmed (PHASE_REVIEW_2 S7);
 *  - `domicile_not` does not match an unknown domicile — such an instrument
 *    falls through to the cascade's terminal rule instead.
 */
export function matchWhen(
  when: Record<string, unknown>,
  subject: RuleSubject,
  ruleId: string
): boolean {
  for (const [key, expected] of Object.entries(when)) {
    switch (key) {
      case "metadata_confirmed":
      case "us_registered":
      case "hmrc_reporting_fund": {
        const want = expected === true;
        if (subject[key as BooleanKey] !== want) return false;
        break;
      }
      case "type_in":
        if (!asStringArray(expected, `${ruleId}.type_in`).includes(subject.type)) return false;
        break;
      case "type_not_in":
        if (asStringArray(expected, `${ruleId}.type_not_in`).includes(subject.type)) return false;
        break;
      case "wrapper_in":
        if (!asStringArray(expected, `${ruleId}.wrapper_in`).includes(subject.wrapper))
          return false;
        break;
      case "domicile_in":
        if (subject.domicile === null) return false;
        if (!asStringArray(expected, `${ruleId}.domicile_in`).includes(subject.domicile))
          return false;
        break;
      case "domicile_not":
        if (subject.domicile === null) return false;
        if (asStringArray(expected, `${ruleId}.domicile_not`).includes(subject.domicile))
          return false;
        break;
      case "domicile_present":
        if ((subject.domicile !== null) !== (expected === true)) return false;
        break;
      default:
        throw new Error(`usconnect params: rule ${ruleId} uses unsupported condition "${key}"`);
    }
  }
  return true;
}
