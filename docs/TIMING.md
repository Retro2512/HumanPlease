# Timing and ranking

HumanPlease publishes one front route for each hostname and locale. Every other working
path stays in the archive, where new timing reports can move it back into contention.

## What is timed

The timer uses a monotonic clock. It starts when AutoYap opens the support chat and stops
when the existing handoff classifier confirms that a human associate joined. The submitted
value is a whole number of seconds from 1 to 14,400.

Queue time belongs in the result because it changes how quickly the route reaches a person.
Time after handoff does not. Failed runs do not enter the timing comparison.

## Recent sample window

Each route keeps the latest 40 successful durations and a lifetime sample count. The window
lets a route adapt when a company changes its bot or staffing without letting the file grow
forever. No timestamps or contributor identifiers are stored with samples.

## Comparison score

Lower is better. The score combines:

1. **Median** — the normal handoff time without letting one long queue dominate.
2. **90th percentile** — a penalty for routes that are occasionally much slower.
3. **Median absolute deviation** — a robust measure of timing variability.
4. **Confidence penalty** — uncertain paths with few or inconsistent samples must prove
   themselves before replacing a well-tested route.
5. **Cold-start penalty** — a new route cannot win on one unusually fast attempt.

The deterministic calculation is:

```text
uncertainty = max(5, 1.4826 × MAD) × 1.96 ÷ √n
cold_start  = 30 ÷ √n
tail        = max(0, p90 − median) × 0.20
score       = round(median + uncertainty + cold_start + tail)
```

`n` is the number of retained samples, up to 40.

## Promotion rules

- The first successful route for a hostname and locale becomes the front route.
- A challenger needs at least three retained samples.
- It replaces a tested front route only when its score is at least 3% lower.
- A fully sampled challenger still has to beat an under-sampled front route's confidence-adjusted score.
- Equal scores break by lower median, fewer steps, then route ID for deterministic output.
- Every intake reruns the comparison, including a new timing for the current route.

The 3% margin prevents route churn caused by ordinary queue noise. Archived routes are not
deleted; if their new evidence becomes stronger, promotion is automatic.
