import React from 'react';
import { ChevronDown, ChevronUp } from 'lucide-react';

interface MoreOptionsButtonProps {
  expanded: boolean;
  onToggle: () => void;
  labelClosed?: string;
  labelOpen?: string;
}

export const MoreOptionsButton: React.FC<MoreOptionsButtonProps> = ({
  expanded,
  onToggle,
  labelClosed = "Plus d'options",
  labelOpen = "Moins d'options",
}) => {
  return (
    <button
      type="button"
      onClick={onToggle}
      className="inline-flex items-center gap-1.5 rounded-md border border-slate-300 bg-slate-50 px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-100 whitespace-nowrap"
    >
      {expanded ? (
        <ChevronUp className="h-3.5 w-3.5 text-slate-500" />
      ) : (
        <ChevronDown className="h-3.5 w-3.5 text-slate-500" />
      )}
      <span>{expanded ? labelOpen : labelClosed}</span>
    </button>
  );
};
