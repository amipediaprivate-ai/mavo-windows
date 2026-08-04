import { Component, type ErrorInfo, type ReactNode } from "react";

interface AppErrorBoundaryProps {
  children: ReactNode;
}

interface AppErrorBoundaryState {
  failed: boolean;
}

export class AppErrorBoundary extends Component<AppErrorBoundaryProps, AppErrorBoundaryState> {
  state: AppErrorBoundaryState = { failed: false };

  static getDerivedStateFromError(): AppErrorBoundaryState {
    return { failed: true };
  }

  componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    console.error("Mavo 界面渲染失败", error, errorInfo);
  }

  render() {
    if (this.state.failed) {
      return (
        <main className="app-error" role="alert">
          <div className="app-error-card">
            <span className="app-error-mark" aria-hidden="true">!</span>
            <h1>界面暂时无法显示</h1>
            <p>资源数据没有丢失。重新载入界面即可继续使用。</p>
            <button type="button" onClick={() => window.location.reload()}>重新载入</button>
          </div>
        </main>
      );
    }

    return this.props.children;
  }
}
