import guessWordsText from './guessWords.txt?raw';

/**
 * Large word list for validating guesses.
 * Loaded from guessWords.txt - includes common 5-letter words.
 */
export const GUESS_WORDS: readonly string[] = guessWordsText
    .split('\n')
    .map(w => w.trim().toLowerCase())
    .filter(w => w.length === 5);

// Build Set for O(1) lookup of guess words
const guessWordsSet = new Set(GUESS_WORDS);

/**
 * Sample word list for Quordle (ANSWER_WORDS).
 * In production, this would be a larger curated list.
 */
export const WORD_LIST: readonly string[] = [
    // Original words
    'apple', 'beach', 'chair', 'dance', 'eagle',
    'flame', 'grape', 'house', 'image', 'juice',
    'knife', 'lemon', 'mouse', 'night', 'ocean',
    'piano', 'queen', 'river', 'stone', 'table',
    'ultra', 'vivid', 'water', 'xenon', 'youth',
    'zebra', 'brave', 'crane', 'dream', 'frost',
    'ghost', 'heart', 'index', 'joker', 'karma',
    'laser', 'metal', 'noble', 'orbit', 'pearl',
    'quest', 'radar', 'solar', 'train', 'unity',
    'voice', 'whale', 'xerox', 'yield', 'zones',
    // Additional 100 words
    'about', 'above', 'abuse', 'actor', 'acute',
    'admit', 'adopt', 'adult', 'after', 'again',
    'agent', 'agree', 'ahead', 'alarm', 'album',
    'alert', 'alike', 'alive', 'allow', 'alone',
    'along', 'alter', 'amino', 'among', 'angel',
    'anger', 'angle', 'angry', 'apart', 'arena',
    'argue', 'arise', 'armor', 'aroma', 'array',
    'arrow', 'asset', 'avoid', 'award', 'aware',
    'bacon', 'badge', 'basic', 'basin', 'batch',
    'began', 'begin', 'being', 'below', 'bench',
    'berry', 'black', 'blade', 'blame', 'blank',
    'blast', 'blaze', 'blend', 'bless', 'blind',
    'block', 'bloom', 'board', 'bonus', 'boost',
    'brain', 'brand', 'bread', 'break', 'breed',
    'brick', 'brief', 'bring', 'broad', 'brook',
    'brown', 'brush', 'build', 'bunch', 'burst',
    'cabin', 'cable', 'candy', 'cargo', 'carry',
    'catch', 'cause', 'chain', 'chalk', 'champ',
    'charm', 'chase', 'cheap', 'check', 'chess',
    'chest', 'child', 'china', 'chunk', 'civic',
    'civil', 'claim', 'clash', 'class', 'clean',
    'clear', 'clerk', 'click', 'cliff', 'climb',
    'clock', 'close', 'cloth', 'cloud', 'coach',
    'coast', 'could', 'count', 'court', 'cover',
    'craft', 'crash', 'crawl', 'crazy', 'cream',
    'creek', 'creep', 'crime', 'crisp', 'cross',
    'crowd', 'crown', 'crude', 'cruel', 'crush',
    'curve', 'cycle', 'dairy', 'dealt', 'death',
    'debut', 'decay', 'delta', 'dense', 'depot',
    'depth', 'dirty', 'disco', 'doubt', 'dough',
] as const;

// Build Set for O(1) lookup of answer words
const answerWordsSet = new Set(WORD_LIST);

/**
 * Validates that a word is in the word list
 */
export function isValidWord(word: string): boolean {
    return WORD_LIST.includes(word.toLowerCase());
}

/**
 * Validates that a guess is acceptable.
 * A guess is valid if it exists in GUESS_WORDS OR WORD_LIST (answer words).
 * @param word - The word to validate
 * @returns true if the word is a valid guess
 */
export function isValidGuess(word: string): boolean {
    const normalized = word.toLowerCase();
    return guessWordsSet.has(normalized) || answerWordsSet.has(normalized);
}

/**
 * Gets a random word from the word list
 */
export function getRandomWord(): string {
    const index = Math.floor(Math.random() * WORD_LIST.length);
    return WORD_LIST[index];
}

/**
 * Gets N unique random words from the word list
 */
export function getRandomWords(count: number): string[] {
    if (count > WORD_LIST.length) {
        throw new Error(`Cannot get ${count} unique words from list of ${WORD_LIST.length}`);
    }

    const shuffled = [...WORD_LIST].sort(() => Math.random() - 0.5);
    return shuffled.slice(0, count);
}

/**
 * Gets 4 unique random words for a Quordle game
 */
export function getQuordleWords(): [string, string, string, string] {
    const words = getRandomWords(4);
    return words as [string, string, string, string];
}
