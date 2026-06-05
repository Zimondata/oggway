import { useState, useEffect, useRef, useCallback } from 'react';

// ── Types ──

interface Topic {
  id: string;
  name: string;
  category: string;
  icon: string;
  system_context: string;
  sort_order: number;
}

interface Message {
  id: string;
  sender: string;
  sender_name: string;
  content: string;
  timestamp: string;
  is_from_me: number;
  is_bot_message: number;
}

interface BotStatus {
  alive: boolean;
  pid: number | null;
  lastRun: { run_at: string; status: string; duration_ms: number; turns: number; model: string } | null;
  pendingMessages: number;
  hasSession: boolean;
}

interface LogLine {
  time: string;
  level: string;
  msg: string;
}

// ── Topic icon mapping (simple SVG icons) ──

function TopicIcon({ icon, size = 16 }: { icon: string; size?: number }) {
  const s = size;
  const icons: Record<string, React.ReactNode> = {
    MessageSquare: <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>,
    Heart: <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M19 14c1.49-1.46 3-3.21 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.76 0-3 .5-4.5 2-1.5-1.5-2.74-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4.05 3 5.5l7 7Z"/></svg>,
    Brain: <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 2a7 7 0 0 0-4 12.9V22h8v-7.1A7 7 0 0 0 12 2z"/></svg>,
    Apple: <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="14" r="7"/><path d="M12 7V3"/><path d="M15 4c-1 1-3 1-3 1"/></svg>,
    Terminal: <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/></svg>,
    Monitor: <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="3" width="20" height="14" rx="2" ry="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>,
    Send: <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>,
    Play: <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polygon points="5 3 19 12 5 21 5 3"/></svg>,
    Image: <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg>,
    Layers: <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polygon points="12 2 2 7 12 12 22 7 12 2"/><polyline points="2 17 12 22 22 17"/><polyline points="2 12 12 17 22 12"/></svg>,
  };
  return icons[icon] || icons.MessageSquare;
}

// ── Status Dot ──

function StatusDot({ alive, pending }: { alive: boolean; pending: number }) {
  if (!alive) return <span className="w-2.5 h-2.5 rounded-full bg-red-500 inline-block" title="Bot offline" />;
  if (pending > 0) return <span className="w-2.5 h-2.5 rounded-full bg-yellow-500 animate-pulse inline-block" title={`Processing ${pending} messages`} />;
  return <span className="w-2.5 h-2.5 rounded-full bg-emerald-500 inline-block" title="Bot online" />;
}

// ── Format time ──

function formatTime(ts: string): string {
  const d = new Date(ts);
  const now = new Date();
  const isToday = d.toDateString() === now.toDateString();
  const hm = d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  if (isToday) return hm;
  const yesterday = new Date(now); yesterday.setDate(yesterday.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString()) return `Yesterday ${hm}`;
  return `${d.getDate()}/${d.getMonth() + 1} ${hm}`;
}

// ── Message Bubble ──

function MessageBubble({ msg }: { msg: Message }) {
  const isBot = msg.is_bot_message === 1;
  const content = msg.content || '';

  // Simple markdown-ish rendering: bold, code, newlines
  const renderContent = (text: string) => {
    // Split into lines
    return text.split('\n').map((line, i) => (
      <span key={i}>
        {i > 0 && <br />}
        {line.split(/(\*\*[^*]+\*\*|`[^`]+`)/).map((part, j) => {
          if (part.startsWith('**') && part.endsWith('**'))
            return <strong key={j} className="font-semibold">{part.slice(2, -2)}</strong>;
          if (part.startsWith('`') && part.endsWith('`'))
            return <code key={j} className="bg-gray-800 px-1 py-0.5 rounded text-xs font-mono">{part.slice(1, -1)}</code>;
          return <span key={j}>{part}</span>;
        })}
      </span>
    ));
  };

  return (
    <div className={`flex ${isBot ? 'justify-start' : 'justify-end'} mb-3`}>
      <div className={`max-w-[75%] rounded-2xl px-4 py-2.5 text-sm leading-relaxed ${
        isBot
          ? 'bg-gray-800/80 text-gray-100 rounded-bl-md'
          : 'bg-blue-600/80 text-white rounded-br-md'
      }`}>
        {isBot && (
          <div className="text-[10px] text-gray-400 mb-1 font-medium uppercase tracking-wider">GLaDOS</div>
        )}
        <div className="whitespace-pre-wrap break-words">{renderContent(content)}</div>
        <div className={`text-[10px] mt-1.5 ${isBot ? 'text-gray-500' : 'text-blue-200/60'}`}>
          {formatTime(msg.timestamp)}
        </div>
      </div>
    </div>
  );
}

// ── Logs Panel ──

function LogsPanel({ logs, visible, onClose }: { logs: LogLine[]; visible: boolean; onClose: () => void }) {
  const logsEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    logsEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [logs]);

  if (!visible) return null;

  const levelColor: Record<string, string> = {
    debug: 'text-gray-500',
    info: 'text-gray-300',
    warn: 'text-yellow-400',
    error: 'text-red-400',
  };

  return (
    <div className="border-t border-gray-800/60 bg-gray-950 h-48 overflow-y-auto font-mono text-[11px]">
      <div className="sticky top-0 bg-gray-950 border-b border-gray-800/40 px-3 py-1.5 flex items-center justify-between">
        <span className="text-gray-400 text-xs font-medium">Live Logs</span>
        <button onClick={onClose} className="text-gray-500 hover:text-gray-300 text-xs">Close</button>
      </div>
      <div className="px-3 py-1">
        {logs.map((l, i) => (
          <div key={i} className={`py-0.5 ${levelColor[l.level] || 'text-gray-300'}`}>
            {l.time && <span className="text-gray-600 mr-2">{new Date(l.time).toLocaleTimeString('en-GB')}</span>}
            <span className={`mr-2 uppercase text-[10px] ${levelColor[l.level]}`}>{l.level}</span>
            <span>{l.msg}</span>
          </div>
        ))}
        <div ref={logsEndRef} />
      </div>
    </div>
  );
}

// ── Main Chat Page ──

export function ChatPage() {
  const [topics, setTopics] = useState<Topic[]>([]);
  const [activeTopic, setActiveTopic] = useState('general');
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [status, setStatus] = useState<BotStatus | null>(null);
  const [logs, setLogs] = useState<LogLine[]>([]);
  const [showLogs, setShowLogs] = useState(false);
  const [sending, setSending] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const chatRef = useRef<HTMLDivElement>(null);

  // Fetch topics
  useEffect(() => {
    fetch('/api/topics')
      .then(r => r.json())
      .then(d => setTopics(d.topics || []))
      .catch(console.error);
  }, []);

  // Fetch initial messages, filtered by topic
  const fetchMessages = useCallback(() => {
    const params = new URLSearchParams({ limit: '100' });
    if (activeTopic !== 'general') params.set('topic', activeTopic);
    fetch(`/api/chat/messages?${params}`)
      .then(r => r.json())
      .then(d => setMessages(d.messages || []))
      .catch(console.error);
  }, [activeTopic]);

  // Initial load + SSE subscription for live updates (replaces 3s polling)
  useEffect(() => {
    fetchMessages();
    const params = new URLSearchParams();
    if (activeTopic !== 'general') params.set('topic', activeTopic);
    const url = `/api/chat/stream${params.toString() ? '?' + params : ''}`;
    const es = new EventSource(url);
    es.onmessage = (ev) => {
      try {
        const evt = JSON.parse(ev.data);
        if (evt.type === 'message' && evt.data) {
          setMessages(prev => {
            // Dedup by id (optimistic insert may have already added it)
            if (prev.some(m => m.id === evt.data.id)) return prev;
            return [...prev, evt.data as Message];
          });
        }
      } catch { /* ignore */ }
    };
    es.onerror = () => { /* browser auto-reconnects */ };
    return () => { es.close(); };
  }, [activeTopic, fetchMessages]);

  // Fetch bot status (poll every 5s)
  useEffect(() => {
    const fetchStatus = () => {
      fetch('/api/bot-status')
        .then(r => r.json())
        .then(setStatus)
        .catch(console.error);
    };
    fetchStatus();
    const interval = setInterval(fetchStatus, 5000);
    return () => clearInterval(interval);
  }, []);

  // Fetch logs
  useEffect(() => {
    if (!showLogs) return;
    const fetchLogs = () => {
      fetch('/api/logs?lines=100')
        .then(r => r.json())
        .then(d => setLogs(d.lines || []))
        .catch(console.error);
    };
    fetchLogs();
    const interval = setInterval(fetchLogs, 3000);
    return () => clearInterval(interval);
  }, [showLogs]);

  // Auto-scroll on new messages
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // Send message
  const sendMessage = useCallback(async () => {
    if (!input.trim() || sending) return;
    setSending(true);
    try {
      const res = await fetch('/api/chat/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: input.trim(), topicId: activeTopic }),
      });
      if (res.ok) {
        setInput('');
        // Optimistic update; bot reply arrives via SSE stream
        const data = await res.json();
        setMessages(prev => [...prev, {
          id: data.id,
          sender: 'Btchit',
          sender_name: 'Btchit',
          content: input.trim(),
          timestamp: data.timestamp,
          is_from_me: 0,
          is_bot_message: 0,
        }]);
      }
    } catch (e) {
      console.error('Send failed:', e);
    } finally {
      setSending(false);
    }
  }, [input, activeTopic, sending]);

  // Group topics by category
  const topicTree = topics.reduce((acc, t) => {
    const cat = t.category || '_root';
    if (!acc[cat]) acc[cat] = [];
    acc[cat].push(t);
    return acc;
  }, {} as Record<string, Topic[]>);

  const categoryOrder = ['_root', 'Health', 'Coding', 'Content'];
  const sortedCategories = Object.keys(topicTree).sort((a, b) => {
    const ia = categoryOrder.indexOf(a);
    const ib = categoryOrder.indexOf(b);
    return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
  });

  return (
    <div className="flex h-full">
      {/* ── Topics Sidebar ── */}
      <div className="w-56 flex-shrink-0 border-r border-gray-800/60 flex flex-col bg-gray-950/50">
        {/* Status bar */}
        <div className="px-4 py-3 border-b border-gray-800/60 flex items-center gap-2">
          <StatusDot alive={status?.alive || false} pending={status?.pendingMessages || 0} />
          <span className="text-xs text-gray-400">
            {status?.alive ? 'Online' : 'Offline'}
          </span>
          {status?.lastRun && (
            <span className="text-[10px] text-gray-600 ml-auto">
              {formatTime(status.lastRun.run_at)}
            </span>
          )}
        </div>

        {/* Topics tree */}
        <div className="flex-1 overflow-y-auto py-2">
          {sortedCategories.map(cat => (
            <div key={cat}>
              {cat !== '_root' && (
                <div className="px-4 pt-3 pb-1 text-[10px] font-semibold text-gray-500 uppercase tracking-wider">
                  {cat}
                </div>
              )}
              {topicTree[cat].map(topic => (
                <button
                  key={topic.id}
                  onClick={() => setActiveTopic(topic.id)}
                  className={`w-full flex items-center gap-2.5 px-4 py-2 text-sm transition-colors ${
                    activeTopic === topic.id
                      ? 'bg-blue-500/10 text-blue-400 border-r-2 border-blue-500'
                      : 'text-gray-400 hover:text-gray-200 hover:bg-gray-800/30'
                  }`}
                >
                  <span className="flex-shrink-0 opacity-60">
                    <TopicIcon icon={topic.icon} size={14} />
                  </span>
                  <span className="truncate">{topic.name}</span>
                </button>
              ))}
            </div>
          ))}
        </div>

        {/* Actions */}
        <div className="border-t border-gray-800/60 px-4 py-2 space-y-1">
          <button
            onClick={() => {
              fetch('/api/chat/auto-classify', { method: 'POST' })
                .then(r => r.json())
                .then(d => {
                  if (d.classified > 0) fetchMessages();
                })
                .catch(console.error);
            }}
            className="text-xs text-gray-500 hover:text-gray-300 transition-colors block"
          >
            Auto-classify messages
          </button>
          <button
            onClick={() => setShowLogs(!showLogs)}
            className="text-xs text-gray-500 hover:text-gray-300 transition-colors block"
          >
            {showLogs ? 'Hide Logs' : 'Show Logs'}
          </button>
        </div>
      </div>

      {/* ── Chat Area ── */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Topic header */}
        <div className="px-6 py-3 border-b border-gray-800/60 flex items-center justify-between flex-shrink-0">
          <div>
            <h2 className="text-sm font-semibold text-gray-200">
              {topics.find(t => t.id === activeTopic)?.name || 'General'}
            </h2>
            <p className="text-[11px] text-gray-500">
              {topics.find(t => t.id === activeTopic)?.system_context || 'Main conversation'}
            </p>
          </div>
          <div className="flex items-center gap-2 text-[10px] text-gray-600">
            {status?.hasSession && <span className="bg-emerald-500/10 text-emerald-400 px-2 py-0.5 rounded-full">Session active</span>}
            <span>{messages.length} messages</span>
          </div>
        </div>

        {/* Messages */}
        <div ref={chatRef} className="flex-1 overflow-y-auto px-6 py-4">
          {messages.length === 0 && (
            <div className="flex items-center justify-center h-full text-gray-600 text-sm">
              No messages yet. Start typing below.
            </div>
          )}
          {messages.map((msg) => (
            <MessageBubble key={msg.id} msg={msg} />
          ))}
          <div ref={messagesEndRef} />
        </div>

        {/* Logs panel */}
        <LogsPanel logs={logs} visible={showLogs} onClose={() => setShowLogs(false)} />

        {/* Input */}
        <div className="border-t border-gray-800/60 px-6 py-3 flex-shrink-0">
          <div className="flex gap-3 items-end">
            <textarea
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  sendMessage();
                }
              }}
              placeholder="Type a message... (Enter to send, Shift+Enter for newline)"
              rows={1}
              className="flex-1 bg-gray-800/60 border border-gray-700/50 rounded-xl px-4 py-2.5 text-sm text-gray-100 placeholder-gray-500 resize-none focus:outline-none focus:ring-1 focus:ring-blue-500/50 focus:border-blue-500/50"
              style={{ minHeight: '40px', maxHeight: '120px' }}
              onInput={(e) => {
                const t = e.currentTarget;
                t.style.height = 'auto';
                t.style.height = Math.min(t.scrollHeight, 120) + 'px';
              }}
            />
            <button
              onClick={sendMessage}
              disabled={!input.trim() || sending}
              className="bg-blue-600 hover:bg-blue-500 disabled:bg-gray-700 disabled:text-gray-500 text-white rounded-xl px-4 py-2.5 text-sm font-medium transition-colors flex-shrink-0"
            >
              {sending ? '...' : 'Send'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
