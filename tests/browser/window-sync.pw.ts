import { expect, test, type Page } from '@playwright/test'
import en from '../../src/web/i18n/locales/en.json'
import ja from '../../src/web/i18n/locales/ja.json'

async function selectVersion(main: Page, version: string) {
  const field = main.getByRole('combobox', { name: en.version_select })
  await field.click()
  await main.getByRole('option', { name: version, exact: true }).click()
  await expect(field).toBeEnabled()
  await expect(field).toHaveText(version)
}

async function expectSounds(studio: Page, sounds: string[]) {
  const field = studio.getByRole('combobox', { name: en.studio.marker_sound, exact: true })
  await field.click()
  const options = studio.getByRole('listbox').getByRole('option')
  await expect(options).toHaveText(sounds)
  await options.first().click()
  await expect(field).toHaveValue(sounds[0])
}

test('shares live preferences and ready sound catalogs with a separate Studio window', async ({ page: main, context }) => {
  const catalogs: Record<string, string[]> = {
    '1.20.4': ['block.cherry_wood.place', 'block.cherry_wood.step'],
    '1.21.4': ['block.pale_oak_wood.place', 'block.pale_oak_wood.step'],
  }
  // The preview has no Minecraft installation. Replace only the catalog data,
  // leaving settings, subscriptions, version selection and both renderers live.
  await context.addInitScript((sounds: Record<string, string[]>) => {
    Object.defineProperty(window, 'myAPI', {
      configurable: true,
      set(api: Window['myAPI']) {
        api.get_versions = async () => Object.keys(sounds).map(id => ({ id, downloaded: true }))
        api.get_mcSounds = async version => sounds[version].map(id => ({ id, sounds: [] }))
        api.getCurrentSounds = async () => []
        Object.defineProperty(window, 'myAPI', { configurable: true, value: api })
      },
    })
  }, catalogs)

  const studio = await context.newPage()
  await Promise.all([main.goto('/'), studio.goto('/sub.html')])
  await expect(studio.getByRole('button', { name: en.studio.add_marker, exact: true })).toBeVisible()
  await main.getByRole('button', { name: en.settings }).click()
  for (const [theme, language, locale] of [['Dark', '日本語', ja], ['Light', 'English', en]] as const) {
    await main.getByText(theme, { exact: true }).click()
    await expect(studio.locator('html')).toHaveAttribute('data-mode', theme.toLowerCase())
    await main.getByText(language, { exact: true }).click()
    await expect(studio.getByRole('button', { name: locale.studio.add_marker, exact: true })).toBeVisible()
  }
  await main.keyboard.press('Escape')

  await selectVersion(main, '1.20.4')
  const laterStudio = await context.newPage()
  await laterStudio.goto('/sub.html')
  await laterStudio.getByRole('button', { name: en.studio.add_marker, exact: true }).click()
  await expectSounds(laterStudio, catalogs['1.20.4'])
  await expect(laterStudio.locator('html')).toHaveAttribute('data-mode', 'light')
  await laterStudio.close()

  await studio.getByRole('button', { name: en.studio.add_marker, exact: true }).click()
  await expectSounds(studio, catalogs['1.20.4'])

  await selectVersion(main, '1.21.4')
  await expectSounds(studio, catalogs['1.21.4'])

  await main.reload()
  await expect(main.getByRole('combobox', { name: en.version_select })).toHaveText('1.21.4')
  await expect(main.getByText(catalogs['1.21.4'][0], { exact: true }).first()).toBeVisible()
})
