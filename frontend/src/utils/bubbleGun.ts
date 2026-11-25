// Bubble detection with BubbleGun2, compiled to WASM (bubbles_wasm/) and run
// in its own worker so a large graph doesn't block the page. Detection only
// uses the graph's topology (segments and links), never its paths.

import type { Graph } from '../types'
import { stripNodeOrientation } from './displayGraph'

export type BubbleType = 'simple' | 'super' | 'insertion'

// In the order of BubbleGun2's BubbleType enum, which the WASM returns as 0-2.
const BUBBLE_TYPES: BubbleType[] = ['simple', 'super', 'insertion']

export const BUBBLE_TYPE_LABELS: Record<BubbleType, string> = {
  simple: 'Simple bubble',
  super: 'Superbubble',
  insertion: 'Insertion',
}

// A highlighted bubble outlines its two ends apart from the nodes inside.
export type BubbleNodeRole = 'end' | 'inside'
export const BUBBLE_HIGHLIGHT_COLORS: Record<
  BubbleNodeRole,
  { light: string; dark: string }
> = {
  end: { light: '#059669', dark: '#34d399' },
  inside: { light: '#9333ea', dark: '#c084fc' },
}

export interface Bubble {
  index: number
  type: BubbleType
  // Bare node names. The ends have no direction: a walk can enter at either.
  source: string
  sink: string
  inside: string[]
  insideBp: number
  // Index of the smallest superbubble holding this one, null at the top level.
  parent: number | null
  // Number of bubbles this one is nested in (0 at the top level).
  nestedness: number
}

export interface BubbleSet {
  bubbles: Bubble[]
  counts: Record<BubbleType, number>
  // Nodes (and their sequence) that are an end or inside of any bubble, out
  // of the whole graph, as BubbleGun2 reports its chain coverage.
  coveredNodes: number
  coveredBp: number
  totalNodes: number
  totalBp: number
  maxNestedness: number
  // Time spent in the worker (detection and nesting), and in total including
  // preparing the graph and sending it to and back from the worker.
  wasmMs: number
  totalMs: number
  indexByName: Map<string, number>
  // Per node index: the innermost bubble whose inside holds the node, or -1.
  innermostBubble: Int32Array
  // Per node index: the bubbles the node is an end of.
  endOfBubbles: Map<number, number[]>
}

interface WasmBubbles {
  source: Uint32Array
  sink: Uint32Array
  type: Uint8Array
  parent: Int32Array
  insideOffsets: Uint32Array
  inside: Uint32Array
}

interface WorkerResponse {
  type: string
  id: number
  success: boolean
  result?: WasmBubbles
  duration?: number
  error?: string
}

interface PendingRequest {
  resolve: (response: { result: WasmBubbles; duration: number }) => void
  reject: (error: Error) => void
}

let worker: Worker | null = null
let nextRequestId = 0
const pendingRequests = new Map<number, PendingRequest>()

// Created on first use, so the WASM is only loaded once someone asks for
// bubbles.
function getWorker(): Worker {
  if (worker) return worker

  // Relative, like the layout worker, so subdirectory deployments work.
  worker = new Worker('./js/bubblegun.worker.js', { type: 'module' })
  worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
    const { id, success, result, duration, error } = event.data
    const pending = pendingRequests.get(id)
    if (!pending) return
    pendingRequests.delete(id)
    if (success && result) {
      pending.resolve({ result, duration: duration ?? 0 })
    } else {
      pending.reject(new Error(error || 'Bubble detection failed'))
    }
  }
  worker.onerror = event => {
    for (const pending of pendingRequests.values()) {
      pending.reject(new Error(event.message || 'The bubble detection worker failed to load'))
    }
    pendingRequests.clear()
    worker?.terminate()
    worker = null
  }
  return worker
}

export async function findBubbles(graph: Graph): Promise<BubbleSet> {
  const startTime = performance.now()

  // graph.nodes has one node per orientation in use; BubbleGun2 wants one
  // per segment.
  const names: string[] = []
  const lengths: number[] = []
  const indexByName = new Map<string, number>()
  for (const node of graph.nodes) {
    if (indexByName.has(node.name)) continue
    indexByName.set(node.name, names.length)
    names.push(node.name)
    lengths.push(node.length)
  }

  const nodeIndex = (nodeId: string): number => {
    const index = indexByName.get(stripNodeOrientation(nodeId))
    if (index === undefined) throw new Error(`Edge to unknown node ${nodeId}`)
    return index
  }
  const edges = new Uint32Array(graph.edges.length * 4)
  graph.edges.forEach((edge, i) => {
    edges[i * 4] = nodeIndex(edge.from)
    edges[i * 4 + 1] = edge.from.endsWith('-') ? 1 : 0
    edges[i * 4 + 2] = nodeIndex(edge.to)
    edges[i * 4 + 3] = edge.to.endsWith('-') ? 1 : 0
  })
  const nodeLengths = Uint32Array.from(lengths)

  const id = nextRequestId++
  const { result, duration } = await new Promise<{
    result: WasmBubbles
    duration: number
  }>((resolve, reject) => {
    pendingRequests.set(id, { resolve, reject })
    getWorker().postMessage(
      { type: 'find-bubbles', id, data: { nodeLengths, edges } },
      [nodeLengths.buffer, edges.buffer],
    )
  })

  return {
    ...buildBubbleSet(result, names, lengths),
    indexByName,
    wasmMs: duration,
    totalMs: performance.now() - startTime,
  }
}

function buildBubbleSet(result: WasmBubbles, names: string[], lengths: number[]) {
  const count = result.source.length

  // Parents can come before or after their children, so each nestedness is
  // found by walking up to the first bubble whose nestedness is known.
  const nestednessOf = new Int32Array(count).fill(-1)
  for (let i = 0; i < count; i++) {
    const chain: number[] = []
    let current = i
    while (current !== -1 && nestednessOf[current] === -1) {
      chain.push(current)
      current = result.parent[current]!
    }
    let level = current === -1 ? -1 : nestednessOf[current]!
    for (let j = chain.length - 1; j >= 0; j--) nestednessOf[chain[j]!] = ++level
  }

  const counts: Record<BubbleType, number> = { simple: 0, super: 0, insertion: 0 }
  const innermostBubble = new Int32Array(names.length).fill(-1)
  const covered = new Uint8Array(names.length)
  const endOfBubbles = new Map<number, number[]>()
  const addEnd = (node: number, bubble: number) => {
    const list = endOfBubbles.get(node)
    if (list) list.push(bubble)
    else endOfBubbles.set(node, [bubble])
  }

  const bubbles: Bubble[] = []
  for (let i = 0; i < count; i++) {
    const type = BUBBLE_TYPES[result.type[i]!] ?? 'super'
    counts[type]++

    const inside: string[] = []
    let insideBp = 0
    for (let k = result.insideOffsets[i]!; k < result.insideOffsets[i + 1]!; k++) {
      const node = result.inside[k]!
      covered[node] = 1
      inside.push(names[node]!)
      insideBp += lengths[node]!
      // Nested bubbles sit strictly inside their parents, so the most nested
      // bubble holding a node is the innermost one.
      const current = innermostBubble[node]!
      if (current === -1 || nestednessOf[i]! > nestednessOf[current]!) innermostBubble[node] = i
    }
    addEnd(result.source[i]!, i)
    addEnd(result.sink[i]!, i)
    covered[result.source[i]!] = 1
    covered[result.sink[i]!] = 1

    const parent = result.parent[i]!
    bubbles.push({
      index: i,
      type,
      source: names[result.source[i]!]!,
      sink: names[result.sink[i]!]!,
      inside,
      insideBp,
      parent: parent === -1 ? null : parent,
      nestedness: nestednessOf[i]!,
    })
  }

  let maxNestedness = 0
  for (const level of nestednessOf) maxNestedness = Math.max(maxNestedness, level)

  let coveredNodes = 0
  let coveredBp = 0
  let totalBp = 0
  for (let node = 0; node < names.length; node++) {
    totalBp += lengths[node]!
    if (covered[node]) {
      coveredNodes++
      coveredBp += lengths[node]!
    }
  }

  return {
    bubbles,
    counts,
    coveredNodes,
    coveredBp,
    totalNodes: names.length,
    totalBp,
    maxNestedness,
    innermostBubble,
    endOfBubbles,
  }
}

// Bubble ids in the downloads and the UI are 1-based detection order.
export function bubbleId(bubble: Bubble): number {
  return bubble.index + 1
}

export function bubblesToTsv(bubbleSet: BubbleSet, graphName: string): string {
  const lines = [
    `# Bubbles found by BubbleGun2 in ${graphName}`,
    [
      'id',
      'type',
      'source',
      'sink',
      'nodes_inside',
      'bp_inside',
      'nestedness',
      'parent_id',
      'inside_nodes',
    ].join('\t'),
  ]
  for (const bubble of bubbleSet.bubbles) {
    lines.push(
      [
        bubbleId(bubble),
        bubble.type,
        bubble.source,
        bubble.sink,
        bubble.inside.length,
        bubble.insideBp,
        bubble.nestedness,
        bubble.parent === null ? '' : bubble.parent + 1,
        bubble.inside.join(','),
      ].join('\t'),
    )
  }
  return lines.join('\n') + '\n'
}

export function bubblesToJson(bubbleSet: BubbleSet, graphName: string): string {
  return JSON.stringify({
    graph: graphName,
    bubbles: bubbleSet.bubbles.map(bubble => ({
      id: bubbleId(bubble),
      type: bubble.type,
      source: bubble.source,
      sink: bubble.sink,
      inside: bubble.inside,
      bp_inside: bubble.insideBp,
      nestedness: bubble.nestedness,
      parent_id: bubble.parent === null ? null : bubble.parent + 1,
    })),
  })
}

// The bubbles a node sits inside, innermost first, and the ones it is an end
// of.
export function bubblesAtNode(
  bubbleSet: BubbleSet,
  nodeName: string,
): { nesting: Bubble[]; endOf: Bubble[] } {
  const nodeIndex = bubbleSet.indexByName.get(nodeName)
  if (nodeIndex === undefined) return { nesting: [], endOf: [] }

  const nesting: Bubble[] = []
  let current: number | null = bubbleSet.innermostBubble[nodeIndex]!
  if (current === -1) current = null
  while (current !== null) {
    const bubble: Bubble = bubbleSet.bubbles[current]!
    nesting.push(bubble)
    current = bubble.parent
  }

  const endOf = (bubbleSet.endOfBubbles.get(nodeIndex) ?? []).map(
    index => bubbleSet.bubbles[index]!,
  )
  return { nesting, endOf }
}
