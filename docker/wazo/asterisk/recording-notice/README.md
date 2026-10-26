# Annonce de l'enregistrement de la stack (étape 11d, ADR 0029)

| Fichier | Texte |
|---|---|
| `twake-recording-notice.wav` | « Cet appel est enregistré. » |

Jouée aux deux parties d'un appel quand un superviseur lance son enregistrement (`RECORDING_NOTICE_SOUND`, par défaut `custom/twake-recording-notice` : le dossier `custom` des sons d'Asterisk, que la stack monte). Faite comme les annonces de la messagerie (`../sounds/README.md`) : synthèse vocale mespeak 2.0.2 (eSpeak, voix `fr`, vitesse 155, hauteur 45), puis WAV 8 kHz, 16 bits, mono (filtre passe-bas à 3,4 kHz, silences des bords réduits à 80 ms). Ce n'est qu'une annonce de test : une plateforme y met son propre texte, dans sa langue, et c'est ce texte qui informe les parties.
