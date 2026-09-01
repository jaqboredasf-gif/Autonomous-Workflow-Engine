# Interview records

One file per conversation. Three ways in, and the first is the one to use after an actual phone
call:

```bash
npm run evidence -- --new interview i014                       # a field sheet
npm run evidence -- --import programs/discovery/interviews/i014.md
```

or `.json` with the record's fields, or `.mjs` exporting `interview({...})` (see `../README.md`)
where a comment is worth having.

`scripts/iic-readiness.mjs` reads every file here and the readiness bands move on their own.

**Empty today.** That is why `customer_discovery` scores 0 and why it is the recommended next
action — which is the scorecard working, not the scorecard complaining.

Two rules worth repeating from `../README.md`:

- **`organization` is what gets counted, not the interview.** Three people at one company are one
  organization, and `repeatedPatterns()` will return nothing for them.
- **`internal: true`** for anybody inside the deploying organization. Those conversations are
  valuable and they are not external validation.
