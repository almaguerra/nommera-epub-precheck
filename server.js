'use strict';

// Nommera -- microservice de pre-controle EPUB (Etape 1)
// Un seul endpoint : recoit un EPUB, renvoie les resultats bruts
// d'EPUBCheck + Ace by DAISY en JSON. Rien n'est stocke : le fichier
// upload et les rapports intermediaires sont supprimes des la reponse
// envoyee (ou en cas d'erreur/timeout), voir cleanup() plus bas.
// Traduction en rapport lisible = Etape 2, pas ce fichier.

const express = require('express');
const multer = require('multer');
const { spawn } = require('child_process');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const PORT = process.env.PORT || 10000;
const API_KEY = process.env.API_KEY || '';

// Decision actee (voir memoire projet nommera_epub_precheck) : 50 Mo max.
const MAX_FILE_BYTES = 50 * 1024 * 1024;

// Marge sous les 180s deja valides sans coupure cote Render (voir le test
// de timeout) -- si un traitement depasse ca, quelque chose ne va pas et
// il vaut mieux echouer proprement que de laisser tourner indefiniment.
const CHILD_TIMEOUT_MS = 170 * 1000;

// Chemins a l'interieur de l'image Docker (voir Dockerfile). Overridables
// par variable d'environnement pour pouvoir tester en dehors du conteneur.
const EPUBCHECK_JAR = process.env.EPUBCHECK_JAR || '/opt/precheck/epubcheck/epubcheck.jar';
const ACE_BIN = process.env.ACE_BIN || '/opt/precheck/node_modules/.bin/ace';
const XVFB_RUN_BIN = process.env.XVFB_RUN_BIN || 'xvfb-run';

// IMPORTANT : ce dossier doit etre cree ICI, au demarrage du processus, et
// PAS dans le Dockerfile a la construction de l'image. Sur Render (et la
// plupart des plateformes conteneurs), /tmp est remonte comme un volume
// vide a chaque demarrage du conteneur -- tout ce qui a ete cree sous /tmp
// pendant le build (mkdir dans le Dockerfile) disparait au runtime. C'est
// exactement le bug rencontre au premier deploiement (ENOENT sur le
// dossier d'upload) : marche en local (dossier cree a la main avant de
// lancer node), casse en prod (dossier absent au demarrage reel).
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(os.tmpdir(), 'nommera-precheck-uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const app = express();
app.disable('x-powered-by');

const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOAD_DIR),
    // Nom de fichier aleatoire : le nom original choisi par la personne
    // qui upload n'est jamais ecrit sur disque ni journalise.
    filename: (req, file, cb) => cb(null, `${crypto.randomUUID()}.epub`),
  }),
  limits: { fileSize: MAX_FILE_BYTES, files: 1 },
  fileFilter: (req, file, cb) => {
    if (!/\.epub$/i.test(file.originalname || '')) {
      return cb(new Error('EXTENSION_NON_EPUB'));
    }
    cb(null, true);
  },
});

function requireApiKey(req, res, next) {
  if (!API_KEY) {
    // Pas de cle configuree cote service -> refuser par defaut plutot que
    // de tout accepter en silence.
    return res.status(500).json({
      error: 'SERVER_MISCONFIGURED',
      message: 'API_KEY non configuree sur le service.',
    });
  }
  if (req.get('X-API-Key') !== API_KEY) {
    return res.status(401).json({ error: 'UNAUTHORIZED' });
  }
  next();
}

/** Lance une commande, capture stdout/stderr, tue et signale un timeout. */
function runChild(cmd, args, { timeoutMs }) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);

    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ code: null, stdout, stderr: `${stderr}\n${err.message}`, timedOut });
    });
  });
}

async function readJsonSafe(filePath) {
  try {
    return JSON.parse(await fsp.readFile(filePath, 'utf8'));
  } catch (e) {
    return null;
  }
}

async function cleanup(paths) {
  await Promise.all(paths.map((p) => fsp.rm(p, { recursive: true, force: true }).catch(() => {})));
}

app.get('/health', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});

app.post('/check', requireApiKey, (req, res) => {
  upload.single('epub')(req, res, async (uploadErr) => {
    if (uploadErr) {
      if (uploadErr.code === 'LIMIT_FILE_SIZE') {
        return res.status(413).json({
          error: 'FICHIER_TROP_VOLUMINEUX',
          message: `Limite : ${MAX_FILE_BYTES / (1024 * 1024)} Mo.`,
        });
      }
      if (uploadErr.message === 'EXTENSION_NON_EPUB') {
        return res.status(415).json({
          error: 'EXTENSION_NON_EPUB',
          message: 'Le fichier doit avoir l\'extension .epub.',
        });
      }
      return res.status(400).json({ error: 'REQUETE_INVALIDE', message: uploadErr.message });
    }
    if (!req.file) {
      return res.status(400).json({
        error: 'AUCUN_FICHIER',
        message: 'Aucun fichier recu (champ multipart attendu : "epub").',
      });
    }

    const startedAt = Date.now();
    const epubPath = req.file.path;
    const aceWorkDir = path.join(os.tmpdir(), `ace-${crypto.randomUUID()}`);
    const epubcheckJsonPath = path.join(os.tmpdir(), `epubcheck-${crypto.randomUUID()}.json`);
    const cleanupPaths = [epubPath, aceWorkDir, epubcheckJsonPath];

    try {
      const epubcheckRun = await runChild(
        'java',
        ['-jar', EPUBCHECK_JAR, epubPath, '--json', epubcheckJsonPath],
        { timeoutMs: CHILD_TIMEOUT_MS }
      );
      const epubcheckJson = await readJsonSafe(epubcheckJsonPath);

      // Un fichier illisible/pas un EPUB du tout (FATAL chez EPUBCheck) ne
      // vaut pas la peine d'etre passe a Ace -- ca economise des ressources
      // et evite de faire planter Electron sur une entree n'importe quoi.
      const isFatallyInvalid = !!(
        epubcheckJson
        && Array.isArray(epubcheckJson.messages)
        && epubcheckJson.messages.some((m) => m.severity === 'FATAL')
      );

      let aceJson = null;
      let aceRun = null;
      let aceSkippedReason = null;

      if (isFatallyInvalid) {
        aceSkippedReason = 'FICHIER_INVALIDE_EPUBCHECK_FATAL';
      } else {
        aceRun = await runChild(
          XVFB_RUN_BIN,
          ['-a', ACE_BIN, '-o', aceWorkDir, '-f', epubPath],
          { timeoutMs: CHILD_TIMEOUT_MS }
        );
        aceJson = await readJsonSafe(path.join(aceWorkDir, 'report.json'));
        // Diagnostic (temporaire) : si Ace echoue, on veut voir pourquoi dans
        // les logs Render -- le JSON de reponse ne contient que le code de
        // sortie, pas le message d'erreur reel du process.
        if (aceRun.code !== 0 || !aceJson) {
          console.error(
            '[ace] echec -- exit_code=%s timed_out=%s\n--- stderr ---\n%s\n--- stdout ---\n%s',
            aceRun.code,
            aceRun.timedOut,
            aceRun.stderr,
            aceRun.stdout
          );
        }
      }

      return res.json({
        analyzed_at: new Date().toISOString(),
        duration_ms: Date.now() - startedAt,
        file_size_bytes: req.file.size,
        epubcheck: epubcheckJson,
        epubcheck_meta: {
          exit_code: epubcheckRun.code,
          timed_out: epubcheckRun.timedOut,
        },
        ace: aceJson,
        ace_meta: aceRun
          ? { exit_code: aceRun.code, timed_out: aceRun.timedOut }
          : { skipped: true, reason: aceSkippedReason },
      });
    } catch (e) {
      // Ne jamais renvoyer le detail interne (stack, chemins) au client.
      return res.status(500).json({
        error: 'ANALYSE_ECHOUEE',
        message: 'Erreur interne pendant l\'analyse.',
      });
    } finally {
      await cleanup(cleanupPaths);
    }
  });
});

// Filet de securite final -- ne doit normalement jamais se declencher.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  res.status(500).json({ error: 'ERREUR_INATTENDUE' });
});

app.listen(PORT, () => {
  console.log(`nommera-epub-precheck en ecoute sur le port ${PORT}`);
});
