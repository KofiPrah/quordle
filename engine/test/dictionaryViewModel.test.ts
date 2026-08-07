import { describe, expect, it } from 'vitest';
import { toChineseDictionaryViewModel, toKoreanDictionaryViewModel } from '../src/dictionaryViewModel.js';

describe('language-neutral dictionary view models', () => {
    it('adapts the unchanged Korean snapshot schema', () => {
        const view = toKoreanDictionaryViewModel({
            word: '학생', normalized: '학생', units: ['학', '생'], romanization: 'haksaeng',
            senses: [{ partOfSpeech: 'noun', translations: ['student'], definition: 'A person who studies.', sourceTargetCode: 1, sourceUrl: 'https://example.test/1' }],
            semanticCategories: [{ korean: '교육', english: 'Education' }],
            answerEligible: true, guessEligible: true,
        });
        expect(view).toMatchObject({ language: 'ko', display: '학생', romanization: 'haksaeng', translations: ['student'] });
        expect(view.senses[0].sourceUrl).toBe('https://example.test/1');
    });

    it('adapts Chinese pinyin, traditional forms, and glosses', () => {
        const view = toChineseDictionaryViewModel({
            word: '学生', normalized: '学生', display: '学生', simplified: '学生', traditional: ['學生'], units: ['学', '生'],
            pronunciations: [{ pinyinNumeric: 'xue2 sheng1', pinyinMarked: 'xué shēng', pinyinPlain: 'xue sheng', tones: [2, 1] }],
            senses: [{ glosses: ['student'] }], translations: ['student'], answerEligible: true, guessEligible: true,
        });
        expect(view).toMatchObject({
            language: 'zh', display: '学生', romanization: 'xué shēng', numericPronunciation: 'xue2 sheng1', alternateForms: ['學生'],
        });
        expect(view.senses).toEqual([{ translations: ['student'] }]);
    });
});
