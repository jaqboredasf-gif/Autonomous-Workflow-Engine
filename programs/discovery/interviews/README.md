# Interview records

One file per conversation. `.mjs` exporting `interview({...})` (see `../README.md`), or `.json`
with the same fields.

`scripts/iic-readiness.mjs` reads every file here and the readiness bands move on their own.

**Empty today.** That is why `customer_discovery` scores 0 and why it is the recommended next
action — which is the scorecard working, not the scorecard complaining.

Two rules worth repeating from `../README.md`:

- **`organization` is what gets counted, not the interview.** Three people at one company are one
  organization, and `repeatedPatterns()` will return nothing for them.
- **`internal: true`** for anybody inside the deploying organization. Those conversations are
  valuable and they are not external validation.
