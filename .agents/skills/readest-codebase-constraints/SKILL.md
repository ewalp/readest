---
name: readest-codebase-constraints
description: Global architectural, coding, and environmental constraints for the Readest monorepo codebase.
---

# Readest Codebase Constraints & Guidelines

This document outlines the global development constraints and rules for working with the Readest codebase. Any agent or developer modifying this repository must adhere to these guidelines.

## 1. Monorepo Architecture
- **Package Manager**: Managed by `pnpm` workspace (`pnpm-workspace.yaml`). Do not use `npm` or `yarn` directly.
- **Sub-packages**:
  - `apps/readest-app`: Main application frontend (Next.js + TailwindCSS + Tauri client).
  - `packages/foliate-js`: Custom EPUB/Book reading engine component.
  - `packages/simplecc-wasm`: WASM-based Chinese Simplified/Traditional converter.
  - `packages/tauri`: Rust backend core and integrations.

## 2. Environment Configurations
- Next.js development and builds are environment-specific:
  - **Tauri local environment**: Uses `.env.tauri` via command prefix `dotenv -e .env.tauri`.
  - **Web environment**: Uses `.env.web` via command prefix `dotenv -e .env.web`.
- When adding or modifying environment variables, ensure they are synchronized across both files (and their corresponding `.example` files).

## 3. Store State Management (Zustand)
- All client states (Settings, Notebook, AI Chat, etc.) are managed using Zustand stores located in `apps/readest-app/src/store/`.
- **Strict Separation Rule**: Stores handling book-specific resources (e.g. AI Chat, bookmarks, notes) must be partitioned or keyed by `bookHash` or `bookKey` to prevent data leakage across different books.
- Reset mechanisms should be implemented in stores to clean state when switching context.

## 4. Internationalization (i18n)
- Do not hardcode user-facing strings.
- Use the `useTranslation` hook from `@/hooks/useTranslation` to fetch translated texts.
- Run `pnpm --filter @readest/readest-app i18n:extract` when adding new strings to update the localization dictionaries.

## 5. UI Custom Component Keys & Remounting
- When rendering client-side UI that relies on asynchronous history or book-level runtime context (like `<AIAssistantChat>` or Foliate engine wrapper), key the component using the active context variables (e.g. `key={`${bookHash}-${activeConversationId}`}`).
- This guarantees React remounts the component upon context switch, preventing internal memory leaks and state contamination.

## 6. Code Style & Testing
- Format code using Prettier and ESLint: `pnpm format` / `pnpm lint`.
- Always run the tests to verify changes: `pnpm --filter @readest/readest-app test --run`.
- Keep cargo rules clean. Run clippy via `pnpm clippy` to check Rust files.
