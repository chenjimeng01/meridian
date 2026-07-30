import type { IdFactory } from "./types.ts";

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

// Deterministic factory for tests and golden generation: valid ULID alphabet,
// strictly sequential. Distinct prefixes keep goldens self-describing.
export function sequentialIds(prefix = "01MER1D1AN"): IdFactory {
  let n = 0;
  return () => prefix + String(++n).padStart(26 - prefix.length, "0");
}

// Production ULIDs. The clock and randomness are injected — nothing in src/
// may read the system clock directly (SPEC §6); the CLI boundary supplies them.
export function ulidFactory(now: () => number, random: () => number): IdFactory {
  return () => {
    let ms = now();
    const time: string[] = new Array(10);
    for (let i = 9; i >= 0; i--) {
      time[i] = CROCKFORD[ms % 32]!;
      ms = Math.floor(ms / 32);
    }
    let rand = "";
    for (let i = 0; i < 16; i++) rand += CROCKFORD[Math.floor(random() * 32) % 32];
    return time.join("") + rand;
  };
}
