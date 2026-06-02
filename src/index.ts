// pi-memsearch — barrel export
export { memsearchBackend } from "./backend";
export { MemsearchClient } from "./client";
export { loadMemsearchConfig } from "./config";
export type { MemsearchConfig, MemsearchScoping } from "./config";
export {
  computeBankScope,
  autoRecall,
  autoRetain,
  formatMemories,
  composeRecallQuery,
} from "./recall";
export {
  MemsearchSessionState,
  getMemsearchSessionState,
  setMemsearchSessionState,
} from "./state";
export type { BankScope, SearchResult, MemsearchSessionStateOptions } from "./types";
