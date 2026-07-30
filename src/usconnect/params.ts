// Typed, validating readers over the /params documents Module 3 consumes.
// Nothing here invents a value: if a rule, severity, threshold or explanation
// is missing from params the module throws rather than guessing.
import { isSeverity, type Severity } from "./types.ts";

// ---------------------------------------------------------------- primitives

export function asRecord(v: unknown, path: string): Record<string, unknown> {
  if (v === null || typeof v !== "object" || Array.isArray(v)) {
    throw new Error(`usconnect params: ${path} must be an object`);
  }
  return v as Record<string, unknown>;
}

function asArray(v: unknown, path: string): unknown[] {
  if (!Array.isArray(v)) throw new Error(`usconnect params: ${path} must be an array`);
  return v;
}

function asString(v: unknown, path: string): string {
  if (typeof v !== "string" || v.length === 0) throw new Error(`usconnect params: ${path} must be a non-empty string`);
  return v;
}

function asNumber(v: unknown, path: string): number {
  if (typeof v !== "number" || !Number.isFinite(v)) throw new Error(`usconnect params: ${path} must be a finite number`);
  return v;
}

function asStringArray(v: unknown, path: string): string[] {
  return asArray(v, path).map((x, i) => asString(x, `${path}[${i}]`));
}

function asSeverity(v: unknown, path: string): Severity {
  if (!isSeverity(v)) throw new Error(`usconnect params: ${path} is not a known severity (${String(v)})`);
  return v;
}

/** Walk a dotted path, throwing with the full path on the first missing hop. */
export function pick(doc: unknown, dotted: string, label: string): unknown {
  let node: unknown = doc;
  const parts = dotted.split(".");
  for (let i = 0; i < parts.length; i++) {
    const key = parts[i] as string;
    const rec = asRecord(node, `${label}.${parts.slice(0, i).join(".")}`);
    if (!Object.hasOwn(rec, key)) throw new Error(`usconnect params: ${label} is missing ${dotted}`);
    node = rec[key];
  }
  return node;
}

/** A sourced parameter entry: `{ value, source, status }`. */
function entry(doc: unknown, dotted: string, label: string): { value: unknown; source: string } {
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
export function matchWhen(when: Record<string, unknown>, subject: RuleSubject, ruleId: string): boolean {
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
        if (!asStringArray(expected, `${ruleId}.wrapper_in`).includes(subject.wrapper)) return false;
        break;
      case "domicile_in":
        if (subject.domicile === null) return false;
        if (!asStringArray(expected, `${ruleId}.domicile_in`).includes(subject.domicile)) return false;
        break;
      case "domicile_not":
        if (subject.domicile === null) return false;
        if (asStringArray(expected, `${ruleId}.domicile_not`).includes(subject.domicile)) return false;
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

// ------------------------------------------------------------- pfic-rules.json

export interface CascadeRule {
  id: string;
  when: Record<string, unknown>;
  outcome: "pfic" | "not_pfic" | "needs_classification";
  severity: Severity;
  explanation: string;
  filingImplication: string | null;
  sources: string[];
}

export interface MitigationRule {
  wrappers: string[];
  severity: Severity;
  explanation: string;
  sources: string[];
}

export interface SitusRule {
  id: string;
  when: Record<string, unknown>;
  assetClass: string | null;
  explanation: string;
}

export interface SitusAssetClass {
  situs: "us" | "non_us";
  usParamsRef: string | null;
  sources: string[];
}

export interface Band {
  band: string;
  upTo: number | null;
}

export interface SharedRules {
  cascade: CascadeRule[];
  mitigation: MitigationRule[];
  reporting: {
    filingStatusBasis: string;
    filingStatusSource: string;
    abovePosition: { text: string; source: string };
    belowPosition: { text: string; source: string };
  };
  investableWealthExcludedTypes: string[];
  situs: {
    label: string;
    attribution: string;
    attributionNote: string;
    treatyCredit: { note: string; source: string };
    assetClasses: Record<string, SitusAssetClass>;
    rules: SitusRule[];
    longTermResidentFlags: string[];
    longTermResidentSource: string;
    ukWorldwideNote: { text: string; source: string };
    ukSitusNote: { text: string; source: string };
    usWorldwideNote: { text: string; source: string };
    usSitusOnlyNote: { text: string; source: string };
  };
  currencyOfLife: {
    method: string;
    lookThrough: boolean;
    lookThroughNote: string;
    bands: Band[];
  };
}

function readCascade(doc: unknown): CascadeRule[] {
  const rules = asArray(pick(doc, "cascade.rules", "pfic-rules"), "pfic-rules.cascade.rules");
  return rules.map((raw, i) => {
    const r = asRecord(raw, `pfic-rules.cascade.rules[${i}]`);
    const id = asString(r["id"], `pfic-rules.cascade.rules[${i}].id`);
    const outcome = asString(r["outcome"], `${id}.outcome`);
    if (outcome !== "pfic" && outcome !== "not_pfic" && outcome !== "needs_classification") {
      throw new Error(`usconnect params: rule ${id} has unknown outcome "${outcome}"`);
    }
    const filing = r["filing_implication"];
    return {
      id,
      when: asRecord(r["when"], `${id}.when`),
      outcome,
      severity: asSeverity(r["severity"], `${id}.severity`),
      explanation: asString(r["explanation"], `${id}.explanation`),
      filingImplication: filing === undefined ? null : asString(filing, `${id}.filing_implication`),
      sources: asStringArray(r["sources"], `${id}.sources`),
    };
  });
}

function readMitigation(doc: unknown): MitigationRule[] {
  const rules = asArray(pick(doc, "wrapper_mitigation.rules", "pfic-rules"), "pfic-rules.wrapper_mitigation.rules");
  return rules.map((raw, i) => {
    const r = asRecord(raw, `pfic-rules.wrapper_mitigation.rules[${i}]`);
    const label = `pfic-rules.wrapper_mitigation.rules[${i}]`;
    return {
      wrappers: asStringArray(r["wrappers"], `${label}.wrappers`),
      severity: asSeverity(r["severity"], `${label}.severity`),
      explanation: asString(r["explanation"], `${label}.explanation`),
      sources: asStringArray(r["sources"], `${label}.sources`),
    };
  });
}

function readSitusRules(doc: unknown): SitusRule[] {
  const rules = asArray(pick(doc, "situs.rules", "pfic-rules"), "pfic-rules.situs.rules");
  return rules.map((raw, i) => {
    const r = asRecord(raw, `pfic-rules.situs.rules[${i}]`);
    const id = asString(r["id"], `pfic-rules.situs.rules[${i}].id`);
    const cls = r["asset_class"];
    return {
      id,
      when: asRecord(r["when"], `situs.${id}.when`),
      assetClass: cls === null ? null : asString(cls, `situs.${id}.asset_class`),
      explanation: asString(r["explanation"], `situs.${id}.explanation`),
    };
  });
}

function readSitusAssetClasses(doc: unknown): Record<string, SitusAssetClass> {
  const raw = asRecord(pick(doc, "situs.asset_classes", "pfic-rules"), "pfic-rules.situs.asset_classes");
  const out: Record<string, SitusAssetClass> = {};
  for (const [name, value] of Object.entries(raw)) {
    if (name === "comment") continue;
    const cell = asRecord(value, `situs.asset_classes.${name}`);
    const situs = asString(cell["situs"], `situs.asset_classes.${name}.situs`);
    if (situs !== "us" && situs !== "non_us") {
      throw new Error(`usconnect params: situs.asset_classes.${name}.situs must be "us" or "non_us"`);
    }
    const ref = cell["us_params_ref"];
    out[name] = {
      situs,
      usParamsRef: ref === undefined ? null : asString(ref, `situs.asset_classes.${name}.us_params_ref`),
      sources: asStringArray(cell["sources"], `situs.asset_classes.${name}.sources`),
    };
  }
  return out;
}

function readBands(doc: unknown): Band[] {
  const raw = asArray(entry(doc, "currency_of_life.bands", "pfic-rules").value, "currency_of_life.bands");
  return raw.map((b, i) => {
    const rec = asRecord(b, `currency_of_life.bands[${i}]`);
    const upTo = rec["up_to"];
    return {
      band: asString(rec["band"], `currency_of_life.bands[${i}].band`),
      upTo: upTo === null ? null : asNumber(upTo, `currency_of_life.bands[${i}].up_to`),
    };
  });
}

export function readSharedRules(doc: unknown): SharedRules {
  const label = "pfic-rules";
  const filingStatus = entry(doc, "reporting.filing_status_assumption", label);
  const above = entry(doc, "reporting.positions.above_de_minimis", label);
  const below = entry(doc, "reporting.positions.below_de_minimis", label);
  const excluded = entry(doc, "summary.investable_wealth_excluded_types", label);
  const situsLabel = entry(doc, "situs.label", label);
  const attribution = entry(doc, "situs.attribution", label);
  const treaty = entry(doc, "situs.treaty_credit", label);
  const ltrFlags = entry(doc, "situs.uk_iht_scope.long_term_resident_flags", label);
  const ukWorldwide = entry(doc, "situs.uk_iht_scope.worldwide_note", label);
  const ukSitus = entry(doc, "situs.uk_iht_scope.uk_situs_note", label);
  const usWorldwide = entry(doc, "situs.us_estate_scope.worldwide_note", label);
  const usSitusOnly = entry(doc, "situs.us_estate_scope.us_situs_only_note", label);
  const method = entry(doc, "currency_of_life.method", label);
  const lookThrough = entry(doc, "currency_of_life.look_through", label);

  return {
    cascade: readCascade(doc),
    mitigation: readMitigation(doc),
    reporting: {
      filingStatusBasis: asString(filingStatus.value, `${label}.reporting.filing_status_assumption.value`),
      filingStatusSource: filingStatus.source,
      abovePosition: { text: asString(above.value, `${label}.reporting.positions.above_de_minimis`), source: above.source },
      belowPosition: { text: asString(below.value, `${label}.reporting.positions.below_de_minimis`), source: below.source },
    },
    investableWealthExcludedTypes: asStringArray(excluded.value, `${label}.summary.investable_wealth_excluded_types`),
    situs: {
      label: asString(situsLabel.value, `${label}.situs.label`),
      attribution: asString(attribution.value, `${label}.situs.attribution`),
      attributionNote: attribution.source,
      treatyCredit: { note: asString(treaty.value, `${label}.situs.treaty_credit`), source: treaty.source },
      assetClasses: readSitusAssetClasses(doc),
      rules: readSitusRules(doc),
      longTermResidentFlags: asStringArray(ltrFlags.value, `${label}.situs.uk_iht_scope.long_term_resident_flags`),
      longTermResidentSource: ltrFlags.source,
      ukWorldwideNote: { text: asString(ukWorldwide.value, "uk worldwide note"), source: ukWorldwide.source },
      ukSitusNote: { text: asString(ukSitus.value, "uk situs note"), source: ukSitus.source },
      usWorldwideNote: { text: asString(usWorldwide.value, "us worldwide note"), source: usWorldwide.source },
      usSitusOnlyNote: { text: asString(usSitusOnly.value, "us situs-only note"), source: usSitusOnly.source },
    },
    currencyOfLife: {
      method: asString(method.value, `${label}.currency_of_life.method`),
      lookThrough: lookThrough.value === true,
      lookThroughNote: lookThrough.source,
      bands: readBands(doc),
    },
  };
}

// ---------------------------------------------------------------- us / uk

export interface UsParams {
  currency: string;
  pficForm: string;
  deMinimis: Record<string, number>;
  deMinimisSource: string;
  estateExemption: number;
  estateExemptionSource: string;
  nraExemption: number;
  nraExemptionSource: string;
  situsClassLists: Record<string, string[]>;
}

export function readUsParams(doc: unknown): UsParams {
  const label = "us/2026";
  const form = entry(doc, "params.pfic.form", label);
  const deMinimis = entry(doc, "params.pfic.de_minimis_reporting_exception", label);
  const estate = entry(doc, "params.estate_gift.estate_exemption", label);
  const nra = entry(doc, "params.estate_gift.nonresident_alien_exemption_equivalent", label);
  const usSitus = entry(doc, "params.situs.us_situs_asset_classes", label);
  const nonUsSitus = entry(doc, "params.situs.non_us_situs_asset_classes", label);

  const deMinimisRec = asRecord(deMinimis.value, `${label}.pfic.de_minimis_reporting_exception.value`);
  const thresholds: Record<string, number> = {};
  for (const [k, v] of Object.entries(deMinimisRec)) thresholds[k] = asNumber(v, `${label}.de_minimis.${k}`);

  return {
    currency: asString(pick(doc, "currency", label), `${label}.currency`),
    pficForm: asString(form.value, `${label}.pfic.form.value`),
    deMinimis: thresholds,
    deMinimisSource: deMinimis.source,
    estateExemption: asNumber(estate.value, `${label}.estate_gift.estate_exemption.value`),
    estateExemptionSource: estate.source,
    nraExemption: asNumber(nra.value, `${label}.estate_gift.nonresident_alien_exemption_equivalent.value`),
    nraExemptionSource: nra.source,
    situsClassLists: {
      "situs.us_situs_asset_classes": asStringArray(usSitus.value, `${label}.situs.us_situs_asset_classes`),
      "situs.non_us_situs_asset_classes": asStringArray(nonUsSitus.value, `${label}.situs.non_us_situs_asset_classes`),
    },
  };
}

export interface UkParams {
  longTermResidenceSource: string;
  longTermResidenceRule: { residentYearsRequired: number; lookbackYears: number };
}

export function readUkParams(doc: unknown): UkParams {
  const label = "uk/2026-27";
  const ltr = entry(doc, "params.iht.long_term_residence_rule", label);
  const rule = asRecord(ltr.value, `${label}.iht.long_term_residence_rule.value`);
  return {
    longTermResidenceSource: ltr.source,
    longTermResidenceRule: {
      residentYearsRequired: asNumber(rule["resident_years_required"], `${label}.ltr.resident_years_required`),
      lookbackYears: asNumber(rule["lookback_years"], `${label}.ltr.lookback_years`),
    },
  };
}

// ----------------------------------------------------------- wrapper matrix

export interface WrapperMatrix {
  cell(wrapper: string, perspective: "us_person" | "uk_resident"): { severity: Severity; explanation: string; sources: string[] };
}

export function readWrapperMatrix(doc: unknown): WrapperMatrix {
  const matrix = asRecord(pick(doc, "matrix", "wrapper-matrix"), "wrapper-matrix.matrix");
  return {
    cell(wrapper, perspective) {
      const row = matrix[wrapper];
      if (row === undefined) throw new Error(`usconnect params: wrapper-matrix has no row for wrapper "${wrapper}"`);
      const cell = asRecord(asRecord(row, `matrix.${wrapper}`)[perspective], `matrix.${wrapper}.${perspective}`);
      return {
        severity: asSeverity(cell["severity"], `matrix.${wrapper}.${perspective}.severity`),
        explanation: asString(cell["explanation"], `matrix.${wrapper}.${perspective}.explanation`),
        sources: asStringArray(cell["sources"], `matrix.${wrapper}.${perspective}.sources`),
      };
    },
  };
}

/** Assert every situs class that claims a params/us list actually appears in it. */
export function assertSitusClassIntegrity(classes: Record<string, SitusAssetClass>, us: UsParams): void {
  for (const [name, cls] of Object.entries(classes)) {
    if (cls.usParamsRef === null) continue;
    const list = us.situsClassLists[cls.usParamsRef];
    if (list === undefined) {
      throw new Error(`usconnect params: situs class ${name} references unknown us list ${cls.usParamsRef}`);
    }
    if (!list.includes(name)) {
      throw new Error(`usconnect params: situs class ${name} is not in params/us ${cls.usParamsRef}`);
    }
  }
}
