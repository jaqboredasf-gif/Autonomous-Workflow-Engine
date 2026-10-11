# The first ten conversations to arrange

**This is a queue, not a CRM.** Ten rows, four columns that matter, and it stops being useful the
moment it grows a pipeline stage. The purpose is to stop Jack re-deciding who to contact every
morning, not to manage a sales process that does not exist.

**No contacts are invented here.** Every row below is empty on purpose — filling one in is a fact
about a real person, and a plausible-looking name in this file would eventually be treated as one.

---

## The order to work in

1. **Warm introductions from Lippolis.** Mike, Paul and Karen know their counterparts at other
   shops. Ask for an *introduction* — a name and a sentence — not a referral.
2. **Supply-house counters.** Graybar, Rexel, City Electric. Counter staff know which shops are
   organised and which are chaos, and the counter conversation is itself discovery.
3. **Trade association chapters.** IBEW/NECA, ACCA, PHCC. One evening, several conversations.
4. **Cold outreach — last.** Operations or office manager, never the owner; the owner forwards it
   to them anyway and the office manager is the person who feels the pain.

**Aim for a mix:** at least three electrical, at least one not electrical, all 10–60 employees.

---

## The queue

| # | Organization | Trade | Size | How you reach them | Who to ask for | Why them | Status | Next action |
|---|---|---|---|---|---|---|---|---|
| 1 | | | | | | | NOT_CONTACTED | |
| 2 | | | | | | | NOT_CONTACTED | |
| 3 | | | | | | | NOT_CONTACTED | |
| 4 | | | | | | | NOT_CONTACTED | |
| 5 | | | | | | | NOT_CONTACTED | |
| 6 | | | | | | | NOT_CONTACTED | |
| 7 | | | | | | | NOT_CONTACTED | |
| 8 | | | | | | | NOT_CONTACTED | |
| 9 | | | | | | | NOT_CONTACTED | |
| 10 | | | | | | | NOT_CONTACTED | |

**Status** is one of: `NOT_CONTACTED` · `ASKED` · `SCHEDULED` · `INTERVIEWED` · `DECLINED` · `NO_REPLY`

`DECLINED` and `NO_REPLY` stay in the table. A queue that only remembers the people who said yes
tells you the response rate was 100%.

**"How you reach them"** is the introduction path, and it is the column that predicts a reply. *"Mike
knows their foreman"* is a different proposition from *"found them on Google"*, and after ten rows
the difference in reply rate is the most useful thing this table will teach you.

---

## When a conversation happens

Record it as an interview — `docs/discovery/FIRST_FIVE_INTERVIEWS.md` has the shape — and change
the status here. Then:

```bash
npm run discovery
```

**Do not record a conversation that did not happen**, and do not record a hallway chat as an
interview. `npm run discovery` counts organizations, and an organization added here on the strength
of a friendly remark is the exact way a market gets imagined into existence.
