// ULID generation at the CLI boundary. The engine and ingest modules never
// read the clock (SPEC §2, §6); the timestamp arrives here and nowhere else.
//
// The suffix is a counter seeded above every id already in the ledger rather
// than randomness: ULIDs here need uniqueness, not unpredictability, and a
// deterministic sequence makes a run reproducible for audit.
import type { IdFactory, Ledger } from "../ingest/types.ts";

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function encodeTime(ms: number, length: number): string {
  let remaining = ms;
  const out: string[] = new Array(length);
  for (let i = length - 1; i >= 0; i--) {
    out[i] = CROCKFORD[remaining % 32]!;
    remaining = Math.floor(remaining / 32);
  }
  return out.join("");
}

function collectIds(ledger: Ledger): Set<string> {
  const ids = new Set<string>([ledger.household.id]);
  for (const person of ledger.household.persons) ids.add(person.id);
  for (const account of ledger.accounts) ids.add(account.id);
  for (const instrument of ledger.instruments) ids.add(instrument.id);
  for (const document of ledger.documents) ids.add(document.id);
  for (const acceptance of ledger.acceptances) ids.add(acceptance.id);
  return ids;
}

/**
 * ULID factory seeded from a ledger, so ids never collide with existing ones.
 *
 * `alsoSeen` matters more than it looks: parse runs live on disk before
 * anything they contain reaches the ledger, so between ingesting and accepting
 * a document the ledger cannot tell you which ids are taken. Without it, two
 * ingests in the same millisecond against an unchanged ledger produce the same
 * run id and the second silently overwrites the first.
 */
export function ledgerIds(
  ledger: Ledger | null,
  isoTimestamp: string,
  alsoSeen: Iterable<string> = []
): IdFactory {
  const ms = Date.parse(isoTimestamp);
  if (Number.isNaN(ms)) throw new Error(`ledgerIds: invalid timestamp ${isoTimestamp}`);
  const timePart = encodeTime(ms, 10);
  const seen = ledger ? collectIds(ledger) : new Set<string>();
  for (const id of alsoSeen) seen.add(id);
  let counter = seen.size;
  return () => {
    let candidate: string;
    do {
      candidate = timePart + encodeTime(++counter, 16);
    } while (seen.has(candidate));
    seen.add(candidate);
    return candidate;
  };
}
