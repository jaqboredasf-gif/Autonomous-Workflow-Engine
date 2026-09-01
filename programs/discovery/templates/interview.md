# Interview — one conversation, twenty minutes
#
# ASK ABOUT THEIR TUESDAY, NOT ABOUT AWE. The twelve questions in order are in
# PROTOCOL in programs/discovery/interview.mjs; the order matters more than the
# wording, and the money question comes last because it changes every answer
# before it.
#
# EVERY INTERPRETED FIELD NEEDS AN ATTRIBUTION. `pain-said` is required:
#   STATED           they said it, in substance
#   FOUNDER_OBSERVED you watched it happen
#   FOUNDER_INFERRED you concluded it
# Getting this wrong is the one mistake that cannot be repaired later: six weeks
# on, nobody can tell your conclusion from their testimony.

kind: interview
id: i001
at: 2026-09-XX
organization:              # REQUIRED. Counting is by ORGANIZATION, never by interview.
organization-type:         # "electrical contractor, ~30 staff"
organization-size:
role:                      # who you spoke to
internal: no               # yes ONLY for somebody inside the deploying organization
workflow:                  # "buying material for a job"

pain:
pain-said: STATED
pain-quote:                # their exact words, if you have them

frequency:
frequency-said:
human-time-stated:
human-time-stated-said:
economic-consequence:
economic-consequence-said:
existing-workaround:
existing-workaround-said:
satisfaction-with-workaround:
satisfaction-with-workaround-said:
urgency:
urgency-said:

current-tools:             # comma-separated
failure-modes:             # comma-separated
willingness-to-change:     # ACTIVELY_LOOKING | OPEN_IF_PROVEN | CONTENT_WITH_WORKAROUND | WILL_NOT_CHANGE | NOT_ASKED
willingness-to-pay:        # WOULD_PAY_STATED_AMOUNT | WOULD_PAY_UNSPECIFIED | WOULD_NOT_PAY | NOT_ASKED | UNCLEAR
stated-amount:
capability-fit:
pattern-tags:              # REQUIRED, snake_case, comma-separated. An untagged interview cannot show a pattern.
follow-up:
design-partner-interest: no
notes:

# --- WHAT THEY USE INSTEAD -------------------------------------------------
# One block per alternative. Copy the block as many times as you need.
# The last two fields are the ones that matter: a business that has lived with a
# problem for nine years, knowing the fix, is telling you something about the
# problem.

--- alternative
kind:                      # nothing | memory | paper | text_message | phone_call | email | spreadsheet |
                           # accounting_software | erp | construction_management_software | custom_software |
                           # admin_staff | rpa | general_purpose_ai | other
what:                      # required if kind is "other"
why-used:
what-works:
what-fails:
switching-cost:            # NONE | LOW | MEDIUM | HIGH | BLOCKING | NOT_ASKED
why-not-fixed:
said: STATED
quote:

# --- WHAT A SALE WOULD BE --------------------------------------------------
# Not a price. Who signs, who uses it, and what they think they would be buying.
# Leave every line blank if the conversation did not get here — a plausible
# guess in these fields is a persona wearing evidence's clothes.

--- commercial
buyer:                     # OWNER | OPERATIONS | OFFICE_MANAGER | FIELD | FINANCE | IT | EXTERNAL_BOOKKEEPER | UNKNOWN
user:
budget-owner:
problem-purchased:         # what they think they would be paying to make go away
deployment-unit:           # company | company_workflow | site | seat | usage | project | service | unknown
current-cost-of-problem:   # what it costs them today, in their words
wants-service:             # yes if they want the work done for them, not software
said: STATED
quote:
