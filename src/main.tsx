import React, { StrictMode } from 'react';
import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import './index.css';

class ErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { error: Error | null }
> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { error: null };
  }
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  render() {
    if (this.state.error) {
      return (
        <div style={{ padding: '2rem', fontFamily: 'monospace', background: '#161616', color: '#f4f4f4', minHeight: '100vh' }}>
          <h1 style={{ color: '#da1e28', marginBottom: '1rem' }}>Erro de renderização</h1>
          <pre style={{ whiteSpace: 'pre-wrap', color: '#ff8389', fontSize: '0.85rem' }}>
            {this.state.error.message}
          </pre>
          <pre style={{ whiteSpace: 'pre-wrap', color: '#a8a8a8', fontSize: '0.75rem', marginTop: '1rem' }}>
            {this.state.error.stack}
          </pre>
          <button
            onClick={() => { this.setState({ error: null }); window.location.reload(); }}
            style={{ marginTop: '1.5rem', padding: '0.5rem 1rem', background: '#0f62fe', color: '#fff', border: 'none', cursor: 'pointer' }}
          >
            Recarregar
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
);
