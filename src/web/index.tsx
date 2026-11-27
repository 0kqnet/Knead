import React from 'react'
import './Style.css'
import { App } from './Main/App'
import { AppInitialize } from './AppInitialize'
import { createRoot } from 'react-dom/client'
import { KneadUIProvider } from './components/KneadUIProvider'
import { HashRouter, Routes, Route } from 'react-router'
import { store } from '../store/_store'
import { Provider } from 'react-redux'
import './i18n/configs'
import '../tauri-api'

const SubApp = React.lazy(async () => {
  const module = await import('./Sub/App')
  return { default: module.SubApp }
})

const studio = (
  <React.Suspense fallback={<div role="status" aria-live="polite">Loading Studio…</div>}>
    <SubApp />
  </React.Suspense>
)

const isSubWindow = window.location.pathname.endsWith('/sub.html')

createRoot(document.getElementById('root') as Element).render(
  <Provider store={store}>
    <KneadUIProvider>
      <AppInitialize />
      {isSubWindow
        ? studio
        : (
            <HashRouter>
              <Routes>
                <Route index element={<App />} />
                <Route path="sub" element={studio} />
              </Routes>
            </HashRouter>
          )}
    </KneadUIProvider>
  </Provider>,
)
