import { gunzipSync } from 'node:zlib'

/**
 * Consumer-side acceptance checks for Minecraft exports.
 *
 * This module intentionally does not import Knead's data-pack, NBT, or GZIP
 * writers. Tests feed it completed exports so a second parser checks the
 * container and cross-file invariants a Minecraft-side consumer relies on.
 */

const RESOURCE_LOCATION = /^[a-z0-9_.-]+:[a-z0-9_./-]+$/u
const RESOURCE_PATH = /^[a-z0-9_./-]+$/u
const SAFE_FILE_PATH = /^[A-Za-z0-9_./-]+$/u
const MAX_PACK_FILES = 20_000
const MAX_TEXT_FILE_BYTES = 32 * 1024 * 1024
const MAX_NBT_BYTES = 64 * 1024 * 1024
const MAX_NBT_ITEMS = 1_000_000
const MAX_NBT_DEPTH = 64

// Explicit consumer fixtures from Mojang technical changelogs. Keeping these
// here (instead of importing the writer's inference table) lets this harness
// catch target/version metadata drift.
const REPRESENTATIVE_DATA_PACK_FORMATS: Readonly<Record<string, readonly [number, number]>> = {
  '1.13.2': [4, 0],
  '1.14.4': [4, 0],
  '1.15.2': [5, 0],
  '1.19.2': [10, 0],
  '1.20.6': [41, 0],
  '1.21.4': [61, 0],
  '1.21.11': [94, 1],
  '26.1': [101, 1],
  '26.2': [107, 1],
  '26.3-snapshot-6': [113, 0],
}

export type AcceptedClockMode = 'tick-tag' | 'schedule-basic' | 'schedule-clear-replace'

export interface DataPackAcceptanceOptions {
  targetVersion: string
  namespace: string
}

export interface DataPackAcceptanceResult {
  layout: 'plural' | 'singular'
  clockMode: AcceptedClockMode
  fileCount: number
  functionCount: number
  functionReferenceCount: number
  eventCommandCount: number
  reachableFunctionCount: number
}

export type AcceptedBuildFormat =
  | 'structure-block-nbt'
  | 'litematica-compatible-nbt'
  | 'schematic-1.11-1.12'
  | 'schematic-pre-1.11'

export interface BuildAcceptanceOptions {
  format: AcceptedBuildFormat
  expectedDimensions?: Readonly<{ x: number, y: number, z: number }>
}

export interface BuildAcceptanceResult {
  format: AcceptedBuildFormat
  dimensions: Readonly<{ x: number, y: number, z: number }>
  paletteSize?: number
  blockCount: number
  noteBlockCount: number
  decodedBytes: number
}

interface ParsedTarget {
  kind: 'release' | 'snapshot'
  major?: number
  minor?: number
  patch?: number
  year?: number
  week?: number
  letter?: string
}

function acceptanceError(message: string): never {
  throw new Error(`Minecraft acceptance failed: ${message}`)
}

function parseTarget(value: string): ParsedTarget {
  const release = /^(\d+)\.(\d+)(?:\.(\d+))?(?:-(?:pre|rc)-?\d+)?$/u.exec(value.trim())
  if (release) {
    return {
      kind: 'release',
      major: Number(release[1]),
      minor: Number(release[2]),
      patch: Number(release[3] ?? 0),
    }
  }
  const snapshot = /^(\d+)w(\d+)([a-z])$/u.exec(value.trim())
  if (snapshot) {
    return {
      kind: 'snapshot',
      year: Number(snapshot[1]),
      week: Number(snapshot[2]),
      letter: snapshot[3],
    }
  }
  const numberedSnapshot = /^(\d+)\.(\d+)-snapshot-(\d+)$/u.exec(value.trim())
  if (numberedSnapshot) {
    return {
      kind: 'snapshot',
      year: Number(numberedSnapshot[1]),
      week: Number(numberedSnapshot[2]) * 1000 + Number(numberedSnapshot[3]),
      letter: 'z',
    }
  }
  return acceptanceError(`unsupported target version ${JSON.stringify(value)}`)
}

function snapshotAtLeast(
  target: ParsedTarget,
  year: number,
  week: number,
  letter = 'a',
): boolean {
  return target.kind === 'snapshot' && (
    target.year! > year
    || (target.year === year && (
      target.week! > week
      || (target.week === week && target.letter!.localeCompare(letter) >= 0)
    ))
  )
}

function expectedLayout(target: ParsedTarget): 'plural' | 'singular' {
  if (target.kind === 'snapshot') return snapshotAtLeast(target, 24, 21, 'a') ? 'singular' : 'plural'
  return target.major! > 1 || (target.major === 1 && target.minor! >= 21) ? 'singular' : 'plural'
}

function expectedClockMode(target: ParsedTarget): AcceptedClockMode {
  if (target.kind === 'snapshot') {
    if (!snapshotAtLeast(target, 17, 43, 'a')) {
      return acceptanceError('the target predates Java data packs (17w43a / 1.13)')
    }
    if (!snapshotAtLeast(target, 18, 43, 'a')) return 'tick-tag'
    if (!snapshotAtLeast(target, 19, 38, 'a')) return 'schedule-basic'
    return 'schedule-clear-replace'
  }
  if (target.major! < 1 || (target.major === 1 && target.minor! < 13)) {
    return acceptanceError('the target predates Java data packs (1.13)')
  }
  if (target.major === 1 && target.minor === 13) return 'tick-tag'
  if (target.major === 1 && target.minor === 14) return 'schedule-basic'
  return 'schedule-clear-replace'
}

function usesMinorPackMetadata(target: ParsedTarget): boolean {
  if (target.kind !== 'release') return false
  if (target.major! > 1) return true
  return target.major === 1 && target.minor === 21 && target.patch! >= 9
}

function assertSafeFilePath(path: string): void {
  if (
    path.length === 0
    || path.length > 512
    || !SAFE_FILE_PATH.test(path)
    || path.startsWith('/')
    || path.endsWith('/')
    || path.includes('//')
    || path.split('/').some(segment => segment === '.' || segment === '..' || segment.length === 0)
  ) {
    acceptanceError(`unsafe pack path ${JSON.stringify(path)}`)
  }
}

function parseJsonObject(text: string, path: string): Record<string, unknown> {
  let value: unknown
  try {
    value = JSON.parse(text)
  }
  catch (error) {
    return acceptanceError(`${path} is not valid JSON: ${String(error)}`)
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return acceptanceError(`${path} must contain a JSON object`)
  }
  return value as Record<string, unknown>
}

function assertFormatTuple(value: unknown, field: string): void {
  if (
    !Array.isArray(value)
    || value.length !== 2
    || !value.every(part => Number.isInteger(part) && part >= 0 && part <= 999)
  ) {
    acceptanceError(`pack.${field} must be a [major, minor] integer tuple`)
  }
}

function sameFormat(
  actual: readonly [number, number],
  expected: readonly [number, number],
): boolean {
  return actual[0] === expected[0] && actual[1] === expected[1]
}

function validatePackMetadata(text: string, target: ParsedTarget, targetVersion: string): void {
  const root = parseJsonObject(text, 'pack.mcmeta')
  const packValue = root.pack
  if (!packValue || typeof packValue !== 'object' || Array.isArray(packValue)) {
    acceptanceError('pack.mcmeta is missing its pack object')
  }
  const pack = packValue as Record<string, unknown>
  if (typeof pack.description !== 'string' || pack.description.length === 0) {
    acceptanceError('pack.description must be a non-empty string')
  }
  let declaredMin: readonly [number, number]
  let declaredMax: readonly [number, number]
  if (usesMinorPackMetadata(target)) {
    if (pack.pack_format !== undefined) acceptanceError('minor-format targets must not emit pack_format')
    assertFormatTuple(pack.min_format, 'min_format')
    assertFormatTuple(pack.max_format, 'max_format')
    declaredMin = pack.min_format as [number, number]
    declaredMax = pack.max_format as [number, number]
  }
  else if (!Number.isInteger(pack.pack_format) || Number(pack.pack_format) < 1) {
    if (target.kind !== 'snapshot') {
      acceptanceError('legacy pack metadata requires a positive integer pack_format')
    }
    assertFormatTuple(pack.min_format, 'min_format')
    assertFormatTuple(pack.max_format, 'max_format')
    declaredMin = pack.min_format as [number, number]
    declaredMax = pack.max_format as [number, number]
  }
  else {
    declaredMin = [Number(pack.pack_format), 0]
    declaredMax = declaredMin
  }
  const expected = REPRESENTATIVE_DATA_PACK_FORMATS[targetVersion.trim()]
  if (expected && (!sameFormat(declaredMin, expected) || !sameFormat(declaredMax, expected))) {
    acceptanceError(
      `pack format ${declaredMin.join('.')}..${declaredMax.join('.')} does not match ${targetVersion} (${expected.join('.')})`,
    )
  }
}

function parseFunctionTag(text: string, path: string): string[] {
  const root = parseJsonObject(text, path)
  if (!Array.isArray(root.values) || root.values.length === 0) {
    return acceptanceError(`${path} must contain a non-empty values array`)
  }
  return root.values.map((value) => {
    if (typeof value !== 'string' || !RESOURCE_LOCATION.test(value)) {
      return acceptanceError(`${path} contains an invalid function ID`)
    }
    return value
  })
}

function validateFunctionLine(line: string, path: string, lineNumber: number): void {
  if (line.length > 2_000_000) acceptanceError(`${path}:${lineNumber} exceeds Minecraft's command limit`)
  if (line.startsWith('/')) acceptanceError(`${path}:${lineNumber} must not start with a slash`)
  const command = line.split(/\s+/u, 1)[0]
  if (![
    'execute', 'function', 'kill', 'particle', 'playsound', 'schedule',
    'scoreboard', 'stopsound', 'summon',
  ].includes(command)) {
    acceptanceError(`${path}:${lineNumber} has unsupported generated command ${JSON.stringify(command)}`)
  }
}

function functionIdFromPath(path: string, namespace: string, directory: string): string | undefined {
  const prefix = `data/${namespace}/${directory}/`
  if (!path.startsWith(prefix) || !path.endsWith('.mcfunction')) return undefined
  const resourcePath = path.slice(prefix.length, -'.mcfunction'.length)
  if (!RESOURCE_PATH.test(resourcePath) || resourcePath.startsWith('/') || resourcePath.includes('//')) {
    acceptanceError(`invalid function resource path ${JSON.stringify(path)}`)
  }
  return `${namespace}:${resourcePath}`
}

export function verifyCommandDatapack(
  files: Readonly<Record<string, string>>,
  options: Readonly<DataPackAcceptanceOptions>,
): DataPackAcceptanceResult {
  const entries = Object.entries(files)
  if (entries.length === 0 || entries.length > MAX_PACK_FILES) acceptanceError('invalid file count')
  if (!/^[a-z0-9_.-]+$/u.test(options.namespace) || options.namespace === 'minecraft') {
    acceptanceError(`invalid generated namespace ${JSON.stringify(options.namespace)}`)
  }
  for (const [path, contents] of entries) {
    assertSafeFilePath(path)
    if (new TextEncoder().encode(contents).byteLength > MAX_TEXT_FILE_BYTES) {
      acceptanceError(`${path} exceeds the text-file budget`)
    }
    if (contents.includes('\0') || contents.includes('\r')) {
      acceptanceError(`${path} contains forbidden control or CR bytes`)
    }
  }

  const target = parseTarget(options.targetVersion)
  const layout = expectedLayout(target)
  const clockMode = expectedClockMode(target)
  const directory = layout === 'singular' ? 'function' : 'functions'
  const oppositeDirectory = layout === 'singular' ? 'functions' : 'function'
  const tagBase = `data/minecraft/tags/${directory}`
  const metadata = files['pack.mcmeta']
  if (metadata === undefined) acceptanceError('missing pack.mcmeta')
  validatePackMetadata(metadata, target, options.targetVersion)
  if (entries.some(([path]) => path.startsWith(`data/${options.namespace}/${oppositeDirectory}/`))) {
    acceptanceError(`target uses ${directory}, but the pack contains ${oppositeDirectory}`)
  }

  const functions = new Map<string, { path: string, text: string }>()
  for (const [path, text] of entries) {
    const id = functionIdFromPath(path, options.namespace, directory)
    if (id) functions.set(id, { path, text })
  }
  for (const path of [
    'install', 'start', 'pause', 'resume', 'stop', 'uninstall',
    'runtime/tick', 'runtime/dispatch', 'runtime/finish', 'runtime/repeat',
  ]) {
    if (!functions.has(`${options.namespace}:${path}`)) acceptanceError(`missing function ${options.namespace}:${path}`)
  }

  const loadPath = `${tagBase}/load.json`
  const loadText = files[loadPath]
  if (loadText === undefined) acceptanceError(`missing ${loadPath}`)
  const loadRoots = parseFunctionTag(loadText, loadPath)
  if (!loadRoots.includes(`${options.namespace}:install`)) acceptanceError('load tag does not call install')
  const tickPath = `${tagBase}/tick.json`
  const tickText = files[tickPath]
  let tickRoots: string[] = []
  if (clockMode === 'tick-tag') {
    if (tickText === undefined) acceptanceError('Java 1.13 clock is missing its tick function tag')
    tickRoots = parseFunctionTag(tickText, tickPath)
    if (!tickRoots.includes(`${options.namespace}:runtime/tick_driver`)) {
      acceptanceError('Java 1.13 tick tag does not call the guarded tick driver')
    }
    const driver = functions.get(`${options.namespace}:runtime/tick_driver`)?.text
    if (!driver?.includes('execute if entity ') || !driver.includes(`run function ${options.namespace}:runtime/tick`)) {
      acceptanceError('Java 1.13 tick driver is not guarded by its controller entity')
    }
    const install = functions.get(`${options.namespace}:install`)!.text
    const uninstall = functions.get(`${options.namespace}:uninstall`)!.text
    if (!install.includes('execute unless entity ') || !install.includes('summon minecraft:armor_stand')) {
      acceptanceError('Java 1.13 install does not create its idempotent clock controller')
    }
    if (!uninstall.includes('kill @e[') || !uninstall.includes('scoreboard objectives remove')) {
      acceptanceError('Java 1.13 uninstall does not remove its controller and objective')
    }
  }
  else if (tickText !== undefined) {
    acceptanceError(`${clockMode} must not install a global tick tag`)
  }

  const references = new Map<string, Set<string>>()
  let referenceCount = 0
  let eventCommandCount = 0
  const functionReference = /\bfunction\s+([a-z0-9_.-]+:[a-z0-9_./-]+)(?=\s|$)/gu
  const scheduleClearReference = /^schedule\s+clear\s+([a-z0-9_.-]+:[a-z0-9_./-]+)$/u
  for (const [id, file] of functions) {
    const ownReferences = new Set<string>()
    const lines = file.text.split('\n')
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index]
      if (line.length === 0 || line.startsWith('#')) continue
      validateFunctionLine(line, file.path, index + 1)
      if (id.includes(':events/') && /\b(?:playsound|stopsound)\b/u.test(line)) eventCommandCount++
      if (clockMode === 'tick-tag' && /\bschedule\s/u.test(line)) {
        acceptanceError(`${file.path}:${index + 1} uses schedule on a Java 1.13 target`)
      }
      if (clockMode === 'schedule-basic') {
        if (/\bschedule\s+clear\s/u.test(line)
          || /\bschedule\s+function\s+\S+\s+\S+\s+(?:append|replace)(?:\s|$)/u.test(line)) {
          acceptanceError(`${file.path}:${index + 1} uses Java 1.15 schedule syntax on Java 1.14`)
        }
      }
      if (clockMode === 'schedule-clear-replace'
        && /\bschedule\s+function\s/u.test(line)
        && !/\sreplace$/u.test(line)) {
        acceptanceError(`${file.path}:${index + 1} omits deterministic replace scheduling`)
      }
      functionReference.lastIndex = 0
      for (let match = functionReference.exec(line); match; match = functionReference.exec(line)) {
        ownReferences.add(match[1])
        referenceCount++
      }
      const cleared = scheduleClearReference.exec(line)?.[1]
      if (cleared) {
        ownReferences.add(cleared)
        referenceCount++
      }
    }
    references.set(id, ownReferences)
  }
  for (const [source, targets] of references) {
    for (const targetId of targets) {
      if (!targetId.startsWith(`${options.namespace}:`)) {
        acceptanceError(`${source} references foreign function ${targetId}`)
      }
      if (!functions.has(targetId)) acceptanceError(`${source} references missing function ${targetId}`)
    }
  }

  const roots = new Set([
    ...loadRoots,
    ...tickRoots,
    `${options.namespace}:start`,
    `${options.namespace}:pause`,
    `${options.namespace}:resume`,
    `${options.namespace}:stop`,
    `${options.namespace}:uninstall`,
    `${options.namespace}:runtime/repeat`,
  ])
  const reachable = new Set<string>()
  const queue = [...roots]
  while (queue.length > 0) {
    const id = queue.pop()!
    if (reachable.has(id)) continue
    if (!functions.has(id)) acceptanceError(`entry point references missing function ${id}`)
    reachable.add(id)
    for (const referenced of references.get(id) ?? []) queue.push(referenced)
  }
  for (const id of functions.keys()) {
    if (id.includes(':events/') && !reachable.has(id)) acceptanceError(`event function ${id} is unreachable`)
  }

  if (clockMode === 'schedule-basic') {
    const install = functions.get(`${options.namespace}:install`)!.text
    const uninstall = functions.get(`${options.namespace}:uninstall`)!.text
    const tick = functions.get(`${options.namespace}:runtime/tick`)!.text
    if (!/scoreboard players set #state \S+ 3(?:\n|$)/u.test(uninstall)) {
      acceptanceError('Java 1.14 uninstall lacks its deferred cleanup state')
    }
    if (!uninstall.includes(`schedule function ${options.namespace}:runtime/tick 1t`)
      || !tick.includes('matches 3 run scoreboard objectives remove')) {
      acceptanceError('Java 1.14 uninstall cannot finish objective cleanup without schedule clear')
    }
    if (!/matches 3 run scoreboard players set #state \S+ 0/u.test(install)) {
      acceptanceError('Java 1.14 reinstall cannot cancel a pending deferred cleanup')
    }
  }
  if (clockMode === 'schedule-clear-replace') {
    const stop = functions.get(`${options.namespace}:stop`)!.text
    if (!stop.includes(`schedule clear ${options.namespace}:runtime/tick`)) {
      acceptanceError('modern stop does not clear its pending clock')
    }
  }

  const reportText = files['knead-export-report.json']
  if (reportText === undefined) acceptanceError('missing knead-export-report.json')
  const report = parseJsonObject(reportText, 'knead-export-report.json')
  if (report.namespace !== options.namespace || report.targetVersion !== options.targetVersion) {
    acceptanceError('export report identity does not match the accepted pack')
  }
  const summary = report.summary
  if (!summary || typeof summary !== 'object' || Array.isArray(summary)) {
    acceptanceError('export report is missing its summary')
  }
  const eventCount = (summary as Record<string, unknown>).eventCount
  if (!Number.isInteger(eventCount) || eventCount !== eventCommandCount) {
    acceptanceError(`report event count ${String(eventCount)} does not match ${eventCommandCount} sound commands`)
  }

  return {
    layout,
    clockMode,
    fileCount: entries.length,
    functionCount: functions.size,
    functionReferenceCount: referenceCount,
    eventCommandCount,
    reachableFunctionCount: reachable.size,
  }
}

type NbtTagId = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12

interface NbtTag {
  type: NbtTagId
  value: unknown
  elementType?: number
}

type NbtCompound = Record<string, NbtTag>

class IndependentNbtReader {
  private readonly view: DataView
  private readonly decoder = new TextDecoder('utf-8', { fatal: true })
  private offset = 0
  private itemCount = 0

  constructor(private readonly data: Uint8Array) {
    this.view = new DataView(data.buffer, data.byteOffset, data.byteLength)
  }

  private require(count: number): void {
    if (!Number.isSafeInteger(count) || count < 0 || this.offset + count > this.data.byteLength) {
      acceptanceError('truncated NBT payload')
    }
  }

  private countItems(count: number): void {
    if (!Number.isSafeInteger(count) || count < 0 || this.itemCount + count > MAX_NBT_ITEMS) {
      acceptanceError('NBT item budget exceeded')
    }
    this.itemCount += count
  }

  private i8(): number {
    this.require(1)
    return this.view.getInt8(this.offset++)
  }

  private u8(): number {
    this.require(1)
    return this.view.getUint8(this.offset++)
  }

  private i16(): number {
    this.require(2)
    const value = this.view.getInt16(this.offset, false)
    this.offset += 2
    return value
  }

  private u16(): number {
    this.require(2)
    const value = this.view.getUint16(this.offset, false)
    this.offset += 2
    return value
  }

  private i32(): number {
    this.require(4)
    const value = this.view.getInt32(this.offset, false)
    this.offset += 4
    return value
  }

  private i64(): bigint {
    this.require(8)
    const value = this.view.getBigInt64(this.offset, false)
    this.offset += 8
    return value
  }

  private f32(): number {
    this.require(4)
    const value = this.view.getFloat32(this.offset, false)
    this.offset += 4
    return value
  }

  private f64(): number {
    this.require(8)
    const value = this.view.getFloat64(this.offset, false)
    this.offset += 8
    return value
  }

  private string(): string {
    const length = this.u16()
    this.require(length)
    let value: string
    try {
      value = this.decoder.decode(this.data.subarray(this.offset, this.offset + length))
    }
    catch {
      return acceptanceError('NBT contains invalid UTF-8')
    }
    this.offset += length
    return value
  }

  private collectionLength(): number {
    const length = this.i32()
    this.countItems(length)
    return length
  }

  private payload(type: number, depth: number): NbtTag {
    if (depth > MAX_NBT_DEPTH) acceptanceError('NBT nesting limit exceeded')
    if (type < 1 || type > 12) acceptanceError(`unsupported NBT tag ${type}`)
    if (type === 1) return { type, value: this.i8() }
    if (type === 2) return { type, value: this.i16() }
    if (type === 3) return { type, value: this.i32() }
    if (type === 4) return { type, value: this.i64() }
    if (type === 5) return { type, value: this.f32() }
    if (type === 6) return { type, value: this.f64() }
    if (type === 7) {
      const length = this.collectionLength()
      this.require(length)
      const value = this.data.slice(this.offset, this.offset + length)
      this.offset += length
      return { type, value }
    }
    if (type === 8) return { type, value: this.string() }
    if (type === 9) {
      const elementType = this.u8()
      const length = this.collectionLength()
      if (elementType === 0 && length !== 0) acceptanceError('non-empty TAG_End list')
      return {
        type,
        elementType,
        value: Array.from({ length }, () => this.payload(elementType, depth + 1)),
      }
    }
    if (type === 10) {
      const value: NbtCompound = Object.create(null) as NbtCompound
      while (true) {
        const childType = this.u8()
        if (childType === 0) break
        this.countItems(1)
        const name = this.string()
        if (Object.hasOwn(value, name)) acceptanceError(`duplicate NBT name ${JSON.stringify(name)}`)
        value[name] = this.payload(childType, depth + 1)
      }
      return { type, value }
    }
    if (type === 11) {
      const length = this.collectionLength()
      return { type, value: Array.from({ length }, () => this.i32()) }
    }
    const length = this.collectionLength()
    return { type: 12, value: Array.from({ length }, () => this.i64()) }
  }

  root(): { name: string, value: NbtCompound } {
    if (this.u8() !== 10) acceptanceError('NBT root is not a compound')
    const name = this.string()
    const root = this.payload(10, 0)
    if (this.offset !== this.data.byteLength) acceptanceError('trailing bytes after NBT root')
    return { name, value: root.value as NbtCompound }
  }
}

function requiredTag(compound: NbtCompound, name: string, type: NbtTagId): NbtTag {
  const tag = compound[name]
  if (!tag) return acceptanceError(`missing NBT tag ${name}`)
  if (tag.type !== type) return acceptanceError(`NBT tag ${name} has type ${tag.type}, expected ${type}`)
  return tag
}

function compoundValue(tag: NbtTag, label: string): NbtCompound {
  if (tag.type !== 10) return acceptanceError(`${label} must be a compound`)
  return tag.value as NbtCompound
}

function listValue(tag: NbtTag, elementType: NbtTagId, label: string): NbtTag[] {
  if (tag.type !== 9 || tag.elementType !== elementType) {
    return acceptanceError(`${label} must be a TAG_List of type ${elementType}`)
  }
  return tag.value as NbtTag[]
}

function numberValue(tag: NbtTag, label: string): number {
  if (typeof tag.value !== 'number' || !Number.isInteger(tag.value)) {
    return acceptanceError(`${label} must be an integer`)
  }
  return tag.value
}

function stringValue(tag: NbtTag, label: string): string {
  if (tag.type !== 8 || typeof tag.value !== 'string') return acceptanceError(`${label} must be a string`)
  return tag.value
}

function intList(tag: NbtTag, label: string): number[] {
  return listValue(tag, 3, label).map((item, index) => numberValue(item, `${label}[${index}]`))
}

function assertDimensionsEqual(
  actual: Readonly<{ x: number, y: number, z: number }>,
  expected: Readonly<{ x: number, y: number, z: number }> | undefined,
): void {
  if (expected && (actual.x !== expected.x || actual.y !== expected.y || actual.z !== expected.z)) {
    acceptanceError(`dimensions ${actual.x}x${actual.y}x${actual.z} do not match expected ${expected.x}x${expected.y}x${expected.z}`)
  }
}

function validateModernBuild(
  rootName: string,
  root: NbtCompound,
  options: Readonly<BuildAcceptanceOptions>,
  decodedBytes: number,
): BuildAcceptanceResult {
  if (rootName !== '') acceptanceError('modern Structure NBT root name must be empty')
  const dataVersion = numberValue(requiredTag(root, 'DataVersion', 3), 'DataVersion')
  if (dataVersion < 1343) acceptanceError('modern Structure NBT has a pre-flattening DataVersion')
  const size = intList(requiredTag(root, 'size', 9), 'size')
  if (size.length !== 3 || size.some(value => value <= 0)) acceptanceError('size must contain three positive integers')
  const dimensions = { x: size[0], y: size[1], z: size[2] }
  assertDimensionsEqual(dimensions, options.expectedDimensions)

  const paletteTags = listValue(requiredTag(root, 'palette', 9), 10, 'palette')
  if (paletteTags.length === 0) acceptanceError('palette must not be empty')
  let notePaletteCount = 0
  for (let index = 0; index < paletteTags.length; index++) {
    const state = compoundValue(paletteTags[index], `palette[${index}]`)
    const name = stringValue(requiredTag(state, 'Name', 8), `palette[${index}].Name`)
    if (!RESOURCE_LOCATION.test(name)) acceptanceError(`palette[${index}].Name is not a resource location`)
    const propertiesTag = state.Properties
    if (propertiesTag) {
      const properties = compoundValue(propertiesTag, `palette[${index}].Properties`)
      for (const [property, value] of Object.entries(properties)) {
        if (!/^[a-z0-9_]+$/u.test(property)) acceptanceError(`invalid block-state property ${property}`)
        stringValue(value, `palette[${index}].Properties.${property}`)
      }
      if (name === 'minecraft:note_block') {
        const note = Number(stringValue(requiredTag(properties, 'note', 8), 'note_block.note'))
        const powered = stringValue(requiredTag(properties, 'powered', 8), 'note_block.powered')
        stringValue(requiredTag(properties, 'instrument', 8), 'note_block.instrument')
        if (!Number.isInteger(note) || note < 0 || note > 24) acceptanceError('note_block.note is outside 0..24')
        if (powered !== 'true' && powered !== 'false') acceptanceError('note_block.powered must be true or false')
        notePaletteCount++
      }
    }
  }

  const blocks = listValue(requiredTag(root, 'blocks', 9), 10, 'blocks')
  const occupied = new Set<string>()
  let noteBlockCount = 0
  for (let index = 0; index < blocks.length; index++) {
    const block = compoundValue(blocks[index], `blocks[${index}]`)
    const pos = intList(requiredTag(block, 'pos', 9), `blocks[${index}].pos`)
    if (pos.length !== 3) acceptanceError(`blocks[${index}].pos must have three integers`)
    if (pos.some(value => value < 0)
      || pos[0] >= dimensions.x || pos[1] >= dimensions.y || pos[2] >= dimensions.z) {
      acceptanceError(`blocks[${index}] position lies outside the declared size`)
    }
    const key = pos.join(',')
    if (occupied.has(key)) acceptanceError(`duplicate block position ${key}`)
    occupied.add(key)
    const stateIndex = numberValue(requiredTag(block, 'state', 3), `blocks[${index}].state`)
    if (stateIndex < 0 || stateIndex >= paletteTags.length) acceptanceError(`blocks[${index}] palette index is invalid`)
    const state = compoundValue(paletteTags[stateIndex], `palette[${stateIndex}]`)
    if (stringValue(requiredTag(state, 'Name', 8), 'block state Name') === 'minecraft:note_block') noteBlockCount++
    if (block.nbt) compoundValue(block.nbt, `blocks[${index}].nbt`)
  }
  listValue(requiredTag(root, 'entities', 9), 10, 'entities')
  if (noteBlockCount > 0 && notePaletteCount === 0) acceptanceError('note blocks have no note-block palette state')
  return {
    format: options.format,
    dimensions,
    paletteSize: paletteTags.length,
    blockCount: blocks.length,
    noteBlockCount,
    decodedBytes,
  }
}

function validateLegacyBuild(
  rootName: string,
  root: NbtCompound,
  options: Readonly<BuildAcceptanceOptions>,
  decodedBytes: number,
): BuildAcceptanceResult {
  if (rootName !== 'Schematic') acceptanceError('legacy schematic root name must be Schematic')
  const dimensions = {
    x: numberValue(requiredTag(root, 'Width', 2), 'Width'),
    y: numberValue(requiredTag(root, 'Height', 2), 'Height'),
    z: numberValue(requiredTag(root, 'Length', 2), 'Length'),
  }
  if (dimensions.x <= 0 || dimensions.y <= 0 || dimensions.z <= 0) {
    acceptanceError('legacy schematic dimensions must be positive')
  }
  assertDimensionsEqual(dimensions, options.expectedDimensions)
  const volume = dimensions.x * dimensions.y * dimensions.z
  if (!Number.isSafeInteger(volume) || volume > MAX_NBT_ITEMS) acceptanceError('legacy schematic volume is unsafe')
  if (stringValue(requiredTag(root, 'Materials', 8), 'Materials') !== 'Alpha') {
    acceptanceError('legacy schematic Materials must be Alpha')
  }
  const blocks = requiredTag(root, 'Blocks', 7).value as Uint8Array
  const data = requiredTag(root, 'Data', 7).value as Uint8Array
  if (blocks.byteLength !== volume || data.byteLength !== volume) {
    acceptanceError('legacy Blocks/Data arrays do not match the declared volume')
  }
  listValue(requiredTag(root, 'Entities', 9), 10, 'Entities')
  const tileEntities = listValue(requiredTag(root, 'TileEntities', 9), 10, 'TileEntities')
  const expectedTileId = options.format === 'schematic-pre-1.11' ? 'Music' : 'minecraft:noteblock'
  for (let index = 0; index < tileEntities.length; index++) {
    const tile = compoundValue(tileEntities[index], `TileEntities[${index}]`)
    if (stringValue(requiredTag(tile, 'id', 8), 'tile id') !== expectedTileId) {
      acceptanceError(`TileEntities[${index}] uses the wrong note-block ID`)
    }
    const x = numberValue(requiredTag(tile, 'x', 3), 'tile x')
    const y = numberValue(requiredTag(tile, 'y', 3), 'tile y')
    const z = numberValue(requiredTag(tile, 'z', 3), 'tile z')
    const note = numberValue(requiredTag(tile, 'note', 1), 'tile note')
    if (x < 0 || y < 0 || z < 0 || x >= dimensions.x || y >= dimensions.y || z >= dimensions.z) {
      acceptanceError(`TileEntities[${index}] lies outside the declared volume`)
    }
    if (note < 0 || note > 24) acceptanceError(`TileEntities[${index}] note is outside 0..24`)
    const cell = y * dimensions.z * dimensions.x + z * dimensions.x + x
    if (blocks[cell] !== 25) acceptanceError(`TileEntities[${index}] does not point to a legacy note block`)
  }
  const version = compoundValue(requiredTag(root, 'Version', 10), 'Version')
  const expectedVersion = options.format === 'schematic-pre-1.11' ? '1.8' : '1.11.2'
  if (stringValue(requiredTag(version, 'Name', 8), 'Version.Name') !== expectedVersion) {
    acceptanceError(`legacy Version.Name does not match ${options.format}`)
  }
  return {
    format: options.format,
    dimensions,
    blockCount: blocks.reduce((count, block) => count + (block === 0 ? 0 : 1), 0),
    noteBlockCount: tileEntities.length,
    decodedBytes,
  }
}

export function verifyNoteBlockBuild(
  data: Uint8Array,
  options: Readonly<BuildAcceptanceOptions>,
): BuildAcceptanceResult {
  if (data.byteLength < 18 || data[0] !== 0x1f || data[1] !== 0x8b || data[2] !== 0x08) {
    acceptanceError('build is not a GZIP container')
  }
  let decoded: Uint8Array
  try {
    const value = gunzipSync(data, { maxOutputLength: MAX_NBT_BYTES })
    decoded = new Uint8Array(value.buffer, value.byteOffset, value.byteLength).slice()
  }
  catch (error) {
    return acceptanceError(`GZIP payload or checksum is invalid: ${String(error)}`)
  }
  if (decoded.byteLength === 0 || decoded.byteLength > MAX_NBT_BYTES) {
    acceptanceError('decoded NBT size is invalid')
  }
  const parsed = new IndependentNbtReader(decoded).root()
  return options.format === 'structure-block-nbt' || options.format === 'litematica-compatible-nbt'
    ? validateModernBuild(parsed.name, parsed.value, options, decoded.byteLength)
    : validateLegacyBuild(parsed.name, parsed.value, options, decoded.byteLength)
}
