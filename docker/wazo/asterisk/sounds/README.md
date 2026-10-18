# Annonces de la messagerie de la stack (étape 11a, ADR 0021)

L'image d'Asterisk de Wazo (`wazoplatform/asterisk`) n'a aucun fichier de son : sur une installation de Wazo, ses paquets de sons les apportent. Sans eux, `VoiceMail()` s'arrête sur la première annonce qui manque. La stack de développement et de CI monte donc ici, en `fr_FR`, les seules annonces qu'une boîte joue quand un correspondant laisse un message :

| Fichier | Texte |
|---|---|
| `vm-theperson.wav` | « Votre correspondant » |
| `digits/0.wav` à `digits/9.wav` | les chiffres du numéro de la boîte, « zéro » à « neuf » |
| `vm-isunavail.wav` | « n'est pas disponible. » (annonce « indisponible ») |
| `vm-isonphone.wav` | « est déjà en ligne. » (annonce « occupé ») |
| `vm-intro.wav` | « Laissez votre message après le bip, puis raccrochez. » |
| `beep.wav` | le bip : 1 kHz, 250 ms |
| `vm-msgsaved.wav`, `vm-goodbye.wav` | « Votre message est enregistré. », « Au revoir. » |

Faites par synthèse vocale : mespeak 2.0.2 (eSpeak, voix `fr`, vitesse 155, hauteur 45), puis ramenées au format d'Asterisk (WAV 8 kHz, 16 bits, mono : filtre passe-bas à 3,4 kHz, rééchantillonnage, silences des bords réduits à 80 ms) ; le bip est une sinusoïde à 1 kHz avec des rampes de 10 ms. Ce ne sont que des annonces de test : une plateforme utilise les sons de Wazo, ou les siens.
