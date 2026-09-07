'use strict';

// Test manuel (pas de framework) du module rapport-fr.js contre de vrais
// fichiers JSON generes localement (epubcheck --locale fr / ace -l fr sur
// un EPUB volontairement casse), plus un cas "propre" synthetique.
// Lancer : node test-rapport-fr.js

const fs = require('fs');
const { construireRapportFr } = require('./rapport-fr');

function assert(cond, msg) {
  if (!cond) {
    console.error('ECHEC:', msg);
    process.exitCode = 1;
  } else {
    console.log('OK:', msg);
  }
}

// --- Cas 1 : fichier casse (donnees reelles generees localement) ---
const epubcheckJson = JSON.parse(fs.readFileSync('/tmp/broken-epubcheck.json', 'utf8'));
const aceJson = JSON.parse(fs.readFileSync('/tmp/broken-ace-out/report.json', 'utf8'));

const rapportCasse = construireRapportFr(
  epubcheckJson,
  { exit_code: 0, timed_out: false },
  aceJson,
  { exit_code: 0, timed_out: false }
);

console.log('\n=== RAPPORT (fichier casse) ===');
console.log(JSON.stringify(rapportCasse, null, 2));

assert(rapportCasse.verdict === 'problemes_importants', `verdict attendu problemes_importants, obtenu ${rapportCasse.verdict}`);
assert(rapportCasse.compteurs.total >= 4, `au moins 4 problemes attendus (PKG-007, html-has-lang, image-alt, metadata-*), obtenu ${rapportCasse.compteurs.total}`);

const codes = rapportCasse.detail.map((d) => d.code);
assert(codes.includes('PKG-007'), 'PKG-007 (mimetype) present dans le detail');
assert(codes.includes('html-has-lang'), 'html-has-lang present dans le detail');
assert(codes.includes('image-alt'), 'image-alt present dans le detail');

const langueEntry = rapportCasse.detail.find((d) => d.code === 'html-has-lang');
assert(langueEntry && langueEntry.categorie === 'langue', `html-has-lang doit etre categorise "langue", obtenu ${langueEntry && langueEntry.categorie}`);
assert(langueEntry && langueEntry.auto_corrigeable === true, 'html-has-lang doit avoir un conseil auto_corrigeable=true');

const altEntry = rapportCasse.detail.find((d) => d.code === 'image-alt');
assert(altEntry && altEntry.categorie === 'images_alt', `image-alt doit etre categorise "images_alt", obtenu ${altEntry && altEntry.categorie}`);

const metaEntry = rapportCasse.detail.find((d) => d.code === 'metadata-accessibilityfeature');
assert(metaEntry && metaEntry.categorie === 'metadonnees', `metadata-accessibilityfeature doit etre categorise "metadonnees", obtenu ${metaEntry && metaEntry.categorie}`);

const pkgEntry = rapportCasse.detail.find((d) => d.code === 'PKG-007');
assert(pkgEntry && /application\/epub\+zip/.test(pkgEntry.message), 'le message PKG-007 est bien le message natif francais d\'EPUBCheck');

const catNoms = rapportCasse.categories.map((c) => c.cle);
assert(catNoms.includes('langue') && catNoms.includes('images_alt') && catNoms.includes('metadonnees'), `categories presentes: ${catNoms.join(', ')}`);

// --- Cas 2 : fichier propre (synthetique, comme le vrai run "La Marge") ---
const epubcheckPropre = { messages: [{ ID: 'RSC-004', severity: 'INFO', message: 'Police chiffree.', locations: [] }] };
const acePropre = {
  assertions: [
    { 'earl:result': { 'earl:outcome': 'pass' }, assertions: [], 'earl:testSubject': { url: 'cover.xhtml' } },
  ],
  'earl:result': { 'earl:outcome': 'pass' },
};
const rapportPropre = construireRapportFr(
  epubcheckPropre,
  { exit_code: 0, timed_out: false },
  acePropre,
  { exit_code: 0, timed_out: false }
);
console.log('\n=== RAPPORT (fichier propre) ===');
console.log(JSON.stringify(rapportPropre, null, 2));
assert(rapportPropre.verdict === 'conforme', `verdict attendu conforme, obtenu ${rapportPropre.verdict}`);
assert(rapportPropre.compteurs.total === 0, `0 probleme attendu (RSC-004 est INFO, filtre), obtenu ${rapportPropre.compteurs.total}`);
assert(rapportPropre.categories.length === 0, 'aucune categorie a afficher quand tout est propre');

// --- Cas 3 : fichier FATAL (Ace saute) ---
const epubcheckFatal = { messages: [{ ID: 'RSC-005', severity: 'FATAL', message: 'Erreur de parsing.', locations: [] }] };
const rapportFatal = construireRapportFr(
  epubcheckFatal,
  { exit_code: 1, timed_out: false },
  null,
  { skipped: true, reason: 'FICHIER_INVALIDE_EPUBCHECK_FATAL' }
);
console.log('\n=== RAPPORT (fichier FATAL) ===');
console.log(JSON.stringify(rapportFatal, null, 2));
assert(rapportFatal.verdict === 'invalide', `verdict attendu invalide, obtenu ${rapportFatal.verdict}`);
assert(rapportFatal.ace_indisponible === false, 'ace_indisponible doit rester false ici car le skip est volontaire (skipped:true), pas un echec');

console.log('\nTerminé.');
