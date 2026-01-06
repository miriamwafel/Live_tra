import React, { useState, useEffect, useRef } from 'react';
import { GoogleGenAI, LiveServerMessage, Modality } from '@google/genai';
import { createBlob, resampleTo16k, blobToBase64 } from './utils/audioUtils';
import { TranscriptEntry, ConnectionStatus } from './types';
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
  KeyIcon
} from '@heroicons/react/24/solid';

const CORRECT_PASSWORD = '1234'; // HASŁO DO APLIKACJI

const App: React.FC = () => {
  // --- Auth State ---
  const [isLoggedIn, setIsLoggedIn] = useState(false);
  const [passwordInput, setPasswordInput] = useState('');
  const [loginError, setLoginError] = useState(false);

  // --- App State ---
  const [status, setStatus] = useState<ConnectionStatus>(ConnectionStatus.DISCONNECTED);
  const [liveTranscript, setLiveTranscript] = useState<TranscriptEntry[]>([]);
  const [diarizedTranscript, setDiarizedTranscript] = useState<TranscriptEntry[]>([]);
  const [activeTab, setActiveTab] = useState<'live' | 'diarized'>('live');
  
  const [volume, setVolume] = useState(0);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [isCopied, setIsCopied] = useState(false);

  // Recording & Diarization State
  const [audioBlob, setAudioBlob] = useState<Blob | null>(null);
  const [isProcessingDiarization, setIsProcessingDiarization] = useState(false);

  // --- Refs for Audio & API ---
  const inputAudioContextRef = useRef<AudioContext | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const sourceNodeRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const sessionRef = useRef<any>(null);
  
  // Recorder Refs
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  
  // Logic Refs
  const currentInputTransRef = useRef<string>('');
  const scrollBottomRef = useRef<HTMLDivElement>(null);
  
  // Auto-reconnect Logic
  const isRecordingActiveRef = useRef<boolean>(false);
  const reconnectTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // --- Helper: Get Active Transcript ---
  const currentTranscript = activeTab === 'live' ? liveTranscript : diarizedTranscript;

  // --- Effects ---

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

  // --- Auth Logic ---
  const handleLogin = (e: React.FormEvent) => {
    e.preventDefault();
    if (passwordInput === CORRECT_PASSWORD) {
      setIsLoggedIn(true);
      setLoginError(false);
    } else {
      setLoginError(true);
      setPasswordInput('');
    }
  };

  // --- Helper Functions ---

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

  // --- Core Logic ---

  const startSession = async () => {
    if (status === ConnectionStatus.CONNECTING || status === ConnectionStatus.CONNECTED) return;

    try {
      setErrorMsg(null);
      setStatus(ConnectionStatus.CONNECTING);
      isRecordingActiveRef.current = true;
      setActiveTab('live'); // Always switch to live when starting
      
      // Reset audio blob if starting a FRESH session
      if (liveTranscript.length === 0) {
        setAudioBlob(null);
        audioChunksRef.current = [];
      }

      // 1. Initialize Audio Context
      if (inputAudioContextRef.current) {
        await inputAudioContextRef.current.close();
      }
      inputAudioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)();

      // 2. Get Microphone Access
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

      // --- Start Local Recording ---
      if (!mediaRecorderRef.current || mediaRecorderRef.current.state === 'inactive') {
         const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') 
             ? 'audio/webm;codecs=opus' 
             : 'audio/mp4'; 
         
         const recorder = new MediaRecorder(stream, { mimeType });
         mediaRecorderRef.current = recorder;
         
         recorder.ondataavailable = (event) => {
           if (event.data.size > 0) {
             audioChunksRef.current.push(event.data);
           }
         };

         recorder.start(1000); 
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
            parts: [{ text: "Jesteś profesjonalnym transkrybentem języka polskiego. Twoim absolutnym priorytetem jest zapisywanie słyszanej mowy WYŁĄCZNIE w języku polskim. \n\nZASADY:\n1. Zapisuj tekst poprawną polszczyzną, dbając o interpunkcję.\n2. NIGDY nie używaj cyrylicy. Jeśli słowo brzmi obco, zapisz je fonetycznie alfabetem łacińskim.\n3. Jeśli mowa jest niewyraźna, staraj się dopasować najbardziej prawdopodobne słowa polskie.\n4. Nie prowadź konwersacji. Nie odpowiadaj na pytania. Działaj jak 'ukryty stenograf'." }]
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
                 updateLiveTranscript(currentInputTransRef.current, false);
              }
            }

            if (content?.turnComplete) {
               if (currentInputTransRef.current) {
                 updateLiveTranscript(currentInputTransRef.current, true);
                 currentInputTransRef.current = '';
               }
            }
          },
          onclose: (e) => {
            console.log("Session Closed", e);
            cleanupSession(false); 

            if (isRecordingActiveRef.current) {
                console.log("Auto-reconnecting...");
                setStatus(ConnectionStatus.CONNECTING);
                
                reconnectTimeoutRef.current = setTimeout(() => {
                    startSession();
                }, 500);
            } else {
                setStatus(ConnectionStatus.DISCONNECTED);
                finalizeRecording();
            }
          },
          onerror: (e) => {
            console.error("Session Error", e);
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

  const cleanupSession = (fullStop = true) => {
    if (currentInputTransRef.current) {
      updateLiveTranscript(currentInputTransRef.current, true);
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

    if (fullStop) {
        if (mediaStreamRef.current) {
          mediaStreamRef.current.getTracks().forEach(track => track.stop());
          mediaStreamRef.current = null;
        }
        if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
            mediaRecorderRef.current.stop();
        }
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

  const finalizeRecording = () => {
    if (audioChunksRef.current.length > 0) {
        const mimeType = mediaRecorderRef.current?.mimeType || 'audio/webm';
        const blob = new Blob(audioChunksRef.current, { type: mimeType });
        setAudioBlob(blob);
    }
  };

  const stopUserAction = () => {
    isRecordingActiveRef.current = false;
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
        mediaRecorderRef.current.stop();
    }
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
        const mimeType = audioBlob.type.split(';')[0] || 'audio/webm';

        const response = await ai.models.generateContent({
            model: modelId,
            contents: {
                parts: [
                    {
                        inlineData: {
                            mimeType: mimeType,
                            data: base64Audio
                        }
                    },
                    {
                        text: `Przeanalizuj to nagranie audio i stwórz dokładną transkrypcję w języku polskim. 
                        
                        Twoim kluczowym zadaniem jest ROZPOZNANIE MÓWCÓW (Diarizacja).
                        
                        Formatuj wyjście następująco:
                        [00:00] Mówca 1: Tekst...
                        [00:15] Mówca 2: Tekst...
                        
                        Jeśli rozpoznasz imiona z kontekstu, użyj ich zamiast "Mówca 1". 
                        Zadbaj o interpunkcję i poprawność gramatyczną.
                        NIGDY nie używaj cyrylicy, używaj tylko języka polskiego (alfabet łaciński).`
                    }
                ]
            }
        });
        
        const text = response.text;
        if (text) {
            const lines = text.split('\n');
            const newEntries: TranscriptEntry[] = lines
                .filter(line => line.trim().length > 0)
                .map((line, idx) => ({
                    id: `diarized-${idx}`,
                    timestamp: line.match(/\[(.*?)\]/)?.[1] || "00:00",
                    speaker: line.toLowerCase().includes('mówca 2') || line.toLowerCase().includes('speaker 2') ? 'model' : 'user', 
                    text: line.replace(/\[.*?\]/, '').trim(),
                    isPartial: false
                }));
            
            // SET SEPARATE DIARIZED TRANSCRIPT
            setDiarizedTranscript(newEntries);
            setActiveTab('diarized'); // Switch to the new tab
            alert("Analiza zakończona. Wynik znajduje się w zakładce 'Analiza Nagrania'.");
        }

    } catch (e) {
        console.error("Diarization error", e);
        setErrorMsg("Błąd podczas analizy nagrania. Sprawdź konsolę (F12) jeśli błąd się powtarza.");
    } finally {
        setIsProcessingDiarization(false);
    }
  };

  const handleDownload = () => {
    // Download ONLY the active transcript
    const source = currentTranscript;
    const prefix = activeTab === 'live' ? 'Live' : 'Analiza';

    const text = source
      .map(t => `[${t.timestamp}] ${t.text}`)
      .join('\n');
    
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `transkrypcja_${prefix}_${new Date().toISOString().slice(0,10)}.txt`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  const handleCopy = () => {
    // Copy ONLY the active transcript
    const source = currentTranscript;
    const text = source
      .map(t => `[${t.timestamp}] ${t.text}`)
      .join('\n');
    
    navigator.clipboard.writeText(text).then(() => {
        setIsCopied(true);
        setTimeout(() => setIsCopied(false), 2000);
    });
  };

  const clearCurrentTranscript = () => {
    const tabName = activeTab === 'live' ? 'transkrypcję na żywo' : 'analizę nagrania';
    if (confirm(`Czy na pewno chcesz usunąć ${tabName}?`)) {
        if (activeTab === 'live') {
            setLiveTranscript([]);
            setAudioBlob(null); // Clear audio too if clearing live source
            audioChunksRef.current = [];
        } else {
            setDiarizedTranscript([]);
            // Don't clear audioBlob here, user might want to run analysis again
            setActiveTab('live'); // Go back to live
        }
    }
  };

  // --- LOGIN SCREEN ---
  if (!isLoggedIn) {
    return (
      <div className="flex flex-col h-screen bg-slate-900 text-slate-100 items-center justify-center font-sans">
        <div className="w-full max-w-sm p-8 bg-slate-800 rounded-2xl shadow-2xl border border-slate-700">
          <div className="flex justify-center mb-6">
            <div className="p-4 bg-slate-900 rounded-full border border-slate-700">
               <LockClosedIcon className="w-8 h-8 text-blue-500" />
            </div>
          </div>
          <h2 className="text-2xl font-bold text-center mb-6 tracking-tight">Dostęp do LiveScribe</h2>
          <form onSubmit={handleLogin} className="space-y-4">
            <div className="relative">
              <KeyIcon className="w-5 h-5 absolute left-3 top-1/2 -translate-y-1/2 text-slate-500" />
              <input 
                type="password"
                value={passwordInput}
                onChange={(e) => setPasswordInput(e.target.value)}
                placeholder="Podaj hasło (1234)"
                className="w-full bg-slate-900 border border-slate-700 text-white rounded-lg py-3 pl-10 pr-4 focus:ring-2 focus:ring-blue-500 focus:outline-none transition-all"
                autoFocus
              />
            </div>
            {loginError && <p className="text-red-500 text-sm text-center font-medium animate-pulse">Nieprawidłowe hasło</p>}
            <button 
              type="submit"
              className="w-full bg-blue-600 hover:bg-blue-500 text-white font-medium py-3 rounded-lg shadow-lg shadow-blue-500/20 transition-all active:scale-95"
            >
              Zaloguj
            </button>
          </form>
          <p className="text-center text-slate-600 text-xs mt-6">Wersja prywatna</p>
        </div>
      </div>
    );
  }

  // --- MAIN APP ---
  return (
    <div className="flex flex-col h-screen bg-slate-900 text-slate-100 overflow-hidden font-sans">
      {/* Header */}
      <header className="flex-none p-4 bg-slate-900 border-b border-slate-800 z-10">
        <div className="max-w-5xl mx-auto flex justify-between items-center">
          <div className="flex items-center gap-3">
             <DocumentTextIcon className="w-6 h-6 text-blue-500" />
             <div className="flex flex-col">
                <h1 className="text-xl font-bold tracking-tight text-white leading-none">LiveScribe <span className="text-slate-500 font-normal">Transkrypcja</span></h1>
                <span className="text-[10px] text-slate-600 font-mono mt-0.5">Model: Gemini 2.5 Flash (PL)</span>
             </div>
          </div>
          
          <div className="flex items-center gap-2">
            {status === ConnectionStatus.CONNECTED && (
              <div className="hidden md:flex items-center gap-2 mr-4 px-3 py-1 bg-red-500/10 rounded-full border border-red-500/20 transition-all">
                <div className="w-2 h-2 rounded-full bg-red-500 animate-pulse"></div>
                <span className="text-xs font-mono text-red-400 font-semibold tracking-wider">NAGRYWANIE</span>
              </div>
            )}
            
            <button 
              onClick={handleCopy}
              disabled={currentTranscript.length === 0}
              className="p-2 hover:bg-slate-800 rounded-lg text-slate-400 hover:text-white transition-colors disabled:opacity-30 group relative"
              title="Kopiuj do schowka"
            >
              {isCopied ? (
                <ClipboardDocumentCheckIcon className="w-5 h-5 text-green-500" />
              ) : (
                <ClipboardDocumentIcon className="w-5 h-5" />
              )}
            </button>

            <button 
              onClick={handleDownload}
              disabled={currentTranscript.length === 0}
              className="p-2 hover:bg-slate-800 rounded-lg text-slate-400 hover:text-white transition-colors disabled:opacity-30"
              title="Pobierz plik tekstowy"
            >
              <ArrowDownTrayIcon className="w-5 h-5" />
            </button>
            <button 
              onClick={clearCurrentTranscript}
              disabled={currentTranscript.length === 0}
              className="p-2 hover:bg-red-900/20 rounded-lg text-slate-400 hover:text-red-400 transition-colors disabled:opacity-30"
              title="Wyczyść"
            >
              <TrashIcon className="w-5 h-5" />
            </button>
          </div>
        </div>
      </header>

      {/* Tabs */}
      {diarizedTranscript.length > 0 && (
         <div className="flex-none bg-slate-900 border-b border-slate-800">
             <div className="max-w-4xl mx-auto flex gap-4 px-4">
                 <button 
                    onClick={() => setActiveTab('live')}
                    className={`pb-3 pt-3 px-2 text-sm font-medium border-b-2 transition-colors ${activeTab === 'live' ? 'border-blue-500 text-white' : 'border-transparent text-slate-500 hover:text-slate-300'}`}
                 >
                    Na Żywo
                 </button>
                 <button 
                    onClick={() => setActiveTab('diarized')}
                    className={`pb-3 pt-3 px-2 text-sm font-medium border-b-2 transition-colors flex items-center gap-2 ${activeTab === 'diarized' ? 'border-indigo-500 text-white' : 'border-transparent text-slate-500 hover:text-slate-300'}`}
                 >
                    <UserGroupIcon className="w-4 h-4" />
                    Analiza Nagrania
                 </button>
             </div>
         </div>
      )}

      {/* Main Transcript Area */}
      <main className="flex-1 overflow-y-auto bg-slate-900 p-4 md:p-8 scrollbar-hide relative">
        <div className="max-w-4xl mx-auto pb-32">
          {currentTranscript.length === 0 ? (
             activeTab === 'live' ? (
                <div className="flex flex-col items-center justify-center h-64 mt-10 text-slate-600">
                  <div className="p-4 bg-slate-800/50 rounded-full mb-4">
                     <MicrophoneIcon className="w-12 h-12 opacity-50" />
                  </div>
                  <p className="text-lg font-medium text-slate-400">Gotowy do nagrywania</p>
                  <p className="text-sm mt-2 max-w-md text-center">Naciśnij start. Aplikacja nagra dźwięk lokalnie i będzie tworzyć transkrypcję na żywo.</p>
                </div>
             ) : (
                <div className="flex flex-col items-center justify-center h-64 mt-10 text-slate-600">
                    <p>Brak danych analizy.</p>
                </div>
             )
          ) : (
            <div className="space-y-1">
              {currentTranscript.map((entry) => (
                <TranscriptItem key={entry.id} entry={entry} />
              ))}
            </div>
          )}
          <div ref={scrollBottomRef} />
        </div>
      </main>

      {/* Audio Processing Toolbar (Post-recording) */}
      {status === ConnectionStatus.DISCONNECTED && audioBlob && (
        <div className="absolute bottom-32 left-0 right-0 z-30 flex justify-center animate-fade-in-up">
           <div className="bg-slate-800/90 backdrop-blur border border-slate-700 p-4 rounded-xl shadow-2xl flex items-center gap-4 max-w-2xl mx-4">
              <div className="flex flex-col">
                  <span className="text-xs text-slate-400 font-mono uppercase mb-1">Ostatnie nagranie</span>
                  <audio controls src={URL.createObjectURL(audioBlob)} className="h-8 w-64" />
              </div>
              <div className="h-10 w-px bg-slate-700 mx-2"></div>
              <button 
                onClick={handleDiarization}
                disabled={isProcessingDiarization}
                className="flex items-center gap-2 bg-indigo-600 hover:bg-indigo-500 disabled:bg-slate-700 text-white px-4 py-2 rounded-lg font-medium transition-colors shadow-lg shadow-indigo-500/20"
              >
                {isProcessingDiarization ? (
                   <>
                     <ArrowPathIcon className="w-5 h-5 animate-spin" />
                     Analizowanie...
                   </>
                ) : (
                   <>
                     <UserGroupIcon className="w-5 h-5" />
                     Transkrybuj z podziałem na osoby
                   </>
                )}
              </button>
           </div>
        </div>
      )}

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
                {liveTranscript.length > 0 ? "Odnawianie sesji..." : "Inicjalizacja..."}
              </span>
           )}
        </div>
      </footer>
    </div>
  );
};

export default App;