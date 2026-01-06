import React, { useState, useEffect, useRef } from 'react';
import { GoogleGenAI, LiveServerMessage, Modality } from '@google/genai';
import { createBlob, resampleTo16k, blobToBase64 } from './utils/audioUtils';
import { TranscriptEntry, ConnectionStatus, ClientProfile, AppView, ClientSession } from './types';
import { getClients, saveClient, deleteClient, createNewClient } from './utils/storage';
import TranscriptItem from './components/TranscriptItem';
import { 
  MicrophoneIcon, 
  StopIcon, 
  ArrowDownTrayIcon, 
  TrashIcon, 
  DocumentTextIcon, 
  ArrowPathIcon,
  UserGroupIcon,
  ClipboardDocumentIcon,
  ClipboardDocumentCheckIcon,
  LockClosedIcon,
  KeyIcon,
  PlusIcon,
  UserIcon,
  BriefcaseIcon,
  ChevronLeftIcon,
  SparklesIcon,
  EnvelopeIcon,
  PresentationChartLineIcon
} from '@heroicons/react/24/solid';

const CORRECT_PASSWORD = '1234'; 

const App: React.FC = () => {
  // --- Auth State ---
  const [isLoggedIn, setIsLoggedIn] = useState(false);
  const [passwordInput, setPasswordInput] = useState('');
  const [loginError, setLoginError] = useState(false);

  // --- CRM State ---
  const [view, setView] = useState<AppView>('dashboard');
  const [clients, setClients] = useState<ClientProfile[]>([]);
  const [selectedClient, setSelectedClient] = useState<ClientProfile | null>(null);
  const [showNewClientModal, setShowNewClientModal] = useState(false);
  const [newClientName, setNewClientName] = useState('');
  const [newClientIndustry, setNewClientIndustry] = useState('');
  
  // --- Generator State ---
  const [isGenerating, setIsGenerating] = useState(false);
  const [generatedContent, setGeneratedContent] = useState<string | null>(null);
  const [generationType, setGenerationType] = useState<'email' | 'strategy' | 'knowledge'>('email');
  const [descriptionPreview, setDescriptionPreview] = useState<string | null>(null);
  const [pendingTranscript, setPendingTranscript] = useState<TranscriptEntry[] | null>(null);

  // --- Session/Recording State ---
  const [status, setStatus] = useState<ConnectionStatus>(ConnectionStatus.DISCONNECTED);
  const [liveTranscript, setLiveTranscript] = useState<TranscriptEntry[]>([]);
  const [diarizedTranscript, setDiarizedTranscript] = useState<TranscriptEntry[]>([]);
  const [activeTab, setActiveTab] = useState<'live' | 'diarized'>('live');
  const [volume, setVolume] = useState(0);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [isCopied, setIsCopied] = useState(false);
  const [audioBlob, setAudioBlob] = useState<Blob | null>(null);
  const [isProcessingDiarization, setIsProcessingDiarization] = useState(false);

  // --- Refs ---
  const inputAudioContextRef = useRef<AudioContext | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const sourceNodeRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const sessionRef = useRef<any>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const currentInputTransRef = useRef<string>('');
  const scrollBottomRef = useRef<HTMLDivElement>(null);
  const isRecordingActiveRef = useRef<boolean>(false);
  const reconnectTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const currentTranscript = activeTab === 'live' ? liveTranscript : diarizedTranscript;

  // --- Effects ---
  useEffect(() => {
    setClients(getClients());
  }, []);

  useEffect(() => {
    if (scrollBottomRef.current) {
      scrollBottomRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [liveTranscript, diarizedTranscript, activeTab]);

  useEffect(() => {
    return () => {
      isRecordingActiveRef.current = false;
      cleanupSession();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // --- CRM Logic ---

  const handleCreateClient = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newClientName.trim()) return;
    const client = createNewClient(newClientName, newClientIndustry);
    saveClient(client);
    setClients(getClients());
    setShowNewClientModal(false);
    setNewClientName('');
    setNewClientIndustry('');
    // Open the new client immediately
    setSelectedClient(client);
    setView('client-detail');
  };

  const handleSelectClient = (client: ClientProfile) => {
    setSelectedClient(client);
    setView('client-detail');
    setGeneratedContent(null);
  };

  const handleBackToDashboard = () => {
    setView('dashboard');
    setSelectedClient(null);
    stopUserAction(); // Ensure recording stops if they force back
  };

  const startRecordingForClient = () => {
    if (!selectedClient) return;
    // Clear previous session data
    setLiveTranscript([]);
    setDiarizedTranscript([]);
    setAudioBlob(null);
    audioChunksRef.current = [];
    setActiveTab('live');
    setView('recording');
    startSession(); // Auto-start
  };

  const clearRecordingData = () => {
    setLiveTranscript([]);
    setDiarizedTranscript([]);
    setAudioBlob(null);
    audioChunksRef.current = [];
  };

  const saveSessionToClient = async () => {
    if (!selectedClient) return;
    if (liveTranscript.length === 0 && diarizedTranscript.length === 0) {
        setView('client-detail');
        return;
    }

    const finalTranscript = diarizedTranscript.length > 0 ? diarizedTranscript : liveTranscript;
    setPendingTranscript(finalTranscript);

    // Generate preview
    await generateDescriptionPreview(selectedClient, finalTranscript);
  };

  const generateDescriptionPreview = async (client: ClientProfile, transcript: TranscriptEntry[]) => {
    setIsGenerating(true);
    setDescriptionPreview(null);

    try {
      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
      const transcriptText = transcript.map(t => `[${t.timestamp}] ${t.text}`).join('\n');
      const wordCount = transcriptText.split(/\s+/).length;

      const prompt = `Jesteś protokolantem spotkania. Twoim zadaniem jest napisać szczegółową relację z rozmowy.

Klient: ${client.name} (${client.industry || 'Brak branży'})

${client.knowledgeBase ? `Wcześniejsze informacje o kliencie:\n${client.knowledgeBase}\n\n` : ''}=== ROZMOWA ===
${transcriptText}
=== KONIEC ===

NAPISZ szczegółową relację z tej rozmowy:
- Opisz CO kto powiedział, jakie padły słowa
- Opisz przebieg rozmowy chronologicznie
- Uwzględnij WSZYSTKIE szczegóły - tematy, liczby, nazwy, daty
- Pisz prostym językiem, bez interpretacji i wniosków AI
- NIE pisz rzeczy typu "wnioskując z...", "klient wydaje się...", "można założyć że..."
- Pisz TYLKO fakty - co zostało powiedziane, bez domysłów
- Minimum ${wordCount} słów

Pisz w stylu: "Rozmowa dotyczyła... Klient powiedział że... Omówiono temat... Padła informacja że..."`;

      const response = await ai.models.generateContent({
        model: 'gemini-2.0-flash',
        contents: prompt
      });

      setDescriptionPreview(response.text || '');
    } catch (e) {
      console.error(e);
      alert("Błąd generowania opisu.");
      setDescriptionPreview(null);
    } finally {
      setIsGenerating(false);
    }
  };

  const acceptDescription = () => {
    if (!selectedClient || !descriptionPreview) return;

    const updatedClient = { ...selectedClient, knowledgeBase: descriptionPreview };
    saveClient(updatedClient);
    setClients(getClients());
    setSelectedClient(updatedClient);

    // Clear everything
    setDescriptionPreview(null);
    setPendingTranscript(null);
    clearRecordingData();
    setView('client-detail');
  };

  const rejectDescription = () => {
    setDescriptionPreview(null);
    setPendingTranscript(null);
    clearRecordingData();
    setView('client-detail');
  };

  // --- AI Generator Logic ---

  const generateArtifact = async (client: ClientProfile, type: 'email' | 'strategy' | 'knowledge', sessionTranscript: TranscriptEntry[] | null = null) => {
    setIsGenerating(true);
    setGenerationType(type);
    setGeneratedContent(null);

    try {
        const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });

        // Prepare Context
        const lastSession = sessionTranscript || (client.sessions.length > 0 ? client.sessions[0].transcript : []);
        const transcriptText = lastSession.map(t => `${t.timestamp} [${t.speaker}]: ${t.text}`).join('\n');

        let prompt = "";

        if (type === 'email') {
            prompt = `Jesteś asystentem biznesowym.
            Klient: ${client.name} (${client.industry || 'Brak branży'}).
            Baza wiedzy o kliencie: ${client.knowledgeBase || 'Brak danych'}.

            Ostatnia rozmowa (transkrypcja):
            ${transcriptText}

            Zadanie: Napisz profesjonalny e-mail podsumowujący (follow-up) do tego klienta.
            Zaproponuj kolejne kroki wynikające z rozmowy. Styl: profesjonalny, ale relacyjny.`;
        } else if (type === 'strategy') {
            prompt = `Jesteś strategiem biznesowym.
            Klient: ${client.name}.
            Kontekst: ${client.knowledgeBase}.

            Ostatnia rozmowa:
            ${transcriptText}

            Zadanie: Stwórz szkic strategii/oferty dla tego klienta.
            Wypunktuj:
            1. Zrozumiane potrzeby/problemy.
            2. Proponowane rozwiązania (bazując na tym co było mówione).
            3. Kluczowe korzyści.
            4. Wstępny plan działania.`;
        } else if (type === 'knowledge') {
            const wordCount = transcriptText.split(/\s+/).length;
            prompt = `Jesteś ekspertem od dokumentowania spotkań biznesowych.

            Klient: ${client.name} (${client.industry || 'Brak branży'})

            Aktualna baza wiedzy o kliencie: ${client.knowledgeBase || 'Brak wcześniejszych danych'}

            === ROZMOWA DO PRZEANALIZOWANIA ===
            ${transcriptText}
            === KONIEC ROZMOWY ===

            ZADANIE: Napisz EKSTREMALNIE SZCZEGÓŁOWY opis tej rozmowy.

            WYMAGANIA:
            - Opis musi mieć MINIMUM ${wordCount} słów (tyle ile transkrypcja lub więcej)
            - Opisz KAŻDY poruszony temat bardzo dokładnie
            - Uwzględnij WSZYSTKIE szczegóły, niuanse, kontekst
            - Opisz ton rozmowy, nastrój, dynamikę
            - Wynotuj WSZYSTKIE konkretne informacje (liczby, daty, nazwiska, firmy, produkty)
            - Opisz co klient powiedział, jak zareagował, jakie miał obawy
            - Uwzględnij wszelkie ustalenia, obietnice, kolejne kroki
            - Jeśli była wcześniejsza baza wiedzy - zintegruj nowe informacje ze starymi
            - NIE pomijaj żadnych detali - im więcej szczegółów tym lepiej
            - Pisz w trzeciej osobie, profesjonalnie ale szczegółowo

            FORMAT: Ciągły tekst opisowy (nie punkty). Możesz użyć akapitów dla czytelności.

            Zwróć TYLKO szczegółowy opis do bazy wiedzy (bez komentarzy, bez nagłówków typu "Opis rozmowy:").`;
        }

        const response = await ai.models.generateContent({
            model: 'gemini-2.0-flash',
            contents: prompt
        });
        const text = response.text;

        if (type === 'knowledge') {
            // Auto-save knowledge base
            const updatedClient = { ...client, knowledgeBase: text };
            saveClient(updatedClient);
            setClients(getClients());
            setSelectedClient(updatedClient);
            alert("Baza wiedzy klienta została zaktualizowana!");
            if (view === 'recording') setView('client-detail');
        } else {
            setGeneratedContent(text);
        }

    } catch (e) {
        console.error(e);
        alert("Błąd generowania AI.");
    } finally {
        setIsGenerating(false);
    }
  };

  // --- Audio / Transcript Logic (Existing) ---
  const formatTime = () => {
    const now = new Date();
    return now.toLocaleTimeString('pl-PL', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  };

  const updateLiveTranscript = (text: string, isFinal: boolean) => {
    setLiveTranscript(prev => {
      const speaker = 'user'; 
      const newEntry: TranscriptEntry = {
        id: Date.now().toString() + Math.random(),
        timestamp: formatTime(),
        speaker,
        text,
        isPartial: !isFinal
      };
      if (prev.length > 0) {
        const last = prev[prev.length - 1];
        if (last.isPartial) {
          if (isFinal) {
             return [...prev.slice(0, -1), { ...last, text, isPartial: false }];
          } else {
             return [...prev.slice(0, -1), { ...last, text }];
          }
        }
      }
      return [...prev, newEntry];
    });
  };

  const startSession = async () => {
    if (status === ConnectionStatus.CONNECTING || status === ConnectionStatus.CONNECTED) return;
    try {
      setErrorMsg(null);
      setStatus(ConnectionStatus.CONNECTING);
      isRecordingActiveRef.current = true;
      setActiveTab('live');
      
      if (liveTranscript.length === 0) {
        setAudioBlob(null);
        audioChunksRef.current = [];
      }

      if (inputAudioContextRef.current) await inputAudioContextRef.current.close();
      inputAudioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)();

      let stream = mediaStreamRef.current;
      if (!stream || !stream.active) {
         stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, autoGainControl: true, noiseSuppression: true } });
         mediaStreamRef.current = stream;
      }

      if (!mediaRecorderRef.current || mediaRecorderRef.current.state === 'inactive') {
         const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : 'audio/mp4'; 
         const recorder = new MediaRecorder(stream, { mimeType });
         mediaRecorderRef.current = recorder;
         recorder.ondataavailable = (event) => {
           if (event.data.size > 0) audioChunksRef.current.push(event.data);
         };
         recorder.start(1000); 
      }

      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
      const sessionPromise = ai.live.connect({
        model: 'gemini-2.5-flash-native-audio-preview-09-2025',
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } } },
          inputAudioTranscription: {}, 
          systemInstruction: { parts: [{ text: "Jesteś stenografem. Zapisuj dokładnie po polsku." }] },
        },
        callbacks: {
          onopen: () => {
            setStatus(ConnectionStatus.CONNECTED);
            if (!inputAudioContextRef.current || !stream) return;
            if (inputAudioContextRef.current.state === 'suspended') inputAudioContextRef.current.resume();
            
            const source = inputAudioContextRef.current.createMediaStreamSource(stream);
            sourceNodeRef.current = source;
            const processor = inputAudioContextRef.current.createScriptProcessor(4096, 1, 1);
            processorRef.current = processor;
            
            processor.onaudioprocess = (e) => {
              const inputData = e.inputBuffer.getChannelData(0);
              let sum = 0;
              for(let i=0; i<inputData.length; i++) sum += inputData[i] * inputData[i];
              setVolume(Math.sqrt(sum / inputData.length));
              const resampledData = resampleTo16k(inputData, inputAudioContextRef.current?.sampleRate || 48000);
              sessionPromise.then(s => s.sendRealtimeInput({ media: createBlob(resampledData) }));
            };
            source.connect(processor);
            processor.connect(inputAudioContextRef.current.destination);
          },
          onmessage: async (msg: LiveServerMessage) => {
            const content = msg.serverContent;
            if (content?.inputTranscription?.text) {
                 currentInputTransRef.current += content.inputTranscription.text;
                 updateLiveTranscript(currentInputTransRef.current, false);
            }
            if (content?.turnComplete && currentInputTransRef.current) {
                 updateLiveTranscript(currentInputTransRef.current, true);
                 currentInputTransRef.current = '';
            }
          },
          onclose: () => {
            cleanupSession(false);
            if (isRecordingActiveRef.current) {
                setStatus(ConnectionStatus.CONNECTING);
                reconnectTimeoutRef.current = setTimeout(startSession, 500);
            } else {
                setStatus(ConnectionStatus.DISCONNECTED);
                finalizeRecording();
            }
          },
          onerror: () => {
             if (isRecordingActiveRef.current) {
                 cleanupSession(false);
                 reconnectTimeoutRef.current = setTimeout(startSession, 1000);
             } else {
                setErrorMsg("Błąd połączenia.");
                stopUserAction();
             }
          }
        }
      });
      sessionRef.current = await sessionPromise;
    } catch (err) {
      console.error(err);
      setErrorMsg("Błąd mikrofonu/sieci.");
      stopUserAction();
    }
  };

  const cleanupSession = (fullStop = true) => {
    if (currentInputTransRef.current) {
      updateLiveTranscript(currentInputTransRef.current, true);
      currentInputTransRef.current = '';
    }
    try { sourceNodeRef.current?.disconnect(); } catch {}
    try { processorRef.current?.disconnect(); } catch {}
    if (fullStop) {
        if (mediaStreamRef.current) mediaStreamRef.current.getTracks().forEach(t => t.stop());
        if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') mediaRecorderRef.current.stop();
    }
    try { inputAudioContextRef.current?.close(); } catch {}
    try { sessionRef.current?.close(); } catch {}
    if (reconnectTimeoutRef.current) clearTimeout(reconnectTimeoutRef.current);
    setVolume(0);
  };

  const finalizeRecording = () => {
    if (audioChunksRef.current.length > 0) {
        const mimeType = mediaRecorderRef.current?.mimeType || 'audio/webm';
        setAudioBlob(new Blob(audioChunksRef.current, { type: mimeType }));
    }
  };

  const stopUserAction = () => {
    isRecordingActiveRef.current = false;
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') mediaRecorderRef.current.stop();
    cleanupSession(true);
    setStatus(ConnectionStatus.DISCONNECTED);
    finalizeRecording();
  };

  const handleDiarization = async () => {
    if (!audioBlob) return;
    setIsProcessingDiarization(true);
    try {
        const base64Audio = await blobToBase64(audioBlob);
        const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
        const modelId = 'gemini-2.0-flash';
        const response = await ai.models.generateContent({
            model: modelId,
            contents: {
                parts: [
                    { inlineData: { mimeType: audioBlob.type.split(';')[0] || 'audio/webm', data: base64Audio } },
                    { text: `Diarizacja (rozpoznanie mówców) i transkrypcja pliku audio. Język polski. Format: [MM:SS] Mówca: Tekst.` }
                ]
            }
        });
        const text = response.text;
        if (text) {
            const newEntries: TranscriptEntry[] = text.split('\n')
                .filter(l => l.trim().length > 0)
                .map((l, i) => ({
                    id: `d-${i}`,
                    timestamp: l.match(/\[(.*?)\]/)?.[1] || "00:00",
                    speaker: l.toLowerCase().includes('mówca 2') ? 'model' : 'user',
                    text: l.replace(/\[.*?\]/, '').trim(),
                    isPartial: false
                }));
            setDiarizedTranscript(newEntries);
            setActiveTab('diarized');
        }
    } catch (e) { console.error(e); setErrorMsg("Błąd analizy."); } finally { setIsProcessingDiarization(false); }
  };

  const handleCopy = (text: string) => {
    navigator.clipboard.writeText(text).then(() => {
        setIsCopied(true);
        setTimeout(() => setIsCopied(false), 2000);
    });
  };

  // --- RENDERING ---

  // 1. LOGIN
  if (!isLoggedIn) {
    return (
      <div className="flex flex-col h-screen bg-slate-900 text-slate-100 items-center justify-center font-sans">
        <div className="w-full max-w-sm p-8 bg-slate-800 rounded-2xl shadow-2xl border border-slate-700">
          <div className="flex justify-center mb-6">
            <div className="p-4 bg-slate-900 rounded-full border border-slate-700">
               <LockClosedIcon className="w-8 h-8 text-blue-500" />
            </div>
          </div>
          <h2 className="text-2xl font-bold text-center mb-6 tracking-tight">Dostęp do CRM</h2>
          <form onSubmit={(e) => { e.preventDefault(); if(passwordInput===CORRECT_PASSWORD) setIsLoggedIn(true); else setLoginError(true); }} className="space-y-4">
            <input type="password" value={passwordInput} onChange={(e) => setPasswordInput(e.target.value)} placeholder="Hasło (1234)" className="w-full bg-slate-900 border border-slate-700 text-white rounded-lg p-3" autoFocus />
            {loginError && <p className="text-red-500 text-sm text-center">Błąd</p>}
            <button type="submit" className="w-full bg-blue-600 hover:bg-blue-500 text-white p-3 rounded-lg">Wejdź</button>
          </form>
        </div>
      </div>
    );
  }

  // 2. DASHBOARD VIEW
  if (view === 'dashboard') {
    return (
        <div className="min-h-screen bg-slate-900 text-slate-100 p-6 font-sans">
            <header className="max-w-6xl mx-auto flex justify-between items-center mb-10">
                <div className="flex items-center gap-3">
                    <DocumentTextIcon className="w-8 h-8 text-blue-500" />
                    <h1 className="text-2xl font-bold">LiveScribe CRM</h1>
                </div>
                <button onClick={() => setShowNewClientModal(true)} className="bg-blue-600 hover:bg-blue-500 text-white px-4 py-2 rounded-lg flex items-center gap-2">
                    <PlusIcon className="w-5 h-5" /> Nowy Klient
                </button>
            </header>

            <div className="max-w-6xl mx-auto grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                {clients.map(client => (
                    <div key={client.id} onClick={() => handleSelectClient(client)} className="bg-slate-800 border border-slate-700 p-6 rounded-xl hover:bg-slate-750 cursor-pointer transition-all hover:border-blue-500/50 group">
                        <div className="flex justify-between items-start mb-4">
                            <div className="p-3 bg-slate-700 rounded-lg group-hover:bg-blue-600/20 group-hover:text-blue-400 transition-colors">
                                <UserIcon className="w-6 h-6" />
                            </div>
                            <span className="text-xs text-slate-500 font-mono">{new Date(client.createdAt).toLocaleDateString()}</span>
                        </div>
                        <h3 className="text-xl font-bold text-white mb-1">{client.name}</h3>
                        <p className="text-slate-400 text-sm mb-4">{client.industry || 'Brak branży'}</p>
                        <div className="flex items-center gap-4 text-xs text-slate-500">
                             <span className="flex items-center gap-1"><BriefcaseIcon className="w-3 h-3" /> {client.sessions.length} sesji</span>
                        </div>
                    </div>
                ))}
                {clients.length === 0 && (
                    <div className="col-span-full text-center py-20 text-slate-500">
                        <UserGroupIcon className="w-16 h-16 mx-auto mb-4 opacity-20" />
                        <p>Brak klientów. Dodaj pierwszego, aby zacząć.</p>
                    </div>
                )}
            </div>

            {showNewClientModal && (
                <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-50">
                    <div className="bg-slate-800 p-8 rounded-xl w-full max-w-md border border-slate-700">
                        <h3 className="text-xl font-bold mb-6">Dodaj nowego klienta</h3>
                        <form onSubmit={handleCreateClient} className="space-y-4">
                            <div>
                                <label className="block text-sm text-slate-400 mb-1">Nazwa firmy / Imię i Nazwisko</label>
                                <input value={newClientName} onChange={e => setNewClientName(e.target.value)} className="w-full bg-slate-900 border border-slate-600 rounded p-2" autoFocus />
                            </div>
                            <div>
                                <label className="block text-sm text-slate-400 mb-1">Branża (opcjonalnie)</label>
                                <input value={newClientIndustry} onChange={e => setNewClientIndustry(e.target.value)} className="w-full bg-slate-900 border border-slate-600 rounded p-2" />
                            </div>
                            <div className="flex justify-end gap-3 mt-6">
                                <button type="button" onClick={() => setShowNewClientModal(false)} className="px-4 py-2 text-slate-300 hover:text-white">Anuluj</button>
                                <button type="submit" className="bg-blue-600 hover:bg-blue-500 px-4 py-2 rounded text-white">Utwórz</button>
                            </div>
                        </form>
                    </div>
                </div>
            )}
        </div>
    );
  }

  // 3. CLIENT DETAIL VIEW
  if (view === 'client-detail' && selectedClient) {
      return (
        <div className="flex h-screen bg-slate-900 text-slate-100 overflow-hidden font-sans">
             {/* Sidebar Navigation */}
             <div className="w-64 bg-slate-800 border-r border-slate-700 flex flex-col">
                 <div className="p-4 border-b border-slate-700">
                     <button onClick={handleBackToDashboard} className="flex items-center gap-2 text-slate-400 hover:text-white text-sm mb-4">
                         <ChevronLeftIcon className="w-4 h-4" /> Wróć
                     </button>
                     <h2 className="text-lg font-bold truncate">{selectedClient.name}</h2>
                     <p className="text-xs text-slate-500">{selectedClient.industry}</p>
                 </div>
                 
                 <div className="p-4 flex-1 overflow-y-auto">
                     <h3 className="text-xs font-bold text-slate-500 uppercase tracking-wider mb-3">Sesje</h3>
                     <div className="space-y-2">
                         {selectedClient.sessions.map(s => (
                             <div key={s.id} className="p-2 bg-slate-900/50 rounded hover:bg-slate-700 cursor-pointer text-sm">
                                 <div className="font-medium text-slate-300">{new Date(s.date).toLocaleDateString()}</div>
                                 <div className="text-xs text-slate-500 truncate">{s.summary}</div>
                             </div>
                         ))}
                         {selectedClient.sessions.length === 0 && <p className="text-xs text-slate-600">Brak historii.</p>}
                     </div>
                 </div>

                 <div className="p-4 border-t border-slate-700">
                     <button onClick={startRecordingForClient} className="w-full bg-red-600 hover:bg-red-500 text-white py-3 rounded-lg flex items-center justify-center gap-2 shadow-lg shadow-red-900/20">
                         <MicrophoneIcon className="w-5 h-5" /> Nowa Sesja
                     </button>
                 </div>
             </div>

             {/* Main Content */}
             <div className="flex-1 flex flex-col overflow-hidden bg-slate-900">
                 <div className="flex-1 overflow-y-auto p-8">
                     {/* Generator Section */}
                     <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
                        {/* Left: Knowledge Base */}
                        <div className="bg-slate-800/50 border border-slate-700 rounded-xl p-6">
                            <div className="flex justify-between items-center mb-4">
                                <h3 className="font-bold flex items-center gap-2"><SparklesIcon className="w-5 h-5 text-yellow-500" /> Baza Wiedzy (AI)</h3>
                                <button onClick={() => generateArtifact(selectedClient, 'knowledge')} className="text-xs text-blue-400 hover:text-blue-300">Aktualizuj</button>
                            </div>
                            <div className="text-sm text-slate-300 whitespace-pre-wrap min-h-[100px]">
                                {selectedClient.knowledgeBase || "Brak danych kontekstowych. Przeprowadź rozmowę, aby AI mogło zbudować profil."}
                            </div>
                        </div>

                        {/* Right: Generators */}
                        <div className="bg-slate-800/50 border border-slate-700 rounded-xl p-6">
                             <h3 className="font-bold mb-4">Generator Treści</h3>
                             <div className="flex gap-2 mb-4">
                                 <button onClick={() => generateArtifact(selectedClient, 'email')} disabled={isGenerating} className="flex-1 bg-slate-700 hover:bg-slate-600 py-2 rounded text-sm flex items-center justify-center gap-2">
                                     <EnvelopeIcon className="w-4 h-4" /> E-mail Follow-up
                                 </button>
                                 <button onClick={() => generateArtifact(selectedClient, 'strategy')} disabled={isGenerating} className="flex-1 bg-slate-700 hover:bg-slate-600 py-2 rounded text-sm flex items-center justify-center gap-2">
                                     <PresentationChartLineIcon className="w-4 h-4" /> Strategia
                                 </button>
                             </div>
                             
                             {isGenerating ? (
                                 <div className="h-40 flex items-center justify-center text-slate-500 animate-pulse">
                                     <SparklesIcon className="w-6 h-6 mr-2" /> Generowanie...
                                 </div>
                             ) : generatedContent ? (
                                 <div className="relative">
                                     <textarea readOnly value={generatedContent} className="w-full h-64 bg-slate-900 p-3 rounded text-sm text-slate-300 border border-slate-700 focus:outline-none" />
                                     <button onClick={() => handleCopy(generatedContent)} className="absolute top-2 right-2 p-1 bg-slate-800 rounded hover:text-white text-slate-400">
                                         {isCopied ? <ClipboardDocumentCheckIcon className="w-4 h-4 text-green-500" /> : <ClipboardDocumentIcon className="w-4 h-4" />}
                                     </button>
                                 </div>
                             ) : (
                                 <div className="h-40 flex items-center justify-center text-slate-600 text-sm border-2 border-dashed border-slate-700 rounded">
                                     Wybierz szablon powyżej, aby wygenerować treść.
                                 </div>
                             )}
                        </div>
                     </div>
                 </div>
             </div>
        </div>
      );
  }

  // 4. RECORDING VIEW (Reusing logic but wrapped)
  if (view === 'recording' && selectedClient) {
      // Show description preview modal
      if (descriptionPreview || isGenerating) {
        return (
          <div className="flex flex-col h-screen bg-slate-900 text-slate-100 overflow-hidden font-sans">
            <header className="flex-none p-4 bg-slate-900 border-b border-slate-800">
              <h1 className="text-lg font-bold">Podgląd opisu rozmowy</h1>
              <span className="text-xs text-slate-400">Sprawdź i zaakceptuj lub odrzuć</span>
            </header>
            <main className="flex-1 overflow-y-auto p-6">
              <div className="max-w-3xl mx-auto">
                {isGenerating ? (
                  <div className="flex flex-col items-center justify-center py-20">
                    <ArrowPathIcon className="w-12 h-12 text-blue-500 animate-spin mb-4" />
                    <p className="text-slate-400">Generowanie opisu...</p>
                  </div>
                ) : (
                  <div className="bg-slate-800/50 border border-slate-700 rounded-xl p-6">
                    <p className="text-slate-200 whitespace-pre-wrap leading-relaxed">{descriptionPreview}</p>
                  </div>
                )}
              </div>
            </main>
            {!isGenerating && descriptionPreview && (
              <footer className="flex-none p-4 bg-slate-900 border-t border-slate-800">
                <div className="max-w-3xl mx-auto flex justify-end gap-3">
                  <button onClick={rejectDescription} className="px-6 py-2 bg-slate-700 hover:bg-slate-600 text-white rounded-lg font-medium">
                    Odrzuć
                  </button>
                  <button onClick={acceptDescription} className="px-6 py-2 bg-green-600 hover:bg-green-500 text-white rounded-lg font-medium">
                    Akceptuj i zapisz
                  </button>
                </div>
              </footer>
            )}
          </div>
        );
      }

      return (
        <div className="flex flex-col h-screen bg-slate-900 text-slate-100 overflow-hidden font-sans relative">
            <header className="flex-none p-4 bg-slate-900 border-b border-slate-800 z-10 flex justify-between">
                <div>
                    <h1 className="text-lg font-bold">Sesja z: {selectedClient.name}</h1>
                    <span className="text-xs text-red-400 animate-pulse font-mono">NAGRYWANIE AKTYWNE</span>
                </div>
                <div className="flex gap-2">
                    <button onClick={() => handleCopy(currentTranscript.map(t => t.text).join('\n'))} className="p-2 hover:bg-slate-800 rounded text-slate-400"><ClipboardDocumentIcon className="w-5 h-5"/></button>
                    <button onClick={saveSessionToClient} className="bg-green-600 hover:bg-green-500 text-white px-4 py-1 rounded text-sm font-bold shadow-lg shadow-green-900/20">
                        Zakończ i Zapisz
                    </button>
                </div>
            </header>

             {/* Transcript Area */}
             <main className="flex-1 overflow-y-auto p-4 md:p-8 relative">
                 <div className="max-w-4xl mx-auto pb-32">
                     {currentTranscript.length === 0 ? (
                         <div className="text-center mt-20 text-slate-600">Rozpocznij mówić...</div>
                     ) : (
                         currentTranscript.map(entry => <TranscriptItem key={entry.id} entry={entry} />)
                     )}
                     <div ref={scrollBottomRef} />
                 </div>
             </main>

             {/* Diarization Controls */}
             {status === ConnectionStatus.DISCONNECTED && audioBlob && (
                <div className="absolute bottom-32 left-0 right-0 z-30 flex justify-center">
                   <div className="bg-slate-800/90 backdrop-blur border border-slate-700 p-4 rounded-xl shadow-2xl flex items-center gap-4">
                      <audio controls src={URL.createObjectURL(audioBlob)} className="h-8 w-48" />
                      <button onClick={handleDiarization} disabled={isProcessingDiarization} className="bg-indigo-600 hover:bg-indigo-500 text-white px-3 py-1 rounded text-sm flex items-center gap-2">
                        {isProcessingDiarization ? <ArrowPathIcon className="w-4 h-4 animate-spin"/> : <UserGroupIcon className="w-4 h-4"/>} 
                        Analiza AI
                      </button>
                   </div>
                </div>
             )}

             {/* Footer Controls */}
             <footer className="flex-none bg-slate-900/90 border-t border-slate-800 p-6 fixed bottom-0 w-full z-20">
                <div className="max-w-md mx-auto flex items-center justify-center gap-8 relative">
                   {status === ConnectionStatus.CONNECTED && (
                     <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-32 h-32 bg-blue-500/10 rounded-full blur-2xl pointer-events-none transition-all duration-75" style={{ transform: `translate(-50%, -50%) scale(${0.8 + volume * 4})`, opacity: 0.5 + volume }} />
                   )}
                   {status === ConnectionStatus.DISCONNECTED ? (
                     <button onClick={startSession} className="w-16 h-16 bg-blue-600 rounded-full flex items-center justify-center shadow-lg"><MicrophoneIcon className="w-8 h-8 text-white"/></button>
                   ) : (
                     <button onClick={stopUserAction} className="w-16 h-16 bg-slate-700 hover:bg-red-600 rounded-full flex items-center justify-center shadow-lg transition-colors"><StopIcon className="w-8 h-8 text-white"/></button>
                   )}
                </div>
             </footer>
        </div>
      );
  }

  return null;
};

export default App;