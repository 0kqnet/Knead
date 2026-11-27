import { expect, test, type Locator, type Page } from '@playwright/test'
import en from '../../src/web/i18n/locales/en.json'
import ja from '../../src/web/i18n/locales/ja.json'

async function expectAlignedList(page: Page, trigger: Locator) {
  const list = page.getByRole('listbox')
  await expect(list).toBeVisible()
  await expect.poll(async () => {
    const field = await trigger.boundingBox()
    const popup = await list.boundingBox()
    if (!field || !popup) return Infinity
    return Math.max(Math.abs(field.x - popup.x), Math.abs(field.width - popup.width))
  }).toBeLessThanOrEqual(1)
  expect(await list.getByRole('option').evaluateAll(options =>
    options.every(el => el.scrollWidth <= el.clientWidth + 1),
  )).toBe(true)
  return list
}

const themes = [
  { mode: 'light', theme: 'Light', language: 'English', locale: en },
  { mode: 'dark', theme: 'Dark', language: '日本語', locale: ja },
] as const

for (const { mode, theme, language, locale } of themes) {
  test(`aligns the main and Studio dropdowns in ${mode} mode`, async ({ page }) => {
    const labels = locale.studio
    await page.goto('/')
    await page.getByRole('button', { name: 'Settings' }).click()
    await page.getByText(theme, { exact: true }).click()
    await page.getByText(language, { exact: true }).click()
    await page.keyboard.press('Escape')
    await expect(page.getByRole('dialog')).toBeHidden()
    await expect(page.locator('html')).toHaveAttribute('data-mode', mode)

    // The browser preview has no native version catalog. Supply two entries
    // before remounting the main screen to exercise its virtualized selector.
    await page.evaluate(() => {
      window.myAPI.get_versions = async () => [{ id: '1.21.4', downloaded: true }, { id: '1.20.4', downloaded: false }]
      window.location.hash = '/sub'
    })
    const snap = page.getByRole('combobox', { name: labels.snap })
    await snap.click()
    await expectAlignedList(page, snap)
    await page.keyboard.press('Escape')
    await page.evaluate(() => { window.location.hash = '/' })
    const version = page.getByRole('combobox', { name: locale.version_select })
    await version.click()
    const versions = await expectAlignedList(page, version)
    await expect(versions.getByRole('option')).toHaveCount(2)
    await version.press('ArrowDown')
    await version.press('Escape')
    await expect(versions).toBeHidden()

    await page.evaluate(() => { window.location.hash = '/sub' })
    await page.getByRole('button', { name: labels.add_marker, exact: true }).click()
    const sound = page.getByRole('combobox', { name: labels.marker_sound, exact: true })
    const sounds = await expectAlignedList(page, sound)
    await sounds.getByRole('option', { name: 'block.note_block.harp' }).click()

    await page.getByRole('button', { name: labels.export, exact: true }).click()
    await page.getByRole('menuitem', { name: labels.audio_export }).click()
    const dialog = page.getByRole('dialog', { name: labels.audio_export })
    const format = dialog.getByRole('combobox', { name: labels.format })
    const range = dialog.getByRole('combobox', { name: labels.range })
    const output = dialog.getByRole('group', { name: labels.output })
    const boxes = await Promise.all([format, output, range].map(el => el.boundingBox()))
    for (const box of boxes) {
      expect(box!.height).toBe(36)
      expect(Math.abs(box!.y - boxes[0]!.y)).toBeLessThanOrEqual(1)
    }
    expect(await range.locator('.ui-select__value-text').evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true)
    const mix = output.getByRole('button', { name: labels.audio_export_mix, exact: true })
    await expect(mix).toHaveAttribute('aria-pressed', 'true')
    const selectedColor = await mix.evaluate(el => getComputedStyle(el).backgroundColor)
    await format.click()
    const formats = await expectAlignedList(page, format)
    await expect(formats.getByRole('option', { selected: true })).toHaveCSS('background-color', selectedColor)
    await page.keyboard.press('ArrowDown')
    await page.keyboard.press('Enter')
    await expect(format).toHaveText('AIFF')
    const stems = output.getByRole('button', { name: labels.audio_export_stems, exact: true })
    await stems.click()
    await expect(stems).toHaveAttribute('aria-pressed', 'true')
    await dialog.getByRole('button', { name: labels.advanced }).click()
    const sampleRate = await dialog.getByRole('combobox', { name: labels.audio_export_sample_rate_preset }).boundingBox()
    const channels = await dialog.getByRole('combobox', { name: labels.audio_export_channels }).boundingBox()
    expect(sampleRate!.x).toBe(channels!.x)
    expect(sampleRate!.width).toBe(channels!.width)
    await dialog.getByRole('button', { name: labels.close_dialog, exact: true }).click()

    await page.getByRole('button', { name: labels.tools_menu }).click()
    await page.getByRole('menuitem', { name: labels.midi_short, exact: true }).click()
    const mapping = page.getByRole('combobox', { name: labels.midi_preview_mapping })
    expect(await mapping.locator('.ui-select__value-text').evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true)
    const midiSound = page.getByRole('combobox', { name: labels.midi_sound })
    await midiSound.fill('custom:melody')
    await midiSound.press('Enter')
    await expect(midiSound).toHaveValue('custom:melody')
    await midiSound.click()
    const midiOptions = await expectAlignedList(page, midiSound)
    await midiOptions.getByRole('option', { name: 'block.note_block.harp' }).click()
    await expect(midiSound).toHaveValue('block.note_block.harp')
  })
}
