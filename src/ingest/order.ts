// Canonical fixture ingestion order. Account tokens allocate on first sight,
// so this order is part of the byte-for-byte parse contract: A1/A2 Alderbrook,
// A3 Beacon, A4 Liberty Street, A5/A6 Harcourt (Sterling Park's MiFID
// disclosures reference the Harcourt-custodied A5 by the same raw number).
export const INGEST_ORDER = [
  "alderbrook-platform/valuation-2025-12.txt",
  "alderbrook-platform/valuation-2026-03.txt",
  "alderbrook-platform/valuation-2026-06.txt",
  "beacon-sipp-trustees/annual-2024.txt",
  "beacon-sipp-trustees/annual-2025.txt",
  "beacon-sipp-trustees/annual-2026.txt",
  "liberty-street-securities/statement-2026-04.txt",
  "liberty-street-securities/statement-2026-05.txt",
  "liberty-street-securities/statement-2026-06.txt",
  "harcourt-private-bank/consolidated-2025-12.txt",
  "harcourt-private-bank/consolidated-2026-03.txt",
  "harcourt-private-bank/consolidated-2026-06.txt",
  "sterling-park-wealth/mifid-costs-2023.txt",
  "sterling-park-wealth/mifid-costs-2024.txt",
  "sterling-park-wealth/mifid-costs-2025.txt",
];
