'use client';

import { createContext, useContext, type ReactNode } from 'react';

/**
 * The book whose AI panel is currently on screen.
 *
 * Mermaid diagrams are cached per book in `reedy.db` (see
 * {@link '@/services/mermaidSvgStore'}), but the markdown component map that
 * renders them is a module-level constant — threading a prop down through it
 * would defeat its memoization. A context carries the value without touching
 * that component's identity.
 *
 * Defaults to null, which simply disables persistence: the diagram still
 * renders, it just is not stored. That keeps the component usable in tests and
 * anywhere outside the reader.
 */
const MermaidBookContext = createContext<string | null>(null);

export const MermaidBookProvider = ({
  bookHash,
  children,
}: {
  bookHash: string | null;
  children: ReactNode;
}) => {
  return <MermaidBookContext.Provider value={bookHash}>{children}</MermaidBookContext.Provider>;
};

export const useMermaidBookHash = (): string | null => useContext(MermaidBookContext);
