import React from 'react';
import { TranscriptEntry } from '../types';

interface TranscriptItemProps {
  entry: TranscriptEntry;
}

const TranscriptItem: React.FC<TranscriptItemProps> = ({ entry }) => {
  return (
    <div className="group w-full py-2 hover:bg-slate-800/50 rounded px-2 transition-colors">
      <div className="flex gap-4 items-baseline">
        <span className="shrink-0 w-16 text-[11px] font-mono text-slate-500 text-right select-none">
          {entry.timestamp}
        </span>
        <div className="flex-1">
          <p className={`text-slate-200 leading-relaxed whitespace-pre-wrap ${entry.isPartial ? 'opacity-70' : ''}`}>
             {entry.text}
             {entry.isPartial && (
               <span className="inline-block w-1.5 h-4 ml-1 align-middle bg-blue-500 animate-pulse" />
             )}
          </p>
        </div>
      </div>
    </div>
  );
};

export default TranscriptItem;