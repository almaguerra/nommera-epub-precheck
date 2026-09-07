'use strict';

// Nommera -- traduction du JSON brut EPUBCheck+Ace en rapport lisible en
// francais (Etape 2). Module pur (pas d'I/O, pas de dependance a Express)
// pour rester facile a tester isolement -- voir test-rapport-fr.js a cote.
//
// Principe general : on ne reecrit PAS les messages d'EPUBCheck/Ace nous-
// memes. Les deux outils savent deja produire des messages en francais
// nativement si on le leur demande (voir server.js : "--locale fr" pour
// EPUBCheck, "-l fr" pour Ace) -- verifie en lisant leurs bundles de
// traduction officiels (com/adobe/epubcheck/messages/MessageBundle_fr.properties
// et @daisy/axe-core-for-ace/locales/fr.json) et en testant sur un vrai
// fichier EPUB volontairement casse. Le travail de ce module est donc
// seulement : classer chaque probleme dans une categorie metier
// comprehensible, en deduire une gravite et un verdict global, separer
// synthese (gratuit) et detail (payant), et ajouter une recommandation
// courte + un indicateur "auto-corrigeable" pour les codes les plus
// frequents qu'on a deja rencontres (liste volontairement partielle, pas
// une pretention a couvrir les ~600 codes EPUBCheck + 106 regles Ace).

const CATEGORIES = {
  structure: 'Structure et balisage',
  metadonnees: 'Métadonnées',
  images_alt: 'Images et texte alternatif',
  navigation: 'Navigation (table des matières, epub:nav)',
  langue: 'Langue',
  ordre_lecture: 'Ordre de lecture',
  // Categorie ajoutee en plus des 6 du cahier des charges : les regles
  // d'accessibilite couvrent aussi des sujets que ni les 6 buckets metier
  // ne decrivent bien (couleur/contraste, ARIA generique, formulaires --
  // rares dans un livre mais existent) ni les erreurs purement internes
  // au checker (fichier de config invalide, etc). Mieux vaut un septieme
  // panier honnete que de forcer une mauvaise categorie.
  technique: 'Autres points techniques',
};

// --- EPUBCheck : categorie par defaut selon le prefixe du code, avec
// quelques exceptions codees en dur la ou le prefixe seul induirait en
// erreur (ex: la plupart des codes OPF sont des metadonnees, mais ceux
// qui parlent du spine/de l'ordre de lecture n'en sont pas).
// Source : sections du fichier officiel
// com/adobe/epubcheck/messages/MessageBundle.properties (prefixe = section).
const EPUBCHECK_PREFIX_CATEGORIE = {
  ACC: 'structure', // affine au cas par cas ci-dessous
  CSS: 'structure',
  HTM: 'structure',
  MED: 'structure',
  NAV: 'navigation', // NAV-011 (ordre de lecture) est une exception ci-dessous
  NCX: 'navigation',
  OPF: 'metadonnees', // les codes spine/reading-order sont une exception ci-dessous
  PKG: 'metadonnees',
  RSC: 'structure',
  INF: 'technique',
  CHK: 'technique',
};

// Exceptions au mapping par prefixe -- verifiees une par une dans le
// texte des messages officiels d'EPUBCheck, pas devinees.
const EPUBCHECK_CODE_CATEGORIE = {
  'ACC-009': 'images_alt', // MathML doit avoir un alttext (texte alternatif)
  'ACC-011': 'images_alt', // lien SVG sans nom accessible (equivalent d'un alt)
  'NAV-011': 'ordre_lecture', // "nav doit etre en ordre de lecture"
  'OPF-033': 'ordre_lecture', // spine sans ressource lineaire
  'OPF-034': 'structure',
  'OPF-036': 'ordre_lecture',
  'OPF-042': 'ordre_lecture',
  'OPF-043': 'ordre_lecture',
  'OPF-044': 'ordre_lecture',
  'OPF-062': 'ordre_lecture',
  'OPF-077': 'ordre_lecture',
  'OPF-092': 'langue', // tag de langue mal forme
  'OPF-096': 'ordre_lecture',
  'OPF-096B': 'ordre_lecture',
};

// --- Ace/axe-core : categorie deduite a partir des "rulesetTags" presents
// DIRECTEMENT dans chaque assertion du rapport (verifie sur un vrai
// rapport genere localement) -- pas besoin d'une table figee par regle,
// les tags axe-core (cat.text-alternatives, cat.language, ...) suffisent.
// "EPUB" (sans cat.*) marque les verifications de metadonnees propres a
// Ace (accessMode, accessibilityFeature, etc.).
const ACE_TAG_CATEGORIE = [
  ['cat.text-alternatives', 'images_alt'],
  ['cat.language', 'langue'],
  ['cat.epub', 'navigation'],
  ['cat.keyboard', 'navigation'],
  ['cat.tables', 'structure'],
  ['cat.structure', 'structure'],
  ['cat.aria', 'structure'],
  ['cat.name-role-value', 'structure'],
  ['cat.semantics', 'structure'],
  ['cat.parsing', 'structure'],
  ['cat.forms', 'structure'],
  ['cat.color', 'structure'],
  ['cat.time-and-media', 'structure'],
  ['cat.sensory-and-visual-cues', 'structure'],
  ['EPUB', 'metadonnees'],
];

function categorieEpubcheck(code) {
  const c = (code || '').toUpperCase();
  if (EPUBCHECK_CODE_CATEGORIE[c]) return EPUBCHECK_CODE_CATEGORIE[c];
  const prefix = c.split('-')[0];
  return EPUBCHECK_PREFIX_CATEGORIE[prefix] || 'technique';
}

function categorieAce(rulesetTags) {
  const tags = Array.isArray(rulesetTags) ? rulesetTags : [];
  for (const [tag, cat] of ACE_TAG_CATEGORIE) {
    if (tags.includes(tag)) return cat;
  }
  return 'technique';
}

// --- Gravite : on garde la gravite native de chaque outil (elle pilote
// deja le verdict de l'outil lui-meme), juste traduite en un intitule
// francais commun aux deux sources pour l'affichage.
// "fatale" reste reservee a EPUBCheck (fichier illisible par les
// liseuses) -- un probleme d'accessibilite Ace, meme le plus grave
// ("critical" chez axe-core), n'empeche pas la lecture du livre, donc on
// lui donne un mot different ("critique") pour ne pas laisser croire que
// le fichier lui-meme est casse.
const GRAVITE_ORDRE = ['fatale', 'critique', 'erreur', 'avertissement', 'info'];

function graviteEpubcheck(severity) {
  switch ((severity || '').toUpperCase()) {
    case 'FATAL': return 'fatale';
    case 'ERROR': return 'erreur';
    case 'WARNING': return 'avertissement';
    case 'USAGE':
    case 'INFO':
    default: return 'info';
  }
}

function graviteAce(impact) {
  switch ((impact || '').toLowerCase()) {
    case 'critical': return 'critique';
    case 'serious': return 'erreur';
    case 'moderate': return 'avertissement';
    case 'minor':
    default: return 'info';
  }
}

// --- Recommandations courtes + indicateur "auto-corrigeable", pour les
// codes les plus frequents deja rencontres en pratique sur ce projet.
// Liste VOLONTAIREMENT PARTIELLE et honnete : pour un code absent d'ici,
// le rapport garde quand meme le message natif (deja en francais) de
// l'outil, juste sans conseil ni indicateur -- mieux vaut ca qu'inventer
// un conseil dont on n'est pas sur. A completer au fil des vrais rapports.
const CONSEILS = {
  // EPUBCheck
  'RSC-004': { autoCorrigeable: false, conseil: 'Police protegee par DRM : normal et attendu, aucune action requise.' },
  'PKG-007': { autoCorrigeable: true, conseil: 'Le fichier "mimetype" doit contenir exactement "application/epub+zip", sans espace ni retour a la ligne, et etre stocke sans compression (methode "store") en tout premier fichier de l\'archive -- verifier l\'outil utilise pour empaqueter l\'EPUB.' },
  'OPF-085': { autoCorrigeable: true, conseil: 'Utiliser un UUID valide (format standard 8-4-4-4-12) pour l\'identifiant, ou un autre schema reconnu (ISBN, DOI).' },
  'ACC-004': { autoCorrigeable: true, conseil: 'Ajouter un texte visible ou un attribut "title"/"aria-label" au lien.' },
  'ACC-005': { autoCorrigeable: true, conseil: 'Utiliser des elements "th" pour les cellules d\'en-tete de tableau.' },
  'ACC-006': { autoCorrigeable: true, conseil: 'Ajouter un element "thead" au tableau.' },
  'ACC-007': { autoCorrigeable: false, conseil: 'Ajouter des attributs "epub:type" pour marquer semantiquement le contenu (titres, notes, etc.).' },
  'ACC-009': { autoCorrigeable: true, conseil: 'Ajouter un attribut "alttext" ou un element "annotation-xml" a la formule MathML.' },
  'ACC-011': { autoCorrigeable: true, conseil: 'Ajouter un texte accessible (attribut "aria-label" ou element "title") au lien SVG.' },
  'ACC-012': { autoCorrigeable: true, conseil: 'Ajouter un element "caption" decrivant le tableau.' },
  'NAV-011': { autoCorrigeable: false, conseil: 'Reordonner les liens de la table des matieres pour qu\'ils suivent le meme ordre que le spine.' },
  'OPF-092': { autoCorrigeable: true, conseil: 'Corriger le code de langue pour qu\'il respecte le format BCP 47 (ex. "fr", "fr-FR").' },

  // Ace / axe-core (dct:title des regles)
  'html-has-lang': { autoCorrigeable: true, conseil: 'Ajouter un attribut "lang" (ex. lang="fr") a l\'element <html> de chaque document.' },
  'html-lang-valid': { autoCorrigeable: true, conseil: 'Utiliser un code de langue valide (format BCP 47) dans l\'attribut "lang".' },
  'image-alt': { autoCorrigeable: false, conseil: 'Ajouter un attribut "alt" decrivant chaque image porteuse de sens (ou alt="" si l\'image est purement decorative).' },
  'epub-type-has-matching-role': { autoCorrigeable: true, conseil: 'Ajouter un role ARIA correspondant a chaque attribut "epub:type" utilise.' },
  'metadata-accessibilityfeature': { autoCorrigeable: true, conseil: 'Declarer la metadonnee "schema:accessibilityFeature" dans le fichier OPF (ex. "readingOrder", "structuralNavigation").' },
  'metadata-accessibilityhazard': { autoCorrigeable: true, conseil: 'Declarer la metadonnee "schema:accessibilityHazard" (ex. "none" si le livre n\'a ni flash, ni son, ni mouvement).' },
  'metadata-accessibilitysummary': { autoCorrigeable: false, conseil: 'Ajouter un court resume en langage naturel de l\'accessibilite du livre ("schema:accessibilitySummary").' },
  'metadata-accessmode': { autoCorrigeable: true, conseil: 'Declarer la metadonnee "schema:accessMode" (ex. "textual").' },
  'metadata-accessmodesufficient': { autoCorrigeable: true, conseil: 'Declarer la metadonnee "schema:accessModeSufficient".' },
};

function conseilPour(code) {
  return CONSEILS[code] || null;
}

/** Aplatit l'arbre d'assertions EARL d'Ace en une liste de violations. */
function aplatirAssertionsAce(assertions, fichier, out) {
  for (const a of assertions || []) {
    const isViolation = a && a['earl:result'] && a['earl:result']['earl:outcome'] === 'fail';
    const test = a && a['earl:test'];
    if (isViolation && test) {
      out.push({
        source: 'ace',
        code: test['dct:title'] || 'inconnu',
        gravite: graviteAce(test['earl:impact']),
        categorie: categorieAce(test.rulesetTags),
        message: (a['earl:result'] && a['earl:result']['dct:description'])
          || test['dct:description']
          || (test.help && test.help['dct:description'])
          || 'Probleme d\'accessibilite detecte.',
        fichier: fichier || null,
      });
    }
    if (Array.isArray(a && a.assertions) && a.assertions.length) {
      // Les assertions imbriquees d'un meme sujet restent sur le meme
      // fichier ; on ne redescend pas de niveau de fichier ici.
      aplatirAssertionsAce(a.assertions, fichier, out);
    }
  }
}

function extraireProblemesAce(aceJson) {
  const out = [];
  if (!aceJson || !Array.isArray(aceJson.assertions)) return out;
  for (const sujet of aceJson.assertions) {
    const url = sujet && sujet['earl:testSubject'] && sujet['earl:testSubject'].url;
    aplatirAssertionsAce(sujet.assertions, url, out);
  }
  return out;
}

function extraireProblemesEpubcheck(epubcheckJson) {
  const out = [];
  if (!epubcheckJson || !Array.isArray(epubcheckJson.messages)) return out;
  for (const m of epubcheckJson.messages) {
    // INFO n'est pas un probleme a signaler dans le rapport lecteur (ex.
    // RSC-004 "police chiffree, normal") -- garde seulement en interne si
    // besoin de deboguer, jamais affiche comme "probleme".
    if ((m.severity || '').toUpperCase() === 'INFO') continue;
    const fichiers = Array.isArray(m.locations) && m.locations.length
      ? m.locations.map((l) => l.path).filter(Boolean)
      : [];
    out.push({
      source: 'epubcheck',
      code: m.ID,
      gravite: graviteEpubcheck(m.severity),
      categorie: categorieEpubcheck(m.ID),
      message: m.message,
      fichier: fichiers[0] || null,
      fichiers_supplementaires: fichiers.length > 1 ? fichiers.slice(1) : undefined,
    });
  }
  return out;
}

function pireGravite(problemes) {
  let pire = null;
  for (const p of problemes) {
    if (pire === null || GRAVITE_ORDRE.indexOf(p.gravite) < GRAVITE_ORDRE.indexOf(pire)) {
      pire = p.gravite;
    }
  }
  return pire;
}

function calculerVerdict(problemes, epubcheckMeta) {
  if (epubcheckMeta && epubcheckMeta.invalide) {
    return 'invalide';
  }
  const pire = pireGravite(problemes);
  if (pire === 'fatale' || pire === 'critique' || pire === 'erreur') return 'problemes_importants';
  if (pire === 'avertissement') return 'ameliorations_recommandees';
  return 'conforme';
}

const SYNTHESES = {
  invalide: (n) => `Ce fichier EPUB n'a pas pu être analysé correctement : il contient au moins une erreur bloquante qui empêche sa lecture par les liseuses. Une correction est nécessaire avant toute publication.`,
  problemes_importants: (n) => `${n} problème${n > 1 ? 's' : ''} important${n > 1 ? 's' : ''} ${n > 1 ? 'ont' : 'a'} été détecté${n > 1 ? 's' : ''}, susceptible${n > 1 ? 's' : ''} de gêner la lecture pour certain·es lecteur·rices (notamment en situation de handicap). Le rapport détaillé liste chaque point et indique comment le corriger.`,
  ameliorations_recommandees: (n) => `Aucun problème bloquant, mais ${n} point${n > 1 ? 's' : ''} d'amélioration ${n > 1 ? 'ont' : 'a'} été identifié${n > 1 ? 's' : ''} pour renforcer l'accessibilité du livre.`,
  conforme: () => `Aucun problème détecté par les vérifications automatiques. C'est une bonne base, mais un contrôle automatique ne couvre qu'une partie des critères d'accessibilité réels (l'estimation généralement admise est environ la moitié) -- une vérification humaine reste recommandée pour une certification complète.`,
};

const AVERTISSEMENT_FIABILITE = 'Ce rapport automatique ne remplace pas un audit humain : il détecte une partie des problèmes d\'accessibilité (grossièrement la moitié, selon DAISY), pas la totalité.';

/**
 * Construit le rapport francais complet a partir des resultats bruts.
 * @param {object|null} epubcheckJson - epubcheckJson tel que renvoye par EPUBCheck --json.
 * @param {object} epubcheckMeta - { exit_code, timed_out }.
 * @param {object|null} aceJson - aceJson tel que renvoye par Ace (report.json), ou null si saute/echoue.
 * @param {object} aceMeta - { exit_code, timed_out } ou { skipped, reason }.
 */
function construireRapportFr(epubcheckJson, epubcheckMeta, aceJson, aceMeta) {
  const invalideEpubcheck = !!(
    epubcheckJson
    && Array.isArray(epubcheckJson.messages)
    && epubcheckJson.messages.some((m) => (m.severity || '').toUpperCase() === 'FATAL')
  );

  const problemesEpubcheck = extraireProblemesEpubcheck(epubcheckJson);
  const problemesAce = extraireProblemesAce(aceJson);
  const acheIndisponible = !aceJson && !(aceMeta && aceMeta.skipped);
  const problemes = [...problemesEpubcheck, ...problemesAce];

  const verdict = calculerVerdict(problemes, { invalide: invalideEpubcheck });
  const nProblemes = problemes.length;

  // Regroupement par categorie pour la synthese (niveau gratuit) : compte
  // et pire gravite par categorie, sans le detail des messages.
  const parCategorie = {};
  for (const cle of Object.keys(CATEGORIES)) {
    parCategorie[cle] = { cle, label: CATEGORIES[cle], nombre: 0, gravite_max: null };
  }
  for (const p of problemes) {
    const c = parCategorie[p.categorie] || parCategorie.technique;
    c.nombre += 1;
    if (c.gravite_max === null || GRAVITE_ORDRE.indexOf(p.gravite) < GRAVITE_ORDRE.indexOf(c.gravite_max)) {
      c.gravite_max = p.gravite;
    }
  }
  const categories = Object.values(parCategorie).filter((c) => c.nombre > 0);

  // Detail complet (niveau payant) : messages natifs deja en francais
  // (voir --locale fr / -l fr cote appel), enrichis d'un conseil/indicateur
  // auto-corrigeable quand on en a un pour ce code precis.
  const detail = problemes.map((p) => {
    const conseil = conseilPour(p.code);
    return {
      source: p.source,
      code: p.code,
      categorie: p.categorie,
      categorie_label: CATEGORIES[p.categorie] || CATEGORIES.technique,
      gravite: p.gravite,
      message: p.message,
      fichier: p.fichier,
      auto_corrigeable: conseil ? conseil.autoCorrigeable : null,
      recommandation: conseil ? conseil.conseil : null,
    };
  });

  return {
    verdict, // 'invalide' | 'problemes_importants' | 'ameliorations_recommandees' | 'conforme'
    synthese: SYNTHESES[verdict](nProblemes),
    avertissement_fiabilite: AVERTISSEMENT_FIABILITE,
    compteurs: {
      total: nProblemes,
      par_gravite: GRAVITE_ORDRE.reduce((acc, g) => {
        acc[g] = problemes.filter((p) => p.gravite === g).length;
        return acc;
      }, {}),
    },
    categories, // niveau gratuit : compte + gravite par categorie, sans detail
    detail, // niveau payant : liste complete avec messages + conseils
    ace_indisponible: acheIndisponible, // signale au site que l'axe accessibilite n'a pas pu tourner (ex. FATAL EPUBCheck -> Ace saute)
  };
}

module.exports = {
  construireRapportFr,
  CATEGORIES,
  // exporte pour les tests
  categorieEpubcheck,
  categorieAce,
  graviteEpubcheck,
  graviteAce,
};
