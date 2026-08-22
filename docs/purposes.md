---
title: Purposes
description: The closed vocabulary every disclosure request must declare.
url: https://docs.afixo.io/concepts/purposes/
---

Every disclosure request declares **why** it is asking. Purposes are a closed, seeded
vocabulary — never free text — so that rules and requests refer to the same seven
names and purpose limitation is something the system can actually check.

| Purpose | Description |
|---|---|
| `social_display` | Show this person in a social or community context |
| `professional` | Represent this person in a professional or workplace context |
| `shipping` | Deliver physical goods to this person |
| `billing` | Invoice or charge this person |
| `age_verification` | Confirm this person meets an age requirement |
| `legal_kyc` | Satisfy a legal know-your-customer obligation |
| `support` | Provide customer support to this person |

The vocabulary is published, without authentication, at `GET /v1/purposes` on both
API surfaces:

```json
[
  { "name": "social_display", "description": "Show this person in a social or community context" },
  { "name": "professional", "description": "Represent this person in a professional or workplace context" }
]
```

## How a purpose travels

A requester passes it as a query parameter — `GET /v1/disclose/alice?purpose=shipping`.
It is required; a name outside the vocabulary is `400 invalid_purpose`. Carrying the
purpose in the URL makes it a self-documenting input that appears in request logs and
in the audit trail with no extra plumbing.

In a rule, `purpose` is optional: `null` means *any purpose* (a wildcard). A named
purpose adds 1 to the rule's [specificity](https://docs.afixo.io/concepts/disclosure-rules/#wildcards-and-specificity).

> **Declared, not proven**
>
> The purpose is taken at face value: the requester asserts it, and the assertion is what
> gets audited. Binding the purpose to the token (RFC 9396 authorization details) is
> listed as future work, not pretended away.
