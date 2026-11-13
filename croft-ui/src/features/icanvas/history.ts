/** A null value denotes an object that did not or no longer exists. Keep snapshots immutable. */
export interface Change<T> {
  id: string
  before: T | null
  after: T | null
}

export interface History<T> {
  readonly past: readonly (readonly Change<T>[])[]
  readonly future: readonly (readonly Change<T>[])[]
  readonly maxActionsPerObject: number
}

export interface HistoryTransition<T> {
  history: History<T>
  /** Apply each change's after state to the corresponding ID in one operation. */
  changes: readonly Change<T>[]
}

export const MAX_ACTIONS_PER_OBJECT = 50

export function createHistory<T>(maxActionsPerObject = MAX_ACTIONS_PER_OBJECT): History<T> {
  if (!Number.isSafeInteger(maxActionsPerObject) || maxActionsPerObject < 1) {
    throw new RangeError('The per-object history limit must be a positive integer.')
  }
  return { past: [], future: [], maxActionsPerObject }
}

function trimPast<T>(
  past: readonly (readonly Change<T>[])[],
  limit: number,
): readonly (readonly Change<T>[])[] {
  const kept: (readonly Change<T>[])[] = []
  const counts = new Map<string, number>()
  const trimmed = new Set<string>()

  for (let index = past.length - 1; index >= 0; index -= 1) {
    const action = past[index]
    // A discarded action leaves a gap for its objects. Keeping earlier actions across
    // that gap would let undo jump to stale snapshots, so trim linked actions together.
    if (action.some(({ id }) => trimmed.has(id) || (counts.get(id) ?? 0) >= limit)) {
      for (const { id } of action) trimmed.add(id)
      continue
    }
    kept.push(action)
    for (const { id } of action) counts.set(id, (counts.get(id) ?? 0) + 1)
  }

  return kept.reverse()
}

export function recordHistory<T>(history: History<T>, changes: readonly Change<T>[]): History<T> {
  const byId = new Map<string, Change<T>>()
  for (const { id, before, after } of changes) {
    const first = byId.get(id)
    byId.set(id, { id, before: first ? first.before : before, after })
  }

  const action = [...byId.values()].filter(({ before, after }) => !Object.is(before, after))
  if (!action.length) return history

  return {
    ...history,
    past: trimPast([...history.past, action], history.maxActionsPerObject),
    future: [],
  }
}

export function undoHistory<T>(history: History<T>): HistoryTransition<T> {
  const action = history.past.at(-1)
  if (!action) return { history, changes: [] }

  return {
    history: {
      ...history,
      past: history.past.slice(0, -1),
      future: [...history.future, action],
    },
    changes: action.map(({ id, before, after }) => ({ id, before: after, after: before })),
  }
}

export function redoHistory<T>(history: History<T>): HistoryTransition<T> {
  const action = history.future.at(-1)
  if (!action) return { history, changes: [] }

  return {
    history: {
      ...history,
      past: [...history.past, action],
      future: history.future.slice(0, -1),
    },
    changes: action,
  }
}
