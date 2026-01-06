import React, { useState, useEffect, useRef, useCallback } from 'react';
import { GoogleGenAI, LiveServerMessage, Modality } from '@google/genai';
import { createBlob, decode, decodeAudioData } from './utils/audioUtils';
import { TranscriptEntry, ConnectionStatus } from './types';
import TranscriptItem from './components/TranscriptItem';
import {
  MicrophoneIcon,
  StopIcon,
  ArrowDownTrayIcon,
  TrashIcon,
  SignalIcon
} from '@heroicons/react/24/solid';

// Reconnection configuration
const RECONNECT_CONFIG = {
  maxAttempts: 5,
  baseDelayMs: 1000,
  maxDelayMs: 30000,
  backoffMultiplier: 2,
};

// Keep-alive interval (send activity every 30 seconds to prevent timeout)
const KEEPALIVE_INTERVAL_MS = 30000;

const App: React.FC = () => {
  // --- State ---
  const [status, setStatus] = useState<ConnectionStatus>(ConnectionStatus.DISCONNECTED);
  const [transcript, setTranscript] = useState<TranscriptEntry[]>([]);
  const [volume, setVolume] = useState(0); // For visualizer
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [reconnectAttempt, setReconnectAttempt] = useState(0);
  const [isManualStop, setIsManualStop] = useState(false);

  // --- Refs for Audio & API ---
  const inputAudioContextRef = useRef<AudioContext | null>(null);
  const outputAudioContextRef = useRef<AudioContext | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const sourceNodeRef = useRef<MediaStreamAudioSourceNode | null>(null);
  const sessionRef = useRef<any>(null); // Type 'Session' is internal to genai, using any for now

  // Buffers for seamless playback
  const nextStartTimeRef = useRef<number>(0);
  const sourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set());

  // Transcription Buffers
  const currentInputTransRef = useRef<string>('');
  const currentOutputTransRef = useRef<string>('');

  // Reconnection & Keep-alive refs
  const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const keepAliveIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const lastActivityRef = useRef<number>(Date.now());
  const isReconnectingRef = useRef<boolean>(false);
  const isSessionActiveRef = useRef<boolean>(false);

  const scrollBottomRef = useRef<HTMLDivElement>(null);

  // --- Effects ---

  // Auto-scroll to bottom
  useEffect(() => {
    if (scrollBottomRef.current) {
      scrollBottomRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [transcript]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      cleanupAll();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // --- Cleanup & Reconnection Helpers ---

  const clearReconnectTimeout = () => {
    if (reconnectTimeoutRef.current) {
      clearTimeout(reconnectTimeoutRef.current);
      reconnectTimeoutRef.current = null;
    }
  };

  const clearKeepAliveInterval = () => {
    if (keepAliveIntervalRef.current) {
      clearInterval(keepAliveIntervalRef.current);
      keepAliveIntervalRef.current = null;
    }
  };

  const cleanupAll = () => {
    clearReconnectTimeout();
    clearKeepAliveInterval();
    stopSessionInternal(false);
  };

  const calculateReconnectDelay = (attempt: number): number => {
    const delay = RECONNECT_CONFIG.baseDelayMs * Math.pow(RECONNECT_CONFIG.backoffMultiplier, attempt);
    return Math.min(delay, RECONNECT_CONFIG.maxDelayMs);
  };

  const scheduleReconnect = () => {
    if (isManualStop || isReconnectingRef.current) return;
    if (reconnectAttempt >= RECONNECT_CONFIG.maxAttempts) {
      setErrorMsg(`Nie udało się połączyć po ${RECONNECT_CONFIG.maxAttempts} próbach. Kliknij Start, aby spróbować ponownie.`);
      setStatus(ConnectionStatus.ERROR);
      setReconnectAttempt(0);
      return;
    }

    isReconnectingRef.current = true;
    const delay = calculateReconnectDelay(reconnectAttempt);
    console.log(`Scheduling reconnect attempt ${reconnectAttempt + 1} in ${delay}ms`);

    setErrorMsg(`Połączenie przerwane. Ponowne łączenie za ${Math.ceil(delay / 1000)}s... (próba ${reconnectAttempt + 1}/${RECONNECT_CONFIG.maxAttempts})`);

    reconnectTimeoutRef.current = setTimeout(async () => {
      setReconnectAttempt(prev => prev + 1);
      isReconnectingRef.current = false;
      await startSession(true); // true = isReconnect
    }, delay);
  };

  const startKeepAlive = () => {
    clearKeepAliveInterval();
    keepAliveIntervalRef.current = setInterval(() => {
      // Only send keep-alive if session is active
      if (!isSessionActiveRef.current || !sessionRef.current) return;

      const timeSinceActivity = Date.now() - lastActivityRef.current;
      // Only send keep-alive if we haven't had recent audio activity
      if (timeSinceActivity > KEEPALIVE_INTERVAL_MS - 5000) {
        console.log('Sending keep-alive ping');
        // Send minimal audio blob to keep connection alive
        try {
          const silentPcm = new Float32Array(160); // 10ms of silence at 16kHz
          const silentBlob = createBlob(silentPcm);
          sessionRef.current.sendRealtimeInput({ media: silentBlob });
        } catch (e) {
          console.warn('Keep-alive failed:', e);
        }
      }
    }, KEEPALIVE_INTERVAL_MS);
  };

  // --- Helper Functions ---

  const formatTime = () => {
    const now = new Date();
    return now.toLocaleTimeString('pl-PL', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  };

  const updateTranscript = (speaker: 'user' | 'model', text: string, isFinal: boolean) => {
    setTranscript(prev => {
      const newEntry: TranscriptEntry = {
        id: Date.now().toString() + Math.random(),
        timestamp: formatTime(),
        speaker,
        text,
        isPartial: !isFinal
      };

      // If the last entry was partial and from the same speaker, update it
      // Otherwise append new
      if (prev.length > 0) {
        const last = prev[prev.length - 1];
        if (last.isPartial && last.speaker === speaker) {
          if (isFinal) {
             // Finalize the last partial entry
             return [...prev.slice(0, -1), { ...last, text, isPartial: false }];
          } else {
             // Update the partial entry
             return [...prev.slice(0, -1), { ...last, text }];
          }
        }
      }
      
      return [...prev, newEntry];
    });
  };

  // --- Core Logic ---

  const startSession = async (isReconnect: boolean = false) => {
    try {
      if (!isReconnect) {
        setIsManualStop(false);
        setReconnectAttempt(0);
        clearReconnectTimeout();
      }
      setErrorMsg(null);
      setStatus(ConnectionStatus.CONNECTING);

      // 1. Initialize Audio Contexts (only if not already initialized or closed)
      if (!inputAudioContextRef.current || inputAudioContextRef.current.state === 'closed') {
        inputAudioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 16000 });
      }
      if (!outputAudioContextRef.current || outputAudioContextRef.current.state === 'closed') {
        outputAudioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });
      }

      // Resume audio contexts if suspended
      if (inputAudioContextRef.current.state === 'suspended') {
        await inputAudioContextRef.current.resume();
      }
      if (outputAudioContextRef.current.state === 'suspended') {
        await outputAudioContextRef.current.resume();
      }

      // 2. Get Microphone Access (reuse existing stream if available)
      let stream = mediaStreamRef.current;
      if (!stream || stream.getTracks().every(t => t.readyState === 'ended')) {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        mediaStreamRef.current = stream;
      }

      // 3. Initialize Gemini Client
      const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });

      // 4. Connect to Live API
      const sessionPromise = ai.live.connect({
        model: 'gemini-2.5-flash-native-audio-preview-09-2025',
        config: {
          responseModalities: [Modality.AUDIO],
          inputAudioTranscription: { model: 'gemini-2.5-flash-native-audio-preview-09-2025' },
          outputAudioTranscription: { model: 'gemini-2.5-flash-native-audio-preview-09-2025' },
          systemInstruction: {
            parts: [{ text: "Jesteś inteligentnym asystentem. Rozmawiasz po polsku. Twoim zadaniem jest prowadzenie konwersacji. Jeśli użytkownik przestanie mówić, czekaj cierpliwie." }]
          },
        },
        callbacks: {
          onopen: () => {
            console.log("Session Opened" + (isReconnect ? " (reconnected)" : ""));
            isSessionActiveRef.current = true;
            setStatus(ConnectionStatus.CONNECTED);
            setErrorMsg(null);
            setReconnectAttempt(0); // Reset on successful connection

            // Start keep-alive mechanism
            startKeepAlive();

            // Setup Audio Processing Node
            if (!inputAudioContextRef.current) return;

            const source = inputAudioContextRef.current.createMediaStreamSource(stream);
            sourceNodeRef.current = source;

            // ScriptProcessor is deprecated but standard for these raw PCM demos
            const processor = inputAudioContextRef.current.createScriptProcessor(4096, 1, 1);
            processorRef.current = processor;

            processor.onaudioprocess = (e) => {
              // Skip if session is not active
              if (!isSessionActiveRef.current) return;

              const inputData = e.inputBuffer.getChannelData(0);

              // Visualizer volume calculation
              let sum = 0;
              for (let i = 0; i < inputData.length; i++) sum += inputData[i] * inputData[i];
              setVolume(Math.sqrt(sum / inputData.length));

              // Update last activity timestamp
              lastActivityRef.current = Date.now();

              const pcmBlob = createBlob(inputData);
              sessionPromise.then((session) => {
                if (isSessionActiveRef.current) {
                  try {
                    session.sendRealtimeInput({ media: pcmBlob });
                  } catch (err) {
                    console.warn('Failed to send audio:', err);
                  }
                }
              });
            };

            source.connect(processor);
            processor.connect(inputAudioContextRef.current.destination);
          },
          onmessage: async (msg: LiveServerMessage) => {
            // Update activity timestamp on any message
            lastActivityRef.current = Date.now();

            // 1. Handle Transcriptions
            const content = msg.serverContent;

            if (content?.inputTranscription) {
              const text = content.inputTranscription.text;
              if (text) {
                currentInputTransRef.current += text;
                // Live update for user partial
                updateTranscript('user', currentInputTransRef.current, false);
              }
            }

            if (content?.outputTranscription) {
              const text = content.outputTranscription.text;
              if (text) {
                currentOutputTransRef.current += text;
                updateTranscript('model', currentOutputTransRef.current, false);
              }
            }

            // Turn Complete Logic (Finalize transcripts)
            if (content?.turnComplete) {
              if (currentInputTransRef.current) {
                updateTranscript('user', currentInputTransRef.current, true);
                currentInputTransRef.current = '';
              }
              if (currentOutputTransRef.current) {
                updateTranscript('model', currentOutputTransRef.current, true);
                currentOutputTransRef.current = '';
              }
            }

            // 2. Handle Audio Output (Playback)
            const audioData = content?.modelTurn?.parts?.[0]?.inlineData?.data;
            if (audioData && outputAudioContextRef.current) {
              const ctx = outputAudioContextRef.current;
              nextStartTimeRef.current = Math.max(nextStartTimeRef.current, ctx.currentTime);

              const audioBuffer = await decodeAudioData(
                decode(audioData),
                ctx,
                24000,
                1
              );

              const source = ctx.createBufferSource();
              source.buffer = audioBuffer;
              source.connect(ctx.destination);

              source.addEventListener('ended', () => {
                sourcesRef.current.delete(source);
              });

              source.start(nextStartTimeRef.current);
              nextStartTimeRef.current += audioBuffer.duration;
              sourcesRef.current.add(source);
            }
          },
          onclose: (e: any) => {
            console.log("Session Closed", e);
            isSessionActiveRef.current = false;
            clearKeepAliveInterval();

            // Check if this was an unexpected close (not manual)
            if (!isManualStop && status === ConnectionStatus.CONNECTED) {
              console.log("Unexpected session close, attempting reconnect...");
              // Clean up audio nodes but keep the stream
              if (sourceNodeRef.current) sourceNodeRef.current.disconnect();
              if (processorRef.current) {
                processorRef.current.disconnect();
                processorRef.current = null;
              }
              sessionRef.current = null;
              setStatus(ConnectionStatus.DISCONNECTED);
              scheduleReconnect();
            } else {
              setStatus(ConnectionStatus.DISCONNECTED);
            }
          },
          onerror: (e: any) => {
            console.error("Session Error", e);
            isSessionActiveRef.current = false;
            clearKeepAliveInterval();

            if (!isManualStop) {
              // Clean up and attempt reconnect
              if (sourceNodeRef.current) sourceNodeRef.current.disconnect();
              if (processorRef.current) {
                processorRef.current.disconnect();
                processorRef.current = null;
              }
              sessionRef.current = null;
              setStatus(ConnectionStatus.DISCONNECTED);
              scheduleReconnect();
            } else {
              setErrorMsg("Błąd połączenia.");
              stopSessionInternal(false);
            }
          }
        }
      });

      // Save session reference to close later
      sessionRef.current = await sessionPromise;

    } catch (err) {
      console.error(err);

      if (!isManualStop && isReconnect) {
        // If this was a reconnect attempt that failed, schedule another
        scheduleReconnect();
      } else {
        setErrorMsg("Nie udało się uzyskać dostępu do mikrofonu lub API.");
        setStatus(ConnectionStatus.ERROR);
      }
    }
  };

  // Internal stop that handles the actual cleanup
  const stopSessionInternal = (finalizeTranscripts: boolean = true) => {
    // Mark session as inactive immediately to stop audio sending
    isSessionActiveRef.current = false;

    // 1. Finalize any hanging transcripts
    if (finalizeTranscripts) {
      if (currentInputTransRef.current) {
        updateTranscript('user', currentInputTransRef.current, true);
        currentInputTransRef.current = '';
      }
      if (currentOutputTransRef.current) {
        updateTranscript('model', currentOutputTransRef.current, true);
        currentOutputTransRef.current = '';
      }
    }

    // 2. Clear keep-alive
    clearKeepAliveInterval();

    // 3. Stop Tracks
    if (mediaStreamRef.current) {
      mediaStreamRef.current.getTracks().forEach(track => track.stop());
      mediaStreamRef.current = null;
    }

    // 4. Disconnect Audio Nodes
    if (sourceNodeRef.current) sourceNodeRef.current.disconnect();
    if (processorRef.current) {
      processorRef.current.disconnect();
      processorRef.current = null;
    }

    // 5. Close Audio Contexts
    if (inputAudioContextRef.current && inputAudioContextRef.current.state !== 'closed') {
      inputAudioContextRef.current.close();
    }
    if (outputAudioContextRef.current && outputAudioContextRef.current.state !== 'closed') {
      outputAudioContextRef.current.close();
    }

    // 6. Close API Session
    if (sessionRef.current) {
      try {
        sessionRef.current.close();
      } catch (e) {
        console.warn("Could not explicitly close session", e);
      }
      sessionRef.current = null;
    }

    setStatus(ConnectionStatus.DISCONNECTED);
    setVolume(0);
  };

  // Public stop - called when user clicks Stop button
  const stopSession = () => {
    setIsManualStop(true);
    clearReconnectTimeout();
    setReconnectAttempt(0);
    setErrorMsg(null);
    stopSessionInternal(true);
  };

  const handleDownload = () => {
    const text = transcript
      .map(t => `[${t.timestamp}] ${t.speaker === 'user' ? 'TY' : 'AI'}: ${t.text}`)
      .join('\n\n');
    
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

  // --- Render ---

  return (
    <div className="flex flex-col h-screen bg-slate-900 text-slate-100 overflow-hidden">
      {/* Header */}
      <header className="flex-none p-4 bg-slate-800 border-b border-slate-700 shadow-md z-10">
        <div className="max-w-4xl mx-auto flex justify-between items-center">
          <div className="flex items-center gap-3">
             <div className={`w-3 h-3 rounded-full ${
               status === ConnectionStatus.CONNECTED
                 ? 'bg-green-500 animate-pulse'
                 : reconnectAttempt > 0
                   ? 'bg-yellow-500 animate-pulse'
                   : status === ConnectionStatus.CONNECTING
                     ? 'bg-blue-500 animate-pulse'
                     : 'bg-red-500'
             }`}></div>
             <h1 className="text-xl font-semibold tracking-tight text-white">LiveScribe <span className="text-blue-400">PL</span></h1>
          </div>
          
          <div className="flex items-center gap-2">
            {status === ConnectionStatus.CONNECTED && (
              <div className="flex items-center gap-2 mr-4 px-3 py-1 bg-slate-700 rounded-full border border-slate-600">
                <SignalIcon className="w-4 h-4 text-green-400" />
                <span className="text-xs font-mono text-green-400">NA ŻYWO</span>
              </div>
            )}
            {reconnectAttempt > 0 && status !== ConnectionStatus.CONNECTED && (
              <div className="flex items-center gap-2 mr-4 px-3 py-1 bg-yellow-900/50 rounded-full border border-yellow-600">
                <div className="w-2 h-2 bg-yellow-400 rounded-full animate-pulse" />
                <span className="text-xs font-mono text-yellow-400">
                  ŁĄCZENIE ({reconnectAttempt}/{RECONNECT_CONFIG.maxAttempts})
                </span>
              </div>
            )}
            
            <button 
              onClick={handleDownload}
              disabled={transcript.length === 0}
              className="p-2 hover:bg-slate-700 rounded-lg text-slate-400 hover:text-white transition-colors disabled:opacity-30"
              title="Pobierz transkrypcję"
            >
              <ArrowDownTrayIcon className="w-5 h-5" />
            </button>
            <button 
              onClick={clearTranscript}
              disabled={transcript.length === 0}
              className="p-2 hover:bg-red-900/30 rounded-lg text-slate-400 hover:text-red-400 transition-colors disabled:opacity-30"
              title="Wyczyść historię"
            >
              <TrashIcon className="w-5 h-5" />
            </button>
          </div>
        </div>
      </header>

      {/* Main Transcript Area */}
      <main className="flex-1 overflow-y-auto p-4 md:p-6 scrollbar-hide relative">
        <div className="max-w-3xl mx-auto pb-32">
          {transcript.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-64 mt-20 text-slate-500 opacity-60">
              <MicrophoneIcon className="w-16 h-16 mb-4 opacity-50" />
              <p className="text-lg font-medium">Rozpocznij nową sesję</p>
              <p className="text-sm">Transkrypcja pojawi się tutaj w czasie rzeczywistym</p>
            </div>
          ) : (
            transcript.map((entry) => (
              <TranscriptItem key={entry.id} entry={entry} />
            ))
          )}
          <div ref={scrollBottomRef} />
        </div>
      </main>

      {/* Error Toast */}
      {errorMsg && (
        <div className="absolute top-20 left-1/2 transform -translate-x-1/2 bg-red-500/90 text-white px-4 py-2 rounded-lg shadow-xl backdrop-blur-sm z-50 text-sm">
          {errorMsg}
        </div>
      )}

      {/* Footer Controls */}
      <footer className="flex-none bg-slate-800/80 backdrop-blur-md border-t border-slate-700 p-6 fixed bottom-0 w-full z-20">
        <div className="max-w-md mx-auto flex items-center justify-center gap-8 relative">
           
           {/* Visualizer Background Effect */}
           {status === ConnectionStatus.CONNECTED && (
             <div 
               className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-24 h-24 bg-blue-500/20 rounded-full blur-xl pointer-events-none transition-all duration-100"
               style={{ transform: `translate(-50%, -50%) scale(${1 + volume * 5})` }}
             />
           )}

           {(status === ConnectionStatus.DISCONNECTED || status === ConnectionStatus.ERROR) && reconnectAttempt === 0 ? (
             <button
               onClick={() => startSession(false)}
               className="group relative flex items-center justify-center w-16 h-16 bg-blue-600 hover:bg-blue-500 text-white rounded-full shadow-lg hover:shadow-blue-500/30 transition-all transform hover:scale-105"
             >
               <MicrophoneIcon className="w-8 h-8" />
               <span className="absolute -bottom-8 text-xs font-medium text-slate-400 group-hover:text-white transition-colors">Start</span>
             </button>
           ) : reconnectAttempt > 0 && status !== ConnectionStatus.CONNECTED ? (
             <button
               onClick={stopSession}
               className="group relative flex items-center justify-center w-16 h-16 bg-yellow-600 hover:bg-yellow-500 text-white rounded-full shadow-lg hover:shadow-yellow-500/30 transition-all transform hover:scale-105"
             >
               <StopIcon className="w-8 h-8" />
               <span className="absolute -bottom-8 text-xs font-medium text-slate-400 group-hover:text-white transition-colors">Anuluj</span>
             </button>
           ) : (
             <button
               onClick={stopSession}
               className="group relative flex items-center justify-center w-16 h-16 bg-red-600 hover:bg-red-500 text-white rounded-full shadow-lg hover:shadow-red-500/30 transition-all transform hover:scale-105"
             >
               <StopIcon className="w-8 h-8" />
               <span className="absolute -bottom-8 text-xs font-medium text-slate-400 group-hover:text-white transition-colors">Stop</span>
             </button>
           )}

           {status === ConnectionStatus.CONNECTING && reconnectAttempt === 0 && (
              <span className="absolute top-[-30px] text-xs text-blue-400 animate-pulse">Łączenie...</span>
           )}
           {reconnectAttempt > 0 && status !== ConnectionStatus.CONNECTED && (
              <span className="absolute top-[-30px] text-xs text-yellow-400 animate-pulse">
                Ponowne łączenie...
              </span>
           )}
        </div>
      </footer>
    </div>
  );
};

export default App;