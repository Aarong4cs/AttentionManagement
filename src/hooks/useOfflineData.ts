import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { supabase } from '../lib/supabase'
import { fetchSnapshot } from '../lib/db'
import { flush } from '../lib/sync'
import { syncNow } from '../lib/gcalClient'
import {
  applyOps,
  loadQueue,
  loadSnapshot,
  saveQueue,
  saveSnapshot,
  type PendingOp,
  type Snapshot,
} from '../lib/offline'

export interface OfflineData {
  /** Cache plus everything not yet synced. This is what the UI renders. */
  view: Snapshot
  online: boolean
  pending: number
  /** True before the first successful fetch of this session. */
  cold: boolean
  error: string | null
  setError: (e: string | null) => void
  enqueue: (op: PendingOp) => void
  refresh: () => Promise<void>
}

/**
 * Server is truth, local is cache.
 *
 * The cached snapshot renders immediately — offline, or on a cold start over a
 * slow connection — and queued operations are layered on top so a write shows
 * up the instant it is made. The queue is pushed whenever the network looks
 * available, and the snapshot is replaced by whatever the server says
 * afterwards.
 */
/** How long a Google pull stays fresh enough to skip repeating. */
const GOOGLE_PULL_MS = 30_000

/** A transport failure rather than something the server refused. */
function isNetworkError(e: unknown): boolean {
  if (e instanceof TypeError) return true // fetch rejects with TypeError
  const message = e instanceof Error ? e.message : String(e)
  return /fetch|network|Failed to fetch|disconnected/i.test(message)
}

export function useOfflineData(
  today: string | null,
  rangeStart: Date | null,
  rangeEnd: Date | null,
): OfflineData {
  const [snapshot, setSnapshot] = useState<Snapshot>(loadSnapshot)
  const [queue, setQueue] = useState<PendingOp[]>(loadQueue)
  // the authoritative queue, so appending never depends on a React state
  // updater having run yet — flush reads storage, not state
  const queueRef = useRef<PendingOp[]>(queue)
  const [online, setOnline] = useState(
    typeof navigator === 'undefined' ? true : navigator.onLine,
  )
  const [cold, setCold] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const busy = useRef(false)
  const rerun = useRef(false)
  /** When Google was last pulled, so a view switch does not trigger one. */
  const lastPull = useRef(0)

  const view = useMemo(() => applyOps(snapshot, queue), [snapshot, queue])

  // primitives, so the dependency arrays below stay statically checkable and a
  // new Date object with the same instant does not retrigger every fetch
  const startMs = rangeStart?.getTime() ?? null
  const endMs = rangeEnd?.getTime() ?? null

  const once = useCallback(async () => {
    if (!today || startMs === null || endMs === null) return
    try {
      // push before pulling, so the server state we cache already contains
      // our own pending writes rather than reverting them on screen
      const result = await flush()
      // a stalled queue means the server could not be reached, whatever
      // navigator.onLine claims; say "offline" rather than "syncing"
      if (result.stalled) setOnline(false)
      if (result.rejected.length > 0) {
        setError(
          `${result.rejected.length} change(s) were refused and dropped: ` +
            result.rejected.map((r) => r.message).join('; '),
        )
      } else if (result.stallReason) {
        // a stalled queue looks identical to a working one; say so
        setError(`Sync paused — ${result.stallReason}`)
      }

      const fresh = await fetchSnapshot(today, new Date(startMs), new Date(endMs))

      /*
       * Drop the drained operations and install the new snapshot TOGETHER.
       * Clearing the queue first leaves a window where the ops are gone but the
       * snapshot predates them, and the view reverts for exactly that long —
       * which looked like a block snapping back to its old position after every
       * drag. applyOps tolerates being run over its own result, so holding the
       * queue across the fetch is safe.
       */
      queueRef.current = loadQueue()
      setSnapshot(fresh)
      setQueue(queueRef.current)
      saveSnapshot(fresh)
      setCold(false)
      setOnline(true)
      if (result.rejected.length === 0 && !result.stallReason) setError(null)

      /*
       * Google comes AFTER the local read, not before.
       *
       * Pulling first meant every change of the visible range — switching to
       * the week, stepping a day — waited on a round trip to Google before
       * asking for its own data, so the other days took a couple of seconds to
       * appear. Nothing on screen depends on that call completing.
       *
       * It is also throttled: navigating between days does not need a fresh
       * pull each time, and the sheet's "Sync now" calls syncNow directly when
       * an immediate one is wanted.
       */
      if (Date.now() - lastPull.current < GOOGLE_PULL_MS) return
      lastPull.current = Date.now()
      try {
        const g = await syncNow()
        const moved =
          (g.written ?? 0) + (g.removed ?? 0) +
          (g.push?.created ?? 0) + (g.push?.updated ?? 0) + (g.push?.deleted ?? 0)
        // only read again if it actually changed something, which is rare once
        // the first sync has happened
        if (moved > 0) {
          const after = await fetchSnapshot(today, new Date(startMs), new Date(endMs))
          setSnapshot(after)
          saveSnapshot(after)
        }
      } catch {
        /* not connected, offline, or Google is down — none of it blocks the app */
      }
    } catch (e) {
      // the fetch failed, so no fresh snapshot is coming: fall back to whatever
      // the queue actually is now, rather than leaving drained ops applied
      queueRef.current = loadQueue()
      setQueue(queueRef.current)
      // navigator.onLine only reports whether a network interface is up — it
      // says true on a wifi network with no internet behind it. Whether the
      // fetch actually completed is the only reliable signal, so reachability
      // is derived from that and navigator.onLine is just the initial hint.
      setOnline(false)
      if (!isNetworkError(e)) setError(e instanceof Error ? e.message : String(e))
    }
  }, [today, startMs, endMs])


  const refresh = useCallback(async () => {
    if (!today || startMs === null || endMs === null) return
    if (busy.current) {
      // Coalesce rather than drop. A fetch made while offline can hang for
      // seconds, and the reconnect signal is exactly the request most likely to
      // arrive during it — dropping that one leaves the queue stalled forever.
      rerun.current = true
      return
    }
    busy.current = true
    try {
      do {
        rerun.current = false
        await once()
      } while (rerun.current)
    } finally {
      busy.current = false
    }
  }, [once, today, startMs, endMs])

  const enqueue = useCallback(
    (op: PendingOp) => {
      // durable BEFORE the UI updates, and outside the React updater: a state
      // updater is render-phase, double-invoked under StrictMode, and may not
      // have run by the time flush reads storage
      const next = [...queueRef.current, op]
      queueRef.current = next
      saveQueue(next)
      setQueue(next)
      void refresh()
    },
    [refresh],
  )

  useEffect(() => {
    // the external-system synchronisation the rule exists to allow: fetch the
    // server's version of what the cache is already showing
    // oxlint-disable-next-line react/set-state-in-effect
    void refresh()
  }, [refresh])

  useEffect(() => {
    const goOnline = () => {
      setOnline(true)
      void refresh()
    }
    const goOffline = () => setOnline(false)
    const onWake = () => {
      if (document.visibilityState === 'visible') void refresh()
    }

    window.addEventListener('online', goOnline)
    window.addEventListener('offline', goOffline)
    document.addEventListener('visibilitychange', onWake)
    window.addEventListener('focus', onWake)

    // Realtime is the fast path; the listeners above are the correctness path.
    const channel = supabase
      .channel('attention-changes')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'tasks' }, () =>
        void refresh(),
      )
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'time_entries' },
        () => void refresh(),
      )
      .subscribe()

    return () => {
      window.removeEventListener('online', goOnline)
      window.removeEventListener('offline', goOffline)
      document.removeEventListener('visibilitychange', onWake)
      window.removeEventListener('focus', onWake)
      supabase.removeChannel(channel)
    }
  }, [refresh])

  return {
    view,
    online,
    pending: queue.length,
    cold,
    error,
    setError,
    enqueue,
    refresh,
  }
}
