import {
    CHINESE_PINYIN_PUZZLE_ANSWERS,
    ENABLED_ZH_PINYIN_LENGTHS,
    PINYIN_PUZZLE_VARIANT,
    type ChinesePinyinPuzzleAnswer,
    type ChinesePinyinRound,
} from './chineseLexicon.js';

function dateKeyToSeed(dateKey: string): number {
    let hash = 5381;
    for (let index = 0; index < dateKey.length; index += 1) {
        hash = ((hash << 5) + hash) ^ dateKey.charCodeAt(index);
    }
    return hash >>> 0;
}

function mulberry32(seed: number): () => number {
    let state = seed >>> 0;
    return () => {
        state = (state + 0x6d2b79f5) >>> 0;
        let value = state;
        value = Math.imul(value ^ (value >>> 15), value | 1);
        value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
        return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
    };
}

function selectChinesePinyinRound(random: () => number): ChinesePinyinRound {
    const length = ENABLED_ZH_PINYIN_LENGTHS[
        Math.floor(random() * ENABLED_ZH_PINYIN_LENGTHS.length)
    ];
    const bucket: ChinesePinyinPuzzleAnswer[] = CHINESE_PINYIN_PUZZLE_ANSWERS
        .filter((answer) => answer.length === length);
    for (let index = bucket.length - 1; index > 0; index -= 1) {
        const swapIndex = Math.floor(random() * (index + 1));
        [bucket[index], bucket[swapIndex]] = [bucket[swapIndex], bucket[index]];
    }
    const answers = bucket.slice(0, 4);
    if (answers.length !== 4
        || new Set(answers.map((answer) => answer.key)).size !== 4
        || new Set(answers.map((answer) => answer.id)).size !== 4) {
        throw new Error(`Chinese Pinyin length ${length} cannot produce four unique answers`);
    }
    return { variant: PINYIN_PUZZLE_VARIANT, length, answers };
}

export function getDailyChinesePinyinRound(dateKey: string): ChinesePinyinRound {
    return selectChinesePinyinRound(mulberry32(dateKeyToSeed(`${dateKey}:zh:${PINYIN_PUZZLE_VARIANT}`)));
}

export function getPracticeChinesePinyinRound(random: () => number = Math.random): ChinesePinyinRound {
    return selectChinesePinyinRound(random);
}
