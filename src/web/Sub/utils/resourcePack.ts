export interface ResourcePackAsset {
  /** ZIP-style path, e.g. assets/example/sounds/drums/kick.ogg. */
  path: string
  /** Content-addressed key understood by Knead's audio asset registry. */
  hash: string
}

export interface ResourcePackLayerInput {
  namespace: string
  soundsJson: string
  assets: readonly ResourcePackAsset[]
  /** Higher-priority layers should be supplied later. */
  label?: string
}

export interface ResourcePackSoundVariant {
  path: string
  hash: string
  pitch: number
  volume: number
  weight: number
  stream: boolean
  preload: boolean
  attenuationDistance?: number
}

export interface ResourcePackSound {
  id: string
  subtitle?: string
  variants: ResourcePackSoundVariant[]
}

export interface ResourcePackResolveResult {
  sounds: ResourcePackSound[]
  warnings: string[]
}

interface SoundEntryDetail {
  name: string
  type: 'file' | 'event'
  volume: number
  pitch: number
  weight: number
  stream: boolean
  preload: boolean
  attenuationDistance?: number
}

interface SoundEvent {
  replace: boolean
  subtitle?: string
  sounds: SoundEntryDetail[]
}

interface ParsedLayer {
  namespace: string
  label: string
  events: Map<string, SoundEvent>
  assets: Map<string, ResourcePackAsset>
}

interface ResolveFactor {
  volume: number
  pitch: number
  weight: number
  stream: boolean
  preload: boolean
  attenuationDistance?: number
}

interface LayeredAsset {
  asset: ResourcePackAsset
  priority: number
}

const MAX_SOUNDS_JSON_BYTES = 4 * 1024 * 1024
const MAX_EVENTS = 50_000
const MAX_ENTRIES = 250_000
const MAX_ASSETS = 250_000
const MAX_RESOLUTION_DEPTH = 32
const MAX_VARIANTS_PER_EVENT = 16_384
const MAX_WARNINGS = 1_000
const encoder = new TextEncoder()

function warn(warnings: string[], message: string): void {
  if (warnings.length >= MAX_WARNINGS) return
  if (warnings.includes(message)) return
  if (warnings.length < MAX_WARNINGS - 1) warnings.push(message)
  else if (warnings.length === MAX_WARNINGS - 1) warnings.push('Additional resource-pack warnings were omitted.')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function namespace(value: string): string {
  if (!/^[a-z0-9_.-]{1,64}$/.test(value)) throw new Error(`Invalid resource namespace: ${value}`)
  return value
}

function resourcePath(value: string): string {
  const normalized = value.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
  if (!normalized || normalized.length > 512 || normalized.split('/').some(segment => !segment || segment === '.' || segment === '..')) {
    throw new Error(`Invalid resource path: ${value}`)
  }
  if (!/^[a-z0-9_./-]+$/.test(normalized)) throw new Error(`Invalid resource path: ${value}`)
  return normalized
}

function location(value: string, fallbackNamespace: string): { namespace: string, path: string, id: string } {
  const separator = value.indexOf(':')
  const ns = namespace(separator >= 0 ? value.slice(0, separator) : fallbackNamespace)
  const path = resourcePath(separator >= 0 ? value.slice(separator + 1) : value)
  return { namespace: ns, path, id: `${ns}:${path}` }
}

function finite(
  value: unknown,
  fallback: number,
  minimum: number,
  maximum: number,
  field: string,
): number {
  if (value === undefined) return fallback
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum || value > maximum) {
    throw new Error(`Invalid sounds.json ${field}`)
  }
  return value
}

function bool(value: unknown, fallback: boolean, field: string): boolean {
  if (value === undefined) return fallback
  if (typeof value !== 'boolean') throw new Error(`Invalid sounds.json ${field}`)
  return value
}

function entry(value: unknown, fallbackNamespace: string): SoundEntryDetail {
  if (typeof value === 'string') {
    const resolved = location(value, fallbackNamespace)
    return {
      name: resolved.id, type: 'file', volume: 1, pitch: 1, weight: 1,
      stream: false, preload: false,
    }
  }
  if (!isRecord(value) || typeof value.name !== 'string') throw new Error('Invalid sounds.json sound entry')
  const resolved = location(value.name, fallbackNamespace)
  const type = value.type === undefined || value.type === 'file'
    ? 'file'
    : value.type === 'event'
      ? 'event'
      : undefined
  if (!type) throw new Error(`Invalid sounds.json sound type: ${String(value.type)}`)
  const attenuationDistance = value.attenuation_distance === undefined
    ? undefined
    : finite(value.attenuation_distance, 16, 0, 1_000_000, 'attenuation_distance')
  return {
    name: resolved.id,
    type,
    volume: finite(value.volume, 1, 0, 1_000_000, 'volume'),
    pitch: finite(value.pitch, 1, 0.000_001, 1_000_000, 'pitch'),
    weight: Math.round(finite(value.weight, 1, 1, 2_147_483_647, 'weight')),
    stream: bool(value.stream, false, 'stream'),
    preload: bool(value.preload, false, 'preload'),
    attenuationDistance,
  }
}

function parseLayer(input: ResourcePackLayerInput): ParsedLayer {
  const ns = namespace(input.namespace)
  if (encoder.encode(input.soundsJson).byteLength > MAX_SOUNDS_JSON_BYTES) throw new Error('sounds.json exceeds the size limit')
  let raw: unknown
  try {
    raw = JSON.parse(input.soundsJson)
  }
  catch (error) {
    throw new Error(`Invalid sounds.json JSON: ${error instanceof Error ? error.message : String(error)}`, { cause: error })
  }
  if (!isRecord(raw) || Object.keys(raw).length > MAX_EVENTS) throw new Error('sounds.json has an invalid event count')
  const events = new Map<string, SoundEvent>()
  let totalEntries = 0
  for (const [rawId, rawEvent] of Object.entries(raw)) {
    const eventId = location(rawId, ns).id
    if (!isRecord(rawEvent) || !Array.isArray(rawEvent.sounds)) throw new Error(`Invalid sound event: ${eventId}`)
    totalEntries += rawEvent.sounds.length
    if (totalEntries > MAX_ENTRIES) throw new Error('sounds.json entries exceed the safety limit')
    if (rawEvent.subtitle !== undefined && (typeof rawEvent.subtitle !== 'string' || rawEvent.subtitle.length > 512)) {
      throw new Error(`Invalid subtitle for sound event: ${eventId}`)
    }
    events.set(eventId, {
      replace: bool(rawEvent.replace, false, 'replace'),
      subtitle: rawEvent.subtitle as string | undefined,
      sounds: rawEvent.sounds.map(value => entry(value, ns)),
    })
  }
  if (input.assets.length > MAX_ASSETS) throw new Error('Resource-pack assets exceed the safety limit')
  const assets = new Map<string, ResourcePackAsset>()
  for (const asset of input.assets) {
    if (!asset.hash || asset.hash.length > 256) throw new Error(`Invalid resource-pack asset key: ${asset.path}`)
    const normalized = resourcePath(asset.path)
    const key = normalized.toLowerCase()
    if (assets.has(key)) throw new Error(`Duplicate resource-pack asset path: ${asset.path}`)
    assets.set(key, { path: normalized, hash: asset.hash })
  }
  return { namespace: ns, label: input.label ?? ns, events, assets }
}

function fileAssetPaths(id: string): string[] {
  const resolved = location(id, 'minecraft')
  const base = `assets/${resolved.namespace}/sounds/${resolved.path}`
  if (/\.(?:ogg|wav|mp3)$/u.test(resolved.path)) return [base]
  // Java Edition normally appends .ogg. WAV is useful for authoring packs and
  // MP3 is accepted only as a compatibility fallback by the importer.
  return [`${base}.ogg`, `${base}.wav`, `${base}.mp3`]
}

function multiplyFactor(parent: ResolveFactor, child: SoundEntryDetail): ResolveFactor {
  return {
    volume: parent.volume * child.volume,
    pitch: parent.pitch * child.pitch,
    weight: Math.min(2_147_483_647, parent.weight * child.weight),
    stream: parent.stream || child.stream,
    preload: parent.preload || child.preload,
    attenuationDistance: child.attenuationDistance ?? parent.attenuationDistance,
  }
}

function resolveEntry(
  entryValue: SoundEntryDetail,
  events: Map<string, SoundEvent>,
  assets: Map<string, LayeredAsset>,
  factor: ResolveFactor,
  stack: Set<string>,
  warnings: string[],
  output: ResourcePackSoundVariant[],
): void {
  const nextFactor = multiplyFactor(factor, entryValue)
  if (entryValue.type === 'event') {
    if (stack.size >= MAX_RESOLUTION_DEPTH) {
      warn(warnings, `Sound event recursion exceeded ${MAX_RESOLUTION_DEPTH}: ${entryValue.name}.`)
      return
    }
    if (stack.has(entryValue.name)) {
      warn(warnings, `Sound event cycle was ignored: ${[...stack, entryValue.name].join(' → ')}.`)
      return
    }
    const nested = events.get(entryValue.name)
    if (!nested) {
      warn(warnings, `Referenced sound event is missing: ${entryValue.name}.`)
      return
    }
    stack.add(entryValue.name)
    for (const child of nested.sounds) {
      if (output.length >= MAX_VARIANTS_PER_EVENT) break
      resolveEntry(child, events, assets, nextFactor, stack, warnings, output)
    }
    stack.delete(entryValue.name)
    return
  }
  const expectedPaths = fileAssetPaths(entryValue.name)
  const matches = expectedPaths
    .map(path => assets.get(path.toLowerCase()))
    .filter((asset): asset is LayeredAsset => !!asset)
    .sort((left, right) => right.priority - left.priority)
  const selected = matches[0]
  if (!selected) {
    warn(warnings, `Sound file is missing: ${expectedPaths[0]}.`)
    return
  }
  const asset = selected.asset
  if (matches.length > 1) {
    warn(warnings, `Multiple audio formats exist for ${entryValue.name}; ${asset.path} was preferred.`)
  }
  output.push({
    path: asset.path,
    hash: asset.hash,
    pitch: Math.max(0.5, Math.min(2, nextFactor.pitch)),
    volume: Math.max(0, Math.min(1, nextFactor.volume)),
    weight: Math.max(1, Math.round(nextFactor.weight)),
    stream: nextFactor.stream,
    preload: nextFactor.preload,
    attenuationDistance: nextFactor.attenuationDistance,
  })
}

/**
 * Resolve layered Java Edition resource-pack `sounds.json` manifests into a
 * deterministic, flattened sound library. `replace` follows pack priority;
 * event indirection is cycle/budget guarded and missing audio stays visible as
 * warnings instead of becoming a silent variant.
 */
export function resolveResourcePackSounds(inputs: readonly ResourcePackLayerInput[]): ResourcePackResolveResult {
  if (!inputs.length) return { sounds: [], warnings: [] }
  const layers = inputs.map(parseLayer)
  const events = new Map<string, SoundEvent>()
  const assets = new Map<string, LayeredAsset>()
  const warnings: string[] = []
  for (let priority = 0; priority < layers.length; priority++) {
    const layer = layers[priority]
    for (const [path, asset] of layer.assets) assets.set(path, { asset, priority })
    for (const [id, incoming] of layer.events) {
      const previous = events.get(id)
      events.set(id, previous && !incoming.replace
        ? {
            replace: false,
            subtitle: incoming.subtitle ?? previous.subtitle,
            sounds: [...previous.sounds, ...incoming.sounds],
          }
        : { ...incoming, sounds: [...incoming.sounds] })
    }
  }
  const sounds: ResourcePackSound[] = []
  for (const [id, event] of [...events.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    const variants: ResourcePackSoundVariant[] = []
    for (const soundEntry of event.sounds) {
      if (variants.length >= MAX_VARIANTS_PER_EVENT) {
        warn(warnings, `Sound event ${id} exceeded ${MAX_VARIANTS_PER_EVENT} resolved variants.`)
        break
      }
      resolveEntry(
        soundEntry,
        events,
        assets,
        { volume: 1, pitch: 1, weight: 1, stream: false, preload: false },
        new Set([id]),
        warnings,
        variants,
      )
    }
    if (variants.length) sounds.push({ id, subtitle: event.subtitle, variants })
    else if (event.sounds.length) warn(warnings, `Sound event has no playable files: ${id}.`)
  }
  return { sounds, warnings: Array.from(new Set(warnings)) }
}
