import React from 'react';
import { TranscriptEntry } from '../types';

interface TranscriptItemProps {
  entry: TranscriptEntry;
}

const TranscriptItem: React.FC<TranscriptItemProps> = ({ entry }) => {
  const isUser = entry.speaker === 'user';
  
  return (
    <div className={`flex w-full mb-4 ${isUser ? 'justify-end' : 'justify-start'}`}>
      <div 
        className={`max-w-[85%] rounded-2xl px-5 py-3 shadow-sm ${
          isUser 
            ? 'bg-blue-600 text-white rounded-br-none' 
            : 'bg-slate-700 text-slate-200 rounded-bl-none'
        } ${entry.isPartial ? 'opacity-70 animate-pulse' : 'opacity-100'}`}
      >
        <div className="flex items-center justify-between mb-1 gap-4">
          <span className="text-xs font-bold uppercase tracking-wider opacity-75">
            {isUser ? 'Ty' : 'AI'}
          </span>
          <span className="text-[10px] opacity-60 font-mono">
            {entry.timestamp}
          </span>
        </div>
        <p className="whitespace-pre-wrap leading-relaxed">
          {entry.text}
        </p>
      </div>
    </div>
  );
};

export default TranscriptItem;