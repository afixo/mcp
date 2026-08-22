---
title: Disclosure rules
description: Grants from (requester, purpose) to a persona, a sensitivity ceiling and an optional allow-list.
url: https://docs.afixo.io/concepts/disclosure-rules/
---

A rule is the unit of policy. It is a **grant** written by a subject:

```
(subject, requester?, purpose?)  →  persona, max_sensitivity, allow_keys?, priority
```

| Part | Meaning |
|---|---|
| `requester_id` | the client the rule applies to, or `null` for *any requester* |
| `purpose` | one of the [seven purposes](https://docs.afixo.io/concepts/purposes/), or `null` for *any purpose* |
| `persona_id` | the persona to disclose; must belong to the subject |
| `max_sensitivity` | the ceiling, `0`–`3`; fields above it are withheld |
| `allow_keys` | optional list of field keys; omitted or `null` = ceiling only, `[]` = release nothing |
| `priority` | integer tie-breaker, default `0`; higher wins at equal specificity |

Rules are validated when written: the persona must belong to the subject, a named
requester must exist, a named purpose must be in the vocabulary. An invalid rule is
never stored, so it can never fail open later.

## Wildcards and specificity

`null` in `requester_id` or `purpose` is a wildcard, so four shapes exist. A rule scores
2 for naming a requester and 1 for naming a purpose:

| Shape | Specificity |
|---|---|
| requester **and** purpose | 3 |
| requester only (any purpose) | 2 |
| purpose only (any requester) | 1 |
| neither — a global default | 0 |

The most specific matching rule wins. *Who* asks outranks *why* they say they are
asking, because identity is the harder signal to forge. Ties break on higher
`priority`, then on the newest rule; the order is deterministic.

A rule with neither requester nor purpose is a catch-all: it applies to every caller
and every purpose no more specific rule covers. The dashboard warns when you write one.

## Two narrowing mechanisms

The ceiling and the allow-list are independent, and **both always apply**:

- The **ceiling** scales without maintenance — a newly added high-sensitivity field is
  withheld automatically.
- The **allow-list** pins an exact contract, e.g. a billing integration that must only
  ever see `full_name` and `email`.

A field is released only if `sensitivity ≤ max_sensitivity` **and** (no allow-list
exists **or** the key is on it).

## Rules only grant

There is no deny rule. Adding a rule can never restrict what another rule releases;
removing one can. Combining positive and negative rules needs conflict-resolution
semantics that are hard to predict, and the failure mode of a misunderstood deny is
silent over-disclosure. With grant-only rules the worst outcome of a misunderstanding
is that too little is released — it fails safe. The price is expressiveness:
"everything except `dob`" has to be written as an allow-list.

## Worked example

Subject `alice` has personas `social` (`display_name` 0, `pronouns` 0), `work` (`name` 1,
`title` 1, `work_email` 1) and `legal` (`full_name` 1, `postal_address` 2, `dob` 3).

| Rule | Effect |
|---|---|
| any requester, `social_display` → `social`, ceiling 0 | everyone declaring a social purpose sees the social persona |
| any requester, `professional` → `work`, ceiling 1 | the work persona to anyone declaring a professional purpose |
| ShopCo, `shipping` → `legal`, ceiling 2 | ShopCo gets `full_name` and `postal_address`; `dob` is withheld |
| ShopCo, `billing` → `legal`, ceiling 1, allow `["full_name"]` | ShopCo gets exactly `full_name` |
| TalentHub, any purpose → `legal`, ceiling 1 | for `professional`, TalentHub's requester-only rule (2) beats the purpose-only rule (1): it gets `legal`, not `work` |

Everything not covered — ShopCo asking `legal_kyc`, anyone asking `age_verification` —
is denied.
