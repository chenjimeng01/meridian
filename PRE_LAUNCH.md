# PRE_LAUNCH checklist — prerequisites before ANY third-party client data

v0 handles synthetic/own data only (SPEC §9). Every item below must be complete
and signed off before a single real third-party document is ingested.

- [ ] ICO registration (data protection fee) in place
- [ ] DPIA completed for the ingestion + LLM-extraction pipeline
- [x] Deletion capability implemented (`meridian delete --household <id>
      --confirm`) — covers ledger, vault, documents, parse-runs including
      parked raw originals, and reports
- [ ] Data **retention** policy written (the schedule and who applies it; the
      mechanism now exists, the policy does not)
- [ ] A process for the operator's own copies of original statements, which
      erasure cannot reach
- [ ] Regulatory-perimeter review: confirm outputs stay on the
      information/analysis side of the advice boundary (FSMA/RAO Art. 53),
      with sign-off recorded
- [ ] Terms of use + privacy notice drafted
- [ ] Anthropic API data-handling terms reviewed (retention, training opt-out)
      and recorded
- [ ] Encryption-at-rest for `data/` directory confirmed (FileVault or
      equivalent) and documented
- [ ] Incident response note: what happens on suspected leak of vault or ledger
- [ ] **Controller identity and contact** completed in the published privacy
      notice (currently a placeholder) and terms of use added
- [ ] Notify PI insurers and add to the firm's system inventory before any
      output informs client advice
- [ ] US-qualified review of `params/shared/wrapper-matrix.json` before any US
      tax position is relied on — the SIPP cell in particular cites an analogy
      rather than authority
