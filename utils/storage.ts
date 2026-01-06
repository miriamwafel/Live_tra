import { ClientProfile } from '../types';

const STORAGE_KEY = 'livescribe_clients_v1';

export const getClients = (): ClientProfile[] => {
  try {
    const data = localStorage.getItem(STORAGE_KEY);
    return data ? JSON.parse(data) : [];
  } catch (e) {
    console.error("Storage error", e);
    return [];
  }
};

export const saveClient = (client: ClientProfile) => {
  const clients = getClients();
  const existingIndex = clients.findIndex(c => c.id === client.id);
  
  if (existingIndex >= 0) {
    clients[existingIndex] = client;
  } else {
    clients.push(client);
  }
  
  localStorage.setItem(STORAGE_KEY, JSON.stringify(clients));
};

export const deleteClient = (clientId: string) => {
  const clients = getClients().filter(c => c.id !== clientId);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(clients));
};

export const createNewClient = (name: string, industry: string): ClientProfile => {
  return {
    id: Date.now().toString(),
    name,
    industry,
    notes: '',
    knowledgeBase: '',
    sessions: [],
    createdAt: new Date().toISOString()
  };
};