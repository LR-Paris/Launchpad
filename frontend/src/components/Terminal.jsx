import { useEffect, useRef } from 'react';

export default function Terminal({ logs, title }) {
  const bottomRef = useRef(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [logs]);

  return (
    <div className="rounded-lg border bg-[#1a1a2e] overflow-hidden">
      {title && (
        <div className="px-4 py-2 bg-[#16213e] border-b border-[#0f3460] flex items-center gap-2">
          <span className="h-2.5 w-2.5 rounded-full bg-red-500" />
          <span className="h-2.5 w-2.5 rounded-full bg-yellow-500" />
          <span className="h-2.5 w-2.5 rounded-full bg-green-500" />
          <span className="text-xs text-gray-400 ml-2 font-mono">{title}</span>
        </div>
      )}
      <pre className="p-4 text-xs text-green-400 font-mono whitespace-pre-wrap overflow-auto max-h-80 leading-relaxed">
        {logs || 'Waiting for output...'}
        <span ref={bottomRef} />
      </pre>
    </div>
  );
}
