import { expect, test, type Locator, type Page } from '@playwright/test'
import { createDefaultTrack, DEFAULT_MASTER, DEFAULT_SETTINGS, type Marker } from '../../src/web/Sub/types/timeline'
import { serialize } from '../../src/web/Sub/utils/timelineIO'

async function openRoll(page: Page, markers: Marker[], lengthTicks: number) {
  const json = serialize({
    projectId: 'roll-navigation', targetVersion: '1.21.4', randomSeed: 1,
    tracks: [createDefaultTrack('notes')], markers, lengthTicks,
    settings: structuredClone(DEFAULT_SETTINGS), master: { ...DEFAULT_MASTER }, referenceAudio: [], customAudio: [],
  })
  await page.goto('/sub.html')
  await page.getByRole('button', { name: 'File', exact: true }).waitFor()
  await page.evaluate((json) => {
    window.myAPI.timeline.openDialog = async () => ({ ok: true, kind: 'kp', path: '/fixture/navigation.kp', json })
  }, json)
  await page.keyboard.press('Control+o')
  await page.locator('[data-marker-id="n0"]').first().waitFor()
  await page.getByRole('button', { name: 'View', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Piano Roll', exact: true }).click()
  return page.getByRole('dialog', { name: 'Piano Roll', exact: true })
}

function note(i: number, tick: number): Marker {
  return { id: 'n' + i, trackId: 'notes', tick, pitch: 1, soundId: 'block.note_block.harp', volume: 1, variantIndex: -1, duration: 4 }
}

function readView(scroll: Locator) {
  return scroll.evaluate((el) => {
    const grid = el.querySelector<HTMLElement>('[data-px-per-tick]')!
    const keys = grid.previousElementSibling!.getBoundingClientRect().width
    const width = el.clientWidth - keys
    return {
      left: el.scrollLeft, width, scale: Number(grid.dataset.pxPerTick),
      x: el.getBoundingClientRect().left + el.clientLeft + keys,
      y: el.getBoundingClientRect().top + el.clientTop + 30,
    }
  })
}

test('keeps the pointer and viewport center on the same tick while zooming a 12,000-note track', async ({ page }) => {
  const markers = Array.from({ length: 12_000 }, (_, i) => note(i, i * 8))
  markers[0].duration = 12_000 * 8
  const dialog = await openRoll(page, markers, 96_010)
  const scroll = dialog.getByTestId('piano-roll-scroll')
  const grid = dialog.getByTestId('piano-roll-grid')
  expect(await grid.locator('[data-piano-roll-note]').count()).toBeLessThan(241)
  await scroll.evaluate(el => { el.scrollLeft = 8490 * 8 * Number(el.querySelector<HTMLElement>('[data-px-per-tick]')!.dataset.pxPerTick) })
  const laterNote = grid.locator('[data-piano-roll-note="n8500"]')
  await expect(laterNote).toBeInViewport()
  await expect(grid.locator('[data-piano-roll-note="n0"]')).toBeAttached()

  const before = await readView(scroll)
  const anchor = Math.round(before.width * 0.7)
  await page.mouse.move(before.x + anchor, before.y)
  await page.keyboard.down('Control')
  await page.mouse.wheel(0, -90)
  await page.keyboard.up('Control')
  await expect.poll(async () => (await readView(scroll)).scale).toBeGreaterThan(before.scale)
  const after = await readView(scroll)
  expect(Math.abs((before.left + anchor) / before.scale - (after.left + anchor) / after.scale)).toBeLessThan(1)

  await dialog.getByRole('button', { name: 'X＋', exact: true }).click()
  const centered = await readView(scroll)
  expect(centered.scale).toBeGreaterThan(after.scale)
  expect(Math.abs((after.left + after.width / 2) / after.scale - (centered.left + centered.width / 2) / centered.scale)).toBeLessThan(1)
  await page.mouse.move(before.x + anchor, before.y)
  await page.keyboard.down('Shift')
  await page.mouse.wheel(0, 180)
  await page.keyboard.up('Shift')
  await expect.poll(async () => (await readView(scroll)).left).toBeGreaterThan(centered.left)

  const centerRow = () => scroll.evaluate(el => (
    (el.scrollTop + el.clientHeight / 2) / el.querySelector('.piano-roll-key')!.getBoundingClientRect().height
  ))
  const pitchBefore = await centerRow()
  await dialog.getByRole('button', { name: 'Y＋', exact: true }).click()
  expect(Math.abs(await centerRow() - pitchBefore)).toBeLessThan(0.1)
  await dialog.getByRole('button', { name: 'Y−', exact: true }).click()

  await dialog.getByRole('button', { name: 'Fit', exact: true }).click()
  await expect(grid.locator('canvas')).toBeVisible()
  const fit = await readView(scroll)
  expect(fit.left).toBe(0)
  expect((96_000 - 1) * fit.scale).toBeLessThanOrEqual(fit.width)
  expect(await grid.locator('[data-piano-roll-note]').count()).toBe(1)
  await scroll.evaluate(el => { el.scrollTop = 120 })
  const rulerTop = (await grid.locator('.piano-roll-grid-line[data-kind="bar"] span').first().boundingBox())!.y
  expect(Math.abs(rulerTop - (await scroll.boundingBox())!.y)).toBeLessThan(3)

  // Canvas notes remain editable by pointer and keyboard, including past the former 5,000-note boundary.
  const bounds = (await grid.boundingBox())!
  await page.mouse.click(bounds.x + Math.floor(8500 * 8 * fit.scale), bounds.y + 12 * 24 + 8)
  await expect(dialog.getByText('1 selected', { exact: true })).toBeVisible()
  const selected = grid.locator('[data-piano-roll-note][aria-pressed="true"]')
  expect(Number((await selected.getAttribute('data-piano-roll-note'))!.slice(1))).toBeGreaterThan(8_000)
  await page.keyboard.press('ArrowUp')
  await expect(dialog.getByRole('button', { name: /Apply 1 change/ })).toBeEnabled()
})

test('reaches and edits the last note beyond the browser-sized scroll surface', async ({ page }) => {
  const lastTick = 5_000_000
  const dialog = await openRoll(page, [note(0, 0), note(1, lastTick)], lastTick + 50)
  const scroll = dialog.getByTestId('piano-roll-scroll')
  const last = dialog.locator('[data-piano-roll-note="n1"]')
  await dialog.locator('[data-piano-roll-note="n0"]').press('Tab')
  await expect(last).toBeFocused()
  await scroll.evaluate(el => { el.scrollLeft = el.scrollWidth })
  await expect(last).toBeInViewport()
  await last.press('ArrowUp')
  await dialog.getByRole('button', { name: /Apply 1 change/ }).click()
  await expect(dialog).toBeHidden()
  await page.getByRole('button', { name: 'View', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Piano Roll', exact: true }).click()
  await expect(last).toBeInViewport()
  await expect(last).toHaveAttribute('aria-label', /C♯4/)
})
