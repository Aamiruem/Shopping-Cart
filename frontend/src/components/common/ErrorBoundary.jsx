import { Component } from 'react';

// Catches a crash anywhere below it (a render error, or a page's code that failed to download) and shows a page the
// shopper can recover from, instead of a blank screen. `resetKey` (the current path) clears the error on navigation.
export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null, key: props.resetKey };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  static getDerivedStateFromProps(props, state) {
    return props.resetKey !== state.key ? { error: null, key: props.resetKey } : null;
  }

  componentDidCatch(error, info) {
    console.error('Page crashed', error, info?.componentStack); // no user data: just the error and where it happened
  }

  render() {
    if (!this.state.error) return this.props.children;
    const offline = typeof navigator !== 'undefined' && navigator.onLine === false;
    return (
      <div className="crash-page" role="alert">
        <img src="/brand/arvixa-mark-192.png" width="64" height="64" alt="" />
        <h1>{offline ? 'You’re offline' : 'Something went wrong on this page'}</h1>
        <p>
          {offline
            ? 'Check your internet connection, then try again. Your cart and account are safe.'
            : 'Please reload. If it keeps happening, go back to the home page. Your cart and account are safe.'}
        </p>
        <div className="crash-actions">
          <button type="button" className="btn btn-primary" onClick={() => window.location.reload()}>Reload</button>
          <a className="btn btn-outline" href="/">Home page</a>
        </div>
      </div>
    );
  }
}
