'use client';

import { useState, useEffect, useCallback, useMemo, useRef, memo } from 'react';
import { History, Plus, Trash2, ArrowLeft, MessageSquare, Pencil } from 'lucide-react';
import {
  AssistantRuntimeProvider,
  useLocalRuntime,
  useAssistantRuntime,
  type ThreadMessage,
  type ThreadHistoryAdapter,
} from '@assistant-ui/react';

import { useTranslation } from '@/hooks/useTranslation';
import { useSettingsStore } from '@/store/settingsStore';
import { useBookDataStore } from '@/store/bookDataStore';
import { useReaderStore } from '@/store/readerStore';
import { useBookProgress } from '@/store/readerProgressStore';
import { useAIChatStore } from '@/store/aiChatStore';
import {
  createTauriAdapter,
  cancelBackgroundStream,
  getBackgroundStream,
  clearBackgroundStream,
} from '@/services/ai';
import {
  LegacyIdbBackend,
  ReedyBackend,
  ReedySourceStore,
  selectBackend,
  type RetrievalBackend,
  type SourceItem,
} from '@/services/ai/adapters';
import type { AISettings, AIMessage } from '@/services/ai/types';
import type { PromptMode } from '@/services/ai/prompts';
import type { RetrievedChunk } from '@/services/reedy/retrieval/BookRetriever';
import { useEnv } from '@/context/EnvContext';
import { isTauriAppPlatform } from '@/services/environment';
import type { AppService } from '@/types/system';
import { ReedyAssistant } from '@/services/reedy/ui/ReedyAssistant';
import type { ReadingContextSnapshot } from '@/services/reedy/tools/builtins/types';

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
  const { conversations, deleteConversation, renameConversation, loadConversations } =
    useAIChatStore();

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
            <div className='flex flex-1 flex-col overflow-hidden mr-2'>
              <span className='truncate font-medium'>{c.title || 'Chat'}</span>
              <span className='text-xs opacity-70'>{new Date(c.updatedAt).toLocaleString()}</span>
            </div>
            <div className='flex items-center gap-1 shrink-0'>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  const newTitle = prompt('Rename conversation', c.title);
                  if (newTitle && newTitle.trim()) {
                    renameConversation(c.id, newTitle.trim());
                  }
                }}
                className='btn btn-ghost text-base-content/60 hover:text-base-content btn-square btn-xs'
                title='Rename'
              >
                <Pencil className='size-3.5' />
              </button>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  if (confirm('Delete this conversation?')) {
                    deleteConversation(c.id);
                  }
                }}
                className='btn btn-ghost text-error btn-square btn-xs'
                title='Delete'
              >
                <Trash2 className='size-4' />
              </button>
            </div>
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
const AIAssistantChat = memo(
  ({
    aiSettings,
    bookHash,
    bookTitle,
    authorName,
    currentPage,
    currentSectionIndex,
    promptMode,
    backend,
    sourceStore,
    currentTurnId,
    setCurrentTurnId,
    onSourceClick,
    onResetIndex,
  }: {
    aiSettings: AISettings;
    bookHash: string;
    bookTitle: string;
    authorName: string;
    currentPage: number;
    currentSectionIndex: number;
    promptMode: PromptMode;
    backend: RetrievalBackend;
    sourceStore: ReedySourceStore;
    currentTurnId: string | null;
    setCurrentTurnId: (id: string) => void;
    onSourceClick?: (source: SourceItem) => void;
    onResetIndex: () => void;
  }) => {
    const { activeConversationId, isLoadingHistory } = useAIChatStore();

    // use a ref to keep up-to-date options without triggering re-renders of the runtime
    const optionsRef = useRef({
      settings: aiSettings,
      bookHash,
      bookTitle,
      authorName,
      currentPage,
      currentSectionIndex,
      promptMode,
      backend,
      sourceStore,
      onTurnStart: setCurrentTurnId,
    });

    // update ref on every render with latest values
    useEffect(() => {
      optionsRef.current = {
        settings: aiSettings,
        bookHash,
        bookTitle,
        authorName,
        currentPage,
        currentSectionIndex,
        promptMode,
        backend,
        sourceStore,
        onTurnStart: setCurrentTurnId,
      };
    });

    // create adapter ONCE and keep it stable
    const adapter = useMemo(() => {
      // eslint-disable-next-line react-hooks/refs -- intentional: we read optionsRef inside a deferred callback, not during render
      return createTauriAdapter(() => optionsRef.current);
    }, []);

    // Create history adapter to load/persist messages
    const historyAdapter = useMemo<ThreadHistoryAdapter>(() => {
      const stateObj = { pendingConversationPromise: null as Promise<string> | null };

      return {
        async load() {
          const storedMessages = useAIChatStore.getState().messages;

          // Check if there's a completed background stream with fuller content
          const bg = getBackgroundStream();
          if (bg && bg.bookHash === bookHash && bg.isComplete && bg.fullText) {
            // Replace the last assistant message content with the complete bg stream text
            const msgs = storedMessages.map((m) => ({ ...m }));
            const lastAssistantIdx =
              msgs.length - 1 - [...msgs].reverse().findIndex((m) => m.role === 'assistant');
            if (lastAssistantIdx >= 0 && lastAssistantIdx < msgs.length) {
              msgs[lastAssistantIdx]!.content = bg.fullText;
            }
            clearBackgroundStream();
            return { messages: convertToExportedMessages(msgs) };
          }

          return {
            messages: convertToExportedMessages(storedMessages),
          };
        },
        async append(item) {
          const msg = item.message;
          if (msg.role === 'system') return;

          // Assistant messages are completely managed by TauriChatAdapter background stream logic
          if (msg.role === 'assistant') {
            console.log(
              '[historyAdapter] Skipping assistant message save - managed by background stream',
            );
            return;
          }

          let conversationId = useAIChatStore.getState().activeConversationId;
          if (conversationId) {
            const exists = useAIChatStore
              .getState()
              .conversations.some((c) => c.id === conversationId);
            if (!exists) {
              if (!stateObj.pendingConversationPromise) {
                stateObj.pendingConversationPromise = useAIChatStore
                  .getState()
                  .createConversation(bookHash, 'Chat', conversationId)
                  .finally(() => {
                    stateObj.pendingConversationPromise = null;
                  });
              }
              await stateObj.pendingConversationPromise;
            }
          } else {
            if (!stateObj.pendingConversationPromise) {
              stateObj.pendingConversationPromise = useAIChatStore
                .getState()
                .createConversation(bookHash, 'Chat')
                .finally(() => {
                  stateObj.pendingConversationPromise = null;
                });
            }
            conversationId = await stateObj.pendingConversationPromise;
          }

          if (conversationId) {
            const textContent = msg.content
              .filter(
                (part): part is { type: 'text'; text: string } =>
                  'type' in part && part.type === 'text',
              )
              .map((part) => part.text)
              .join('\n');

            if (textContent) {
              await useAIChatStore.getState().addMessage({
                conversationId: conversationId,
                role: msg.role as 'user' | 'assistant',
                content: textContent,
              });
            }
          }
        },
      };
    }, [bookHash]);

    return (
      <AIAssistantWithRuntime
        adapter={adapter}
        historyAdapter={historyAdapter}
        onResetIndex={onResetIndex}
        isLoadingHistory={isLoadingHistory}
        hasActiveConversation={!!activeConversationId}
        bookHash={bookHash}
        sourceStore={sourceStore}
        currentTurnId={currentTurnId}
        onSourceClick={onSourceClick}
      />
    );
  },
);

AIAssistantChat.displayName = 'AIAssistantChat';

const AIAssistantWithRuntime = ({
  adapter,
  historyAdapter,
  onResetIndex,
  isLoadingHistory,
  hasActiveConversation,
  bookHash,
  sourceStore,
  currentTurnId,
  onSourceClick,
}: {
  adapter: NonNullable<ReturnType<typeof createTauriAdapter>>;
  historyAdapter?: ThreadHistoryAdapter;
  onResetIndex: () => void;
  isLoadingHistory: boolean;
  hasActiveConversation: boolean;
  bookHash: string;
  sourceStore: ReedySourceStore;
  currentTurnId: string | null;
  onSourceClick?: (source: SourceItem) => void;
}) => {
  const config = useMemo(() => {
    return {
      adapters: historyAdapter ? { history: historyAdapter } : undefined,
    };
  }, [historyAdapter]);

  const runtime = useLocalRuntime(adapter, config);

  if (!runtime) return null;

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <ThreadWrapper
        onResetIndex={onResetIndex}
        isLoadingHistory={isLoadingHistory}
        hasActiveConversation={hasActiveConversation}
        bookHash={bookHash}
        sourceStore={sourceStore}
        currentTurnId={currentTurnId}
        onSourceClick={onSourceClick}
      />
    </AssistantRuntimeProvider>
  );
};

const ThreadWrapper = ({
  onResetIndex,
  isLoadingHistory,
  hasActiveConversation,
  bookHash,
  sourceStore,
  currentTurnId,
  onSourceClick,
}: {
  onResetIndex: () => void;
  isLoadingHistory: boolean;
  hasActiveConversation: boolean;
  bookHash: string;
  sourceStore: ReedySourceStore;
  currentTurnId: string | null;
  onSourceClick?: (source: SourceItem) => void;
}) => {
  const [sources, setSources] = useState<RetrievedChunk[]>(
    currentTurnId ? sourceStore.get(currentTurnId) : [],
  );
  const assistantRuntime = useAssistantRuntime();
  const { setActiveConversation } = useAIChatStore();
  const hasResumedRef = useRef(false);

  useEffect(() => {
    const thread = assistantRuntime.thread;
    if (
      !isLoadingHistory &&
      hasActiveConversation &&
      !hasResumedRef.current &&
      thread.getState().messages.length === 0
    ) {
      const bg = getBackgroundStream();
      if (bg && bg.bookHash === bookHash && !bg.isComplete) {
        hasResumedRef.current = true;
        setTimeout(() => {
          console.log(
            '[ThreadWrapper] Found active background stream, triggering startRun to resume UI',
          );
          thread.startRun(null);
        }, 100);
      }
    }
  }, [isLoadingHistory, hasActiveConversation, bookHash, assistantRuntime.thread]);

  useEffect(() => {
    if (!currentTurnId) {
      setSources([]);
      return;
    }
    setSources(sourceStore.get(currentTurnId));
    return sourceStore.subscribe(currentTurnId, setSources);
  }, [currentTurnId, sourceStore]);

  const handleClear = useCallback(() => {
    cancelBackgroundStream();
    sourceStore.clear();
    setSources([]);
    setActiveConversation(null);
    assistantRuntime.switchToNewThread();
  }, [assistantRuntime, setActiveConversation, sourceStore]);

  return (
    <Thread
      sources={sources}
      onSourceClick={onSourceClick}
      onClear={handleClear}
      onResetIndex={onResetIndex}
      isLoadingHistory={isLoadingHistory}
      hasActiveConversation={hasActiveConversation}
    />
  );
};

import { GlobalMermaidModal } from '@/components/assistant/GlobalMermaidModal';

const AIAssistant = ({ bookKey }: AIAssistantProps) => {
  const { appService } = useEnv();
  const { settings } = useSettingsStore();
  const getBookData = useBookDataStore((s) => s.getBookData);
  const bookData = getBookData(bookKey);

  const reedyRuntime = settings?.aiSettings?.reedy?.runtime ?? 'mvp';
  const useAgentRuntime =
    settings?.aiSettings?.enabled === true &&
    settings?.aiSettings?.reedy?.enabled === true &&
    reedyRuntime === 'agent' &&
    !!appService &&
    isTauriAppPlatform() &&
    !!bookData?.bookDoc;

  if (useAgentRuntime) return <ReedyAgentAssistantBridge bookKey={bookKey} />;
  return <LegacyAIAssistant bookKey={bookKey} />;
};

const LegacyAIAssistant = ({ bookKey }: AIAssistantProps) => {
  const _ = useTranslation();
  const { appService } = useEnv();
  const { settings } = useSettingsStore();
  const getBookData = useBookDataStore((s) => s.getBookData);
  const getView = useReaderStore((s) => s.getView);
  const bookData = getBookData(bookKey);
  const progress = useBookProgress(bookKey);

  const [_isLoading, setIsLoading] = useState(true);
  const [isIndexing, setIsIndexing] = useState(false);
  const [indexProgress, setIndexProgress] = useState<number>(0);
  const [indexingPhase, setIndexingPhase] = useState<string>('');
  const [indexed, setIndexed] = useState(false);
  const [currentTurnId, setCurrentTurnId] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<'chat' | 'history'>('chat');
  const [promptMode, setPromptMode] = useState<PromptMode>('standard');
  const abortControllerRef = useRef<AbortController | null>(null);

  const {
    loadConversations,
    conversations,
    setActiveConversation,
    activeConversationId,
    createConversation,
  } = useAIChatStore();

  const bookHash = bookKey.split('-')[0] || '';
  const bookTitle = bookData?.book?.title || 'Unknown';
  const authorName = bookData?.book?.author || '';
  const currentPage = progress?.pageinfo?.current ?? 0;
  const currentSectionIndex = progress?.section?.current ?? 0;
  const aiSettings = settings?.aiSettings;

  useEffect(() => {
    if (bookHash) {
      loadConversations(bookHash);
    }
  }, [bookHash, loadConversations]);

  const sourceStore = useMemo(() => new ReedySourceStore(), []);
  const backend = useMemo<RetrievalBackend | null>(() => {
    if (!aiSettings) return null;
    const legacy = new LegacyIdbBackend(aiSettings);
    const reedy: RetrievalBackend | null =
      appService && isTauriAppPlatform()
        ? new ReedyBackend(appService as AppService, aiSettings)
        : null;
    return selectBackend({ settings: aiSettings, isTauri: isTauriAppPlatform(), legacy, reedy });
  }, [aiSettings, appService]);

  useEffect(() => {
    async function checkIndex() {
      if (!bookHash || !settings.aiSettings?.enabled) return;
      if (backend) {
        const isIndexed = await backend.isIndexed(bookHash);
        setIndexed(isIndexed);
      }
      setIsLoading(false);
    }
    checkIndex();
  }, [bookHash, backend, settings.aiSettings?.enabled]);

  const performIndexing = useCallback(async () => {
    if (!bookData?.bookDoc || isIndexing || indexed || !aiSettings || !backend) return;

    const controller = new AbortController();
    abortControllerRef.current = controller;

    setIsIndexing(true);
    setIndexProgress(0);

    try {
      if (backend.kind === 'legacy-idb') {
        const { indexBook } = await import('@/services/ai/ragService');
        await indexBook(
          bookData.bookDoc,
          bookHash,
          settings.aiSettings,
          (prog) => {
            setIndexProgress(Math.round((prog.current / prog.total) * 100));
            setIndexingPhase(prog.phase);
          },
          controller.signal,
        );
      } else {
        await backend.indexBook(bookData.bookDoc, bookHash, {
          onProgress: (p) => setIndexProgress(Math.round((p.current / p.total) * 100)),
        });
      }
      setIndexed(true);
    } catch (e) {
      if ((e as Error).message === 'Indexing aborted') {
        console.log('[AIAssistant] Indexing cancelled');
      } else {
        console.error('[AIAssistant] Indexing failed', e);
        alert('Indexing failed: ' + (e as Error).message);
      }
    } finally {
      setIsIndexing(false);
      abortControllerRef.current = null;
    }
  }, [bookData, bookHash, settings.aiSettings, isIndexing, indexed, backend, aiSettings]);

  const cancelIndexing = useCallback(() => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      abortControllerRef.current = null;
      setIsIndexing(false);
    }
  }, []);

  useEffect(() => {
    return () => cancelIndexing();
  }, [cancelIndexing]);

  const handleResetIndex = useCallback(async () => {
    if (!backend) return;
    if (appService && !(await appService.ask(_('Are you sure you want to re-index this book?'))))
      return;
    await backend.clearBook(bookHash);
    setIndexed(false);
    performIndexing();
  }, [bookHash, appService, backend, _, performIndexing]);

  const handleSourceClick = useCallback(
    (source: SourceItem) => {
      if (!source.cfi) return;
      getView(bookKey)?.goTo(source.cfi);
    },
    [bookKey, getView],
  );

  if (!settings.aiSettings?.enabled) {
    return (
      <div className='text-base-content/70 flex flex-col items-center justify-center p-8 text-center'>
        <p>AI Assistant is disabled globally.</p>
        <p className='text-sm'>Enable it in Settings {'>'} AI to use this feature.</p>
      </div>
    );
  }

  const handleNewChat = () => {
    cancelBackgroundStream();
    createConversation(bookHash, 'New Chat');
    setViewMode('chat');
  };

  if (!backend) return null;

  return (
    <div className='bg-base-100 flex h-full flex-col'>
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

      <div className='relative flex flex-1 flex-col overflow-hidden'>
        {viewMode === 'history' ? (
          <ChatHistoryList
            bookHash={bookHash}
            onSelect={async (id) => {
              cancelBackgroundStream();
              await setActiveConversation(id);
              setViewMode('chat');
            }}
            onClose={() => setViewMode('chat')}
          />
        ) : (
          <>
            <div className='border-base-200 bg-base-100 flex min-h-12 items-center justify-between border-b px-4 py-2'>
              <span className='mr-2 flex flex-1 items-center gap-2 truncate text-sm font-semibold opacity-70'>
                <MessageSquare className='size-4 shrink-0' />
                <span className='truncate'>
                  {conversations.find((c) => c.id === activeConversationId)?.title || 'New Chat'}
                </span>
              </span>
              <div className='flex shrink-0 items-center gap-2'>
                <select
                  className='select select-bordered select-xs bg-base-200 w-28'
                  value={promptMode}
                  onChange={(e) => setPromptMode(e.target.value as PromptMode)}
                  title='Cognitive Mode'
                >
                  <option value='standard'>标准模式</option>
                  <option value='knowledge'>百科问答</option>
                  <option value='devil'>反方思辨</option>
                  <option value='feynman'>费曼模式</option>
                  <option value='radar'>雷达模式</option>
                  <option value='discussion'>对抗讨论</option>
                </select>
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
                key={`${bookHash}-${activeConversationId || 'new'}`}
                aiSettings={aiSettings}
                bookHash={bookHash}
                bookTitle={bookTitle}
                authorName={authorName}
                currentPage={currentPage}
                currentSectionIndex={currentSectionIndex}
                promptMode={promptMode}
                backend={backend}
                sourceStore={sourceStore}
                currentTurnId={currentTurnId}
                setCurrentTurnId={setCurrentTurnId}
                onSourceClick={handleSourceClick}
                onResetIndex={handleResetIndex}
              />
            </div>
          </>
        )}
      </div>
      <GlobalMermaidModal />
    </div>
  );
};

const ReedyAgentAssistantBridge = ({ bookKey }: AIAssistantProps) => {
  const { appService } = useEnv();
  const { settings } = useSettingsStore();
  const getBookData = useBookDataStore((s) => s.getBookData);
  const getView = useReaderStore((s) => s.getView);
  const bookData = getBookData(bookKey);
  const progress = useBookProgress(bookKey);

  const bookHash = bookKey.split('-')[0] || '';
  const aiSettings = settings?.aiSettings;

  const readingContext = useMemo<ReadingContextSnapshot>(
    () => ({
      cfi: progress?.location ?? null,
      sectionIndex: progress?.section?.current ?? 0,
      chapterTitle: progress?.sectionLabel ?? null,
      pageNumber: progress?.pageinfo?.current ?? 0,
    }),
    [progress],
  );

  const handleNavigate = useCallback(
    (cfi: string) => {
      getView(bookKey)?.goTo(cfi);
    },
    [bookKey, getView],
  );

  if (!aiSettings || !appService || !bookData?.bookDoc) return null;

  return (
    <ReedyAssistant
      appService={appService as AppService}
      bookDoc={bookData.bookDoc}
      bookHash={bookHash}
      bookKey={bookKey}
      aiSettings={aiSettings}
      readingContext={readingContext}
      onNavigateToCfi={handleNavigate}
    />
  );
};

export default AIAssistant;
