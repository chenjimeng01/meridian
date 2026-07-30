# NETWORK AUDIT

Auto-appended log of every external network call made by Meridian tooling.
Format: `| timestamp (ISO 8601) | household | document | endpoint | purpose | redaction-check |`

Household and document are recorded so the log can answer *whose* data went
where — the question UK GDPR Art. 33 gives 72 hours to answer.

No entry may be written unless the assert-redacted check passed for the payload.

| timestamp | household | document | endpoint | purpose | redaction-check |
|---|---|---|---|---|---|
