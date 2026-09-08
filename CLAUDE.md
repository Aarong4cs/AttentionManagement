# Attention Management

Personal time-management PWA. Single user (me).
Used on iPhone and MacBook, data synced across both.

## Stack
- Vite + React + TypeScript
- Supabase (Postgres + Auth)
- Plain CSS, no UI framework
- Deployed to Vercel

## The app
Two panes side by side:
- TIMELINE (left): today, vertical. Due-date tasks are fixed
  blocks at their scheduled time. A live marker shows now.
- SEQUENCE (right): tasks with no due date, in a manual
  priority order I control.

Core interaction: in the gaps between scheduled blocks, I select
a task from the sequence and toggle it ON. A block starts drawing
on the timeline at the current time and grows live. Toggling OFF
freezes it. That block is a permanent record of what I actually
did, visually distinct from scheduled blocks.

## Non-negotiables
- Running timers are stored as a start TIMESTAMP, never an
  incrementing counter. iOS suspends background JS and a
  counter will silently lose time.
- Server is truth, local storage is cache. Write locally first
  for instant UI, then sync.
- Must work offline and reconcile on reconnect.
- Mobile-first. The two panes collapse to tabs on narrow screens.

## Conventions
- Estimated duration (set per task) and actual duration
  (elapsed time from the toggle) are different fields. Store both.
- Block types: `scheduled` (planned) vs `trailed` (observed).

## Commands
- dev: npm run dev
- build: npm run build