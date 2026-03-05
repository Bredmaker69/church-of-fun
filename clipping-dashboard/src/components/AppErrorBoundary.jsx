import React from 'react';

class AppErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = {
      hasError: false,
      errorMessage: '',
    };
  }

  static getDerivedStateFromError(error) {
    return {
      hasError: true,
      errorMessage: String(error?.message || 'Unknown runtime error'),
    };
  }

  componentDidCatch(error, errorInfo) {
    console.error('AppErrorBoundary caught an error:', error, errorInfo);
  }

  componentDidUpdate(prevProps) {
    if (this.state.hasError && prevProps.resetKey !== this.props.resetKey) {
      this.setState({
        hasError: false,
        errorMessage: '',
      });
    }
  }

  handleRetry = () => {
    this.setState({
      hasError: false,
      errorMessage: '',
    });
  };

  render() {
    if (!this.state.hasError) {
      return this.props.children;
    }

    return (
      <section className="glass rounded-3xl p-5 lg:p-6 space-y-3">
        <div className="text-sm font-semibold text-rose-700 dark:text-rose-300">
          Clip Studio hit a runtime error.
        </div>
        <div className="text-xs text-slate-700 dark:text-slate-200 break-words">
          {this.state.errorMessage}
        </div>
        <button
          type="button"
          onClick={this.handleRetry}
          className="inline-flex items-center gap-2 rounded-md bg-primary text-white px-3 py-1.5 text-xs font-semibold"
        >
          Retry Clip Studio
        </button>
      </section>
    );
  }
}

export default AppErrorBoundary;
