export type Stage = 'intent' | 'plan' | 'generate' | 'check' | 'preview' | 'failed';
export type ItemStatus = 'pending' | 'running' | 'done' | 'error';
export type FilePath = 'server.js' | 'index.html' | 'app.js';

export const FILE_PATHS: FilePath[] = ['server.js', 'index.html', 'app.js'];
export const MAX_REPAIRS = 3;
export const MAX_PLAN_REJECTS = 1;
export const SUMMARY_TRIGGER = 12;

export interface Field {
  name: string;
  label: string;
  type: 'text' | 'number' | 'boolean' | 'date';
  required: boolean;
  max_length?: number;
}

export interface Intent {
  sufficient: boolean;
  app_type: string;
  entity: string;
  fields: Field[];
  question: string;
  options: string[];
}

export interface Plan {
  title: string;
  summary: string;
  entity: string;
  fields: Field[];
  defaults: string[];
  files: { path: FilePath; purpose: string }[];
  api: { method: string; path: string; desc: string }[];
  max_length: number;
  /** Cumulative change requests applied by incremental revisions. */
  changes?: string[];
  /** Field names removed by revisions; the page must no longer reference them. */
  removed?: string[];
}

export interface RevisionResult {
  kind: 'increment' | 'new_app' | 'type_change' | 'unsupported';
  reason: string;
  change?: string;
  fields?: Field[];
  added?: string[];
  removed?: string[];
  affected?: FilePath[];
}

export interface Revision {
  request: string;
  change: string;
  affected: FilePath[];
  added: string[];
  removed: string[];
  backupFiles: Partial<Record<FilePath, string>>;
  backupPlan: Plan;
}

export interface Message {
  role: 'user' | 'agent' | 'system';
  text: string;
  ts: number;
}

export interface CheckItem {
  name: string;
  status: ItemStatus;
  detail?: string;
}

export interface SessionState {
  requirement: string;
  intent: Intent | null;
  asked: boolean;
  awaitingAnswer: boolean;
  plan: Plan | null;
  planRejects: number;
  awaitingConfirm: boolean;
  tasks: { path: FilePath; status: ItemStatus }[];
  files: Partial<Record<FilePath, string>>;
  lastGood: Partial<Record<FilePath, string>>;
  lastGoodPassed: boolean;
  repairs: number;
  checks: CheckItem[];
  lastError: string;
  port: number | null;
  running: boolean;
  messages: Message[];
  logs: string[];
  summary: string;
  summarizedAt: number;
  revision: Revision | null;
  suggestNew: string;
  /** Message count at the moment each stage card (re)appeared; drives chronological placement. */
  anchors: Record<string, number>;
}

export interface Session {
  id: number;
  sid: string;
  title: string;
  stage: Stage;
  state: SessionState;
  updated_at?: string;
}

export const emptyState = (requirement: string): SessionState => ({
  requirement,
  intent: null,
  asked: false,
  awaitingAnswer: false,
  plan: null,
  planRejects: 0,
  awaitingConfirm: false,
  tasks: FILE_PATHS.map((path) => ({ path, status: 'pending' })),
  files: {},
  lastGood: {},
  lastGoodPassed: false,
  repairs: 0,
  checks: [],
  lastError: '',
  port: null,
  running: false,
  messages: [],
  logs: [],
  summary: '',
  summarizedAt: 0,
  revision: null,
  suggestNew: '',
  anchors: {},
});
