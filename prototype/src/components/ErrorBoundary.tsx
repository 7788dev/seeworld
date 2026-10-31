import { Component } from 'react'
import type { ErrorInfo, ReactNode } from 'react'

interface ErrorBoundaryProps {
  children: ReactNode
}

interface ErrorBoundaryState {
  error: Error | null
}

export default class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[jj] render crashed', error, info.componentStack)
  }

  render() {
    if (!this.state.error) return this.props.children
    return (
      <div
        role="alert"
        style={{
          minHeight: '100vh',
          display: 'grid',
          placeItems: 'center',
          padding: 32,
          background: '#0b0d0a',
          color: '#f2efe6',
          fontFamily: 'Manrope, system-ui, sans-serif',
        }}
      >
        <div style={{ maxWidth: 520, textAlign: 'center' }}>
          <p style={{ letterSpacing: '0.3em', opacity: 0.55, fontSize: 12 }}>SEEWORLD</p>
          <h1 style={{ fontSize: 24, margin: '12px 0' }}>页面遇到了一点问题</h1>
          <p style={{ opacity: 0.72, lineHeight: 1.7 }}>
            Something went wrong while rendering this view. Your local lists and progress are safe.
          </p>
          <button
            type="button"
            onClick={() => window.location.reload()}
            style={{
              marginTop: 20,
              padding: '10px 18px',
              borderRadius: 999,
              border: '1px solid rgba(255,255,255,0.25)',
              background: 'rgba(255,255,255,0.08)',
              color: 'inherit',
              cursor: 'pointer',
            }}
          >
            重新载入 · Reload
          </button>
        </div>
      </div>
    )
  }
}
