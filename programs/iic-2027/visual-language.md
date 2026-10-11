# Visual language

**No graphics yet.** This is the system that later graphics must obey, written now so that the
first time somebody opens a design tool there is already an answer to "what should this look like".

## What it should feel like

Serious. Industrial. Built by somebody who has been on a job site. **Founder-built, not
agency-built** — a deck that looks like a startup template invites the question of whether the
product is one too.

**What it must not feel like:** generic AI, science fiction, a school PowerPoint, or a
Series-A pitch from a company that does not exist yet.

The product deals with money, authority and audit trails inside a real business. The presentation
should communicate **trust and capability**, in that order.

---

## Colour

**One dark neutral, one paper neutral, one accent, and nothing else.**

| Role | Direction |
|---|---|
| Ground | A deep neutral — near-black with warmth, or a very dark slate. Not pure black; pure black on a projector loses all shadow detail and flattens screenshots. |
| Paper | An off-white with a trace of warmth, for the sections that must read as documents. |
| Accent | **One.** Drawn from the industrial world the product lives in: safety orange, or the yellow of site plant. Used for one thing per slide and never for decoration. |
| Data | Greys, with the accent reserved for the single figure that matters on that slide. |

**No purple-to-blue gradients.** Every AI product in the world used that palette in 2024 and it now
reads as a category signal — it says "this is an AI thing" at the exact moment we want it to say
"this is a system a business runs on". If a strong argument for it appears later, it must be written
down here first.

**No colour that carries meaning without a label.** A green tick and a red cross across a
competitor table is the visual form of a claim we cannot support — see `competitive-positioning.md`.

---

## Typography

- **One family, two weights.** A grotesque with real character — something with the flavour of
  industrial signage rather than a default UI font. Not Helvetica, not Inter, not the system stack.
- **A monospace for anything the system produced**: purchase order numbers, timestamps, identifiers,
  derived figures. This is a load-bearing choice, not a style one — monospace marks *machine
  output*, and the whole argument is about what the machine did.
- **Type sizes are large.** A slide is read from twenty feet by somebody who has been watching
  pitches for two hours. If it needs six lines, it needs two slides or fewer words.
- **No sentence case headline followed by three bullets.** Most slides carry one takeaway sentence.

---

## Diagrams

- **A diagram must be readable in three seconds.** If it needs to be walked through, it is a
  document, not a slide.
- **The before-workflow is one line with hand-offs on it**, and each hand-off is labelled with what
  a *person* had to do — not with a system name. The audience should count the hand-offs without
  being asked to.
- **The after-workflow is the same line, collapsed.** Same geometry, same position on the slide, so
  the difference is visible without an explanation.
- **No architecture diagram in the spoken pitch.** Boxes and arrows describing internals serve the
  presenter, not the audience. One may exist in the appendix for Q&A.
- Nothing isometric, no 3D, no cloud icons, no robot.

---

## Data visualisation

- **Every figure carries what it is measured against, in the same size text.** "31 hours returned"
  alone is a number; "31 hours returned, against a measured baseline of 18 minutes per request" is
  evidence. The second one is the whole differentiator and it must not be set in a footnote.
- **Three figures on a slide, maximum.** Four is a table and a table is not read.
- **Show the weak number too.** A slide that shows objective success at 78% is more credible than
  one showing task completion at 100%, and the difference between those two numbers is the product.
- **Never a chart where a number would do.** A bar chart of two values is a decoration around a
  comparison that a sentence states better.
- If a figure cannot be produced by `proof/`, it does not go on a slide. There is no exception for
  "just for illustration".

---

## Screenshots and device frames

- **Real screens, always.** Never a mockup, never a redrawn interface, never a stylised
  approximation. The product looking like real software is an asset — a redrawn version of it looks
  like a concept.
- **Full-bleed, no device frame.** A laptop bezel around a screenshot shrinks the content and adds
  nothing. The exception is where the point is *that it is on a phone in the field*.
- **Real data.** Real vendors, real jobs, real material names. Demo data with `ACME` and `Widget` in
  it says the system has never been used.
- **No cursor highlights, no annotation arrows, no zoom-and-pan.** If a detail matters, crop to it.

---

## Animation

**One rule: animation may only show a state change that actually happened.**

A request moving from a person to the system is a state change. A bullet flying in from the left is
not. Transitions between slides are cuts. Build-ins are cuts.

The demonstration is the only motion in the presentation, and that motion is the product working.

---

## Information density

- Deck slides: **one takeaway, and it survives without the speaker.**
- Executive summary: dense. It is read, not watched, and a reader who chose to read it wants the
  detail.
- Video: **one idea per segment**, five segments, no exceptions.

---

## Branding

- The name is **AWE**. It appears at the start of the video and at the end, and once in the deck.
- **No tagline.** A tagline under a name reads as marketing; the one sentence does the work a
  tagline would do and does it better.
- **No logo work before January.** Logo iteration is the most enjoyable and least valuable
  presentation task available, and it has consumed better projects than this one.
- **No acronym that is not a customer's** in any spoken artifact. PCC, TEGG, AXIS: available in Q&A,
  absent from the pitch. The audience is given one product story, not a system with named parts.
