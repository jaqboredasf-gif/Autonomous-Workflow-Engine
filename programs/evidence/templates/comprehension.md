# Plain-language test — one person, ten minutes
#
# PROTOCOL. Say the sentence ONCE, at normal speed. Say nothing else about AWE:
# no "so basically", no company name, no example, no second version when they
# look puzzled. Then talk about something else for two minutes. Then ask:
#
#     "If a friend asked you what that thing does, what would you tell them?"
#
# Write down what they said BEFORE you score anything below. Their words are the
# evidence; the scores are only your reading of them.
#
# The verdict is COMPUTED from the four concepts. Do not write one here.

kind: comprehension
id: plt-XXX
at: 2026-09-XX
person:                    # initials are enough
background:                # what they do. "dental office manager", "roofer", "teacher"
relationship:              # STRANGER | ACQUAINTANCE | FAMILY | COLLEAGUE | INDUSTRY_INSIDER
version: spoken-v1         # which wording you used. Change this when you change the sentence.
delivery: SPOKEN           # SPOKEN | WRITTEN | SHOWN

restatement:               # THEIR words, as close to verbatim as you can manage. One line.
verbatim-echo: no          # yes if they recited the sentence back rather than restating it

# Did each idea survive? PRESENT | GARBLED | ABSENT.
# Score the MEANING, never the wording. A person who says "it does the office
# paperwork by itself, following your rules" has understood more than one who
# recites the original sentence.

concept-business-operations-work:      # they named routine business/office work
concept-execution-not-advice:          # a verb of DOING. "helps you" / "tells you" = ABSENT
concept-company-rules:                 # rules, approvals, permissions, "it can't just do anything"
concept-reduced-human-handling:        # somebody who no longer has to do something

questions:                 # what they asked, semicolon-separated. A question names a hole.
confusion:                 # what did not make sense to them
notes:
