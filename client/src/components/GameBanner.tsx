interface GameBannerProps {
    gameOver: boolean;
    won: boolean;
    solvedCount: number;
    totalBoards: number;
}

export function GameBanner({ gameOver, won, solvedCount, totalBoards }: GameBannerProps) {
    if (!gameOver) {
        return (
            <div className="text-lg text-gray-600">
                Solved: {solvedCount} / {totalBoards}
            </div>
        );
    }

    return (
        <div
            className={`
                px-6 py-3 rounded-lg text-center
                ${won ? 'bg-green-100 border-2 border-green-500' : 'bg-red-100 border-2 border-red-500'}
            `}
        >
            <div className={`text-2xl font-bold ${won ? 'text-green-600' : 'text-red-600'}`}>
                {won ? '🎉 You Won!' : '💔 Game Over'}
            </div>
            <div className="text-sm text-gray-600 mt-1">
                Solved {solvedCount} of {totalBoards} boards
            </div>
        </div>
    );
}
