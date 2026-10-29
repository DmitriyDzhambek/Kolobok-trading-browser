import React from "react";
import { Activity, CheckCircle, AlertCircle, XCircle } from "lucide-react";

export default function SystemStatusPanel() {
  const statuses = [
    { name: "TradingView", status: "online", label: "Подключён" },
    { name: "MOEX API", status: "checking", label: "Проверка" },
    { name: "Binance", status: "online", label: "Котировки" },
    { name: "Kolobok Backend", status: "offline", label: "Недоступен" },
    { name: "LLM", status: "checking", label: "Инициализация" }
  ];

  const getStatusIcon = (status) => {
    switch (status) {
      case "online":
        return <CheckCircle size={14} className="status-green" />;
      case "offline":
        return <XCircle size={14} className="status-red" />;
      case "checking":
      default:
        return <AlertCircle size={14} className="status-yellow" />;
    }
  };

  const getStatusClass = (status) => {
    switch (status) {
      case "online":
        return "status-online";
      case "offline":
        return "status-offline";
      case "checking":
      default:
        return "status-checking";
    }
  };

  return (
    <section className="status-card panel">
      <div className="section-title">
        <span>Статус сервисов</span>
        <Activity size={15} />
      </div>
      <div className="status-list">
        {statuses.map((item, index) => (
          <div key={index} className={`status-row ${getStatusClass(item.status)}`}>
            <span className="status-icon">{getStatusIcon(item.status)}</span>
            <div className="status-info">
              <strong>{item.name}</strong>
              <small>{item.label}</small>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
