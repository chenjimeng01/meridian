// NETWORK_AUDIT.md appender (SPEC §2.2, §9): one table row per external call.
// The extractor takes an appendAudit callback; the CLI (Phase 4) binds it to
// this file-backed implementation.
import { appendFileSync } from "node:fs";
import type { AuditEntry } from "./extract-llm.ts";

export function fileAuditAppender(auditPath: string): (entry: AuditEntry) => void {
  return (entry) => {
    appendFileSync(
      auditPath,
      `| ${entry.timestamp} | ${entry.household_id ?? "-"} | ${entry.document_ref ?? "-"} | ` +
        `${entry.endpoint} | ${entry.purpose} | ${entry.redaction_check} |\n`
    );
  };
}
