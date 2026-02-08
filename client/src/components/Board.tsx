import type { BoardState } from '../../../engine/src/types';
import { BoardRow } from './BoardRow';

interface BoardProps {
    board: BoardState;
    currentGuess: string;
    maxGuesses: number;
}

export function Board({ board, currentGuess, maxGuesses }: BoardProps) {
    const { guesses, results, solved, solvedOnGuess } = board;

    // Determine the solve row index (0-based): the row where this board was solved
    // solvedOnGuess is 1-based guess count, so subtract 1 for 0-based index
    const solveRowIndex = solvedOnGuess !== null ? solvedOnGuess - 1 : null;

    const rows = [];

    // Submitted guesses: only render rows up to and including solveRowIndex
    for (let i = 0; i < guesses.length; i++) {
        if (solveRowIndex !== null && i > solveRowIndex) {
            // Board was solved earlier; render empty row instead of this guess
            rows.push(<BoardRow key={i} guess="" />);
        } else {
            rows.push(<BoardRow key={i} guess={guesses[i]} result={results[i]} />);
        }
    }

    // Current guess row (only if board not solved and game not full)
    if (!solved && guesses.length < maxGuesses) {
        rows.push(<BoardRow key="current" guess={currentGuess} />);
    }

    // Empty rows
    const emptyRowStart = solved ? guesses.length : guesses.length + 1;
    for (let i = emptyRowStart; i < maxGuesses; i++) {
        rows.push(<BoardRow key={`empty-${i}`} guess="" />);
    }

    return (
        <div className={`flex flex-col gap-1 p-2 rounded ${solved ? 'bg-green-100' : ''}`}>
            {rows}
        </div>
    );
}
