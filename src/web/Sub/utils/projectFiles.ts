export const MAX_KNEAD_PROJECT_PATHS = 32

function projectPathDedupeKey(path: string): string {
  const normalized = path.replace(/\\/g, '/')
  return /^(?:[a-z]:|\/\/)/i.test(normalized) ? normalized.toLowerCase() : normalized
}

export function findStudioSongPaths(paths: readonly string[]): string[] {
  const projects: string[] = []
  const seen = new Set<string>()
  for (const path of paths) {
    if (!/\.(?:kp|nbs)$/i.test(path)) continue
    const key = projectPathDedupeKey(path)
    if (seen.has(key)) continue
    seen.add(key)
    projects.push(path)
    if (projects.length === MAX_KNEAD_PROJECT_PATHS) break
  }
  return projects
}

/** Compatibility name retained for existing workspace and standalone editor callers. */
export const findKneadProjectPaths = findStudioSongPaths

export function findKneadProjectPath(paths: readonly string[]): string | undefined {
  return findKneadProjectPaths(paths)[0]
}

export function _selfCheckProjectFiles(): void {
  const selected = findKneadProjectPath([
    'C:\\projects\\notes.json',
    'C:\\projects\\song.KP',
    'C:\\projects\\ignored.kp.json',
  ])
  if (selected !== 'C:\\projects\\song.KP') {
    throw new Error(`.kp の抽出結果が不正です: ${String(selected)}`)
  }
  if (findKneadProjectPath(['project.kp.json']) !== undefined) {
    throw new Error('.kp/.nbs 以外をプロジェクトとして扱っています')
  }
  if (findKneadProjectPaths(['song.kp', 'song.kp']).length !== 1) {
    throw new Error('重複した .kp パスを除外できていません')
  }
  console.log('projectFiles self-check OK')
}
