import { describe, expect, it } from 'vitest';

import { conversationToMarkdown, makeConversationFilename } from '@/utils/aiConversationExport';
import type { AIMessage } from '@/services/ai/types';

const msg = (
  role: 'user' | 'assistant',
  content: string,
  createdAt = 1730000000000,
): AIMessage => ({
  id: `${role}-${createdAt}`,
  conversationId: 'conv-1',
  role,
  content,
  createdAt,
});

const MERMAID = `\`\`\`mermaid
flowchart TD
  A[开始] --> B{判断}
  B -->|是| C[结束]
\`\`\``;

describe('conversationToMarkdown', () => {
  it('writes Obsidian-compatible YAML front matter', () => {
    const md = conversationToMarkdown([msg('user', '你好')], {
      bookTitle: '深度工作',
      bookAuthor: 'Cal Newport',
      conversationTitle: '关于专注力',
      exportedAt: 1730000000000,
    });

    expect(md.startsWith('---\n')).toBe(true);
    const frontMatter = md.slice(4, md.indexOf('\n---', 4));
    expect(frontMatter).toContain('title: 关于专注力');
    expect(frontMatter).toContain('book: 深度工作');
    expect(frontMatter).toContain('author: Cal Newport');
    expect(frontMatter).toContain('messages: 1');
    expect(frontMatter).toMatch(/exported: \d{4}-\d{2}-\d{2}T/);
  });

  it('keeps mermaid fences intact so Obsidian renders them live', () => {
    const md = conversationToMarkdown([msg('assistant', `图示：\n\n${MERMAID}\n\n完成。`)], {
      bookTitle: '测试书',
    });

    // The fence and its language tag must survive byte-for-byte.
    expect(md).toContain('```mermaid');
    expect(md).toContain('flowchart TD');
    expect(md).toContain('B -->|是| C[结束]');
    // Exactly one opening and one closing fence.
    expect(md.split('```mermaid').length - 1).toBe(1);
    expect(md.split('```').length - 1).toBe(2);
  });

  it('does not corrupt tables, math or nested lists in assistant output', () => {
    const rich = [
      '| 指标 | 值 |',
      '| --- | --- |',
      '| 深度 | 3 |',
      '',
      '公式 $E = mc^2$ 保持原样。',
      '',
      '- 一级',
      '  - 二级',
      '    - 三级',
    ].join('\n');

    const md = conversationToMarkdown([msg('assistant', rich)], { bookTitle: '测试书' });
    expect(md).toContain('| 深度 | 3 |');
    expect(md).toContain('$E = mc^2$');
    expect(md).toContain('    - 三级');
  });

  it('uses ## per turn and leaves # free for the note title', () => {
    const md = conversationToMarkdown([msg('user', '问题'), msg('assistant', '回答')], {
      bookTitle: '测试书',
      conversationTitle: '一次对话',
    });

    const turnHeadings = md.split('\n').filter((l) => l.startsWith('## '));
    expect(turnHeadings.length).toBe(2);
    expect(turnHeadings[0]).toContain('我');
    expect(turnHeadings[1]).toContain('AI');

    // Only the document title may use a single '#', and it must appear once.
    const h1 = md.split('\n').filter((l) => /^# /.test(l));
    expect(h1.length).toBe(1);
    expect(h1[0]).toBe('# 一次对话');
  });

  it('emits one block reference per turn for cross-linking', () => {
    const md = conversationToMarkdown([msg('user', 'a'), msg('assistant', 'b'), msg('user', 'c')], {
      bookTitle: '测试书',
    });
    expect(md).toContain('^msg-1');
    expect(md).toContain('^msg-2');
    expect(md).toContain('^msg-3');
  });

  it('quotes YAML values that would break parsing', () => {
    const md = conversationToMarkdown([msg('user', 'x')], {
      bookTitle: '书名: 带冒号',
    });
    const frontMatter = md.slice(4, md.indexOf('\n---', 4));
    // Must be quoted, otherwise YAML reads a nested mapping.
    expect(frontMatter).toMatch(/book: "书名: 带冒号"/);
  });

  it('handles an empty conversation without throwing', () => {
    const md = conversationToMarkdown([], { bookTitle: '空对话' });
    expect(md).toContain('messages: 0');
    expect(md).toContain('# 空对话');
  });
});

describe('makeConversationFilename', () => {
  it('produces a .md file named after the book and conversation', () => {
    expect(makeConversationFilename('深度工作', '专注力')).toBe('深度工作 - 专注力.md');
  });

  it('strips characters that are illegal in filenames', () => {
    const name = makeConversationFilename('A/B:C*D?"E<F>G|H', undefined);
    expect(name).not.toMatch(/[/\\:*?"<>|]/);
    expect(name.endsWith('.md')).toBe(true);
  });

  it('truncates very long titles', () => {
    const name = makeConversationFilename('书'.repeat(300), '长');
    expect(name.length).toBeLessThanOrEqual(123);
  });
});
