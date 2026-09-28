import { createContext, useContext, useReducer, type Dispatch, type ReactNode } from 'react';
import { INITIAL_STATE, demoReducer, type DemoAction, type DemoState } from './demo';

const StateContext = createContext<DemoState>(INITIAL_STATE);
const DispatchContext = createContext<Dispatch<DemoAction>>(() => undefined);

/** Session-only demo state. A refresh resets it. */
export function DemoStoreProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(demoReducer, INITIAL_STATE);
  return (
    <StateContext.Provider value={state}>
      <DispatchContext.Provider value={dispatch}>{children}</DispatchContext.Provider>
    </StateContext.Provider>
  );
}

export const useDemoState = (): DemoState => useContext(StateContext);
export const useDemoDispatch = (): Dispatch<DemoAction> => useContext(DispatchContext);
