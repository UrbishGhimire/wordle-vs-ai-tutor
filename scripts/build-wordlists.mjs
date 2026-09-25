#!/usr/bin/env node
/**
 * scripts/build-wordlists.mjs
 *
 * Regenerates words/valid-guesses.txt and words/answers.txt deterministically
 * from:
 *   1. words_alpha.txt  (dwyl/english-words, openly licensed dictionary;
 *                        download: https://raw.githubusercontent.com/dwyl/english-words/master/words_alpha.txt)
 *   2. scripts/wordfreq-ranks.json (frequency ranks for 5-letter words, from
 *      wordfreq 3.1.1 — data CC BY-SA 4.0, derived from Google Books Ngrams;
 *      used ONLY to rank commonness at build time, not redistributed as data)
 *   3. The hand-curated MANUAL_* lists below (proper nouns, profanity,
 *      contractions, archaic/foreign words, past-tense and plural forms
 *      removed after full manual review; see TESTING-NOTES.md).
 *
 * Usage: node scripts/build-wordlists.mjs [path/to/words_alpha.txt]
 *        (defaults to ./words_alpha.txt in the project root)
 *
 * Output: words/valid-guesses.txt — every 5-letter words_alpha entry
 *                               (~15.9k; the PRD estimated 9–11k, but the
 *                               actual dictionary yields 15,921 — a
 *                               permissive guess list is strictly better
 *                               gameplay, so we ship the full slice)
 *         words/answers.txt — ~2,204 common, guessable answers
 *
 * The script prints both sizes. It is fully deterministic: same inputs =>
 * byte-identical outputs.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

// Manual curation lists (hand-reviewed; see TESTING-NOTES.md for method).

const MANUAL_DROP = [
    'aaron', 'abbie', 'abner', 'abram', 'accra', 'acton', 'addie', 'addis', 'adobe', 'adolf', 'aggie', 'agnes',
    'ahmed', 'ahmet', 'aimee', 'akron', 'alain', 'alamo', 'alban', 'alden', 'alice', 'allah', 'allan', 'allen',
    'allie', 'alvin', 'amiga', 'amish', 'amman', 'andes', 'andre', 'angie', 'angus', 'anion', 'anita', 'annie',
    'ansar', 'ansel', 'anton', 'anzac', 'april', 'arent', 'argos', 'argus', 'arian', 'arias', 'ariel', 'aries',
    'arjun', 'artie', 'aryan', 'asher', 'asian', 'assam', 'astor', 'avant', 'avery', 'aztec', 'babel', 'bafta',
    'bally', 'banda', 'banff', 'bantu', 'barbs', 'barra', 'barry', 'barth', 'basal', 'becky', 'bella', 'belle',
    'bello', 'benin', 'benny', 'berne', 'betsy', 'betty', 'bible', 'bilbo', 'billy', 'bitch', 'blair', 'blake',
    'blanc', 'bobby', 'boise', 'bonne', 'boone', 'bosch', 'bowie', 'boyce', 'boyer', 'brant', 'brees', 'brent',
    'brest', 'brett', 'brian', 'britt', 'brock', 'bronx', 'brook', 'bruce', 'bruno', 'bryan', 'bryce', 'bubba',
    'bucky', 'buffy', 'buick', 'bundy', 'burgh', 'burke', 'burma', 'busby', 'byron', 'cabot', 'cairo', 'cajun',
    'caleb', 'calif', 'campo', 'camus', 'capri', 'carey', 'carlo', 'carne', 'carol', 'casas', 'casey', 'cathy',
    'cecil', 'celia', 'celts', 'ceres', 'cesar', 'chaka', 'chang', 'chara', 'cheng', 'chevy', 'chiba', 'chico',
    'chien', 'chile', 'china', 'ching', 'chloe', 'chris', 'chubb', 'chung', 'cindy', 'cisco', 'clair', 'clara',
    'clare', 'clark', 'claus', 'cline', 'clint', 'clive', 'clyde', 'cohen', 'coker', 'coles', 'colin', 'comme',
    'congo', 'conor', 'const', 'conte', 'corby', 'corey', 'corso', 'cosmo', 'costa', 'cotta', 'covid', 'cowan',
    'craig', 'crete', 'crewe', 'criss', 'crore', 'cupid', 'cuppa', 'curie', 'cyrus', 'czech', 'dalai', 'dales',
    'damon', 'danes', 'danny', 'dante', 'darby', 'darcy', 'darin', 'daryl', 'david', 'davis', 'degas', 'delft',
    'delhi', 'delia', 'della', 'denis', 'derek', 'derry', 'devel', 'devon', 'dewey', 'dhoni', 'diana', 'diane',
    'diddy', 'didnt', 'diego', 'dildo', 'dinah', 'dinka', 'dixie', 'doesn', 'dolly', 'dolph', 'donna', 'donne',
    'donny', 'dover', 'doyle', 'draco', 'drago', 'drury', 'duane', 'duffy', 'dumas', 'dunne', 'dunno', 'dutch',
    'dykes', 'dylan', 'earle', 'eddie', 'edgar', 'edith', 'edwin', 'effie', 'egypt', 'eliot', 'eliza', 'ellen',
    'elmer', 'elses', 'elvis', 'emery', 'emily', 'emmet', 'emory', 'ender', 'enoch', 'entre', 'epsom', 'erica',
    'erick', 'erika', 'ernie', 'ernst', 'erwin', 'essex', 'ethan', 'ethel', 'ewing', 'exxon', 'facto', 'falco',
    'fanny', 'faust', 'felix', 'fermi', 'fetal', 'fidel', 'firth', 'fitch', 'fleur', 'forex', 'forma', 'franz',
    'freud', 'freya', 'fritz', 'gabon', 'gaius', 'galen', 'ganga', 'garde', 'garth', 'gauss', 'geese', 'gemma',
    'genoa', 'geoff', 'ghana', 'ghazi', 'ghent', 'gimme', 'ginny', 'gipsy', 'givin', 'glenn', 'glynn', 'gonna',
    'gonzo', 'goran', 'goths', 'gotta', 'graff', 'greco', 'greek', 'gregg', 'greta', 'greys', 'griff', 'grimm',
    'groot', 'guido', 'gypsy', 'hades', 'hague', 'haiti', 'hakim', 'hales', 'hamza', 'hanks', 'hanna', 'hanoi',
    'haram', 'harry', 'hasan', 'hasnt', 'hausa', 'haydn', 'heath', 'heidi', 'heinz', 'helen', 'hells', 'henry',
    'heros', 'hilda', 'hindi', 'hindu', 'hiram', 'hirst', 'hodge', 'hogan', 'homer', 'homme', 'honda', 'horny',
    'horst', 'hough', 'howes', 'huron', 'hurst', 'hydra', 'idaho', 'imams', 'india', 'indra', 'indus', 'intel',
    'intra', 'iraqi', 'irene', 'irish', 'irvin', 'irwin', 'isaac', 'islam', 'italy', 'jacky', 'jacob', 'jaime',
    'jakob', 'james', 'jamie', 'janet', 'janus', 'japan', 'jason', 'jello', 'jenna', 'jenny', 'jerry', 'jesse',
    'jewry', 'jihad', 'jimbo', 'jimmy', 'johan', 'jonah', 'jonas', 'jones', 'jorge', 'joshi', 'josie', 'joyce',
    'judah', 'judas', 'julia', 'julie', 'julio', 'juris', 'kafka', 'karel', 'karen', 'kathy', 'katie', 'keats',
    'keita', 'keith', 'kelly', 'kemal', 'kenny', 'kenya', 'kerri', 'kerry', 'kevin', 'khmer', 'kirby', 'klaus',
    'kodak', 'koran', 'korea', 'kraft', 'krebs', 'kylie', 'kyoto', 'kyrie', 'kyung', 'laban', 'lacey', 'laine',
    'laker', 'larry', 'laude', 'laura', 'lazar', 'leary', 'leila', 'leith', 'lenin', 'lenny', 'leone', 'leung',
    'levin', 'lewis', 'liang', 'libby', 'liber', 'libra', 'libya', 'lilly', 'linda', 'linus', 'lipid', 'liszt',
    'lloyd', 'lobos', 'logan', 'lohan', 'lopes', 'loren', 'lotta', 'lotte', 'louie', 'louis', 'lowes', 'lowry',
    'lucan', 'lucia', 'luigi', 'lukas', 'lydia', 'lynch', 'lynne', 'mabel', 'macao', 'macon', 'madge', 'magna',
    'mahal', 'mahdi', 'maine', 'malay', 'malik', 'malta', 'mamie', 'mandi', 'manny', 'manus', 'maori', 'marco',
    'mardi', 'marek', 'marge', 'maria', 'marie', 'mario', 'maris', 'marko', 'marla', 'marty', 'masai', 'masha',
    'mason', 'massa', 'mater', 'matty', 'mavis', 'maxim', 'mayer', 'mazda', 'mccoy', 'mckay', 'mecca', 'medea',
    'meeks', 'meiji', 'merci', 'merle', 'miami', 'micah', 'micky', 'midas', 'mikey', 'milan', 'mille', 'milly',
    'milos', 'minas', 'mirza', 'missy', 'mitch', 'mitra', 'mobil', 'moira', 'molly', 'monde', 'monte', 'monty',
    'moore', 'moran', 'mores', 'morin', 'morse', 'mosul', 'myron', 'nagel', 'nance', 'nancy', 'naomi', 'natal',
    'negro', 'nehru', 'nelly', 'nepal', 'niall', 'nicht', 'nicky', 'nicol', 'niels', 'nigel', 'nikon', 'nixon',
    'nobel', 'noire', 'norah', 'norma', 'norse', 'notre', 'odell', 'ollie', 'olson', 'omaha', 'orion', 'orson',
    'osage', 'osaka', 'oscar', 'oskar', 'pablo', 'paddy', 'paine', 'palau', 'palma', 'paola', 'paolo', 'papua',
    'parma', 'parra', 'pasha', 'patel', 'paula', 'pease', 'pedro', 'peggy', 'penis', 'pepsi', 'percy', 'peres',
    'perry', 'peter', 'petro', 'pilar', 'plato', 'platt', 'pliny', 'pluto', 'polis', 'polly', 'ponce', 'porno',
    'porta', 'porte', 'porto', 'posey', 'potus', 'prado', 'pratt', 'prick', 'prius', 'puget', 'punta', 'purdy',
    'pussy', 'qatar', 'quito', 'rabin', 'rahul', 'rajiv', 'ralph', 'raman', 'rambo', 'ramon', 'randy', 'razer',
    'reals', 'reddy', 'reese', 'reeve', 'reich', 'reina', 'remus', 'renal', 'rhine', 'rhoda', 'ricks', 'roche',
    'rogan', 'roger', 'rohan', 'rolfe', 'rollo', 'roman', 'romeo', 'roper', 'rouen', 'rowan', 'rubin', 'rufus',
    'ryder', 'saban', 'sacra', 'sadie', 'sagan', 'saith', 'salem', 'salle', 'sally', 'salma', 'samir', 'sammy',
    'samoa', 'santa', 'santo', 'sarah', 'satan', 'saudi', 'sault', 'savoy', 'saxon', 'scala', 'scott', 'seine',
    'semen', 'senna', 'seoul', 'serra', 'seton', 'shalt', 'shane', 'shang', 'shari', 'shawn', 'sheng', 'shiva',
    'shona', 'siena', 'sikhs', 'silas', 'silva', 'simba', 'simon', 'singh', 'sioux', 'sitka', 'slade', 'slavs',
    'sloan', 'smith', 'smyth', 'snape', 'snell', 'sodom', 'sofia', 'solon', 'sonja', 'sonny', 'spain', 'speer',
    'spina', 'spock', 'squaw', 'stacy', 'stade', 'starr', 'steen', 'stein', 'steve', 'sudan', 'sunil', 'sunni',
    'surat', 'surya', 'susan', 'susie', 'sutra', 'swede', 'swiss', 'sybil', 'synod', 'syria', 'tabor', 'tajik',
    'takin', 'tamil', 'tammy', 'tampa', 'tandy', 'tania', 'tanya', 'tatar', 'teeth', 'tempe', 'terra', 'terre',
    'terri', 'terry', 'tesla', 'teton', 'texan', 'texas', 'thais', 'thats', 'thine', 'tibet', 'tilda', 'tilly',
    'timon', 'timor', 'titty', 'titus', 'tokyo', 'tommy', 'tonga', 'tonto', 'torah', 'tracy', 'trent', 'trina',
    'trois', 'trudy', 'trump', 'tudor', 'tulsa', 'tunis', 'twain', 'tyler', 'uzbek', 'vadim', 'vamos', 'vance',
    'vardy', 'varna', 'vedic', 'venus', 'verde', 'verdi', 'vichy', 'vicki', 'vicky', 'vidya', 'vijay', 'ville',
    'vince', 'vinci', 'vinny', 'virgo', 'volga', 'vying', 'wagga', 'walla', 'wally', 'walsh', 'waned', 'wanna',
    'wasnt', 'waugh', 'wayne', 'weber', 'welch', 'welsh', 'wendy', 'wests', 'whats', 'whigs', 'whore', 'wigan',
    'willi', 'willy', 'woolf', 'wynne', 'xerox', 'xviii', 'xxiii', 'yahoo', 'yanks', 'yemen', 'youre', 'youve',
    'yukon', 'zaire', 'zeiss', 'zorro',
];

const MANUAL_PAST = [
    'arose', 'awoke', 'baked', 'bared', 'began', 'begun', 'boned', 'booed', 'built', 'burnt', 'caged', 'caked',
    'caved', 'ceded', 'chose', 'clung', 'crept', 'cried', 'dazed', 'dealt', 'diced', 'dined', 'dived', 'domed',
    'doped', 'drank', 'drawn', 'dried', 'drove', 'drunk', 'duped', 'durst', 'dwelt', 'eared', 'eased', 'eaten',
    'edged', 'erred', 'faked', 'fared', 'fried', 'froze', 'fused', 'gated', 'gazed', 'glued', 'hiked', 'holed',
    'honed', 'inked', 'joked', 'keyed', 'knelt', 'leapt', 'liked', 'lured', 'mated', 'mired', 'moved', 'mused',
    'nosed', 'oiled', 'outed', 'pared', 'payed', 'piped', 'poked', 'raged', 'raked', 'razed', 'riled', 'risen',
    'roped', 'ruled', 'sawed', 'sewed', 'shone', 'shook', 'sired', 'sized', 'slept', 'slung', 'spent', 'spied',
    'spilt', 'stole', 'stung', 'swept', 'swore', 'sworn', 'tamed', 'threw', 'tiled', 'toyed', 'upped', 'urged',
    'vexed', 'waged', 'waxed', 'woken', 'woven', 'wrote', 'zoned',
];

const MANUAL_KEEP_S = [
    'press', 'grass', 'brass', 'chaos', 'alias', 'blues', 'gross', 'corps', 'jeans', 'pants', 'goods', 'vibes',
    'yikes', 'kudos',
];

const MANUAL_KEEP_ED = [
    'naked', 'greed', 'creed', 'shred', 'bored', 'wired',
];

const MANUAL_KEEP_ING = [
    'aging', 'being', 'bring', 'cling', 'doing', 'dying', 'fling', 'going', 'icing', 'lying', 'owing', 'sling',
    'sting', 'suing', 'swing', 'thing', 'tying', 'using',
];

const RANK_THRESHOLD = 45000;

const dropSet = new Set(MANUAL_DROP);
const pastSet = new Set(MANUAL_PAST);
const keepSet = new Set([...MANUAL_KEEP_S, ...MANUAL_KEEP_ED, ...MANUAL_KEEP_ING]);

function main() {
  const dictPath = process.argv[2] || path.join(ROOT, 'words_alpha.txt');
  if (!existsSync(dictPath)) {
    console.error(`Dictionary not found: ${dictPath}`);
    console.error('Download it first:');
    console.error('  curl -o words_alpha.txt https://raw.githubusercontent.com/dwyl/english-words/master/words_alpha.txt');
    process.exit(1);
  }

  const allWords = new Set(
    readFileSync(dictPath, 'utf8').split('\n').map((w) => w.trim().toLowerCase()).filter(Boolean)
  );
  const five = [...allWords].filter((w) => /^[a-z]{5}$/.test(w)).sort();

  const ranks = JSON.parse(readFileSync(path.join(ROOT, 'scripts', 'wordfreq-ranks.json'), 'utf8'));

  const isPluralS = (w) => w.endsWith('s') && allWords.has(w.slice(0, -1));
  const isPluralEs = (w) =>
    w.endsWith('es') && (allWords.has(w.slice(0, -2)) || allWords.has(w.slice(0, -1)));
  const isPluralIes = (w) => w.endsWith('ies') && allWords.has(w.slice(0, -3) + 'y');
  const isPastEd = (w) => w.endsWith('ed') && allWords.has(w.slice(0, -2));

  const answers = [];
  for (const w of five) {
    const rank = ranks[w];
    if (rank === undefined || rank >= RANK_THRESHOLD) continue;
    if (dropSet.has(w) || pastSet.has(w)) continue;
    if (keepSet.has(w)) {
      answers.push(w);
      continue;
    }
    if (isPluralS(w) || isPluralEs(w) || isPluralIes(w)) continue;
    if (isPastEd(w)) continue;
    answers.push(w);
  }
  answers.sort();

  mkdirSync(path.join(ROOT, 'words'), { recursive: true });
  writeFileSync(path.join(ROOT, 'words', 'valid-guesses.txt'), five.join('\n') + '\n');
  writeFileSync(path.join(ROOT, 'words', 'answers.txt'), answers.join('\n') + '\n');

  console.log(`valid guesses: ${five.length}`);
  console.log(`answers:       ${answers.length}`);
}

main();
