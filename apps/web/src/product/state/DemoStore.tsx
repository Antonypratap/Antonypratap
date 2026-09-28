import {
  createContext,
  useContext,
  useEffect,
  useReducer,
  type Dispatch,
  type ReactNode,
} from 'react';
import {
  INITIAL_STATE,
  decisionLog,
  demoReducer,
  replayDecisions,
  type DemoAction,
  type DemoState,
} from './demo';

const StateContext = createContext<DemoState>(INITIAL_STATE);
const DispatchContext = createContext<Dispatch<DemoAction>>(() => undefined);

const STORAGE_KEY = 'veyra-demo-decisions';

function load(): DemoState {
  try {
    const saved = window.sessionStorage.getItem(STORAGE_KEY);
    return saved ? replayDecisions(JSON.parse(saved)) : INITIAL_STATE;
  } catch {
    return INITIAL_STATE;
  }
}

function save(state: DemoState): void {
  try {
    window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(decisionLog(state)));
  } catch {
    // Storage unavailable (private window, blocked site data): the demo still works in memory.
  }
}

/**
 * One demo state for the whole app, mounted above both the homepage and the product so
 * leaving the product never resets it. Kept for this browser tab only.
 */
export function DemoStoreProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(demoReducer, undefined, load);
  useEffect(() => {
    save(state);
  }, [state]);
  return (
    <StateContext.Provider value={state}>
      <DispatchContext.Provider value={dispatch}>{children}</DispatchContext.Provider>
    </StateContext.Provider>
  );
}

export const useDemoState = (): DemoState => useContext(StateContext);
export const useDemoDispatch = (): Dispatch<DemoAction> => useContext(DispatchContext);
