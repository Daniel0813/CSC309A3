import { useEffect, useMemo, useRef, useState } from 'react';
import { io } from 'socket.io-client';
import { get, patch } from '../api';

const SOCKET_BASE = import.meta.env.VITE_API_BASE || 'http://localhost:3000';

function mapMessage(message) {
  return {
    id: message.id || `${message.createdAt}-${message.sender?.id || 'unknown'}`,
    text: message.text,
    sender: message.sender,
    createdAt: message.createdAt,
  };
}

export default function NegotiationPanel() {
  const socketRef = useRef(null);
  const [negotiation, setNegotiation] = useState(null);
  const [messages, setMessages] = useState([]);
  const [decision, setDecision] = useState('accept');
  const [draft, setDraft] = useState('');
  const [error, setError] = useState('');

  async function refresh() {
    setError('');
    try {
      const data = await get('/negotiations/me');
      setNegotiation(data);
      setMessages((data.messages || []).map(mapMessage));
    } catch (err) {
      setNegotiation(null);
      setMessages([]);
      setError(err.message);
    }
  }

  useEffect(() => {
    refresh();
    const timer = setInterval(refresh, 5000);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    const token = localStorage.getItem('token');
    if (!token) {
      return undefined;
    }

    const socket = io(SOCKET_BASE, {
      auth: { token },
      transports: ['websocket'],
    });
    socketRef.current = socket;

    socket.on('negotiation:started', () => {
      refresh();
    });

    socket.on('negotiation:message', (payload) => {
      setMessages((prev) => {
        const next = [...prev, mapMessage(payload)];
        return next;
      });
    });

    socket.on('negotiation:error', (payload) => {
      setError(payload?.error || 'Negotiation message failed');
    });

    return () => {
      socketRef.current = null;
      socket.disconnect();
    };
  }, []);

  async function submitDecision() {
    if (!negotiation) {
      return;
    }
    setError('');
    try {
      await patch('/negotiations/me/decision', {
        decision,
        negotiation_id: negotiation.id,
      });
      await refresh();
    } catch (err) {
      setError(err.message);
    }
  }

  function sendMessage() {
    if (!negotiation || !draft.trim()) {
      return;
    }
    if (!socketRef.current) {
      setError('Not authenticated');
      return;
    }

    socketRef.current.emit('negotiation:message', {
      negotiation_id: negotiation.id,
      text: draft.trim(),
    });

    setDraft('');
  }

  const secondsLeft = useMemo(() => {
    if (!negotiation) {
      return 0;
    }
    return Math.max(0, Math.floor((new Date(negotiation.expiresAt).getTime() - Date.now()) / 1000));
  }, [negotiation]);

  return (
    <section className="card">
      <h2>Active Negotiation</h2>
      {negotiation && <p>Time left: {secondsLeft}s</p>}
      {error && <p className="error">{error}</p>}

      {negotiation && (
        <>
          <div className="row wrap">
            <select value={decision} onChange={(e) => setDecision(e.target.value)}>
              <option value="accept">accept</option>
              <option value="decline">decline</option>
            </select>
            <button className="btn" onClick={submitDecision}>Submit Decision</button>
          </div>

          <div className="card">
            <h3>Live Chat</h3>
            <ul className="list">
              {messages.map((message) => (
                <li key={message.id}>
                  <strong>{message.sender?.role || 'unknown'} #{message.sender?.id || '?'}</strong>
                  <span>{message.text}</span>
                </li>
              ))}
            </ul>
            <div className="row wrap">
              <input
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                placeholder="Type a message"
              />
              <button className="btn" onClick={sendMessage}>Send</button>
            </div>
          </div>

          <pre className="codebox">{JSON.stringify(negotiation, null, 2)}</pre>
        </>
      )}
    </section>
  );
}
