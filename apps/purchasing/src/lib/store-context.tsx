'use client';

// React binding for the demo store.
//
// Server render and the first client render both use the seed state, so the
// markup matches; localStorage is read in an effect straight after mount.

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { buildInitialState } from './demo-data';
import * as store from './store';
import type {
  DemoSettings,
  DemoState,
  Job,
  PurchaseRequest,
  Requestor,
  RequestStatus,
  Vendor,
} from './types';

const ACTOR_KEY = 'lippolis.purchasing.demo.actor';
const DEFAULT_ACTOR = 'Sara Brennan';

interface PurchasingContextValue {
  state: DemoState;
  hydrated: boolean;
  /** Who the demo is currently acting as — there is no real authentication. */
  actor: string;
  setActor: (name: string) => void;
  createRequest: (input: Omit<store.NewRequestInput, 'actor'>) => PurchaseRequest;
  transition: (id: string, to: RequestStatus, action: string, detail?: string) => void;
  addNote: (id: string, note: string) => void;
  generatePo: (id: string) => string | null;
  updateSettings: (settings: DemoSettings) => void;
  resetDemoData: () => void;
  vendorById: (id: string) => Vendor | undefined;
  jobById: (id: string) => Job | undefined;
  requestorById: (id: string) => Requestor | undefined;
  requestById: (id: string) => PurchaseRequest | undefined;
}

const PurchasingContext = createContext<PurchasingContextValue | null>(null);

export function PurchasingProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<DemoState>(buildInitialState);
  const [hydrated, setHydrated] = useState(false);
  const [actor, setActorState] = useState(DEFAULT_ACTOR);

  useEffect(() => {
    setState(store.loadState());
    setActorState(window.localStorage.getItem(ACTOR_KEY) ?? DEFAULT_ACTOR);
    setHydrated(true);
  }, []);

  const commit = useCallback((next: DemoState) => {
    store.saveState(next);
    setState(next);
  }, []);

  const setActor = useCallback((name: string) => {
    setActorState(name);
    try {
      window.localStorage.setItem(ACTOR_KEY, name);
    } catch {
      // Non-fatal: the switcher still works for this page view.
    }
  }, []);

  const value = useMemo<PurchasingContextValue>(() => {
    return {
      state,
      hydrated,
      actor,
      setActor,
      createRequest(input) {
        const result = store.createRequest(state, { ...input, actor });
        commit(result.state);
        return result.request;
      },
      transition(id, to, action, detail) {
        commit(store.transitionRequest(state, id, to, actor, action, detail));
      },
      addNote(id, note) {
        commit(store.addNote(state, id, actor, note));
      },
      generatePo(id) {
        const result = store.generatePo(state, id, actor);
        commit(result.state);
        return result.poNumber;
      },
      updateSettings(settings) {
        commit(store.updateSettings(state, settings));
      },
      resetDemoData() {
        setState(store.resetState());
      },
      vendorById: (id) => state.vendors.find((v) => v.id === id),
      jobById: (id) => state.jobs.find((j) => j.id === id),
      requestorById: (id) => state.requestors.find((r) => r.id === id),
      requestById: (id) => state.requests.find((r) => r.id === id),
    };
  }, [state, hydrated, actor, setActor, commit]);

  return <PurchasingContext.Provider value={value}>{children}</PurchasingContext.Provider>;
}

export function usePurchasing(): PurchasingContextValue {
  const ctx = useContext(PurchasingContext);
  if (!ctx) throw new Error('usePurchasing must be used inside <PurchasingProvider>');
  return ctx;
}
