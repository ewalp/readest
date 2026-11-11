import { describe, expect, it } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { conversationToMarkdown, makeConversationFilename } from '@/utils/aiConversationExport';
import type { AIMessage } from '@/services/ai/types';

/**
 * Not a behavioural test — it writes a realistic sample to the scratch dir so
 * the export format can be eyeballed (and pasted into Obsidian) as a whole
 * document rather than asserted on fragment by fragment.
 */
describe('export sample', () => {
  it('writes a sample document for manual inspection', () => {
    const messages: AIMessage[] = [
      {
        id: 'm1',
        conversationId: 'c1',
        role: 'user',
        content: '帮我梳理一下这本书里"深度工作"的四种哲学流派，画个流程图。',
        createdAt: 1730000000000,
      },
      {
        id: 'm2',
        conversationId: 'c1',
        role: 'assistant',
        content: [
          '书中提出四种深度工作哲学，核心差异在于**节奏**与**场景**：',
          '',
          '```mermaid',
          'flowchart TD',
          '  A[深度工作哲学] --> B[禁欲主义]',
          '  A --> C[双峰哲学]',
          '  A --> D[节奏哲学]',
          '  A --> E[新闻记者哲学]',
          '  B --> B1[彻底隔绝]',
          '  C --> C1[按季节划分]',
          '  D --> D1[每日固定时段]',
          '  E --> E1[见缝插针]',
          '```',
          '',
          '| 流派 | 适合人群 | 切换成本 |',
          '| --- | --- | --- |',
          '| 禁欲主义 | 无需协作的创作者 | 极低 |',
          '| 双峰哲学 | 需固定深度块的人 | 中 |',
          '| 节奏哲学 | 上班族 | 低 |',
          '| 记者哲学 | 训练有素者 | 高 |',
          '',
          '其中节奏哲学最易落地，正如作者所说：',
          '',
          '> 一条固定的日程可以降低进入深度状态所需的意志力消耗。',
          '',
          '- 每日固定时段',
          '  - 早上 6:00–8:00',
          '    - 关闭所有通知',
        ].join('\n'),
        createdAt: 1730000060000,
      },
      {
        id: 'm3',
        conversationId: 'c1',
        role: 'user',
        content: '那公式 $E=mc^2$ 这种行内数学也行吗？',
        createdAt: 1730000120000,
      },
    ];

    const md = conversationToMarkdown(messages, {
      bookTitle: '深度工作',
      bookAuthor: 'Cal Newport',
      conversationTitle: '深度工作的四种哲学',
      exportedAt: 1730000180000,
    });

    const outDir = process.env['HERMES_SCRATCH_DIR'] || '/tmp';
    const path = join(outDir, 'export-sample.md');
    writeFileSync(path, md, 'utf8');

    expect(md.length).toBeGreaterThan(200);
    expect(makeConversationFilename('深度工作', '深度工作的四种哲学')).toBe(
      '深度工作 - 深度工作的四种哲学.md',
    );
    // eslint-disable-next-line no-console
    console.log('[export-sample] written to', path);
  });
});
