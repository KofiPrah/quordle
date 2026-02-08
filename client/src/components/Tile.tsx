import type { LetterResult } from '../../../engine/src/types';

interface TileProps {
    letter: string;
    result?: LetterResult;
}

const resultStyles: Record<LetterResult, string> = {
    correct: 'bg-green-500 text-white border-green-600',
    present: 'bg-yellow-500 text-white border-yellow-600',
    absent: 'bg-gray-500 text-white border-gray-600',
};

const emptyStyle = 'bg-white border-gray-300';

export function Tile({ letter, result }: TileProps) {
    const style = result ? resultStyles[result] : emptyStyle;

    return (
        <div
            className={`w-12 h-12 flex items-center justify-center border-2 font-bold text-xl uppercase ${style}`}
        >
            {letter}
        </div>
    );
}
