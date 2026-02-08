/** Result of evaluating a single letter in a guess */
export type LetterResult = 'correct' | 'present' | 'absent';

/** Result of evaluating a full guess against a target word */
export type GuessResult = LetterResult[];

/** State of a single board in Quordle */
export interface BoardState {
    targetWord: string;
    guesses: string[];
    results: GuessResult[];
    solved: boolean;
    solvedOnGuess: number | null;
}

/** Full game state for Quordle (4 boards) */
export interface GameState {
    boards: [BoardState, BoardState, BoardState, BoardState];
    currentGuess: string;
    guessCount: number;
    maxGuesses: number;
    gameOver: boolean;
    won: boolean;
}

/** Configuration for creating a new game */
export interface GameConfig {
    targetWords: [string, string, string, string];
    maxGuesses?: number;
}
