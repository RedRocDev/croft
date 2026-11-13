import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  MAX_ACTIONS_PER_OBJECT, createHistory, recordHistory, redoHistory, undoHistory,
} from '../src/features/icanvas/history.ts'

const change = (id, before, after) => ({ id, before, after })

function apply(state, transition) {
  const next = { ...state }
  for (const { id, before, after } of transition.changes) {
    assert.equal(next[id] ?? null, before, 'A change must start from the current object state.')
    if (after === null) delete next[id]
    else next[id] = after
  }
  return next
}

test('undo and redo are chronological and preserve unrelated state', () => {
  let history = createHistory()
  history = recordHistory(history, [change('A', 1, 2)])
  history = recordHistory(history, [change('B', 4, 5)])
  history = recordHistory(history, [change('A', 2, 3)])
  let state = { A: 3, B: 5, outsideHistory: 'untouched' }

  let transition = undoHistory(history)
  state = apply(state, transition)
  assert.deepEqual(state, { A: 2, B: 5, outsideHistory: 'untouched' })
  transition = undoHistory(transition.history)
  state = apply(state, transition)
  assert.deepEqual(state, { A: 2, B: 4, outsideHistory: 'untouched' })
  transition = redoHistory(transition.history)
  state = apply(state, transition)
  assert.deepEqual(state, { A: 2, B: 5, outsideHistory: 'untouched' })
  state = apply(state, redoHistory(transition.history))
  assert.deepEqual(state, { A: 3, B: 5, outsideHistory: 'untouched' })
})

test('multi-object changes undo and redo atomically across deletion and creation', () => {
  const history = recordHistory(createHistory(), [
    change('A', 'old', null),
    change('B', null, 'new'),
  ])
  const state = { B: 'new', elsewhere: 'keep' }
  const undo = undoHistory(history)
  assert.deepEqual(apply(state, undo), { A: 'old', elsewhere: 'keep' })
  assert.equal(undo.changes.length, 2)
  assert.deepEqual(apply(apply(state, undo), redoHistory(undo.history)), state)
})

test('the default retains the newest 50 actions for an object', () => {
  let history = createHistory()
  for (let after = 1; after <= 70; after += 1) {
    history = recordHistory(history, [change('A', after - 1, after)])
  }
  assert.equal(history.past.length, MAX_ACTIONS_PER_OBJECT)
  assert.equal(history.past[0][0].before, 20)
  let state = { A: 70 }
  for (let i = 0; i < 70; i += 1) {
    const next = undoHistory(history)
    history = next.history
    state = apply(state, next)
  }
  assert.deepEqual(state, { A: 20 })
  assert.equal(history.future.length, MAX_ACTIONS_PER_OBJECT)
})

test('caps preserve unrelated actions and discard earlier linked actions across snapshot gaps', () => {
  let history = createHistory(2)
  history = recordHistory(history, [change('B', 0, 1)])
  history = recordHistory(history, [change('C', 0, 1)])
  history = recordHistory(history, [change('A', 0, 1), change('B', 1, 2)])
  history = recordHistory(history, [change('A', 1, 2)])
  history = recordHistory(history, [change('A', 2, 3)])
  let state = { A: 3, B: 2, C: 1 }
  while (history.past.length) {
    const next = undoHistory(history)
    history = next.history
    state = apply(state, next)
  }
  assert.deepEqual(state, { A: 1, B: 2, C: 0 })
})

test('new work clears redo, duplicate changes collapse and no-ops leave it alone', () => {
  let history = createHistory()
  history = recordHistory(history, [change('A', null, 1), change('A', 1, 2)])
  assert.deepEqual(history.past, [[change('A', null, 2)]])
  history = undoHistory(history).history
  assert.equal(recordHistory(history, [change('A', null, null)]), history)
  assert.equal(history.future.length, 1)
  history = recordHistory(history, [change('B', null, 2)])
  assert.deepEqual(redoHistory(history).changes, [])
})
