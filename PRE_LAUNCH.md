# PRE_LAUNCH checklist — prerequisites before ANY third-party client data

v0 handles synthetic/own data only (SPEC §9). Every item below must be complete
and signed off before a single real third-party document is ingested.

- [ ] ICO registration (data protection fee) in place
- [ ] DPIA completed for the ingestion + LLM-extraction pipeline
- [ ] Data retention & deletion policy written and implemented
- [ ] Regulatory-perimeter review: confirm outputs stay on the
      information/analysis side of the advice boundary (FSMA/RAO Art. 53),
      with sign-off recorded
- [ ] Terms of use + privacy notice drafted
- [ ] Anthropic API data-handling terms reviewed (retention, training opt-out)
      and recorded
- [ ] Encryption-at-rest for `data/` directory confirmed (FileVault or
      equivalent) and documented
- [ ] Incident response note: what happens on suspected leak of vault or ledger
