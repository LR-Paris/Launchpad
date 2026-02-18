import { cn } from '../lib/utils';

export default function StatusBadge({ status }) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-medium',
        status === 'running' && 'bg-green-100 text-green-700',
        status === 'stopped' && 'bg-gray-100 text-gray-600',
        status === 'error' && 'bg-red-100 text-red-700'
      )}
    >
      <span
        className={cn(
          'h-1.5 w-1.5 rounded-full',
          status === 'running' && 'bg-green-500',
          status === 'stopped' && 'bg-gray-400',
          status === 'error' && 'bg-red-500'
        )}
      />
      {status}
    </span>
  );
}
