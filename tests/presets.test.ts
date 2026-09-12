/**
 * Preset tasks, applied optimistically.
 *
 * The same guarantees every other op has, plus the one this feature depends
 * on: a preset's backing task is created like any other task, so the timer
 * banner can find its name, while the preset list and switch behave on their
 * own.
 */
import { describe, expect, it } from 'vitest'
import { applyOps, emptySnapshot, type PendingOp, type Snapshot } from '../src/lib/offline'
import type { Preset, Profile, Task } from '../src/lib/types'
import { DEFAULT_PRESETS, presetEmoji } from '../src/lib/presets'

const at = '2026-09-12T10:00:00.000Z'
const profile = {
  id: 'u',
  timezone: 'UTC',
  created_at: at,
  updated_at: at,
  presets_enabled: false,
} as Profile
const base: Snapshot = { ...emptySnapshot, profile, presets: [] }

const preset = (id: string, rank: string): Preset => ({
  id,
  user_id: 'u',
  title: `preset ${id}`,
  rank,
  deleted_at: null,
  created_at: at,
  updated_at: at,
})

const create = (p: Preset): PendingOp => ({ op: 'createPreset', at, preset: p })

describe('preset ops', () => {
  it('shows a created preset at once', () => {
    const s = applyOps(base, [create(preset('a', 'a0'))])
    expect(s.presets.map((x) => x.id)).toEqual(['a'])
  })

  it('does not duplicate a preset when the queue is replayed over its result', () => {
    const ops = [create(preset('a', 'a0'))]
    expect(applyOps(applyOps(base, ops), ops).presets).toHaveLength(1)
  })

  it('keeps presets in the order they were added, however they arrived', () => {
    const s = applyOps(base, [create(preset('b', 'a1')), create(preset('a', 'a0'))])
    expect(s.presets.map((x) => x.id)).toEqual(['a', 'b'])
  })

  it('drops a deleted preset from the list', () => {
    const s = applyOps(base, [
      create(preset('a', 'a0')),
      create(preset('b', 'a1')),
      { op: 'deletePreset', at, presetId: 'a' },
    ])
    expect(s.presets.map((x) => x.id)).toEqual(['b'])
  })

  it('switches the menu on and off on the profile', () => {
    const on = applyOps(base, [{ op: 'setPresetsEnabled', at, enabled: true }])
    expect(on.profile?.presets_enabled).toBe(true)
    const off = applyOps(on, [{ op: 'setPresetsEnabled', at, enabled: false }])
    expect(off.profile?.presets_enabled).toBe(false)
  })

  it('accepts a snapshot cached before presets existed', () => {
    const legacy: Partial<Snapshot> = { ...emptySnapshot }
    delete legacy.presets
    expect(applyOps(legacy as Snapshot, []).presets).toEqual([])
  })

  it("puts a preset's task where the timer banner looks for its name", () => {
    const task = {
      id: 'pt',
      user_id: 'u',
      title: 'Eating',
      rank: 'a0',
      preset_id: 'a',
      due_at: null,
      deleted_at: null,
      completed_at: null,
      priority: null,
    } as Task
    const s = applyOps(base, [{ op: 'createTask', at, task }])
    expect(s.tasks.find((t) => t.id === 'pt')?.title).toBe('Eating')
  })
})

describe('default preset emoji', () => {
  it('labels each default preset with its own emoji', () => {
    for (const p of DEFAULT_PRESETS) expect(presetEmoji(p.title)).toBe(p.emoji)
    expect(new Set(DEFAULT_PRESETS.map((p) => p.emoji)).size).toBe(DEFAULT_PRESETS.length)
  })

  it('matches by name however it was typed', () => {
    expect(presetEmoji('  eating ')).toBe(presetEmoji('Eating'))
  })

  it('gives a preset of your own no emoji', () => {
    expect(presetEmoji('Stretching')).toBeNull()
  })
})
