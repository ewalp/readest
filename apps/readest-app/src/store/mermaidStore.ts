import { create } from 'zustand';

interface MermaidStore {
  isOpen: boolean;
  code: string;
  openModal: (code: string) => void;
  closeModal: () => void;
}

export const useMermaidStore = create<MermaidStore>((set) => ({
  isOpen: false,
  code: '',
  openModal: (code) => set({ isOpen: true, code }),
  closeModal: () => set({ isOpen: false }),
}));
