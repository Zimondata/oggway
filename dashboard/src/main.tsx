import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App';
import './index.css';

// Debug: catch any render errors
window.onerror = (msg, src, line) => {
  document.getElementById('root')!.innerHTML = `<pre style="color:red;padding:20px">ERROR: ${msg}\n${src}:${line}</pre>`;
};

class ErrorBoundary extends React.Component<{children: React.ReactNode}, {error: Error | null}> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) { return { error }; }
  render() {
    if (this.state.error) {
      return <pre style={{color:'red',padding:20,whiteSpace:'pre-wrap'}}>React Error: {this.state.error.message}{'\n'}{this.state.error.stack}</pre>;
    }
    return this.props.children;
  }
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <ErrorBoundary>
    <App />
  </ErrorBoundary>
);
