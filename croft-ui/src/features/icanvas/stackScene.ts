import { intersects, rectCenter, rotatedBounds, type OrientedRect } from './geometry.ts'
import { canFlip, makeObject, objectFlags, type CanvasObject, type Point, type StackLayout } from './model.ts'

export type StackRearCard = { memberId: string; rect: OrientedRect; colour: string; depth: number }
export type StackDisplay = {
  stack: CanvasObject
  /** The full persistent order, including cards hidden with the Layers control. */
  order: string[]
  frontId?: string
  rear: StackRearCard[]
}
export type StackScene = {
  /** Only members whose real card faces should mount. Geometry is a projection. */
  cards: Map<string, CanvasObject>
  obscured: Set<string>
  /** Rendering geometry for edge endpoints, keyed by immutable member IDs. */
  proxies: Map<string, OrientedRect>
  piles: Map<string, StackDisplay>
}

const maxRear = 3
const fanColumns = 4
const fanGap = 24

function objectsById(objects: readonly CanvasObject[]) {
  return new Map(objects.map(object => [object.id, object]))
}

function pileAt(byId: ReadonlyMap<string, CanvasObject>, stackId: string) {
  const stack = byId.get(stackId)
  if (stack?.kind !== 'stack' || !stack.stack) throw new Error('This card stack is unavailable.')
  return stack as CanvasObject & { stack: NonNullable<CanvasObject['stack']> }
}

function editable(object: CanvasObject, byId: ReadonlyMap<string, CanvasObject>) {
  const flags = objectFlags(object, byId)
  if (flags.hidden || flags.locked) throw new Error('Show and unlock the objects before changing their stack.')
}

function requestedCards(
  objects: readonly CanvasObject[],
  ids: readonly string[],
  minimum: number,
  byId = objectsById(objects),
) {
  const requested = new Set(ids)
  if (requested.size !== ids.length) throw new Error('Each card can be selected only once.')
  if (requested.size < minimum) throw new Error('Select at least two cards to create a stack.')
  const cards = objects.filter(object => requested.has(object.id))
  if (cards.length !== requested.size || !cards.every(canFlip)) throw new Error('Only notes and card-style objects can be stacked.')
  if (cards.some(card => card.parentId !== cards[0].parentId)) throw new Error('Select cards from the same frame or group.')
  if (cards[0].parentId && byId.get(cards[0].parentId)?.kind === 'stack') {
    throw new Error('Remove these cards from their current stack first.')
  }
  cards.forEach(card => editable(card, byId))
  return cards
}

function candidatesForStack(objects: readonly CanvasObject[], stackId: string, ids: readonly string[]) {
  const byId = objectsById(objects)
  const stack = pileAt(byId, stackId)
  editable(stack, byId)
  const cards = requestedCards(objects, ids, 1, byId)
  if (cards.some(card => card.parentId !== stack.parentId)) {
    throw new Error('Place the cards and stack in the same frame or group first.')
  }
  return { stack, cards }
}

export function canStackCards(objects: readonly CanvasObject[], ids: readonly string[]) {
  try {
    requestedCards(objects, ids, 2)
    return true
  } catch {
    return false
  }
}

export function canAddToStack(objects: readonly CanvasObject[], stackId: string, ids: readonly string[]) {
  try {
    candidatesForStack(objects, stackId, ids)
    return true
  } catch {
    return false
  }
}

export function createStack(objects: readonly CanvasObject[], ids: readonly string[], name = 'Card stack') {
  const cards = requestedCards(objects, ids, 2)
  // Canvas layer order is back to front. Keep the topmost selected card active.
  const order = cards.map(card => card.id).reverse()
  const front = cards[cards.length - 1]
  const stack = makeObject('stack', { x: front.x, y: front.y }, {
    parentId: front.parentId,
    name: name.trim() || 'Card stack',
    width: front.width,
    height: front.height,
    rotation: front.rotation,
    stack: { order, layout: 'compact' },
  })
  const members = new Set(order)
  const next = objects.flatMap(object => {
    if (!members.has(object.id)) return [object]
    const member = { ...object, parentId: stack.id }
    return object.id === front.id ? [member, stack] : [member]
  })
  return { objects: next, stackId: stack.id }
}

export function addToStack(objects: readonly CanvasObject[], stackId: string, memberIds: readonly string[]) {
  const { stack, cards } = candidatesForStack(objects, stackId, memberIds)
  const newcomers = cards.map(card => card.id).reverse()
  const members = new Set(newcomers)
  const changedStack = { ...stack, stack: { ...stack.stack, order: [...newcomers, ...stack.stack.order] } }
  return objects.map(object => object.id === stackId
    ? changedStack
    : members.has(object.id) ? { ...object, parentId: stackId } : object)
}

function layoutMember(stack: CanvasObject, member: CanvasObject, dx = 0, dy = 0): CanvasObject {
  const anchor = rectCenter(stack)
  const angle = stack.rotation * Math.PI / 180
  return {
    ...member,
    x: anchor.x + dx * Math.cos(angle) - dy * Math.sin(angle) - member.width / 2,
    y: anchor.y + dx * Math.sin(angle) + dy * Math.cos(angle) - member.height / 2,
  }
}

export function layoutStacks(objects: readonly CanvasObject[]): StackScene {
  const byId = objectsById(objects)
  const cards = new Map<string, CanvasObject>()
  const obscured = new Set<string>()
  const proxies = new Map<string, OrientedRect>()
  const piles = new Map<string, StackDisplay>()
  for (const stack of objects) {
    if (stack.kind !== 'stack' || !stack.stack) continue
    const order = [...new Set(stack.stack.order)].filter(id => byId.get(id)?.parentId === stack.id)
    const members = order.map(id => byId.get(id)!)
    const visible = members.filter(member => !objectFlags(member, byId).hidden)
    const visibleIds = new Set(visible.map(member => member.id))
    for (const id of order) if (!visibleIds.has(id)) obscured.add(id)
    const [front, ...others] = visible
    const pile: StackDisplay = { stack, order, frontId: front?.id, rear: [] }
    piles.set(stack.id, pile)
    if (!front) continue
    if (stack.stack.layout === 'fan') {
      const dimensions = visible.reduce((size, member) => {
        const bounds = rotatedBounds(member, member.rotation - stack.rotation)
        return { width: Math.max(size.width, bounds.right - bounds.left), height: Math.max(size.height, bounds.bottom - bounds.top) }
      }, { width: stack.width, height: stack.height })
      for (const [index, member] of visible.entries()) {
        const card = layoutMember(stack, member, (index % fanColumns) * (dimensions.width + fanGap),
          Math.floor(index / fanColumns) * (dimensions.height + fanGap))
        cards.set(member.id, card)
        proxies.set(member.id, card)
      }
    } else {
      const card = layoutMember(stack, front)
      cards.set(front.id, card)
      proxies.set(front.id, card)
      for (const [index, member] of others.entries()) {
        obscured.add(member.id)
        // Only rear silhouette rectangles are rendered. Their width/height describe the
        // exposed outline of the front, and never overwrite a member's natural geometry.
        const depth = Math.min(index + 1, maxRear)
        const outline = layoutMember(stack, card, depth * 7, depth * 7)
        const rect = { x: outline.x, y: outline.y, width: outline.width, height: outline.height, rotation: outline.rotation }
        if (index < maxRear) pile.rear.push({ memberId: member.id, rect, colour: member.colour, depth })
        // Put the edge endpoint on the lower-right stack side without changing the edge ID.
        const angle = rect.rotation * Math.PI / 180
        const center = rectCenter(rect)
        const x = Math.max(0, rect.width / 2 - 3)
        const y = Math.max(0, rect.height / 2 - 3)
        proxies.set(member.id, {
          x: center.x + x * Math.cos(angle) - y * Math.sin(angle),
          y: center.y + x * Math.sin(angle) + y * Math.cos(angle),
          width: 0, height: 0, rotation: 0,
        })
      }
    }
  }
  return { cards, obscured, proxies, piles }
}

export function showStackMember(
  objects: readonly CanvasObject[],
  stackId: string,
  memberId: string,
  { preview = false }: { preview?: boolean } = {},
): CanvasObject[] {
  const byId = objectsById(objects)
  const stack = pileAt(byId, stackId)
  const member = byId.get(memberId)
  if (!member || member.parentId !== stackId || !stack.stack.order.includes(memberId)) {
    throw new Error('That card is no longer in this stack.')
  }
  if (!preview) editable(stack, byId)
  if (objectFlags(member, byId).hidden) throw new Error('Show this card in Layers before revealing it.')
  if (stack.stack.order[0] === memberId) return [...objects]
  const order = [memberId, ...stack.stack.order.filter(id => id !== memberId)]
  return objects.map(object => object.id === stackId ? { ...stack, stack: { ...stack.stack, order } } : object)
}

export function setStackLayout(
  objects: readonly CanvasObject[],
  stackId: string,
  layout: StackLayout,
  { preview = false }: { preview?: boolean } = {},
): CanvasObject[] {
  const byId = objectsById(objects)
  const stack = pileAt(byId, stackId)
  if (!preview) editable(stack, byId)
  if (stack.stack.layout === layout) return [...objects]
  return objects.map(object => object.id === stackId ? { ...stack, stack: { ...stack.stack, layout } } : object)
}

function avoidOverlap(card: CanvasObject, placed: readonly CanvasObject[]): CanvasObject {
  const bounds = rotatedBounds(card, card.rotation)
  const rect = { x: bounds.left, y: bounds.top, width: bounds.right - bounds.left, height: bounds.bottom - bounds.top }
  if (placed.every(other => {
    const { left, top, right, bottom } = rotatedBounds(other, other.rotation)
    return !intersects(rect, { x: left, y: top, width: right - left, height: bottom - top })
  })) return card
  const right = placed.reduce((edge, other) => Math.max(edge, rotatedBounds(other, other.rotation).right), -Infinity)
  return { ...card, x: card.x + right + fanGap - bounds.left }
}

export function extractFromStack(objects: readonly CanvasObject[], stackId: string, memberId: string, position?: Point) {
  const byId = objectsById(objects)
  const stack = pileAt(byId, stackId)
  const member = byId.get(memberId)
  if (!member || member.parentId !== stackId || !stack.stack.order.includes(memberId)) {
    throw new Error('That card is no longer in this stack.')
  }
  editable(stack, byId)
  editable(member, byId)
  const order = stack.stack.order.filter(id => id !== memberId)
  let detached: CanvasObject = { ...member, x: position?.x ?? member.x, y: position?.y ?? member.y, parentId: stack.parentId }
  if (order.length && !position) {
    const next = order.map(id => byId.get(id)).find(card => card && !objectFlags(card, byId).hidden)
    if (next) detached = avoidOverlap(detached, [layoutMember(stack, next)])
  }
  return objects.flatMap(object => {
    if (object.id === memberId) return [detached]
    if (object.id !== stackId) return [object]
    return order.length ? [{ ...stack, stack: { ...stack.stack, order } }] : []
  })
}

export function unstackAll(objects: readonly CanvasObject[], stackId: string) {
  const byId = objectsById(objects)
  const stack = pileAt(byId, stackId)
  editable(stack, byId)
  const placed: CanvasObject[] = []
  const detached = new Map<string, CanvasObject>()
  for (const id of stack.stack.order) {
    const member = byId.get(id)
    if (!member || member.parentId !== stackId) continue
    if (objectFlags(member, byId).locked) throw new Error('Unlock the cards before unstacking them.')
    const released = avoidOverlap({ ...member, parentId: stack.parentId }, placed)
    placed.push(released)
    detached.set(id, released)
  }
  return objects.filter(object => object.id !== stackId).map(object => detached.get(object.id) ?? object)
}

export function moveStack(objects: readonly CanvasObject[], stackId: string, position: Point) {
  const byId = objectsById(objects)
  const stack = pileAt(byId, stackId)
  editable(stack, byId)
  if (stack.stack.order.some(id => {
    const card = byId.get(id)
    return card && objectFlags(card, byId).locked
  })) throw new Error('Unlock the cards before moving this stack.')
  const moved = { ...stack, x: position.x, y: position.y }
  const dx = moved.x - stack.x
  const dy = moved.y - stack.y
  return objects.map(object => object.id === stackId ? moved
    : object.parentId === stackId ? { ...object, x: object.x + dx, y: object.y + dy } : object)
}
