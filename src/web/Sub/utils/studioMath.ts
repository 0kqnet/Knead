export function stableVariantIndex(
  randomSeed: number,
  markerId: string,
  firingIndex: number,
  variantCount: number,
): number {
  if (variantCount <= 0) return -1
  let hash = 2166136261
  const input = `${randomSeed}:${markerId}:${firingIndex}`
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0) % variantCount
}

export function sanitizeStemName(value: string): string {
  const sanitized = Array.from(value)
    .map(character => character.charCodeAt(0) < 32 || /[<>:"/\\|?*]/.test(character) ? '_' : character)
    .join('')
    .replace(/^[ .]+|[ .]+$/g, '')
  return (sanitized || 'Track').slice(0, 80)
}

export function stemFileName(index: number, trackName: string, extension: string): string {
  return `${String(index + 1).padStart(2, '0')}_${sanitizeStemName(trackName)}.${extension}`
}
