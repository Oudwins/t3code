import { createContext, use } from "react";
import type { BranchToolbarHandle } from "./components/BranchToolbar";

export type BranchToolbarHandleRef = React.RefObject<BranchToolbarHandle | null>;

export const BranchToolbarHandleContext = createContext<BranchToolbarHandleRef | null>(null);

export function useBranchToolbarHandleContext(): BranchToolbarHandleRef | null {
  return use(BranchToolbarHandleContext);
}
