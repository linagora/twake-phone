# ADR 0023 : La transcription des messages par LinTO STT et leur avis dans Twake Chat par un bot Matrix, faits par la passerelle qui écrit les boîtes

Date : 2026-10-18. État : proposée. Décidée à la PR de l'étape 11b, dans le fil de discussion du projet (ligne « 11. Wazo » du plan, sous-étape 11b de `stories/etape-11-wazo.md`) ; suit l'ADR 0022 ; remplacé par : aucun. L'historique des revues de cette décision est dans la PR, pas ici.

## Contexte

La démo de l'étape 11 du plan est « un appel en NPD tombe sur la messagerie, le message transcrit arrive dans Chat ». L'étape 11a (ADR 0022) met le message dans l'onglet « Messagerie vocale ». Il reste à le transcrire, à montrer le texte sous le message (ce qui lève la dérogation au critère 4.1 du RGAA notée jusque-là) et à prévenir la personne dans Twake Chat, qui est un client Matrix. Les règles de 11a s'appliquent aussi aux transcriptions et aux messages du bot : effacement RGPD et durée de conservation, vérification du titulaire, bail et barrière pour toute écriture, bornes sur la durée de l'audio et sur la file, ni audio ni texte dans les journaux.

## Décisions

### 1. LinTO STT, par son API HTTP

- `packages/transcription-linto` envoie l'enregistrement (WAV, tel que Wazo le donne) à `POST /transcribe` de LinTO STT (`file` en multipart, `Accept: application/json`) et lit `text`. Le moteur Kaldi encode sa réponse JSON deux fois, et les deux formes sont lues.
- Pas de `language` par défaut (`LINTO_LANGUAGE`) : le moteur Kaldi refuse ce paramètre, la langue est celle du modèle.
- Délai de 120 s par message (`LINTO_TIMEOUT_SEC`), pas de redirection suivie, réponse lue jusqu'à 1 Mo. Une adresse avec identifiants, requête ou fragment est refusée au démarrage. Le SDK des fournisseurs gagne `TranscriptionProvider` : un autre service se branche au même endroit.

### 2. La stack de développement et de CI

- Le vrai LinTO STT tourne dans la stack et en CI : l'image officielle de son moteur Kaldi, épinglée par empreinte, avec le plus petit modèle français (Vosk small fr 0.22, environ 41 Mo, Apache 2.0) ajouté à la construction (`docker/linto/Dockerfile`). Un message de quelques secondes est transcrit en une ou deux secondes, sans GPU.
- Un Synapse épinglé (`docker/synapse/homeserver.yaml`) sert de serveur Matrix : API client seulement, sur la boucle locale, sans fédération, en SQLite. L'e2e y crée le compte du bot et ceux des personnes par l'enregistrement à secret partagé. Ce secret n'existe que dans la stack.
- Le jeton du bot vient de l'environnement seulement (`MATRIX_BOT_TOKEN`), jamais du dépôt. En e2e, c'est celui que Synapse rend à l'enregistrement, et il n'est écrit nulle part.
- `docker/wazo/check-loopback.py` vérifie aussi LinTO STT et Synapse.

### 3. Une seule passerelle transcrit et prévient, sous le bail des boîtes

- Le `voicemail.created` d'un message est entendu par chaque passerelle. Seule celle qui tient le bail `voicemail:<tenant>` (ADR 0022) l'inscrit dans `voicemail_transcripts`, une ligne par message, avec le titulaire de la boîte (`HolderRecord`) et l'extension. Elle seule le transcrit, envoie l'avis et le retire.
- Chaque écriture de la table passe le bail et sa génération (`FencedLease`). La base la refuse dans la même requête si ce bail n'est plus tenu dans sa fenêtre d'écriture. La passerelle demande aussi `mayWrite` avant chaque appel à LinTO et à Matrix.
- Une passerelle qui prend le bail reprend ce qui reste dû (`dueTranscripts`) : transcription à faire, avis à envoyer ou à retirer. L'avis porte un identifiant de transaction tiré du message (`twakephone-n-…`). S'il est renvoyé par une autre passerelle, le serveur Matrix rend le même événement, sans doublon.
- Chaque passerelle prévient ses propres écrans quand une transcription est faite (`TranscriptWatcher`, qui lit les changements toutes les 2 s) : le bus d'événements ne dépasse pas le processus. L'événement ne va qu'au titulaire, vérifié à nouveau : un identifiant donné depuis à quelqu'un d'autre ne lui montre rien de l'ancien titulaire.

### 4. Les bornes

- Un message plus long que `VOICEMAIL_TRANSCRIBE_MAX_SEC` (par défaut `VOICEMAIL_MAX_SEC`, 180 s) n'est pas transcrit : son état est `none`, avec la raison `too-long`. L'enregistrement est lu jusqu'à la taille que cette durée permet, pas au-delà.
- Une organisation a au plus `VOICEMAIL_TRANSCRIBE_QUEUE_MAX` messages en attente (100). Au-delà, le message est gardé sans transcription (`busy`), son avis est envoyé quand même, et les administrateurs sont prévenus.
- Une transcription qui échoue est retentée deux fois (après 30 s, puis 2 min), puis passe à `none` avec la raison `failed` et une alerte. Un avis est retenté cinq fois (30 s, 2 min, 10 min, 1 h, 6 h, en respectant le délai que le serveur Matrix demande), puis abandonné avec une alerte. Chaque alerte (`transcription-busy`, `transcription-failed`, `notice-failed`, type `voicemail`) part au plus une fois par heure.
- Le texte gardé fait 10 000 caractères au plus, sans caractères de contrôle.

### 5. Ce que la personne voit

- `GET /voicemails` donne à chaque message sa transcription (`transcript`) : `pending`, `done` avec son texte (vide si rien n'a été reconnu), ou `none` avec sa raison. Un message laissé avant 11b, ou qu'aucune passerelle n'a entendu arriver, n'en a pas.
- Le `voicemail.created` d'un message nouveau porte déjà `pending`. Quand la transcription est faite, `voicemail.transcribed` part. `/capabilities` annonce `voicemailTranscription`.
- L'onglet « Messagerie vocale » affiche le texte sous le message. Le lecteur le désigne par `aria-describedby` : c'est l'alternative textuelle de l'enregistrement (critère 4.1 du RGAA, dont la dérogation tombe). La zone de statut annonce une fois que la transcription est arrivée. Un message sans transcription dit pourquoi.

### 6. Le bot dans Twake Chat

- Le bot est un compte Matrix ordinaire de l'organisation, sur son serveur. Il crée pour chaque personne une salle à lui : `private_chat`, `is_direct`, lui seul peut y inviter, l'historique est visible à partir de l'invitation, sans chiffrement. Il n'est pas nommé dans les niveaux de pouvoir : il est le créateur de la salle, et Synapse refuse de le nommer dans une salle de version 12, où un créateur est au-dessus d'eux. Il y envoie un `m.notice` en texte et en HTML : appelant (nom et numéro, ou « un numéro masqué »), date et heure (`NOTICE_TIME_ZONE`, Europe/Paris), durée, transcription ou raison de son absence, lien « Écouter dans TwakePhone » vers `APP_URL/voicemail`.
- La salle est gardée (`matrix:room:<id>` dans l'état de la passerelle) tant que la personne y est seule avec le bot, invitée ou présente. Si elle est partie, ou si quelqu'un d'autre y est entré, une nouvelle salle est créée.
- Une personne n'a d'avis que si son compte Matrix est sur le serveur du bot : un avis ne sort jamais du serveur de l'organisation.

### 7. Le compte Matrix de chacun

- C'est l'attribut d'annuaire `LDAP_ATTR_MATRIX` s'il est donné et renseigné. Sinon, c'est `MATRIX_USER_TEMPLATE` (`@{uid}:example.org`), avec l'identifiant d'annuaire en minuscules. Sans l'un ni l'autre, pas d'avis.

### 8. Effacement et conservation

- Un message supprimé (depuis l'app, un téléphone ou Wazo) emporte sa transcription, et l'avis est retiré par une rédaction Matrix. L'effacement d'une personne (`DELETE /me/history`, `POST /admin/voicemail/erase`) emporte toutes ses transcriptions, retire ses avis et oublie sa salle. La durée de conservation des messages (`VOICEMAIL_RETENTION_DAYS`) s'applique aussi aux transcriptions et aux avis.
- Le texte est effacé tout de suite. La ligne reste en `erased` seulement le temps de retirer l'avis. Si le bot ne peut plus le retirer (403 ou 404 : il a quitté la salle, l'événement n'existe plus), il y renonce et le note au journal.
- Une rédaction retire le contenu pour tous les membres. Le serveur Matrix garde l'original le temps de `redaction_retention_period` (7 jours par défaut chez Synapse, 5 minutes dans la stack) : un déploiement le règle court.

### 9. Les webhooks

- `voicemail.created` (appelant, heure, durée) et `voicemail.transcribed` (état et raison) sortent de la liste « plus tard » de l'ADR 0020. Ils ne portent jamais le texte ni l'enregistrement : le texte n'est lu que par son titulaire. Leur identifiant est commun à toutes les passerelles. L'effacement d'une personne retire aussi ses livraisons en attente (`subjectUser`).

### 10. Les journaux

- Ni audio, ni texte, ni identifiant Matrix d'une personne : les comptes, l'organisation, une empreinte quand c'est nécessaire, et les quelques mots de l'erreur (jamais un corps de réponse de LinTO ou du serveur Matrix). Le jeton du bot ne va que dans l'en-tête `Authorization`. Un test le vérifie en niveau `debug`.

## Conséquences

- La démo de l'étape 11 se joue de bout en bout en e2e, avec le vrai LinTO STT et un vrai Synapse.
- Un message laissé pendant qu'aucune passerelle ne tient le bail n'est pas transcrit. Il reste écoutable, sans texte.
- Le serveur Matrix de l'organisation garde l'historique de la salle. TwakePhone ne retire que ses propres avis, et seulement tant que le bot est dans la salle.
- Pas de chiffrement de bout en bout. Le bot n'est pas un appservice. L'activation par personne et l'annonce à l'appelant (FR-G4) viennent plus tard.

## Alternatives écartées

- Transcrire dans chaque passerelle qui entend l'événement : autant d'appels à LinTO que de passerelles, et des avis en double.
- Mettre le texte dans les webhooks : il sortirait de la plateforme vers un tiers, sans le titulaire.
- Un appservice Matrix (namespace d'utilisateurs, enregistrement sur le serveur) : plus de droits que ce qu'un avis demande, et une configuration côté serveur.
- Le mode tâche de LinTO (Celery et broker) : un broker de plus pour un message à la fois.
- Un faux LinTO en CI : le vrai tient dans le budget de temps d'un runner.
