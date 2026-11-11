import type { AIMessage } from '@/services/ai/types';

export interface ConversationExportMeta {
  bookTitle: string;
  bookAuthor?: string;
  conversationTitle?: string;
  exportedAt?: number;
}

/**
 * Serialize an AI conversation to Markdown for Obsidian (or any other
 * Markdown tool).
 *
 * Design constraints, all driven by how Obsidian actually renders files:
 *
 * - **Mermaid stays a fenced ```mermaid block.** Obsidian's Mermaid plugin
 *   picks these up natively, so the diagram is live and re-editable there.
 *   Rendering it as an image would throw away the source and break zoom.
 * - **YAML front matter** gives Dataview/Bases something to query on, and is
 *   the conventional Obsidian "properties" block.
 * - **`## ` per turn, never `# `.** Obsidian's outline pane and note-title
 *   inference both key off `#`; leaving the top level free keeps the book or
 *   conversation title usable as the note name.
 * - **Message body is passed through verbatim.** Assistant answers contain
 *   tables, `$math$`, nested lists and Mermaid; re-escaping or reflowing them
 *   would corrupt the content that is the whole point of the export.
 */
export const conversationToMarkdown = (
  messages: AIMessage[],
  meta: ConversationExportMeta,
): string => {
  const exportedAt = meta.exportedAt ?? Date.now();
  const lines: string[] = [];

  // --- Front matter ------------------------------------------------------
  lines.push('---');
  lines.push(`title: ${yamlString(meta.conversationTitle || meta.bookTitle)}`);
  lines.push(`book: ${yamlString(meta.bookTitle)}`);
  if (meta.bookAuthor) lines.push(`author: ${yamlString(meta.bookAuthor)}`);
  lines.push(`exported: ${new Date(exportedAt).toISOString()}`);
  lines.push(`messages: ${messages.length}`);
  lines.push('source: Readest AI');
  lines.push('---');
  lines.push('');

  // --- Human-readable header --------------------------------------------
  lines.push(`# ${meta.conversationTitle || meta.bookTitle}`);
  lines.push('');
  const byline = [meta.bookAuthor ? `*${meta.bookAuthor}*` : '', `_${messages.length} 条消息_`]
    .filter(Boolean)
    .join(' · ');
  lines.push(byline);
  lines.push('');
  lines.push('---');
  lines.push('');

  // --- Turns -------------------------------------------------------------
  messages.forEach((message, index) => {
    const isUser = message.role === 'user';
    const who = isUser ? '🧑 我' : '🤖 AI';
    const time = formatTime(message.createdAt);

    // Anchor each turn so a reader can link straight to it from elsewhere.
    lines.push(`## ${who}${time ? ` · ${time}` : ''}`);
    lines.push('');
    // `^msg-1` is an Obsidian block reference: `[[note#^msg-1]]` links here.
    const body = (message.content ?? '').trim();
    lines.push(body);
    lines.push(`^msg-${index + 1}`);
    lines.push('');
  });

  return lines.join('\n');
};

/** Quote a YAML scalar only when it would otherwise be ambiguous. */
const yamlString = (value: string): string => {
  const safe = /^[A-Za-z0-9\u4e00-\u9fa5][^:!&*?|>%@`#{}[\],"'\n]*$/u.test(value);
  if (safe) return value;
  // JSON string escaping happens to be valid YAML double-quoted syntax.
  return JSON.stringify(value);
};

const formatTime = (timestamp: number): string => {
  if (!timestamp) return '';
  const d = new Date(timestamp);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(
    d.getHours(),
  )}:${pad(d.getMinutes())}`;
};

/** Filesystem-safe filename stem for the export. */
export const makeConversationFilename = (bookTitle: string, conversationTitle?: string): string => {
  const raw = conversationTitle ? `${bookTitle} - ${conversationTitle}` : `${bookTitle} - AI 对话`;
  const safe = raw
    .replace(/[/\\:*?"<>|]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
  return `${safe || 'AI 对话'}.md`;
};
