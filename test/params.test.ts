import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT, readJson, listFiles } from "./helpers.ts";

const PARAM_FILES = listFiles("params", ".json");

test("all expected params files are present", () => {
  const names = PARAM_FILES.map((f) => f.replace(/^params\//, ""));
  for (const required of ["uk/2026-27.json", "us/2026.json", "shared/fx-policy.json", "shared/wrapper-matrix.json"]) {
    assert.ok(names.includes(required), `missing params/${required}`);
  }
  assert.ok(names.filter((n) => n.startsWith("shared/benchmarks/")).length >= 5, "expected at least 5 benchmark series");
});

test("params round-trip: parse → serialize → parse is lossless and stable", () => {
  for (const f of PARAM_FILES) {
    const raw = readFileSync(join(ROOT, f), "utf8");
    const parsed = JSON.parse(raw);
    const reparsed = JSON.parse(JSON.stringify(parsed));
    assert.deepEqual(reparsed, parsed, `${f}: round-trip not lossless`);
    assert.equal(JSON.stringify(reparsed), JSON.stringify(parsed), `${f}: round-trip not stable`);
  }
});

test("every params file has a valid effective date range", () => {
  const iso = /^\d{4}-\d{2}-\d{2}$/;
  for (const f of PARAM_FILES) {
    const doc = readJson(f) as any;
    assert.ok(doc.effective?.from && doc.effective?.to, `${f}: missing effective range`);
    assert.match(doc.effective.from, iso, `${f}: effective.from not ISO`);
    assert.match(doc.effective.to, iso, `${f}: effective.to not ISO`);
    assert.ok(doc.effective.from < doc.effective.to, `${f}: effective.from >= effective.to`);
  }
});

test("UK and US files cover their tax years exactly", () => {
  const uk = readJson("params/uk/2026-27.json") as any;
  assert.equal(uk.effective.from, "2026-04-06");
  assert.equal(uk.effective.to, "2027-04-05");
  const us = readJson("params/us/2026.json") as any;
  assert.equal(us.effective.from, "2026-01-01");
  assert.equal(us.effective.to, "2026-12-31");
});

test("every parameter entry carries a source string and a valid status", () => {
  // Walk each doc; any object with a "value" key is a parameter entry.
  const walk = (node: unknown, path: string, file: string): number => {
    if (node === null || typeof node !== "object") return 0;
    let count = 0;
    if (Object.hasOwn(node as object, "value")) {
      const entry = node as { source?: unknown; status?: unknown };
      assert.ok(
        typeof entry.source === "string" && entry.source.length > 10,
        `${file} ${path}: parameter entry missing a meaningful source string`
      );
      assert.ok(
        entry.status === "published" || entry.status === "projected",
        `${file} ${path}: status must be published|projected`
      );
      return 1;
    }
    for (const [k, v] of Object.entries(node as object)) count += walk(v, `${path}.${k}`, file);
    return count;
  };
  for (const f of ["params/uk/2026-27.json", "params/us/2026.json", "params/shared/fx-policy.json"]) {
    const n = walk(readJson(f), "$", f);
    assert.ok(n >= 5, `${f}: expected at least 5 sourced parameter entries, found ${n}`);
  }
});

test("wrapper matrix covers exactly the ledger schema wrapper enum, with complete cells", () => {
  const matrixDoc = readJson("params/shared/wrapper-matrix.json") as any;
  const ledgerSchema = readJson("schema/ledger.schema.json") as any;
  const wrapperEnum: string[] = ledgerSchema.$defs.wrapper.enum;
  const matrixKeys = Object.keys(matrixDoc.matrix).sort();
  assert.deepEqual(matrixKeys, [...wrapperEnum].sort(), "matrix keys must match ledger wrapper enum exactly");

  for (const [wrapper, cells] of Object.entries<any>(matrixDoc.matrix)) {
    for (const perspective of ["us_person", "uk_resident"]) {
      const cell = cells[perspective];
      assert.ok(cell, `${wrapper}: missing ${perspective} cell`);
      assert.ok(matrixDoc.severity_levels.includes(cell.severity), `${wrapper}.${perspective}: bad severity ${cell.severity}`);
      assert.ok(typeof cell.explanation === "string" && cell.explanation.length > 20, `${wrapper}.${perspective}: explanation too short`);
      assert.ok(Array.isArray(cell.sources) && cell.sources.length > 0, `${wrapper}.${perspective}: sources[] required`);
    }
  }
});

test("ISA/SIPP/UK-bond cells encode the SPEC §7.2 severities", () => {
  const m = (readJson("params/shared/wrapper-matrix.json") as any).matrix;
  assert.equal(m.isa.us_person.severity, "WARN");
  assert.equal(m.sipp.us_person.severity, "OK");
  assert.equal(m.uk_bond_onshore.us_person.severity, "CRITICAL");
  assert.equal(m.uk_bond_offshore.us_person.severity, "CRITICAL");
});

test("benchmark series are monthly, monotonic, positive and marked synthetic", () => {
  const files = PARAM_FILES.filter((f) => f.includes("benchmarks/"));
  for (const f of files) {
    const doc = readJson(f) as any;
    assert.equal(doc.source, "synthetic_v0", `${f}: v0 benchmarks must be marked synthetic`);
    assert.equal(doc.frequency, "monthly", `${f}: frequency`);
    assert.ok(doc.series.length >= 36, `${f}: expected >= 36 monthly points`);
    for (let i = 0; i < doc.series.length; i++) {
      const pt = doc.series[i];
      assert.ok(pt.value > 0, `${f}[${i}]: non-positive value`);
      if (i > 0) assert.ok(pt.date > doc.series[i - 1].date, `${f}[${i}]: dates not strictly increasing`);
    }
  }
});
