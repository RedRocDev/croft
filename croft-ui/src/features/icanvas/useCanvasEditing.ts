import { useRef, useState } from 'react'
import type { CanvasEdge, CanvasObject, CanvasProject } from './model'
import { createHistory, recordHistory, redoHistory, undoHistory, type Change } from './history'

type EditValue = { object: CanvasObject; index: number } | { edge: CanvasEdge; index: number }

function entries(project: CanvasProject) {
  return new Map<string, EditValue>([
    ...project.objects.map((object, index): [string, EditValue] => [object.id, { object, index }]),
    ...project.edges.map((edge, index): [string, EditValue] => [edge.id, { edge, index }]),
  ])
}

export function useCanvasEditing(project: CanvasProject, update: (project: CanvasProject) => void) {
  const history = useRef(createHistory<EditValue>())
  const [, renderHistory] = useState(0)
  function edit(objects: CanvasObject[], edges = project.edges) {
    const next = { ...project, objects, edges }
    const before = entries(project)
    const after = entries(next)
    const oldObjectOrder = project.objects.map(object => object.id).filter(id => after.has(id))
    const newObjectOrder = objects.map(object => object.id).filter(id => before.has(id))
    const oldPosition = new Map(oldObjectOrder.map((id, index) => [id, index]))
    const moved = new Set(newObjectOrder.filter((id, index) => oldPosition.get(id) !== index))
    const changes: Change<EditValue>[] = []
    for (const id of new Set([...before.keys(), ...after.keys()])) {
      const previous = before.get(id)
      const current = after.get(id)
      if (previous && current && !moved.has(id)) {
        if ('object' in previous && 'object' in current && previous.object === current.object) continue
        if ('edge' in previous && 'edge' in current && previous.edge === current.edge) continue
      }
      changes.push({ id, before: previous ?? null, after: current ?? null })
    }
    if (!changes.length) return
    history.current = recordHistory(history.current, changes)
    update(next)
    renderHistory(value => value + 1)
  }

  function step(direction: 'undo' | 'redo') {
    const result = (direction === 'undo' ? undoHistory : redoHistory)(history.current)
    if (!result.changes?.length) return
    const touched = new Set(result.changes.map(change => change.id))
    const objects = project.objects.filter(object => !touched.has(object.id))
    const edges = project.edges.filter(edge => !touched.has(edge.id))
    const replacements = result.changes.flatMap(change => change.after ? [change.after] : []).sort((a, b) => a.index - b.index)
    for (const value of replacements) {
      if ('object' in value) objects.splice(value.index, 0, value.object)
      else edges.splice(value.index, 0, value.edge)
    }
    history.current = result.history
    update({ ...project, objects, edges })
    renderHistory(value => value + 1)
  }

  function resetHistory() {
    history.current = createHistory()
    renderHistory(value => value + 1)
  }
  return { edit, step, resetHistory, canUndo: history.current.past.length > 0, canRedo: history.current.future.length > 0 }
}
