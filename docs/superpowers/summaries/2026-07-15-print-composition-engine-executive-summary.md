# Executive summary — Print Composition Engine (PR #182)

**In plain terms:** this PR is exploratory groundwork, not a shipped feature. It builds a first version of a system that could let us generate every print size automatically from one artwork file, instead of an artist hand-cropping and hand-placing each size by hand.

## The business problem it addresses

Today, turning a piece of art into a sellable print (in all its sizes and framings) requires manual, per-size layout work. That's slow, hard to keep consistent, and doesn't scale as the print catalog grows.

## What this PR delivers

- A calculator that automatically works out where the artwork and signature should sit on the canvas for any print size, so every size looks correctly proportioned without anyone manually positioning it.
- A renderer that turns that calculation into the actual print-ready image file, with consistent quality and color handling.
- A settings file per artwork so an artist can nudge the look (e.g. recenter a piece) without touching any code.
- Automated checks (27 tests) confirming the math and image output behave correctly and consistently.

## Why it matters

If adopted, this removes a manual, artist-hours bottleneck from adding new prints or new print sizes — new sizes could be generated automatically instead of re-authored by hand each time.

## Current status — not yet production-ready

This was explicitly merged as **exploratory work for review**, not for immediate use:
- It has not been run against a real artwork file end-to-end yet.
- It has not been compared side-by-side against our existing, working print pipeline to rule out regressions.
- There's a second, similar effort in progress elsewhere (the mockup pipeline) that overlaps in purpose — the two need to be reconciled before either goes live, to avoid maintaining two competing systems.

## Bottom line

No customer-facing change yet, and no risk introduced to the current live print process. The value is a validated technical approach and reusable building blocks; the next step is a real-world trial and a decision on which composition approach we standardize on.