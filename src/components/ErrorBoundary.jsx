import React from "react";

// Displays an error card instead of a blank screen when a child component throws.
export default class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }
  static getDerivedStateFromError(error) {
    return { error };
  }
  componentDidCatch(error, info) {
    console.error("Kolobok render error:", error, info);
  }
  render() {
    if (this.state.error) {
      return (
        <div style={{
          padding: 24, color: "#e2d1c3", background: "#0f0f1a",
          minHeight: "100vh", fontFamily: "Inter, sans-serif"
        }}>
          <h2 style={{ color: "#d4af37" }}>Колобок: ошибка отображения</h2>
          <p style={{ color: "#9da9c0", fontSize: 13, lineHeight: 1.6 }}>
            Приложение не смогло отрисовать интерфейс. Проверьте консоль разработчика (F12) для деталей.
          </p>
          <pre style={{
            padding: 12, background: "#111827", border: "1px solid #2e2e3a",
            borderRadius: 8, color: "#f06c75", fontSize: 11, whiteSpace: "pre-wrap"
          }}>
            {String(this.state.error?.message || this.state.error)}
          </pre>
          <button
            onClick={() => this.setState({ error: null })}
            style={{
              marginTop: 12, padding: "9px 14px", background: "#2b251a",
              border: "1px solid #d4af37", borderRadius: 8, color: "#f1d58b", cursor: "pointer"
            }}
          >
            Попробовать снова
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
