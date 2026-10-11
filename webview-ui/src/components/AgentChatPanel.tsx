import { useCallback, useEffect, useRef, useState } from 'react';

import type { TranscriptMessage } from '../../../core/src/messages.js';
import type { OfficeState } from '../office/engine/officeState.js';
import { transport } from '../transport/index.js';
import { Button } from './ui/Button.js';

/** How often the open panel re-reads the agent's transcript. */
const TRANSCRIPT_POLL_MS = 2500;
/** How often to notice a selection change made on the canvas (selection lives
 *  imperatively in OfficeState, outside React). */
const SELECTION_POLL_MS = 200;
const STATUS_CLEAR_MS = 4000;

interface AgentChatPanelProps {
  officeState: OfficeState;
}

/** The agent whose conversation to show: the selected character, or a selected
 *  sub-agent's parent (sub-agents have no conversation of their own). */
function selectedConversationAgent(os: OfficeState): number | null {
  const id = os.selectedAgentId;
  if (id === null) return null;
  return os.subagentMeta.get(id)?.parentAgentId ?? id;
}

function formatTime(ts: string | undefined): string {
  if (!ts) return '';
  const d = new Date(ts);
  return Number.isNaN(d.getTime())
    ? ''
    : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

/**
 * Side panel for the selected agent: its recent conversation (polled from the
 * transcript) plus a box that types a message straight into the agent's terminal.
 */
export function AgentChatPanel({ officeState }: AgentChatPanelProps) {
  const [agentId, setAgentId] = useState<number | null>(null);
  const [messages, setMessages] = useState<TranscriptMessage[]>([]);
  const [draft, setDraft] = useState('');
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const stickToBottom = useRef(true);

  // Follow the canvas selection.
  useEffect(() => {
    const timer = setInterval(() => {
      const next = selectedConversationAgent(officeState);
      setAgentId((prev) => (prev === next ? prev : next));
    }, SELECTION_POLL_MS);
    return () => clearInterval(timer);
  }, [officeState]);

  // Replies for the shown agent only.
  useEffect(() => {
    return transport.onMessage((msg) => {
      if (msg.type === 'agentTranscript' && msg.id === agentId) {
        setMessages(msg.messages);
      } else if (msg.type === 'agentActionResult' && msg.id === agentId && !msg.ok) {
        setStatus({ ok: false, text: msg.message ?? `${msg.action} failed` });
      } else if (msg.type === 'agentActionResult' && msg.id === agentId && msg.action === 'send') {
        setStatus({ ok: true, text: 'Sent' });
      }
    });
  }, [agentId]);

  // Poll the transcript while open.
  useEffect(() => {
    setMessages([]);
    setStatus(null);
    stickToBottom.current = true;
    if (agentId === null) return;
    const request = () => transport.send({ type: 'requestTranscript', id: agentId });
    request();
    const timer = setInterval(() => {
      if (!document.hidden) request();
    }, TRANSCRIPT_POLL_MS);
    return () => clearInterval(timer);
  }, [agentId]);

  useEffect(() => {
    if (!status) return;
    const timer = setTimeout(() => setStatus(null), STATUS_CLEAR_MS);
    return () => clearTimeout(timer);
  }, [status]);

  // Keep the newest message in view unless the user scrolled up to read.
  useEffect(() => {
    const el = listRef.current;
    if (el && stickToBottom.current) el.scrollTop = el.scrollHeight;
  }, [messages]);

  const onScroll = useCallback(() => {
    const el = listRef.current;
    if (el) stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  }, []);

  const send = useCallback(() => {
    const text = draft.trim();
    if (!text || agentId === null) return;
    transport.send({ type: 'sendToAgent', id: agentId, text });
    setDraft('');
    stickToBottom.current = true;
    setTimeout(() => transport.send({ type: 'requestTranscript', id: agentId }), 800);
  }, [draft, agentId]);

  const close = useCallback(() => {
    officeState.selectedAgentId = null;
    officeState.cameraFollowId = null;
    setAgentId(null);
  }, [officeState]);

  if (agentId === null) return null;
  const ch = officeState.characters.get(agentId);
  const title = ch?.agentName || ch?.folderName || `Agent #${agentId}`;

  return (
    <div
      className="absolute top-8 right-8 bottom-72 z-30 pixel-panel flex flex-col"
      style={{ width: 'min(460px, calc(100% - 16px))' }}
    >
      <div className="flex items-center gap-8 py-4 px-8 border-b border-border">
        <span className="text-base text-accent font-bold flex-1 truncate" title={title}>
          {title}
        </span>
        <Button
          size="sm"
          title="Bring this agent's terminal to the front"
          onClick={() => transport.send({ type: 'focusAgent', id: agentId })}
        >
          Terminal
        </Button>
        <Button size="sm" variant="ghost" onClick={close} aria-label="Close">
          ✕
        </Button>
      </div>

      <div
        ref={listRef}
        onScroll={onScroll}
        className="flex-1 overflow-y-auto flex flex-col gap-6 p-8 bg-bg-dark"
      >
        {messages.length === 0 && <span className="text-sm text-text-muted">No messages yet.</span>}
        {messages.map((m, i) =>
          m.role === 'tool' ? (
            <div
              key={i}
              className="text-2xs text-text-muted truncate shrink-0"
              title={`${m.toolName}: ${m.text}`}
            >
              › {m.toolName} {m.text}
            </div>
          ) : (
            <div
              key={i}
              className={`text-sm whitespace-pre-wrap break-words py-4 px-8 border-2 max-w-[92%] shrink-0 ${
                m.role === 'user'
                  ? 'self-end bg-active-bg border-accent'
                  : 'self-start bg-btn-bg border-border'
              }`}
            >
              {m.text}
              <span className="block text-2xs text-text-muted mt-2">
                {m.role === 'user' ? 'You' : 'Agent'} {formatTime(m.timestamp)}
              </span>
            </div>
          ),
        )}
      </div>

      <div className="flex gap-6 p-8 border-t border-border">
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            // Keep office shortcuts (R, T, Esc, Ctrl+Z…) from firing while typing.
            e.stopPropagation();
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              send();
            }
          }}
          placeholder="Message this agent's terminal (⌘/Ctrl+Enter)"
          className="flex-1 min-h-[56px] resize-y bg-bg border-2 border-border text-text text-sm p-4 font-[inherit]"
        />
        <Button size="sm" variant="accent" onClick={send} disabled={!draft.trim()}>
          Send
        </Button>
      </div>
      {status && (
        <div
          className={`px-8 pb-6 text-2xs ${status.ok ? 'text-status-success' : 'text-status-error'}`}
        >
          {status.text}
        </div>
      )}
    </div>
  );
}
