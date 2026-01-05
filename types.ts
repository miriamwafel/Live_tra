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