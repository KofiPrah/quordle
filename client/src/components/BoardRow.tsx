import type { GuessResult } from '../../../engine/src/types';
import { Tile } from './Tile';

interface BoardRowProps {
    guess: string;
    result?: GuessResult;
}

export function BoardRow({ guess, result }: BoardRowProps) {
    const letters = guess.padEnd(5, ' ').split('');

    return (
        <div className="flex gap-1">
            {letters.map((letter, i) => (
                <Tile key={i} letter={letter.trim()} result={result?.[i]} />
            ))}
        </div>
    );
}
