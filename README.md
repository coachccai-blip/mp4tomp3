# Convertisseur MP4 → MP3

Application web qui convertit des fichiers vidéo MP4 en fichiers audio MP3, par lots de **30 fichiers maximum**.

La conversion se fait **entièrement dans le navigateur** grâce à [ffmpeg.wasm](https://ffmpegwasm.netlify.app/) : aucun fichier n'est envoyé sur un serveur, tout reste sur votre machine.

## Utilisation

1. Ouvrez `index.html` dans votre navigateur (Chrome, Edge ou Firefox récent).
   - Recommandé : servez le fichier via un petit serveur local pour éviter les restrictions des navigateurs sur les fichiers ouverts directement :
     ```bash
     # avec Python
     python3 -m http.server 8000
     # puis ouvrez http://localhost:8000
     ```
   - Ou activez GitHub Pages sur ce dépôt (Settings → Pages → branche principale) pour y accéder depuis n'importe où.
2. Glissez-déposez vos fichiers MP4 (jusqu'à 30 à la fois), ou cliquez sur la zone pour les sélectionner.
3. Choisissez la qualité audio souhaitée (haute par défaut).
4. Cliquez sur **« Convertir en MP3 »**. Les fichiers sont convertis un par un, avec une barre de progression.
5. Téléchargez chaque MP3 individuellement, ou cliquez sur **« Tout télécharger (ZIP) »** pour récupérer tout le lot d'un coup.

## Notes

- L'application est **autonome** : le moteur ffmpeg (dossier `vendor/`) est inclus dans le dépôt, aucune connexion internet n'est nécessaire une fois le dépôt cloné.
- Les fichiers en erreur peuvent être relancés en recliquant sur « Convertir en MP3 ».
- Formats d'entrée acceptés : `.mp4`, `.m4v`, `.mov`.
- Pour de très gros fichiers (plusieurs Go), la conversion dans le navigateur peut être limitée par la mémoire disponible.
