import type { GameState } from '../../../engine/src/types';
import { Board } from './Board';
import { GameBanner } from './GameBanner';

interface QuordleBoardProps {
    gameState: GameState;
}

export function QuordleBoard({ gameState }: QuordleBoardProps) {
    const { boards, currentGuess, maxGuesses, gameOver, won } = gameState;
    const solvedCount = boards.filter((b) => b.solved).length;

    return (
        <div className="flex flex-col items-center gap-4">
            <GameBanner
                gameOver={gameOver}
                won={won}
                solvedCount={solvedCount}
                totalBoards={boards.length}
            />

            <div className="grid grid-cols-2 gap-4 p-4 bg-gray-50 rounded-lg">
                {boards.map((board, i) => (
                    <Board
                        key={i}
                        board={board}
                        currentGuess={currentGuess}
                        maxGuesses={maxGuesses}
                    />
                ))}
            </div>
        </div>
    );
}
