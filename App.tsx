import React, { useState, useEffect, useRef, useCallback } from 'react';
import { GoogleGenAI, LiveServerMessage, Modality } from '@google/genai';
import { createBlob, resampleTo16k } from './utils/audioUtils';
import { TranscriptEntry, ConnectionStatus } from './types';
import TranscriptItem from './components/TranscriptItem';
import { 
  MicrophoneIcon, 
  StopIcon, 
  ArrowDownTrayIcon, 
  TrashIcon, 
  SignalIcon,
  DocumentTextIcon,
  ArrowPathIcon
} from '@heroicons/react/24/solid';

const App: React.FC = () => {
  // --- State ---
  const [status, setStatus] = useState<ConnectionStatus>(ConnectionStatus.DISCONNECTED);
  const [transcript, setTranscript] = useState<TranscriptEntry[]>([]);
  const [volume, setVolume] = useState(0);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // --- Refs for Audio & API ---
  const inputAudioContextRef = useRef<AudioContext | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const sourceNodeRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const sessionRef = useRef<any>(null);
  
  // Logic Refs
  const currentInputTransRef = useRef<string>('');
  const scrollBottomRef = useRef<HTMLDivElement>(null);
  
  // Auto-reconnect Logic
  const isRecordingActiveRef = useRef<boolean>(false);
  const reconnectTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // --- Effects ---

  useEffect(() => {
    if (scrollBottomRef.current) {
      scrollBottomRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [transcript]);

  useEffect(() => {
    return () => {
      isRecordingActiveRef.current = false;
      cleanupSession();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // --- Helper Functions ---

  const formatTime = () => {
    const now = new Date();
    return now.toLocaleTimeString('pl-PL', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  };

  const updateTranscript = (text: string, isFinal: boolean) => {
    setTranscript(prev => {
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

  // --- Core Logic ---

  const startSession = async () => {
    // Prevent multiple clicks
    if (status === ConnectionStatus.CONNECTING || status === ConnectionStatus.CONNECTED) return;

    try {
      setErrorMsg(null);
      setStatus(ConnectionStatus.CONNECTING);
      isRecordingActiveRef.current = true;

      // 1. Initialize Audio Context (Input Only)
      // Ensure previous context is closed
      if (inputAudioContextRef.current) {
        await inputAudioContextRef.current.close();
      }
      inputAudioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)();

      // 2. Get Microphone Access (Reuse stream if available to avoid prompting user again during reconnect)
      let stream = mediaStreamRef.current;
      if (!stream || !stream.active) {
         stream = await navigator.mediaDevices.getUserMedia({ audio: {
          channelCount: 1,
          echoCancellation: true,
          autoGainControl: true,
          noiseSuppression: true
        } });
        mediaStreamRef.current = stream;
      }

      // 3. Initialize Gemini Client
      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
      
      // 4. Connect to Live API
      const sessionPromise = ai.live.connect({
        model: 'gemini-2.5-flash-native-audio-preview-09-2025',
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: {
            voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } }
          },
          inputAudioTranscription: {}, 
          systemInstruction: {
            parts: [{ text: "Jesteś pasywnym systemem transkrypcji. Twoim jedynym zadaniem jest słuchanie i zapisywanie. Nie odpowiadaj." }]
          },
        },
        callbacks: {
          onopen: () => {
            console.log("Session Opened");
            setStatus(ConnectionStatus.CONNECTED);
            
            if (!inputAudioContextRef.current || !stream) return;
            
            if (inputAudioContextRef.current.state === 'suspended') {
              inputAudioContextRef.current.resume();
            }

            const source = inputAudioContextRef.current.createMediaStreamSource(stream);
            sourceNodeRef.current = source;

            const processor = inputAudioContextRef.current.createScriptProcessor(4096, 1, 1);
            processorRef.current = processor;

            processor.onaudioprocess = (e) => {
              const inputData = e.inputBuffer.getChannelData(0);
              
              let sum = 0;
              for(let i=0; i<inputData.length; i++) sum += inputData[i] * inputData[i];
              setVolume(Math.sqrt(sum / inputData.length));

              const currentSampleRate = inputAudioContextRef.current?.sampleRate || 48000;
              const resampledData = resampleTo16k(inputData, currentSampleRate);

              const pcmBlob = createBlob(resampledData);
              sessionPromise.then((session) => {
                 session.sendRealtimeInput({ media: pcmBlob });
              });
            };

            source.connect(processor);
            processor.connect(inputAudioContextRef.current.destination);
          },
          onmessage: async (msg: LiveServerMessage) => {
            const content = msg.serverContent;
            
            if (content?.inputTranscription) {
              const text = content.inputTranscription.text;
              if (text) {
                 currentInputTransRef.current += text;
                 updateTranscript(currentInputTransRef.current, false);
              }
            }

            if (content?.turnComplete) {
               if (currentInputTransRef.current) {
                 updateTranscript(currentInputTransRef.current, true);
                 currentInputTransRef.current = '';
               }
            }
          },
          onclose: (e) => {
            console.log("Session Closed", e);
            cleanupSession(false); // Clean up audio nodes but keep intent

            // AUTO-RECONNECT LOGIC
            // If user didn't press stop (isRecordingActiveRef is true), reconnect.
            if (isRecordingActiveRef.current) {
                console.log("Auto-reconnecting due to API limit or network drop...");
                setStatus(ConnectionStatus.CONNECTING); // Visual feedback
                
                // Small delay to ensure clean socket state
                reconnectTimeoutRef.current = setTimeout(() => {
                    startSession();
                }, 500);
            } else {
                setStatus(ConnectionStatus.DISCONNECTED);
            }
          },
          onerror: (e) => {
            console.error("Session Error", e);
            // Don't kill the app, try to reconnect if it's a network blip
            if (isRecordingActiveRef.current) {
                 cleanupSession(false);
                 reconnectTimeoutRef.current = setTimeout(() => {
                    startSession();
                }, 1000);
            } else {
                setErrorMsg("Błąd połączenia. Sesja zakończona.");
                stopUserAction();
            }
          }
        }
      });

      sessionRef.current = await sessionPromise;

    } catch (err) {
      console.error(err);
      setErrorMsg("Nie udało się połączyć. Sprawdź internet i mikrofon.");
      stopUserAction();
    }
  };

  // Internal cleanup (stops nodes, leaves intent flag alone unless specified)
  const cleanupSession = (fullStop = true) => {
    if (currentInputTransRef.current) {
      updateTranscript(currentInputTransRef.current, true);
      currentInputTransRef.current = '';
    }

    if (sourceNodeRef.current) {
        try { sourceNodeRef.current.disconnect(); } catch (e) {}
        sourceNodeRef.current = null;
    }
    
    if (processorRef.current) {
      try { processorRef.current.disconnect(); } catch (e) {}
      processorRef.current = null;
    }

    if (fullStop && mediaStreamRef.current) {
      mediaStreamRef.current.getTracks().forEach(track => track.stop());
      mediaStreamRef.current = null;
    }

    if (inputAudioContextRef.current) {
        try { inputAudioContextRef.current.close(); } catch (e) {}
        inputAudioContextRef.current = null;
    }

    if (sessionRef.current) {
      try { sessionRef.current.close(); } catch (e) {}
      sessionRef.current = null;
    }
    
    if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current);
        reconnectTimeoutRef.current = null;
    }

    setVolume(0);
  };

  // User explicitly clicks Stop
  const stopUserAction = () => {
    isRecordingActiveRef.current = false;
    cleanupSession(true);
    setStatus(ConnectionStatus.DISCONNECTED);
  };

  const handleDownload = () => {
    const text = transcript
      .map(t => `[${t.timestamp}] ${t.text}`)
      .join('\n');
    
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `transkrypcja_${new Date().toISOString().slice(0,10)}.txt`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const clearTranscript = () => {
    if (confirm("Czy na pewno chcesz usunąć całą historię?")) {
      setTranscript([]);
    }
  };

  return (
    <div className="flex flex-col h-screen bg-slate-900 text-slate-100 overflow-hidden font-sans">
      {/* Header */}
      <header className="flex-none p-4 bg-slate-900 border-b border-slate-800 z-10">
        <div className="max-w-5xl mx-auto flex justify-between items-center">
          <div className="flex items-center gap-3">
             <DocumentTextIcon className="w-6 h-6 text-blue-500" />
             <div className="flex flex-col">
                <h1 className="text-xl font-bold tracking-tight text-white leading-none">LiveScribe <span className="text-slate-500 font-normal">Transkrypcja</span></h1>
                <span className="text-[10px] text-slate-600 font-mono mt-0.5">Model: Gemini 2.5 Flash</span>
             </div>
          </div>
          
          <div className="flex items-center gap-2">
            {status === ConnectionStatus.CONNECTED && (
              <div className="flex items-center gap-2 mr-4 px-3 py-1 bg-red-500/10 rounded-full border border-red-500/20 transition-all">
                <div className="w-2 h-2 rounded-full bg-red-500 animate-pulse"></div>
                <span className="text-xs font-mono text-red-400 font-semibold tracking-wider">NAGRYWANIE</span>
              </div>
            )}
            {status === ConnectionStatus.CONNECTING && (
              <div className="flex items-center gap-2 mr-4 px-3 py-1 bg-yellow-500/10 rounded-full border border-yellow-500/20 transition-all">
                <ArrowPathIcon className="w-3 h-3 text-yellow-500 animate-spin" />
                <span className="text-xs font-mono text-yellow-400 font-semibold tracking-wider">WCHODZENIE</span>
              </div>
            )}
            
            <button 
              onClick={handleDownload}
              disabled={transcript.length === 0}
              className="p-2 hover:bg-slate-800 rounded-lg text-slate-400 hover:text-white transition-colors disabled:opacity-30"
              title="Pobierz plik tekstowy"
            >
              <ArrowDownTrayIcon className="w-5 h-5" />
            </button>
            <button 
              onClick={clearTranscript}
              disabled={transcript.length === 0}
              className="p-2 hover:bg-red-900/20 rounded-lg text-slate-400 hover:text-red-400 transition-colors disabled:opacity-30"
              title="Wyczyść"
            >
              <TrashIcon className="w-5 h-5" />
            </button>
          </div>
        </div>
      </header>

      {/* Main Transcript Area */}
      <main className="flex-1 overflow-y-auto bg-slate-900 p-4 md:p-8 scrollbar-hide relative">
        <div className="max-w-4xl mx-auto pb-32">
          {transcript.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-64 mt-10 text-slate-600">
              <div className="p-4 bg-slate-800/50 rounded-full mb-4">
                 <MicrophoneIcon className="w-12 h-12 opacity-50" />
              </div>
              <p className="text-lg font-medium text-slate-400">Gotowy do nagrywania</p>
              <p className="text-sm mt-2 max-w-md text-center">Naciśnij start. Aplikacja automatycznie wznowi połączenie, jeśli zostanie przerwane przez limit czasowy.</p>
            </div>
          ) : (
            <div className="space-y-1">
              {transcript.map((entry) => (
                <TranscriptItem key={entry.id} entry={entry} />
              ))}
            </div>
          )}
          <div ref={scrollBottomRef} />
        </div>
      </main>

      {/* Error Toast */}
      {errorMsg && (
        <div className="absolute top-20 left-1/2 transform -translate-x-1/2 bg-red-600 text-white px-6 py-3 rounded-lg shadow-xl z-50 text-sm font-medium animate-bounce">
          {errorMsg}
        </div>
      )}

      {/* Footer Controls */}
      <footer className="flex-none bg-slate-900/90 backdrop-blur-sm border-t border-slate-800 p-6 fixed bottom-0 w-full z-20">
        <div className="max-w-md mx-auto flex items-center justify-center gap-8 relative">
           
           {/* Visualizer Background Effect */}
           {status === ConnectionStatus.CONNECTED && (
             <div 
               className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-32 h-32 bg-blue-500/10 rounded-full blur-2xl pointer-events-none transition-all duration-75"
               style={{ transform: `translate(-50%, -50%) scale(${0.8 + volume * 4})`, opacity: 0.5 + volume }}
             />
           )}

           {status === ConnectionStatus.DISCONNECTED || status === ConnectionStatus.ERROR ? (
             <button
               onClick={startSession}
               className="group relative flex items-center justify-center w-20 h-20 bg-blue-600 hover:bg-blue-500 text-white rounded-full shadow-lg hover:shadow-blue-500/20 transition-all transform hover:scale-105 active:scale-95"
             >
               <MicrophoneIcon className="w-9 h-9" />
             </button>
           ) : (
             <button
               onClick={stopUserAction}
               className="group relative flex items-center justify-center w-20 h-20 bg-slate-700 hover:bg-red-600 text-white rounded-full shadow-lg transition-all transform hover:scale-105 active:scale-95"
             >
               <StopIcon className="w-9 h-9" />
             </button>
           )}
           
           {status === ConnectionStatus.CONNECTING && (
              <span className="absolute -top-8 text-xs font-mono text-yellow-400 animate-pulse uppercase tracking-widest">
                {transcript.length > 0 ? "Odnawianie sesji..." : "Inicjalizacja..."}
              </span>
           )}
        </div>
      </footer>
    </div>
  );
};

export default App;