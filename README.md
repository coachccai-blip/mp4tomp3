# Studio Audio — Conversion MP4 → MP3 & Nettoyage audio

Application web 100 % statique (GitHub Pages) regroupant deux outils, par lots de **30 fichiers maximum** :

- **🎬 MP4 → MP3** : convertit des vidéos MP4 en fichiers audio MP3.
- **🎙️ Nettoyage audio** : supprime le bruit de fond des enregistrements de voix (podcast, interview, voix off, cours…), ajuste le gain, normalise le niveau, permet d'écouter avant/après puis de télécharger.

Tout le traitement se fait **dans le navigateur** grâce à [ffmpeg.wasm](https://ffmpegwasm.netlify.app/) : aucun serveur, aucun envoi de fichier — vos fichiers ne quittent jamais votre machine (sauf mode ElevenLabs optionnel, voir plus bas).

## Utilisation

Ouvrez l'application (GitHub Pages, ou en local — voir « Développement local »), puis :

### Onglet MP4 → MP3

1. Glissez-déposez jusqu'à 30 fichiers `.mp4` / `.m4v` / `.mov`.
2. Choisissez la qualité, cliquez sur **« Convertir en MP3 »**.
3. Téléchargez chaque MP3, ou tout le lot en ZIP.

### Onglet Nettoyage audio

1. Glissez-déposez jusqu'à 30 fichiers audio (WAV, MP3, M4A/AAC, OGG, FLAC, WebM… les MP4 sont acceptés : seul l'audio est traité).
2. Réglez :
   - **Préréglage de débruitage** :
     - **Profil de bruit (méthode Audacity, par défaut)** : la forme d'onde s'affiche dès le dépôt du fichier, avec une zone de bruit détectée automatiquement (la fenêtre la plus silencieuse). Glissez sur la forme d'onde pour sélectionner vous-même une portion contenant *uniquement* du bruit ; ce profil spectral est ensuite soustrait à tout le fichier. Le curseur **Réduction de bruit (3–48 dB)** correspond au réglage « Noise reduction » d'Audacity.
     - Léger / Standard / Fort : débruitage FFT « à l'aveugle » (`afftdn` adaptatif), sans profil ;
     - **Isolation voix** (réseau de neurones RNNoise) ;
   - **Intensité** : mélange entre l'original (« dry ») et le signal traité (« wet »), pour éviter l'effet « voix robotique » à 100 % ;
   - **Gain** (−12 → +24 dB) ;
   - **Normalisation** : crête −1 dB, ou sonie −16 LUFS (podcast) / −14 LUFS (YouTube/Spotify), mesurée selon ITU-R BS.1770 (deux passes, filtre K-weighting via `loudnorm`) ;
   - **Format de sortie** : MP3, WAV 16 bits ou WAV 24 bits (fréquence d'échantillonnage et canaux d'origine conservés) ;
   - option **Couper le silence en début et fin**.
3. Cliquez sur **« Nettoyer les fichiers »** (annulable à tout moment). Un limiteur en fin de chaîne garantit l'absence d'écrêtage quel que soit le gain.
4. Écoutez le résultat avec le lecteur **A/B** (bascule instantanée Original ↔ Nettoyé, les deux pistes jouent en parallèle) et comparez les formes d'onde superposées.
5. Téléchargez chaque fichier, ou tout le lot en ZIP.

### Mode « qualité maximale » ElevenLabs (optionnel)

Dans l'onglet Nettoyage, un panneau optionnel permet d'utiliser l'API d'isolation vocale d'ElevenLabs (`POST /v1/audio-isolation`) avec **votre propre clé API**. ⚠️ Dans ce mode uniquement, les fichiers sont envoyés aux serveurs d'ElevenLabs ; la clé est stockée seulement dans le `localStorage` de votre navigateur. Si l'appel échoue (clé invalide, crédit épuisé, restriction CORS), un message clair l'explique et le moteur local reste disponible. Ce mode n'a pas pu être testé automatiquement (pas d'accès réseau dans l'environnement de développement).

## Chaîne de traitement (onglet Nettoyage)

```
décodage (ffmpeg) → débruitage (afftdn ou RNNoise à 48 kHz) → mélange dry/wet
→ gain → normalisation (2 passes : mesure puis application linéaire)
→ retour à la fréquence d'origine → limiteur (plafond −1 dB) → trim optionnel
→ encodage WAV 16/24 bits ou MP3
```

En mode « Profil de bruit », la zone sélectionnée est préfixée au fichier, mesurée par `afftdn` (commande `sample_noise`, l'équivalent FFmpeg du « Get noise profile » d'Audacity), appliquée à tout le fichier, puis le préfixe est coupé : la durée de sortie est identique à l'entrée.

Résultats mesurés sur les fichiers de test (vérifiés avec un ffmpeg natif indépendant) :

- profil de bruit, réduction 18 dB → plancher de bruit abaissé de **17,9 dB**, signal utile inchangé (±0,05 dB), durée préservée à l'échantillon près ;
- normalisation −16 LUFS → sortie mesurée à **−15,8 LUFS** (tolérance du cahier des charges : ±0,5) ;
- normalisation crête −1 dB → crête mesurée à **−1,0 dB**, aucun écrêtage ;
- préréglage Standard (aveugle) à 85 % d'intensité → plancher de bruit abaissé de ~6 dB.

## Moteurs et licences

| Composant | Rôle | Licence |
|---|---|---|
| [ffmpeg.wasm](https://github.com/ffmpegwasm/ffmpeg.wasm) (`@ffmpeg/ffmpeg`, `@ffmpeg/util`, `@ffmpeg/core` 0.12) | décodage, filtres (`afftdn`, `arnndn`, `loudnorm`, `alimiter`, `silenceremove`), encodage | MIT (wrapper) / LGPL 2.1+ (FFmpeg) |
| [RNNoise](https://jmvalin.ca/demo/rnnoise/) via le filtre FFmpeg `arnndn` | débruitage neuronal « Isolation voix » | BSD-3-Clause |
| Modèle `bd.rnnn` (« beguiling-drafter », [rnnoise-models](https://github.com/GregorR/rnnoise-models)) | poids du réseau, entraîné voix + bruit d'enregistrement | domaine public |
| [JSZip](https://stuk.github.io/jszip/) | téléchargement groupé en ZIP | MIT |

Toutes les bibliothèques sont embarquées dans `vendor/` : l'application est autonome, sans CDN, et **fonctionne hors-ligne après le premier chargement** (un service worker met les ressources — dont le moteur ffmpeg — en cache).

## Limites connues

- Le traitement est mono-thread WASM (GitHub Pages ne permet pas les en-têtes COOP/COEP nécessaires au multithread) : comptez environ la durée réelle du fichier ÷ 5 à ÷ 20 selon la machine, × 2 quand une normalisation est demandée (deux passes).
- Le moteur DeepFilterNet (meilleure qualité théorique) n'a pas de portage navigateur mûr et léger à ce jour ; RNNoise + `afftdn` ont été retenus (voir brief). Le mode ElevenLabs couvre le besoin « qualité maximale ».
- Les très gros fichiers (plusieurs heures / > 1 Go) peuvent dépasser la mémoire allouée au moteur WASM. En cas d'erreur, préférez la sortie MP3 (plus légère que le WAV) ou découpez le fichier.
- La lecture A/B « Original » dépend des formats que votre navigateur sait lire nativement (le FLAC ou l'OGG peuvent ne pas être lisibles sur Safari ; la version nettoyée reste toujours écoutable).

## Développement local

Aucune étape de build. Servez simplement le dossier :

```bash
python3 -m http.server 8000
# puis ouvrez http://localhost:8000
```

Les tests de bout en bout (Playwright + Chromium, conversion et nettoyage réels, mesures LUFS/crête/SNR vérifiées avec un ffmpeg natif) sont exécutés à chaque évolution.

## Déploiement

GitHub Pages, branche `main`, dossier racine (Settings → Pages). Aucune autre configuration : la page d'accueil est `index.html`, tous les assets sont relatifs.
