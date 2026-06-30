---
name: ai-chat-separation
description: Rules and guidelines for separating AI chat conversation history per book in the Readest application.
---

# AI Chat History Separation

This skill enforces strict separation of AI chat conversations and messages on a per-book basis in the Readest application. It prevents conversation history or messages from one book leaking or displaying when another book is loaded.

## Core Rules

1. **Book-Scoped Stores**:
   - The state store (e.g., `useAIChatStore`) must track the active book identifier (`currentBookHash`).
   - When loading conversations for a new book (`currentBookHash !== bookHash`), the store MUST immediately reset the `activeConversationId` to `null` and clear the `messages` array (`[]`).
   
2. **Conversation Loading Lifecycle**:
   - Clearing the old book's conversation state prevents the UI from showing stale messages from the previous book while the new book's conversations are being queried.
   - Once loading completes, the UI should automatically restore the most recent session or pre-allocate a session ID specifically for the new book.

3. **Pre-allocated Conversation ID**:
   - To avoid component remounts and stream disruption when the user sends the very first message on an empty chat thread, the store should pre-allocate a unique `activeConversationId` even if the database has zero records for this book.
   - When the user sends a message, `historyAdapter.append` checks if the pre-allocated conversation ID exists in the database. If not, it saves the conversation to the database without changing the active ID, keeping the component key stable and the stream uninterrupted.

4. **Component State Synchronization (Key Keying)**:
   - The UI chat component (e.g., `<AIAssistantChat>`) must be keyed with a combination of the current book identifier and the active conversation ID: `key={`${bookHash}-${activeConversationId || 'new'}`}`.
   - This ensures that if the book or active conversation ID changes (due to restoration, explicit new chat, or sidebar selection), the component automatically remounts, recreating the runtime and loading the correct conversation history cleanly.

## Implementation Reference

- In [aiChatStore.ts](file:///Volumes/fx900/myownproj/readest/apps/readest-app/src/store/aiChatStore.ts), when `loadConversations` is called:
  ```typescript
  const conversations = await aiStore.getConversations(bookHash);
  let activeId = get().activeConversationId;
  let messages = get().messages;

  if (!activeId || isNewBook) {
    if (conversations.length > 0) {
      activeId = conversations[0]!.id;
      messages = await aiStore.getMessages(bookHash, activeId);
    } else {
      activeId = generateId(); // Pre-allocate ID
      messages = [];
    }
  }
  ```

- In [AIAssistant.tsx](file:///Volumes/fx900/myownproj/readest/apps/readest-app/src/app/reader/components/notebook/AIAssistant.tsx), `historyAdapter.append` persists the pre-allocated conversation on first message:
  ```typescript
  let conversationId = useAIChatStore.getState().activeConversationId;
  if (conversationId) {
    const exists = useAIChatStore.getState().conversations.some((c) => c.id === conversationId);
    if (!exists) {
      // Create conversation with the pre-allocated ID
      await useAIChatStore.getState().createConversation(bookHash, 'Chat', conversationId);
    }
  }
  ```

- Render key in `AIAssistant.tsx`:
  ```typescript
  <AIAssistantChat
    key={`${bookHash}-${activeConversationId || 'new'}`}
    aiSettings={aiSettings}
    bookHash={bookHash}
    ...
  />
  ```
