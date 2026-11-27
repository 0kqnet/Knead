import { expect, test, type Page } from '@playwright/test'

async function addMarker(page: Page) {
  await page.getByRole('button', { name: '+ Marker', exact: true }).click()
  await page.getByRole('option', { name: 'block.note_block.harp' }).click()
}

test('opens select options above Studio dialogs and keeps the marker selected on Escape', async ({ page }) => {
  await page.goto('/sub.html')
  await addMarker(page)
  await page.getByRole('button', { name: 'Export', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Audio Export' }).click()
  const dialog = page.getByRole('dialog', { name: 'Audio Export' })
  const format = dialog.getByRole('combobox', { name: 'Format' })
  await format.click()
  await page.getByRole('option', { name: 'FLAC', exact: true }).click()
  await expect(format).toHaveText('FLAC')

  await format.click()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('listbox')).toBeHidden()
  await expect(dialog).toBeVisible()
  await dialog.getByRole('button', { name: 'Close', exact: true }).click()
  await expect(page.getByRole('region', { name: 'Inspector' })).toContainText('1 marker selected')

  await page.getByRole('button', { name: 'Tools' }).click()
  await page.getByRole('menuitem', { name: 'Macros' }).click()
  const macros = page.getByRole('dialog', { name: 'Note Block Studio macros' })
  await macros.getByRole('combobox').first().click()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('listbox')).toBeHidden()
  await expect(macros).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(macros).toBeHidden()

  await page.getByRole('button', { name: 'Tools' }).click()
  await page.getByRole('menuitem', { name: 'Extensions', exact: true }).click()
  const extensions = page.getByRole('dialog', { name: 'Studio extensions' })
  await extensions.getByRole('combobox', { name: 'Note block preset' }).click()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('listbox')).toBeHidden()
  await expect(extensions).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(extensions).toBeHidden()
})

test('keeps the selected track, inspector and mixer controls reachable together', async ({ page }) => {
  await page.goto('/sub.html')
  for (let i = 0; i < 7; i++) await page.getByRole('button', { name: '+ Track', exact: true }).click()
  await page.getByRole('button', { name: 'Mixer', exact: true }).click()
  await addMarker(page)
  await addMarker(page)

  const track = page.locator('[data-track-header-id]').last()
  await expect(track).toBeInViewport({ ratio: 0.99 })
  const timeline = page.locator('.studio-timeline-viewport')
  const inspector = page.getByRole('region', { name: 'Inspector' })
  const timelineBox = (await timeline.boundingBox())!
  const inspectorBox = (await inspector.boundingBox())!
  const trackBox = (await track.boundingBox())!
  expect(timelineBox.height).toBeGreaterThan(2 * trackBox.height)
  expect(inspectorBox.x).toBeGreaterThanOrEqual(timelineBox.x + timelineBox.width - 1)
  const pan = track.getByRole('slider', { name: 'Pan', exact: true })
  const thumb = (await pan.boundingBox())!
  expect(thumb.y + thumb.height).toBeLessThanOrEqual(trackBox.y + trackBox.height)
  await pan.focus()
  await pan.press('ArrowRight')
  await expect(pan).not.toHaveAttribute('aria-valuenow', '0')

  const mixer = page.getByRole('region', { name: 'Mixer' })
  const mute = mixer.getByRole('button', { name: 'Mute: Track 8', exact: true })
  await expect(mute).toBeInViewport({ ratio: 0.99 })
  await mute.click()
  await expect(track.getByRole('button', { name: 'Mute', exact: true })).toHaveAttribute('aria-pressed', 'true')
  const limiter = mixer.getByRole('button', { name: /LIMIT/ })
  const masterBox = await limiter.boundingBox()
  await mixer.getByRole('button', { name: 'Solo: Track 1', exact: true }).click()
  expect(await limiter.boundingBox()).toEqual(masterBox)
  await limiter.click()

  const snap = inspector.getByRole('button', { name: 'Pitch snap' })
  await snap.click()
  await expect(snap).toHaveAttribute('aria-pressed', 'true')
  const curve = inspector.locator('svg.studio-curve').last()
  const graph = (await curve.boundingBox())!
  expect(graph.x + graph.width).toBeLessThanOrEqual(inspectorBox.x + inspectorBox.width)
  await curve.locator('circle').last().click({ button: 'right' })
  await inspector.getByRole('button', { name: 'Ease Out', exact: true }).click()
})

test('keeps the Japanese toolbar and zoom usable alongside the dark inspector', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: 'Settings' }).click()
  await page.getByText('Dark', { exact: true }).click()
  await page.getByText('日本語', { exact: true }).click()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('dialog')).toBeHidden()
  await page.evaluate(() => { window.location.hash = '/sub' })
  await page.getByRole('button', { name: 'ミキサー', exact: true }).click()
  await page.getByRole('button', { name: '+ マーカー', exact: true }).click()
  await page.getByRole('option', { name: 'block.note_block.harp' }).click()
  await expect(page.locator('html')).toHaveAttribute('data-mode', 'dark')
  const zoom = page.locator('.studio-zoom-controls')
  const value = zoom.locator('.studio-zoom-value')
  await expect(value).toHaveText('100%')
  await zoom.getByRole('button', { name: '拡大', exact: true }).click()
  await expect(value).toHaveText('135%')
  await expect(page.getByRole('region', { name: 'プロパティ' })).toBeInViewport({ ratio: 0.99 })
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(page.viewportSize()!.width)
})

test('lets manual scrolling take precedence over the playhead while playing', async ({ page }) => {
  await page.goto('/sub.html')
  await page.getByRole('button', { name: 'Play', exact: true }).click()
  const pause = page.getByRole('button', { name: 'Pause', exact: true })
  await expect(pause).toBeVisible()

  const timeline = page.locator('.studio-timeline-viewport')
  const { left, positions } = await timeline.evaluate(async (element) => {
    const distance = element.scrollWidth - element.clientWidth
    element.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaX: distance }))
    element.scrollLeft = distance
    const left = element.scrollLeft
    const positions = []
    for (let frame = 0; frame < 3; frame++) {
      await new Promise<number>(requestAnimationFrame)
      positions.push(element.scrollLeft)
    }
    return { left, positions }
  })
  expect(left).toBeGreaterThan(300)
  expect(positions).toEqual([left, left, left])

  await expect.poll(() => timeline.evaluate(element => element.scrollLeft)).toBeLessThan(left - 100)
  await expect(pause).toBeVisible()
})
