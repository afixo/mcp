---
title: The decision algorithm
description: How (subject, requester, purpose) becomes an allow or a deny, and the invariants that always hold.
url: https://docs.afixo.io/concepts/decision-algorithm/
---

The decision is one pure function in the `afixo-engine` crate, surrounded by services
that own data. The `disclosure` service orchestrates; it owns no data of its own.

## Steps

Given *(subject, requester, purpose)*:

1. **Select candidates.** The policy service runs one indexed query that returns the
   exact matches and every applicable wildcard:

   ```sql
   where subject_id = $1
     and (requester_id = $2 or requester_id is null)
     and (purpose      = $3 or purpose      is null)
   ```

2. **Rank by specificity** — `2·[requester named] + 1·[purpose named]` — so
   requester + purpose (3) beats requester only (2) beats purpose only (1) beats a
   global default (0). Ties: higher `priority`, then the newest rule. Ranking happens
   in code, not in SQL, so the rule stays readable and property-testable.

3. **Resolve the winner's persona** from the identity service. Missing, or belonging
   to another subject: **deny**.

4. **Filter fields.** Withhold a field when `sensitivity > max_sensitivity`, or when an
   allow-list exists and the key is not on it. Both mechanisms always apply.

5. **Deny by default** when no candidate matched.

6. **Record, then answer.** `audit.Record` is awaited for both outcomes; only then is
   the response written. If the audit service is unavailable the request fails closed
   with `503 upstream_unavailable`: an unrecorded disclosure is unreachable.

## Invariants

Property-tested in the engine:

- released ⊆ persona fields
- released ∩ withheld = ∅, and released ∪ withheld = all keys of the persona
- every released field is within the ceiling, and on the allow-list if one exists
- no candidates ⇒ denied
- the winner is never beaten on specificity, nor on priority at equal specificity

## What the requester learns

An allow carries the persona label, the released fields and the **names** of the
withheld keys — never their values. That is enough to tell "filtered" from "empty
persona" without leaking data, at the cost of revealing the persona's shape; the
trade-off is deliberate.

A deny is uniform: `403 {"decision":"deny","reason":"no_matching_rule"}` whether there
was no rule, the handle is unknown or the persona was deleted. The audit log records
the real reason for the subject; the requester cannot enumerate handles.

## Failure modes, by design

| Situation | Result |
|---|---|
| No rule matches | deny |
| Rule points at a deleted persona | deny |
| Rule points at a persona of another subject | deny |
| Unknown handle | deny (and recorded as a probe) |
| Purpose not in the vocabulary | `400 invalid_purpose` |
| Audit service unavailable | `503` — fails closed |
