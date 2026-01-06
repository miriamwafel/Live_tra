export interface TranscriptEntry {
  id: string;
  timestamp: string;
  speaker: 'user' | 'model';
  text: string;
  isPartial: boolean;
}

export enum ConnectionStatus {
  DISCONNECTED = 'disconnected',
  CONNECTING = 'connecting',
  CONNECTED = 'connected',
  ERROR = 'error',
}

export interface ClientSession {
  id: string;
  date: string;
  summary?: string;
  transcript: TranscriptEntry[];
}

export interface ClientProfile {
  id: string;
  name: string;
  industry?: string;
  notes: string; // Manual notes
  knowledgeBase: string; // AI generated context (facts, preferences)
  sessions: ClientSession[];
  createdAt: string;
}

export type AppView = 'dashboard' | 'client-detail' | 'recording';
