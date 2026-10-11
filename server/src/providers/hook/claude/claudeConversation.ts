import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import type { TranscriptMessage } from '../../../../../core/src/messages.js';

/** How much of the transcript tail to read. Transcripts reach tens of MB; the last
 *  ~1.5 MB comfortably holds the most recent dozens of turns. */
const CONVERSATION_TAIL_BYTES = 1_500_000;
/** Per-message cap so one huge paste or report doesn't bloat the WebSocket frame. */
const MESSAGE_TEXT_MAX = 4000;
const TOOL_SUMMARY_MAX = 160;

/** Tool input fields that best describe a call in one line, in preference order. */
const TOOL_SUMMARY_KEYS = [
  'description',
  'command',
  'file_path',
  'pattern',
  'prompt',
  'url',
  'query',
  'skill',
];

function toolSummary(input: unknown): string {
  if (!input || typeof input !== 'object') return '';
  const rec = input as Record<string, unknown>;
  for (const key of TOOL_SUMMARY_KEYS) {
    const v = rec[key];
    if (typeof v === 'string' && v.trim()) {
      return v.trim().split('\n')[0].slice(0, TOOL_SUMMARY_MAX);
    }
  }
  return '';
}

/** Harness-injected user turns (slash-command echoes, reminders, hook output) start
 *  with an XML-ish tag; the person never typed them. */
function isInjected(text: string): boolean {
  return text.trimStart().startsWith('<');
}

function readTail(file: string, maxBytes: number): string[] {
  const size = fs.statSync(file).size;
  const start = Math.max(0, size - maxBytes);
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    const lines = buf.toString('utf-8').split('\n');
    // A mid-file start lands inside a record; drop the partial first line.
    if (start > 0) lines.shift();
    return lines;
  } finally {
    fs.closeSync(fd);
  }
}

/** Main-chain user prompts, assistant text, and one-line tool calls, oldest first. */
export function readClaudeConversation(
  transcriptPath: string,
  maxMessages: number,
): TranscriptMessage[] {
  let lines: string[];
  try {
    lines = readTail(transcriptPath, CONVERSATION_TAIL_BYTES);
  } catch {
    return [];
  }
  const out: TranscriptMessage[] = [];
  const push = (m: TranscriptMessage) => {
    out.push({ ...m, text: m.text.slice(0, MESSAGE_TEXT_MAX) });
  };
  for (const line of lines) {
    if (!line.startsWith('{')) continue;
    let rec: Record<string, unknown>;
    try {
      rec = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const type = rec.type;
    if ((type !== 'user' && type !== 'assistant') || rec.isSidechain || rec.isMeta) continue;
    const timestamp = typeof rec.timestamp === 'string' ? rec.timestamp : undefined;
    const content = (rec.message as { content?: unknown } | undefined)?.content;
    if (typeof content === 'string') {
      if (type === 'user' && !isInjected(content)) push({ role: 'user', text: content, timestamp });
      continue;
    }
    if (!Array.isArray(content)) continue;
    for (const block of content as Array<Record<string, unknown>>) {
      if (block.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
        if (type === 'user' && isInjected(block.text)) continue;
        push({ role: type, text: block.text, timestamp });
      } else if (block.type === 'tool_use' && typeof block.name === 'string') {
        push({ role: 'tool', toolName: block.name, text: toolSummary(block.input), timestamp });
      }
    }
  }
  return out.slice(-maxMessages);
}

/**
 * Claude Code writes `~/.claude/sessions/<pid>.json` ({ pid, sessionId, ... }) for every
 * live interactive session. Map the session to its pid, then ask `ps` for the pid's
 * controlling terminal. Returns undefined for headless runs, the desktop app, or
 * non-POSIX hosts.
 */
export function findClaudeSessionTty(sessionId: string): string | undefined {
  if (process.platform === 'win32') return undefined;
  const dir = path.join(os.homedir(), '.claude', 'sessions');
  let files: string[];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  } catch {
    return undefined;
  }
  for (const f of files) {
    let pid: unknown;
    try {
      const meta = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8')) as {
        pid?: unknown;
        sessionId?: unknown;
      };
      if (meta.sessionId !== sessionId) continue;
      pid = meta.pid;
    } catch {
      continue;
    }
    if (typeof pid !== 'number' || !Number.isInteger(pid)) return undefined;
    try {
      const tty = execFileSync('ps', ['-o', 'tty=', '-p', String(pid)], {
        encoding: 'utf-8',
        timeout: 2000,
      }).trim();
      return /^ttys?\d+$/.test(tty) ? `/dev/${tty}` : undefined;
    } catch {
      return undefined; // process gone
    }
  }
  return undefined;
}
