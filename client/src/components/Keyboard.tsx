import type { LetterResult, BoardLetterStatuses } from '../../../engine/src/types';

const KEYBOARD_ROWS = [
    ['q', 'w', 'e', 'r', 't', 'y', 'u', 'i', 'o', 'p'],
    ['a', 's', 'd', 'f', 'g', 'h', 'j', 'k', 'l'],
    ['enter', 'z', 'x', 'c', 'v', 'b', 'n', 'm', 'backspace'],
];

interface KeyboardProps {
    onKey: (key: string) => void;
    onEnter: () => void;
    onBackspace: () => void;
    letterStates?: Map<string, LetterResult>;
    boardStatuses?: Record<string, BoardLetterStatuses>;
    disabled?: boolean;
}

const stateStyles: Record<LetterResult, string> = {
    correct: 'bg-green-500 text-white',
    present: 'bg-yellow-500 text-white',
    absent: 'bg-gray-500 text-white',
};

const dotStyles: Record<LetterResult, string> = {
    correct: 'kbd-correct',
    present: 'kbd-present',
    absent: 'kbd-absent',
};

const defaultStyle = 'bg-gray-200 hover:bg-gray-300';

function BoardGrid({ statuses }: { statuses: BoardLetterStatuses }) {
    if (statuses.every(s => s === null)) return null;
    return (
        <span className="key-board-grid">
            {statuses.map((s, i) => (
                <span key={i} className={`kbd-dot ${s ? dotStyles[s] : ''}`} data-board={i} />
            ))}
        </span>
    );
}

export function Keyboard({ onKey, onEnter, onBackspace, letterStates, boardStatuses, disabled }: KeyboardProps) {
    const handleClick = (key: string) => {
        if (disabled) return;

        if (key === 'enter') {
            onEnter();
        } else if (key === 'backspace') {
            onBackspace();
        } else {
            onKey(key);
        }
    };

    const getKeyStyle = (key: string) => {
        if (key === 'enter' || key === 'backspace') return defaultStyle;
        const state = letterStates?.get(key);
        return state ? stateStyles[state] : defaultStyle;
    };

    return (
        <div className="flex flex-col items-center gap-1">
            {KEYBOARD_ROWS.map((row, rowIndex) => (
                <div key={rowIndex} className="flex gap-1">
                    {row.map((key) => (
                        <button
                            key={key}
                            onClick={() => handleClick(key)}
                            disabled={disabled}
                            className={`
                                ${key.length > 1 ? 'px-3 text-xs' : 'w-9'} 
                                h-12 rounded font-bold uppercase 
                                transition-colors disabled:opacity-50
                                ${getKeyStyle(key)}
                            `}
                        >
                            {key.length === 1 && boardStatuses?.[key] && (
                                <BoardGrid statuses={boardStatuses[key]} />
                            )}
                            {key === 'backspace' ? '⌫' : key}
                        </button>
                    ))}
                </div>
            ))}
        </div>
    );
}
