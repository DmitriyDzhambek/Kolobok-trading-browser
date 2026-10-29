import React, { useState, useRef, useEffect } from "react";
import { Send, MessageSquare, X, ChevronRight } from "lucide-react";
import ReactMarkdown from "react-markdown";

export default function ContextChat({ isOpen, onClose, activeSymbol = "EUR/USD", activeTimeframe = "M1" }) {
  const [messages, setMessages] = useState([
    { role: "assistant", content: "Привет! Я Колобок — твой ИИ-помощник в трейдинге. Спроси меня о рынке, сигналах или рисках." }
  ]);
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const messagesEndRef = useRef(null);

  const quickQuestions = [
    "Что с рынком?",
    "Почему нет сигнала?",
    "Какие риски?"
  ];

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages]);

  const handleQuickQuestion = (question) => {
    setInput(question);
    handleSend(question);
  };

  const handleSend = async (customInput = null) => {
    const messageText = customInput || input.trim();
    if (!messageText || isLoading) return;

    const userMessage = { role: "user", content: messageText };
    setMessages(prev => [...prev, userMessage]);
    setInput("");
    setIsLoading(true);

    try {
      const response = await fetch("http://127.0.0.1:8000/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: messageText,
          active_symbol: activeSymbol,
          active_timeframe: activeTimeframe
        })
      });

      if (!response.ok) throw new Error("Failed to connect to backend");

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let assistantMessage = "";

      setMessages(prev => [...prev, { role: "assistant", content: "" }]);

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value);
        const lines = chunk.split("\n");

        for (const line of lines) {
          if (line.startsWith("data: ")) {
            const data = line.slice(6);
            if (data === "[DONE]") break;
            try {
              const parsed = JSON.parse(data);
              if (parsed.content) {
                assistantMessage += parsed.content;
                setMessages(prev => {
                  const newMessages = [...prev];
                  newMessages[newMessages.length - 1] = { role: "assistant", content: assistantMessage };
                  return newMessages;
                });
              }
            } catch (e) {
              console.error("Parse error:", e);
            }
          }
        }
      }
    } catch (error) {
      setMessages(prev => [...prev, {
        role: "assistant",
        content: "Извините, не удалось связаться с бэкендом. Убедитесь, что сервис Kolobok Backend запущен на http://127.0.0.1:8000"
      }]);
    } finally {
      setIsLoading(false);
    }
  };

  const handleKeyPress = (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  if (!isOpen) return null;

  return (
    <div className="context-chat-overlay">
      <div className="context-chat-panel">
        <div className="chat-header">
          <div className="chat-title">
            <div className="kolobok-avatar-mini">☺</div>
            <div>
              <strong>Чат с Колобком</strong>
              <small>Контекстный ИИ-анализ</small>
            </div>
          </div>
          <button className="round-button" onClick={onClose} aria-label="Закрыть">
            <X size={17} />
          </button>
        </div>

        <div className="chat-messages">
          {messages.map((msg, index) => (
            <div key={index} className={`message ${msg.role}`}>
              {msg.role === "assistant" && <div className="message-avatar">☺</div>}
              <div className="message-content">
                <ReactMarkdown>{msg.content}</ReactMarkdown>
              </div>
            </div>
          ))}
          {isLoading && (
            <div className="message assistant">
              <div className="message-avatar">☺</div>
              <div className="message-content typing">
                <span>Пишет</span>
                <span className="typing-dots">...</span>
              </div>
            </div>
          )}
          <div ref={messagesEndRef} />
        </div>

        <div className="quick-questions">
          {quickQuestions.map((q, i) => (
            <button
              key={i}
              className="quick-question-btn"
              onClick={() => handleQuickQuestion(q)}
              disabled={isLoading}
            >
              <span>{q}</span>
              <ChevronRight size={14} />
            </button>
          ))}
        </div>

        <div className="chat-input-area">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyPress={handleKeyPress}
            placeholder="Спросите о рынке, сигналах или рисках..."
            rows={2}
            disabled={isLoading}
          />
          <button
            className="send-button"
            onClick={() => handleSend()}
            disabled={!input.trim() || isLoading}
          >
            <Send size={18} />
          </button>
        </div>
      </div>
    </div>
  );
}
