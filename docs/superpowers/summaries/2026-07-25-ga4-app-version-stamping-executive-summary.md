# Executive summary — GA4 app version/build tagging (PR #189)

**In plain terms:** this PR tags every analytics event we send to Google Analytics with which version of the website sent it, so we can tell "was this weird traffic pattern caused by a bug in last week's release?" instead of guessing.

## The business problem it addresses

When something looks off in our analytics (a metric drops, an event stops firing, a conversion breaks), there was previously no way to tell *from the analytics data itself* whether it lined up with a specific website deploy. Diagnosing that meant cross-referencing deploy timestamps by hand.

## What this PR delivers

- Every event sent to Google Analytics — from a page view to a completed purchase — now carries the app's version number and the exact code revision that produced it.
- This applies both to browser activity (clicks, page views) and to the server-side purchase record we send when a Stripe payment completes, so the coverage is consistent everywhere.
- No new tracking infrastructure was built — it reuses version/build information the site already generates for other purposes (error monitoring, an internal footer badge), so there's minimal added complexity or new failure points.
- Documentation was updated so the team knows this data exists and how to use it.

## Why it matters

If a future release causes an analytics anomaly (e.g., a broken checkout event, a sudden traffic dip), we can now filter Google Analytics by version/build to confirm — or rule out — that release as the cause, cutting down investigation time.

## Current status — functioning, one manual step outstanding

The code change is live and tested (full test suite + manual verification passed). The data is already being collected. One follow-up remains before it's fully usable in Google Analytics' reporting screens:
- Someone needs to manually register these two new fields as "custom dimensions" in the Google Analytics admin panel (a few minutes of point-and-click work, not a code change) so they show up in reports and exploration views. Until then, the data is being collected correctly but isn't yet browsable in the GA4 UI.

## Bottom line

Low-risk, additive change with no customer-facing impact. The value is faster root-cause analysis when analytics look wrong after a release — the one remaining step is a manual GA4 admin configuration, not further engineering work.