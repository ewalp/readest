'use client';

import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { History, Plus, Trash2, ArrowLeft, MessageSquare } from 'lucide-react';
import {
  AssistantRuntimeProvider,
  useLocalRuntime,
  useAssistantRuntime,
  type ThreadMessage,
  type ThreadHistoryAdapter,
} from '@assistant-ui/react';

// import { useTranslation } from '@/hooks/useTranslation';
import { useSettingsStore } from '@/store/settingsStore';
import { useBookDataStore } from '@/store/bookDataStore';
import { useReaderStore } from '@/store/readerStore';
import { useAIChatStore } from '@/store/aiChatStore';
import { createTauriAdapter, getLastSources, clearLastSources } from '@/services/ai';
import type { AISettings, AIMessage } from '@/services/ai/types';

import { Thread } from '@/components/assistant/Thread';

// Helper function to convert AIMessage array to ExportedMessageRepository format
// Each message needs to be wrapped with { message, parentId } structure
function convertToExportedMessages(
  aiMessages: AIMessage[],
): { message: ThreadMessage; parentId: string | null }[] {
  return aiMessages.map((msg, idx) => {
    const baseMessage = {
      id: msg.id,
      content: [{ type: 'text' as const, text: msg.content }],
      createdAt: new Date(msg.createdAt),
      metadata: { custom: {} },
    };

    // Build role-specific message to satisfy ThreadMessage union type
    const threadMessage: ThreadMessage =
      msg.role === 'user'
        ? ({
            ...baseMessage,
            role: 'user' as const,
            attachments: [] as const,
          } as unknown as ThreadMessage)
        : ({
            ...baseMessage,
            role: 'assistant' as const,
            status: { type: 'complete' as const, reason: 'stop' as const },
          } as unknown as ThreadMessage);

    return {
      message: threadMessage,
      parentId: idx > 0 ? (aiMessages[idx - 1]?.id ?? null) : null,
    };
  });
}

const ChatHistoryList = ({
  bookHash,
  onSelect,
  onClose,
}: {
  bookHash: string;
  onSelect: (id: string) => void;
  onClose: () => void;
}) => {
  const { conversations, deleteConversation, loadConversations } = useAIChatStore();

  useEffect(() => {
    if (bookHash) loadConversations(bookHash);
  }, [bookHash, loadConversations]);

  return (
    <div className='bg-base-100 flex h-full flex-col'>
      <div className='border-base-300 bg-base-200 flex min-h-12 items-center border-b px-2'>
        <button onClick={onClose} className='btn btn-ghost btn-sm btn-square'>
          <ArrowLeft className='size-4' />
        </button>
        <span className='flex-1 text-center font-bold'>History</span>
      </div>
      <div className='flex-1 space-y-2 overflow-y-auto p-2'>
        {conversations.length === 0 && (
          <div className='text-base-content/50 flex h-full flex-col items-center justify-center'>
            <History className='mb-2 size-8 opacity-20' />
            <span className='text-sm'>No history yet</span>
          </div>
        )}
        {conversations.map((c) => (
          <div
            key={c.id}
            role='button'
            tabIndex={0}
            onKeyDown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                onSelect(c.id);
              }
            }}
            className='card bg-base-200 hover:bg-base-300 flex cursor-pointer flex-row items-center justify-between p-3 shadow-sm transition-colors'
            onClick={() => onSelect(c.id)}
          >
            <div className='flex flex-col overflow-hidden'>
              <span className='truncate font-medium'>{c.title || 'Chat'}</span>
              <span className='text-xs opacity-70'>{new Date(c.updatedAt).toLocaleString()}</span>
            </div>
            <button
              onClick={(e) => {
                e.stopPropagation();
                if (confirm('Delete this conversation?')) {
                  deleteConversation(c.id);
                }
              }}
              className='btn btn-ghost text-error btn-square btn-xs'
            >
              <Trash2 className='size-4' />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
};

interface AIAssistantProps {
  bookKey: string;
}

// inner component that uses the runtime hook
const AIAssistantChat = ({
  aiSettings,
  bookHash,
  bookTitle,
  authorName,
  currentPage,
  onResetIndex,
}: {
  aiSettings: AISettings;
  bookHash: string;
  bookTitle: string;
  authorName: string;
  currentPage: number;
  onResetIndex: () => void;
}) => {
  const {
    activeConversationId,
    messages: storedMessages,
    addMessage,
    isLoadingHistory,
    createConversation,
  } = useAIChatStore();

  // use a ref to keep up-to-date options without triggering re-renders of the runtime
  const optionsRef = useRef({
    settings: aiSettings,
    bookHash,
    bookTitle,
    authorName,
    currentPage,
  });

  // update ref on every render with latest values
  useEffect(() => {
    optionsRef.current = {
      settings: aiSettings,
      bookHash,
      bookTitle,
      authorName,
      currentPage,
    };
  });

  // create adapter ONCE and keep it stable
  const adapter = useMemo(() => {
    // eslint-disable-next-line react-hooks/refs -- intentional: we read optionsRef inside a deferred callback, not during render
    return createTauriAdapter(() => optionsRef.current);
  }, []);

  // Create history adapter to load/persist messages
  const historyAdapter = useMemo<ThreadHistoryAdapter>(() => {
    return {
      async load() {
        // storedMessages are already loaded by aiChatStore when conversation is selected
        return {
          messages: convertToExportedMessages(storedMessages),
        };
      },
      async append(item) {
        // item is ExportedMessageRepositoryItem - access the actual message via .message
        const msg = item.message;
        if (msg.role === 'system') return;

        let conversationId = activeConversationId;
        if (!conversationId) {
          conversationId = await createConversation(bookHash, 'Chat');
        }

        // Persist new messages to our store
        if (conversationId) {
          const textContent = msg.content
            .filter(
              (part): part is { type: 'text'; text: string } =>
                'type' in part && part.type === 'text',
            )
            .map((part) => part.text)
            .join('\n');

          if (textContent) {
            await addMessage({
              conversationId: conversationId,
              role: msg.role as 'user' | 'assistant',
              content: textContent,
            });
          }
        }
      },
    };
  }, [activeConversationId, storedMessages, addMessage, createConversation, bookHash]);

  return (
    <AIAssistantWithRuntime
      adapter={adapter}
      historyAdapter={historyAdapter}
      onResetIndex={onResetIndex}
      isLoadingHistory={isLoadingHistory}
      hasActiveConversation={!!activeConversationId}
    />
  );
};

const AIAssistantWithRuntime = ({
  adapter,
  historyAdapter,
  onResetIndex,
  isLoadingHistory,
  hasActiveConversation,
}: {
  adapter: NonNullable<ReturnType<typeof createTauriAdapter>>;
  historyAdapter?: ThreadHistoryAdapter;
  onResetIndex: () => void;
  isLoadingHistory: boolean;
  hasActiveConversation: boolean;
}) => {
  const runtime = useLocalRuntime(adapter, {
    adapters: historyAdapter ? { history: historyAdapter } : undefined,
  });

  if (!runtime) return null;

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <ThreadWrapper
        onResetIndex={onResetIndex}
        isLoadingHistory={isLoadingHistory}
        hasActiveConversation={hasActiveConversation}
      />
    </AssistantRuntimeProvider>
  );
};

const ThreadWrapper = ({
  onResetIndex,
  isLoadingHistory,
  hasActiveConversation,
}: {
  onResetIndex: () => void;
  isLoadingHistory: boolean;
  hasActiveConversation: boolean;
}) => {
  const [sources, setSources] = useState(getLastSources());
  const assistantRuntime = useAssistantRuntime();
  const { setActiveConversation } = useAIChatStore();

  useEffect(() => {
    const interval = setInterval(() => {
      setSources(getLastSources());
    }, 500);
    return () => clearInterval(interval);
  }, []);

  const handleClear = useCallback(() => {
    clearLastSources();
    setSources([]);
    setActiveConversation(null);
    assistantRuntime.switchToNewThread();
  }, [assistantRuntime, setActiveConversation]);

  return (
    <Thread
      sources={sources}
      onClear={handleClear}
      onResetIndex={onResetIndex}
      isLoadingHistory={isLoadingHistory}
      hasActiveConversation={hasActiveConversation}
    />
  );
};

import { GlobalMermaidModal } from '@/components/assistant/GlobalMermaidModal';

const AIAssistant = ({ bookKey }: AIAssistantProps) => {
  // const _ = useTranslation(); // Removed unused variable
  const { settings } = useSettingsStore();
  const { getBookData } = useBookDataStore();
  const { getProgress } = useReaderStore();
  const bookData = getBookData(bookKey);
  const progress = getProgress(bookKey);

  const bookHash = bookKey.split('-')[0] || '';
  const bookTitle = bookData?.book?.title || 'Unknown';
  const authorName = bookData?.book?.author || '';
  const currentPage = progress?.pageinfo?.current ?? 0;
  const aiSettings = settings?.aiSettings;

  const abortControllerRef = useRef<AbortController | null>(null);
  const [indexProgress, setIndexProgress] = useState<number>(0);
  const [indexingPhase, setIndexingPhase] = useState<string>('');
  const [isIndexing, setIsIndexing] = useState(false);
  const [indexed, setIndexed] = useState(false);
  const [viewMode, setViewMode] = useState<'chat' | 'history'>('chat');

  const {
    loadConversations,
    conversations,
    setActiveConversation,
    activeConversationId,
    isLoadingHistory,
    createConversation,
  } = useAIChatStore();

  // Load conversations on mount
  useEffect(() => {
    if (bookHash) {
      loadConversations(bookHash);
    }
  }, [bookHash, loadConversations]);

  // Restore session if exists
  useEffect(() => {
    if (!bookHash || isLoadingHistory) return;

    // Check if we need to restore a session
    if (!activeConversationId && conversations.length > 0) {
      const mostRecent = conversations[0]!;
      setActiveConversation(mostRecent.id);
    }
  }, [bookHash, isLoadingHistory, conversations, activeConversationId, setActiveConversation]);

  // Check if book is already indexed on mount
  useEffect(() => {
    async function checkIndex() {
      if (!bookHash || !settings.aiSettings?.enabled) return;
      const { isBookIndexed } = await import('@/services/ai/ragService');
      const isIndexed = await isBookIndexed(bookHash);
      setIndexed(isIndexed);
    }
    checkIndex();
  }, [bookHash, settings.aiSettings?.enabled]);

  const performIndexing = useCallback(async () => {
    if (!bookData?.bookDoc || isIndexing || indexed) return;

    // Create new abort controller
    const controller = new AbortController();
    abortControllerRef.current = controller;

    setIsIndexing(true);
    setIndexProgress(0);

    try {
      console.log('[AIAssistant] Starting indexing for', bookTitle);
      const { indexBook } = await import('@/services/ai/ragService');

      await indexBook(
        bookData.bookDoc,
        bookHash,
        settings.aiSettings,
        (progress) => {
          setIndexProgress(Math.round((progress.current / progress.total) * 100));
          setIndexingPhase(progress.phase);
        },
        controller.signal, // Pass signal
      );

      setIndexed(true);
      setIsIndexing(false);
      abortControllerRef.current = null;
    } catch (e) {
      if ((e as Error).message === 'Indexing aborted') {
        console.log('[AIAssistant] Indexing cancelled');
      } else {
        console.error('[AIAssistant] Indexing failed', e);
        alert('Indexing failed: ' + (e as Error).message);
      }
      setIsIndexing(false);
      abortControllerRef.current = null;
    }
  }, [bookData, bookHash, bookTitle, settings.aiSettings, isIndexing, indexed]);

  const cancelIndexing = useCallback(() => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
      setIsIndexing(false);
    }
  }, []);

  // Removed auto-indexing useEffect

  if (!settings.aiSettings?.enabled) {
    return (
      <div className='text-base-content/70 flex flex-col items-center justify-center p-8 text-center'>
        <p>AI Assistant is disabled globally.</p>
        <p className='text-sm'>Enable it in Settings {'>'} AI to use this feature.</p>
      </div>
    );
  }

  const handleNewChat = () => {
    createConversation(bookHash, 'New Chat');
    setViewMode('chat');
  };

  return (
    <div className='bg-base-100 flex h-full flex-col'>
      {/* Indexing Status / Control Banner */}
      {(!indexed || isIndexing) && (
        <div className='border-base-300 bg-base-200/50 flex items-center justify-between border-b px-4 py-2 text-sm'>
          {!indexed && !isIndexing && (
            <div className='flex w-full items-center justify-between'>
              <span>Book not indexed for AI.</span>
              <button
                className='btn btn-primary btn-xs'
                onClick={performIndexing}
                disabled={!bookData?.bookDoc}
              >
                Start Indexing
              </button>
            </div>
          )}

          {isIndexing && (
            <div className='flex w-full flex-col gap-2'>
              <div className='flex items-center justify-between'>
                <span>
                  Indexing... {indexingPhase} ({indexProgress}%)
                </span>
                <button className='btn btn-ghost btn-xs text-error' onClick={cancelIndexing}>
                  Cancel
                </button>
              </div>
              <progress
                className='progress progress-primary w-full'
                value={indexProgress}
                max='100'
              ></progress>
            </div>
          )}
        </div>
      )}

      {/* Messages Area OR History */}
      <div className='relative flex flex-1 flex-col overflow-hidden'>
        {viewMode === 'history' ? (
          <ChatHistoryList
            bookHash={bookHash}
            onSelect={(id) => {
              setActiveConversation(id);
              setViewMode('chat');
            }}
            onClose={() => setViewMode('chat')}
          />
        ) : (
          <>
            {/* Toolbar */}
            <div className='border-base-200 bg-base-100 flex min-h-12 items-center justify-between border-b px-4 py-2'>
              <span className='mr-2 flex flex-1 items-center gap-2 truncate text-sm font-semibold opacity-70'>
                <MessageSquare className='size-4 shrink-0' />
                <span className='truncate'>
                  {conversations.find((c) => c.id === activeConversationId)?.title || 'New Chat'}
                </span>
              </span>
              <div className='flex shrink-0 gap-1'>
                <button
                  onClick={() => setViewMode('history')}
                  className='btn btn-ghost btn-sm btn-square'
                  title='History'
                >
                  <History className='size-4' />
                </button>
                <button
                  onClick={handleNewChat}
                  className='btn btn-ghost btn-sm btn-square'
                  title='New Chat'
                >
                  <Plus className='size-4' />
                </button>
              </div>
            </div>
            <div className='relative flex-1 overflow-hidden'>
              <AIAssistantChat
                aiSettings={aiSettings}
                bookHash={bookHash}
                bookTitle={bookTitle}
                authorName={authorName}
                currentPage={currentPage}
                onResetIndex={async () => {
                  setIndexed(false);
                  // Verify it clears from store
                  const { clearBookIndex } = await import('@/services/ai/ragService');
                  await clearBookIndex(bookHash);
                  performIndexing();
                }}
              />
            </div>
          </>
        )}
      </div>
      <GlobalMermaidModal />
    </div>
  );
};

export default AIAssistant;
