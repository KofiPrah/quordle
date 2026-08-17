import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    CHINESE_PINYIN_PUZZLE_ANSWERS,
    PINYIN_PUZZLE_VARIANT,
    type ChinesePinyinPuzzleAnswer,
} from '../src/chineseLexicon.js';
import { parseChinesePinyinInput } from '../src/pinyin.js';
import { ZH_PINYIN_GUESS_KEYS_BY_LENGTH } from '../src/zhPinyinGuessKeys.generated.js';
import { generateChinesePinyinCatalog } from '../scripts/generate-zh-pinyin-catalog.mjs';

const engineRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function withCorruptedPronunciation(mutate: (pronunciation: Record<string, unknown>) => void): { fixtureRoot: string; dispose: () => void } {
    const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'quordle-pinyin-catalog-'));
    fs.cpSync(path.join(engineRoot, 'src'), path.join(fixtureRoot, 'src'), { recursive: true });
    const manifestPath = path.join(fixtureRoot, 'src', 'zhDictionary.generated.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const shardPath = manifest.shards
        .map((id: string) => path.join(fixtureRoot, 'src', 'zhDictionaryShards', `${id}.json`))
        .find((candidate: string) => JSON.parse(fs.readFileSync(candidate, 'utf8')).entries['学生']);
    if (!shardPath) throw new Error('The checked-in student fixture is missing');
    const shard = JSON.parse(fs.readFileSync(shardPath, 'utf8'));
    mutate(shard.entries['学生'].pronunciations[0]);
    fs.writeFileSync(shardPath, `${JSON.stringify(shard)}\n`);
    return { fixtureRoot, dispose: () => fs.rmSync(fixtureRoot, { recursive: true, force: true }) };
}

describe('Chinese Pinyin puzzle catalog', () => {
    it.each([
        ['numeric', (pronunciation: Record<string, unknown>) => { pronunciation.pinyinNumeric = 'bad data'; }],
        ['marked', (pronunciation: Record<string, unknown>) => { pronunciation.pinyinMarked = 'xué shang'; }],
    ])('fails generation when %s pronunciation metadata disagrees with its canonical plain syllables', (_kind, mutate) => {
        const { fixtureRoot, dispose } = withCorruptedPronunciation(mutate);
        try {
            expect(() => generateChinesePinyinCatalog({ engineRoot: fixtureRoot, quiet: true })).toThrow(/canonical Pinyin metadata/u);
        } finally {
            dispose();
        }
    });

    it('ships the 64 curated Hanzi identities with playable keys and canonical metadata', () => {
        expect(PINYIN_PUZZLE_VARIANT).toBe('pinyin-latin-v2');
        expect(CHINESE_PINYIN_PUZZLE_ANSWERS).toHaveLength(64);
        expect(new Set(CHINESE_PINYIN_PUZZLE_ANSWERS.map((answer) => answer.key)).size).toBe(64);
        expect(CHINESE_PINYIN_PUZZLE_ANSWERS.reduce<Record<number, number>>((counts, answer) => {
            counts[answer.length] = (counts[answer.length] ?? 0) + 1;
            return counts;
        }, {})).toEqual({ 4: 6, 5: 15, 6: 14, 7: 20, 8: 7, 9: 2 });

        const student = CHINESE_PINYIN_PUZZLE_ANSWERS.find((answer) => answer.id === '学生') as ChinesePinyinPuzzleAnswer;
        expect(student).toMatchObject({
            id: '学生',
            hanzi: '学生',
            key: 'xuesheng',
            pinyinMarked: 'xué sheng',
            pinyinNumeric: 'xue2 sheng5',
            tones: [2, 5],
            syllableBoundary: 3,
            length: 8,
            answerEligible: true,
        });
        expect(student.broadMeaning).toMatch(/person enrolled/u);
    });

    it('keeps every answer boundary valid and every answer key in its normalized guess set', () => {
        for (const answer of CHINESE_PINYIN_PUZZLE_ANSWERS) {
            expect(answer.syllableBoundary).toBeGreaterThan(0);
            expect(answer.syllableBoundary).toBeLessThan(answer.length);
            expect(ZH_PINYIN_GUESS_KEYS_BY_LENGTH[answer.length]).toContain(answer.key);
        }
    });

    it('deduplicates homophonous accepted dictionary entries into one playable key per length', () => {
        for (const keys of Object.values(ZH_PINYIN_GUESS_KEYS_BY_LENGTH)) {
            expect(new Set(keys).size).toBe(keys.length);
        }
        expect(ZH_PINYIN_GUESS_KEYS_BY_LENGTH[5].filter((key) => key === 'aiyou')).toEqual(['aiyou']);
    });
});

describe('strict Chinese Pinyin input grammar', () => {
    it('normalizes plain, marked, numeric, decomposed, separator, and umlaut forms into a two-syllable key', () => {
        const expected = { key: 'xuesheng', syllables: [{ key: 'xue', tone: 2 }, { key: 'sheng', tone: 1 }] };
        expect(parseChinesePinyinInput('xue sheng')).toMatchObject({ key: 'xuesheng', syllables: [{ key: 'xue', tone: null }, { key: 'sheng', tone: null }] });
        expect(parseChinesePinyinInput('xué-shēng')).toMatchObject(expected);
        expect(parseChinesePinyinInput('xu\u0065\u0301\u00b7shēng')).toMatchObject(expected);
        expect(parseChinesePinyinInput('xue2sheng1')).toMatchObject(expected);
        expect(parseChinesePinyinInput('nü ér')).toMatchObject({ key: 'nver', syllables: [{ key: 'nv', tone: null }, { key: 'er', tone: 2 }] });
        expect(parseChinesePinyinInput('nu:3 er2')).toMatchObject({ key: 'nver', syllables: [{ key: 'nv', tone: 3 }, { key: 'er', tone: 2 }] });
        expect(parseChinesePinyinInput('nv er')).toMatchObject({ key: 'nver' });
    });

    it('rejects malformed numeric, mixed-script, mixed-tone, and punctuated input without discarding characters', () => {
        [
            'xue2 sheng',
            'xue sheng1',
            'xue2 sheng1 ma3',
            'xué2 sheng1',
            'xue0 sheng1',
            'xue6 sheng1',
            '学生',
            'xue学 sheng',
            'xue/sheng',
            'xue,sheng',
        ].forEach((input) => expect(parseChinesePinyinInput(input)).toBeNull());
    });
});
