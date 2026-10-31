import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import '@fontsource/manrope/latin-400.css'
import '@fontsource/manrope/latin-500.css'
import '@fontsource/manrope/latin-600.css'
import '@fontsource/manrope/latin-700.css'
import '@fontsource/manrope/latin-800.css'
import '@fontsource/anton/latin-400.css'
import '@fontsource/bebas-neue/latin-400.css'
import '@fontsource/playfair-display/latin-700.css'
import '@fontsource/playfair-display/latin-900.css'
import '@fontsource/cormorant-garamond/latin-600.css'
import '@fontsource/cinzel/latin-600.css'
import './styles.css'
import App from './App'
import ErrorBoundary from './components/ErrorBoundary'
import { LanguageProvider } from './i18n'
import { isDesktopApp } from './lib'

if (isDesktopApp) {
  document.documentElement.classList.add('is-desktop')
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <LanguageProvider>
      <ErrorBoundary>
        <App />
      </ErrorBoundary>
    </LanguageProvider>
  </StrictMode>,
)
