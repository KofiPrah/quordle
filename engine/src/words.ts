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
    // Additional 200 common words
    'draft', 'drain', 'drama', 'drawn', 'dress',
    'dried', 'drill', 'drink', 'drive', 'drown',
    'drugs', 'drunk', 'dying', 'eager', 'early',
    'earth', 'eight', 'elect', 'elite', 'email',
    'empty', 'enemy', 'enjoy', 'enter', 'entry',
    'equal', 'error', 'essay', 'ethic', 'event',
    'every', 'exact', 'exile', 'exist', 'extra',
    'faint', 'faith', 'false', 'fancy', 'fatal',
    'fatty', 'fault', 'favor', 'feast', 'fiber',
    'field', 'fiery', 'fifth', 'fifty', 'fight',
    'final', 'first', 'fixed', 'flash', 'fleet',
    'flesh', 'float', 'flood', 'floor', 'flour',
    'fluid', 'flush', 'focus', 'foggy', 'force',
    'forge', 'forth', 'forty', 'forum', 'found',
    'frame', 'frank', 'fraud', 'fresh', 'fried',
    'front', 'fruit', 'fully', 'funny', 'giant',
    'given', 'glass', 'globe', 'glory', 'glove',
    'going', 'goods', 'grace', 'grade', 'grain',
    'grand', 'grant', 'grass', 'grave', 'great',
    'green', 'grief', 'gross', 'group', 'grove',
    'grown', 'guard', 'guess', 'guest', 'guide',
    'guilt', 'habit', 'happy', 'harsh', 'haven',
    'heavy', 'hello', 'hence', 'herbs', 'hinge',
    'hobby', 'honey', 'honor', 'hoped', 'horse',
    'hotel', 'hours', 'human', 'humor', 'hurry',
    'ideal', 'imply', 'inbox', 'inner', 'input',
    'inter', 'issue', 'items', 'ivory', 'jelly',
    'jewel', 'joint', 'jolly', 'judge', 'jumbo',
    'kayak', 'kebab', 'keeps', 'knock', 'known',
    'label', 'labor', 'large', 'later', 'laugh',
    'layer', 'learn', 'lease', 'least', 'leave',
    'legal', 'level', 'lever', 'light', 'likes',
    'limit', 'linen', 'liner', 'links', 'lions',
    'lists', 'liver', 'lives', 'lobby', 'local',
    'lodge', 'logic', 'looks', 'loose', 'lorry',
    'lotus', 'loved', 'lover', 'lower', 'loyal',
    'lucky', 'lunch', 'lymph', 'lyric', 'macro',
    'magic', 'major', 'maker', 'manor', 'maple',
    'march', 'marry', 'marsh', 'match', 'maybe',
    'mayor', 'means', 'meant', 'media', 'melon',
    'mercy', 'merge', 'merit', 'merry', 'metro',
    'micro', 'midst', 'might', 'minor', 'minus',
    'mixed', 'model', 'moist', 'money', 'month',
    'moral', 'motor', 'motto', 'mount', 'mouth',
    'moved', 'movie', 'muddy', 'music', 'naive',
    'naked', 'nasty', 'naval', 'needs', 'nerve',
    'never', 'newly', 'niece', 'ninth', 'noise',
    'north', 'notch', 'noted', 'novel', 'nurse',
    'occur', 'offer', 'often', 'olive', 'onion',
    'onset', 'opera', 'optic', 'order', 'organ',
    'other', 'ought', 'outer', 'owing', 'owner',
    'oxide', 'ozone', 'paint', 'panel', 'panic',
    'paper', 'party', 'pasta', 'paste', 'patch',
    'pause', 'peace', 'peach', 'penny', 'perch',
    'phase', 'phone', 'photo', 'piece', 'pilot',
    'pinch', 'pitch', 'pizza', 'place', 'plain',
    'plane', 'plant', 'plate', 'plaza', 'plead',
    'pluck', 'point', 'poise', 'polar', 'polio',
    'polls', 'pools', 'pound', 'power', 'press',
    'price', 'pride', 'prime', 'print', 'prior',
    'prize', 'probe', 'proof', 'proud', 'prove',
    'proxy', 'psalm', 'punch', 'pupil', 'puppy',
    'purse', 'quake', 'qualm', 'quill', 'query',
    'quick', 'quiet', 'quilt', 'quirk', 'quota',
    'quote', 'rabbi', 'racer', 'radio', 'rainy',
    'raise', 'rally', 'ranch', 'range', 'rapid',
    'ratio', 'rayon', 'reach', 'react', 'ready',
    'realm', 'rebel', 'refer', 'reign', 'relax',
    'relay', 'renal', 'renew', 'reply', 'reset',
    'rhino', 'rider', 'ridge', 'rifle', 'right',
    'rigid', 'risky', 'rival', 'roast', 'robot',
    'rocky', 'roman', 'rooms', 'roots', 'rough',
    'round', 'route', 'royal', 'rugby', 'ruins',
    'ruler', 'rural', 'sadly', 'saint', 'salad',
    'sales', 'sandy', 'sauce', 'saved', 'scale',
    'scare', 'scarf', 'scene', 'scent', 'scope',
    'score', 'scout', 'seize', 'sense', 'serve',
    'setup', 'seven', 'sewer', 'shade', 'shake',
    'shall', 'shame', 'shape', 'share', 'shark',
    'sharp', 'sheep', 'sheer', 'sheet', 'shelf',
    'shell', 'shift', 'shine', 'shirt', 'shock',
    'shoot', 'shore', 'short', 'shout', 'shown',
    'sight', 'sigma', 'silks', 'silly', 'since',
    'sixth', 'sixty', 'sized', 'skill', 'skull',
    'slave', 'sleep', 'slice', 'slide', 'slope',
    'small', 'smart', 'smell', 'smile', 'smoke',
    'snake', 'solid', 'solve', 'sorry', 'sound',
    'south', 'space', 'spare', 'spark', 'speak',
    'speed', 'spell', 'spend', 'spice', 'spine',
    'split', 'spoke', 'sport', 'spray', 'squad',
    'stack', 'staff', 'stage', 'stain', 'stair',
    'stake', 'stamp', 'stand', 'start', 'state',
    'steak', 'steam', 'steel', 'steep', 'steer',
    'stick', 'still', 'stock', 'stole', 'storm',
    'story', 'stove', 'strap', 'straw', 'strip',
    'stuck', 'study', 'stuff', 'style', 'sugar',
    'suite', 'sunny', 'super', 'surge', 'swamp',
    'swear', 'sweat', 'sweet', 'swept', 'swift',
    'swing', 'sword', 'teach', 'teeth', 'tempo',
    'tense', 'tenth', 'terms', 'thank', 'theft',
    'their', 'theme', 'there', 'these', 'thick',
    'thief', 'thing', 'think', 'third', 'those',
    'three', 'threw', 'throw', 'thumb', 'tiger',
    'tight', 'timer', 'tired', 'title', 'today',
    'token', 'topic', 'torch', 'total', 'touch',
    'tough', 'towel', 'tower', 'toxic', 'trace',
    'track', 'trade', 'trail', 'trait', 'trash',
    'treat', 'trend', 'trial', 'tribe', 'trick',
    'tried', 'troop', 'truck', 'truly', 'trunk',
    'trust', 'truth', 'tumor', 'tuner', 'twice',
    'twist', 'tying', 'under', 'union', 'unite',
    'until', 'upper', 'upset', 'urban', 'usage',
    'usual', 'valid', 'value', 'valve', 'vapor',
    'vault', 'venue', 'verse', 'video', 'villa',
    'vinyl', 'viral', 'virus', 'visit', 'vital',
    'vocal', 'vodka', 'vogue', 'voter', 'wagon',
    'waist', 'waste', 'watch', 'waved', 'waves',
    'weary', 'weigh', 'weird', 'wells', 'wheat',
    'wheel', 'where', 'which', 'while', 'white',
    'whole', 'whose', 'widow', 'width', 'wired',
    'witch', 'woman', 'woods', 'world', 'worry',
    'worse', 'worst', 'worth', 'would', 'wound',
    'wrist', 'write', 'wrong', 'wrote', 'yacht',
    'young', 'yours', 'yummy', 'zilch', 'zonal',
    // Additional 500 words
    'abase', 'abate', 'abbey', 'abbot', 'abhor',
    'abide', 'abler', 'abode', 'abort', 'ached',
    'abyss', 'acorn', 'acres', 'acted', 'adapt',
    'added', 'adept', 'admin', 'adore', 'adorn',
    'aegis', 'afoot', 'aging', 'agile', 'agony',
    'aided', 'aimed', 'aired', 'aisle', 'algae',
    'alibi', 'alien', 'align', 'allay', 'alley',
    'allot', 'alloy', 'aloft', 'alpha', 'altar',
    'amber', 'amble', 'amend', 'amiss', 'ample',
    'amuse', 'anime', 'ankle', 'annex', 'anvil',
    'aorta', 'apnea', 'arced', 'apply', 'aptly',
    'arbor', 'ardor', 'arose', 'aside', 'asked',
    'atone', 'attic', 'audio', 'audit', 'augur',
    'aunts', 'avian', 'avows', 'await', 'awake',
    'awful', 'axial', 'axiom', 'azure', 'babel',
    'baked', 'badly', 'bagel', 'balls', 'balmy',
    'bands', 'banjo', 'banks', 'baron', 'barge',
    'bases', 'basil', 'basis', 'baste', 'batty',
    'bayou', 'beads', 'beans', 'beast', 'beats',
    'beech', 'begot', 'begun', 'beige', 'bells',
    'belly', 'belts', 'berth', 'beset', 'bible',
    'bikes', 'bills', 'birch', 'birds', 'birth',
    'bliss', 'blitz', 'bloat', 'bloke', 'blond',
    'blood', 'blown', 'blues', 'bluff', 'blunt',
    'blurt', 'blush', 'bolts', 'bombs', 'bonds',
    'bones', 'books', 'booth', 'boots', 'bored',
    'borne', 'bosom', 'bossy', 'botch', 'bound',
    'bowed', 'bowel', 'boxer', 'brace', 'braid',
    'brake', 'brash', 'brass', 'bravo', 'brawl',
    'brawn', 'braze', 'bride', 'brine', 'brink',
    'brisk', 'broil', 'broke', 'brood', 'broom',
    'broth', 'brunt', 'budge', 'buggy', 'built',
    'bulge', 'bulky', 'bully', 'bumpy', 'bunny',
    'burns', 'burps', 'buses', 'buyer', 'bylaw',
    'cabal', 'cache', 'cadet', 'camel', 'cameo',
    'camps', 'canal', 'canny', 'canon', 'caper',
    'cards', 'cared', 'caret', 'carve', 'cases',
    'caste', 'caves', 'cedar', 'cells', 'cents',
    'chaos', 'chant', 'chaps', 'chart', 'chasm',
    'cheek', 'cheer', 'chefs', 'chick', 'chief',
    'chill', 'chimp', 'chips', 'choir', 'choke',
    'chord', 'chore', 'chose', 'cited', 'clamp',
    'clang', 'clank', 'claps', 'clasp', 'claws',
    'clone', 'clout', 'clown', 'clubs', 'clues',
    'clung', 'clunk', 'coals', 'coats', 'cocoa',
    'coded', 'coils', 'coins', 'comet', 'comic',
    'comma', 'conch', 'condo', 'cones', 'coral',
    'cords', 'corps', 'couch', 'cough', 'coupe',
    'cramp', 'crank', 'crass', 'crate', 'crave',
    'creak', 'crest', 'crews', 'cribs', 'cried',
    'cries', 'crops', 'cruet', 'crumb', 'cubic',
    'cuffs', 'curly', 'curry', 'curse', 'curvy',
    'cyber', 'darts', 'dated', 'dates', 'datum',
    'deals', 'debts', 'decal', 'decor', 'decoy',
    'decry', 'deeds', 'defer', 'deity', 'delay',
    'delve', 'demon', 'denim', 'derby', 'desks',
    'detox', 'deuce', 'devot', 'diary', 'digit',
    'diner', 'dingy', 'diode', 'dirge', 'dizzy',
    'dodge', 'doing', 'donor', 'donut', 'doses',
    'dowdy', 'downs', 'dowry', 'dozed', 'dozen',
    'drape', 'drawl', 'dread', 'drier', 'drift',
    'drone', 'drool', 'droop', 'drops', 'drove',
    'drums', 'dryer', 'dryly', 'ducal', 'ducks',
    'duels', 'duets', 'dummy', 'dumps', 'dunce',
    'dunes', 'dunks', 'dusky', 'dusty', 'dwarf',
    'dwell', 'eaten', 'eaves', 'ebbed', 'ebony',
    'edged', 'edges', 'edict', 'eerie', 'elbow',
    'elder', 'elfin', 'elate', 'elope', 'elude',
    'ember', 'embed', 'emcee', 'emoji', 'emote',
    'endow', 'enema', 'ended', 'envoy', 'epoch',
    'equip', 'erode', 'erupt', 'ether', 'evade',
    'evens', 'exalt', 'excel', 'exert', 'expat',
    'expel', 'exude', 'exult', 'fable', 'facet',
    'facts', 'faded', 'fails', 'fairy', 'falls',
    'famed', 'fangs', 'farce', 'farms', 'fated',
    'fatso', 'fauna', 'fears', 'feats', 'feeds',
    'feign', 'feint', 'fella', 'felon', 'femur',
    'fence', 'fends', 'ferry', 'fetch', 'fetid',
    'fetus', 'feuds', 'fever', 'fewer', 'films',
    'filth', 'finch', 'finds', 'finer', 'fires',
    'firms', 'flair', 'flake', 'flaky', 'flank',
    'flaps', 'flare', 'flask', 'flats', 'flaws',
    'fleas', 'fleck', 'flees', 'flick', 'flier',
    'fling', 'flint', 'flips', 'flirt', 'flock',
    'floss', 'flout', 'flows', 'fluff', 'fluke',
    'flung', 'flunk', 'flute', 'flyby', 'focal',
    'foamy', 'foils', 'folds', 'folks', 'folly',
    'fonts', 'foods', 'foray', 'forgo', 'forks',
    'forms', 'forte', 'forts', 'fosse', 'fount',
    'fouls', 'foxes', 'foyer', 'frail', 'franc',
    'frays', 'freed', 'freer', 'frees', 'friar',
    'frill', 'frisk', 'fritz', 'frizz', 'frogs',
    'froze', 'frump', 'fuels', 'fumed', 'funds',
    'fungi', 'funky', 'furor', 'furry', 'fused',
    'fussy', 'fusty', 'fuzzy', 'gains', 'gaits',
    'galas', 'gales', 'gamma', 'gamer', 'games',
    'gangs', 'gases', 'gates', 'gauge', 'gaunt',
    'gauze', 'gavel', 'gawky', 'gears', 'geese',
    'genes', 'genre', 'germs', 'gilts', 'gizmo',
    'gland', 'glare', 'gleam',
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
