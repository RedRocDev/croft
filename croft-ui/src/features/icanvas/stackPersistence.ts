import { canFlip, type CanvasObject, type CanvasProject } from './model.ts'

export function containsCardExtensions(projects: readonly CanvasProject[]) {
  return projects.some(project => project.objects.some(object =>
    object.kind === 'stack' || object.stack !== undefined || object.back !== undefined || object.visibleSide !== undefined))
}

export function assertStackMembership(objects: readonly CanvasObject[]) {
  const byId = new Map(objects.map(object => [object.id, object]))
  const assigned = new Map<string, string>()
  for (const object of objects) {
    if (object.kind !== 'stack') {
      if (object.stack !== undefined) throw new Error('Only a stack can have a card order.')
      continue
    }
    const parent = object.parentId ? byId.get(object.parentId) : undefined
    if (object.parentId && (!parent || (parent.kind !== 'frame' && parent.kind !== 'group')))
      throw new Error('A stack must be on the canvas or inside a frame or group.')
    const { stack } = object
    if (!stack || !Array.isArray(stack.order) || !stack.order.length || (stack.layout !== 'compact' && stack.layout !== 'fan'))
      throw new Error('Stack layout or card order is missing.')
    for (const id of stack.order) {
      const member = byId.get(id)
      if (!member || member.parentId !== object.id || !canFlip(member) || assigned.has(id))
        throw new Error('Stack order contains an invalid, unowned or duplicate card.')
      assigned.set(id, object.id)
    }
  }
  for (const object of objects) {
    const parent = object.parentId ? byId.get(object.parentId) : undefined
    if (parent?.kind === 'stack' && assigned.get(object.id) !== parent.id)
      throw new Error('A card is missing from its stack order.')
  }
}
