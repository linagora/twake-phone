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
- Le modèle est vérifié par son SHA-256 avant d'être décompressé (`docker/linto/fetch-model.py`), pris dans `docker/linto/model-cache/` s'il y est (la CI le garde d'un run à l'autre), sinon téléchargé dans la même étape : l'archive n'est dans aucune couche de l'image. Son éditeur ne publie pas d'empreinte : celle du dépôt a été calculée au premier téléchargement (confiance au premier usage), et un modèle changé à la source arrête la construction.
- Un Synapse épinglé (`docker/synapse/homeserver.yaml`) sert de serveur Matrix : API client seulement, sur la boucle locale, sans fédération, en SQLite. L'e2e y crée le compte du bot et ceux des personnes par l'enregistrement à secret partagé. Ce secret n'existe que dans la stack.
- Le jeton du bot vient de l'environnement seulement (`MATRIX_BOT_TOKEN`), jamais du dépôt. En e2e, c'est celui que Synapse rend à l'enregistrement, et il n'est écrit nulle part.
- `docker/wazo/check-loopback.py` vérifie aussi LinTO STT et Synapse.

### 3. Une seule passerelle transcrit et prévient, sous le bail des boîtes

- Le `voicemail.created` d'un message est entendu par chaque passerelle. Seule celle qui tient le bail `voicemail:<tenant>` (ADR 0022) l'inscrit dans `voicemail_transcripts`, une ligne par message, avec le titulaire de la boîte (`HolderRecord`) et l'extension. Elle seule le transcrit, envoie l'avis et le retire.
- Chaque écriture de la table passe le bail et sa génération (`FencedLease`). La base la refuse dans la même requête si ce bail n'est plus tenu dans sa fenêtre d'écriture. La passerelle demande aussi `mayWrite` avant chaque appel à LinTO et à Matrix.
- Une passerelle qui prend le bail reprend ce qui reste dû (`dueTranscripts`) : transcription à faire, avis à envoyer ou à retirer. L'avis porte un identifiant de transaction tiré du message (`twakephone-n-…`) et, dans son contenu, l'empreinte du message (`org.twakephone.message`). Renvoyé par la même session, le serveur Matrix rend le même événement ; par une autre, l'avis déjà dans la salle est retrouvé par cette empreinte et n'est pas renvoyé.
- Les événements manqués (passerelle redémarrée, bail perdu puis repris, WebSocket de Wazo coupée) sont rattrapés : la passerelle qui tient le bail compare les messages de chaque boîte aux lignes de la table (réconciliation), à la prise du bail, à chaque reconnexion de la WebSocket de Wazo, toutes les 15 minutes, et quand un écran demande un message sans ligne (au plus une fois par minute). Un message des dernières 24 heures (au plus la durée de conservation) sans ligne en reçoit une ; quand la file est pleine, il attend la réconciliation suivante, sans être dit `busy`. Un message plus ancien sans ligne est dit `untracked`.
- Une ligne dont le message n'est plus dans sa boîte n'est jamais effacée sur une seule lecture : il faut deux réconciliations à au moins 10 minutes d'écart (`orphanConfirmMs`) qui ne le voient pas ; un message revu entre-temps repart de zéro. Un Wazo qui ne voit plus son spool (volume démonté) répond des boîtes vides sans erreur : rien n'est effacé, aucun avis retiré, et l'alerte `transcription-held` est levée, quand toutes les boîtes lues sont vides, quand une boîte qui avait deux lignes ou plus se lit vide, ou quand plus de la moitié des lignes lues (deux au moins) disparaissent d'un coup. Ces lignes attendent leur `voicemail.deleted` ou la durée de conservation. Les lignes sont gardées : le spool revenu, aucun message n'est réinscrit ni annoncé une deuxième fois.
- Une boîte illisible (une erreur de Wazo pour elle seule) est passée : les autres sont réconciliées, l'alerte de retard est quand même vérifiée, et l'alerte `transcription-unreadable` est levée après trois réconciliations de suite sans pouvoir la lire. Toutes illisibles, c'est Wazo hors d'atteinte : pas cette alerte. Dans les files, ses lignes sont passées le temps du tour ; trois boîtes illisibles dans un tour l'arrêtent.
- La reconnexion de la WebSocket de Wazo (`onHeard`) ne couvre que les coupures de cette WebSocket : un événement perdu plus loin (wazo-amid, RabbitMQ) ne la déclenche pas, et n'est rattrapé que par la réconciliation des 15 minutes. Une connexion à wazo-websocketd refusée avant de s'ouvrir est retentée comme une connexion fermée : le WebSocket de Node n'en dit qu'une erreur, sans fermeture (trouvé par l'e2e).
- Deux files par organisation : les transcriptions, et les avis (envoi et retrait). Un LinTO lent ou en panne ne retient ni les avis ni les retraits : un avis attend sa transcription au plus 10 minutes, puis part sans le texte (« pas encore prête, à lire dans TwakePhone »). Après trois échecs de LinTO de suite, la file des transcriptions s'arrête 1, puis 5, puis 15 minutes. Wazo hors d'atteinte suspend les deux files sans compter d'échec, ni de transcription ni d'avis. Une transcription ou un avis en attente depuis plus de 30 minutes lève l'alerte `transcription-backlog`.
- L'arrêt de la passerelle (`stop()`) interrompt les appels en cours à LinTO et au serveur Matrix.
- Chaque passerelle prévient ses propres écrans quand une transcription est faite (`TranscriptWatcher`, qui lit les changements toutes les 2 s) : le bus d'événements ne dépasse pas le processus. L'événement ne va qu'au titulaire, vérifié à nouveau : un identifiant donné depuis à quelqu'un d'autre ne lui montre rien de l'ancien titulaire.

### 4. Les bornes

- Un message plus long que `VOICEMAIL_TRANSCRIBE_MAX_SEC` (par défaut `VOICEMAIL_MAX_SEC`, 180 s, 10 s au moins) n'est pas transcrit : son état est `none`, avec la raison `too-long`. L'enregistrement est lu jusqu'à la taille que cette durée permet en 16 bits à 16 kHz, plus la moitié ; un enregistrement plus gros est aussi `too-long`.
- Une organisation a au plus `VOICEMAIL_TRANSCRIBE_QUEUE_MAX` messages en attente (100). Au-delà, le message est gardé sans transcription (`busy`), son avis est envoyé quand même, et les administrateurs sont prévenus.
- Une transcription qui échoue est retentée deux fois (après 30 s, puis 2 min), puis passe à `none` avec la raison `failed` et une alerte. Un avis est retenté cinq fois (30 s, 2 min, 10 min, 1 h, 6 h, en respectant le délai que le serveur Matrix demande), puis abandonné avec une alerte. Chaque alerte (`transcription-busy`, `transcription-failed`, `notice-failed`, type `voicemail`) part au plus une fois par heure.
- Le texte gardé fait 10 000 caractères au plus, sans caractères de contrôle.

### 5. Ce que la personne voit

- `GET /voicemails` donne à chaque message sa transcription (`transcript`) : `pending`, `done` avec son texte (vide si rien n'a été reconnu) et sa langue (`lang`, `LINTO_LANGUAGE` ou `fr`), ou `none` avec sa raison (`too-long`, `busy`, `failed`, `untracked`). Toutes les passerelles la donnent, avec ou sans LinTO et bot.
- Le `voicemail.created` d'un message nouveau porte déjà `pending`. Quand la transcription est faite, `voicemail.transcribed` part. `/capabilities` annonce `voicemailTranscription`.
- L'onglet « Messagerie vocale » affiche le texte sous le message, dans sa langue (`lang`, critère 8.7 du RGAA). Le lecteur le désigne par `aria-describedby` : c'est l'alternative textuelle de l'enregistrement (critère 4.1 du RGAA, dont la dérogation tombe). La zone de statut annonce une fois que la transcription est arrivée, ou qu'elle ne viendra pas, et pourquoi. Un message sans transcription dit pourquoi.

### 6. Le bot dans Twake Chat

- Le bot est un compte Matrix ordinaire de l'organisation, sur son serveur. Il crée pour chaque personne une salle à lui : `private_chat`, `is_direct`, lui seul peut y inviter, l'historique est visible à partir de l'invitation, sans chiffrement. Il n'est pas nommé dans les niveaux de pouvoir : il est le créateur de la salle, et Synapse refuse de le nommer dans une salle de version 12, où un créateur est au-dessus d'eux. Il y envoie un `m.notice` en texte et en HTML : appelant (nom et numéro, ou « un numéro masqué »), date et heure (`NOTICE_TIME_ZONE`, Europe/Paris), durée, transcription ou raison de son absence, lien « Écouter dans TwakePhone » vers `APP_URL/voicemail`.
- La salle est celle du titulaire de la boîte (`matrix:room:<empreinte de l'organisation et du titulaire>` dans l'état de la passerelle), gardée tant que la personne y est seule avec le bot, invitée ou présente. Elle est créée une seule fois : son adresse (un alias tiré au hasard) est écrite avant la création, et une réponse perdue retrouve la salle par cet alias. Quelqu'un d'autre y est entré : une nouvelle salle. La personne a refusé l'invitation ou quitté la salle : pas de nouvelle invitation pendant 30 jours, ses avis ne sont pas envoyés. Le bot quitte une salle qu'il n'utilise plus (perdue, remplacée, titulaire effacé) une fois ses avis retirés, et supprime son alias.
- Une personne n'a d'avis que si son compte Matrix est sur le serveur du bot : un avis ne sort jamais du serveur de l'organisation. Le compte est vérifié (profil) avant de créer la salle. Un identifiant absent, invalide, ambigu, d'un autre serveur ou sans compte : pas d'avis, une ligne au journal (avec une empreinte de l'identifiant), un compteur et l'alerte `notice-no-account`.
- Un avis parti sans le texte (la transcription en retard) est complété quand elle arrive : un remplacement (`m.replace`) du même avis, avec le texte ou la raison de son absence. Il est retiré avec l'avis. Retenté comme un avis ; au-delà, l'avis reste tel qu'il est parti (le texte est dans TwakePhone).
- Le compte est vérifié par son profil. Synapse répond 404 `M_UNKNOWN` pour un compte inexistant, et 404 `M_NOT_FOUND` pour un compte sans nom ni avatar : seul le premier veut dire « pas de compte ».
- Un avis déjà envoyé dont la réponse s'est perdue est cherché parmi les 50 derniers messages du bot dans la salle, 10 par page : une page d'avis longs tient dans la borne d'une réponse.
- Le refus de la personne (invitation refusée, salle quittée) survit à l'effacement de ses messages : elle n'est pas réinvitée avant les 30 jours.
- Le nom donné par l'appelant n'est pas vérifié : l'avis le dit « annoncé par l'appelant », sans caractères de format ni de contrôle, 64 caractères au plus. Il ne garde que des lettres, des chiffres, des espaces et `' ’ - , ( ) &` : ni adresse web ni courriel qu'un client changerait en lien.
- Le texte de l'avis passe par le serveur Matrix, et de là par les notifications push des clients (sauf un pusher en `event_id_only`) et les courriels de notification du serveur, s'ils sont activés. Avec `MATRIX_NOTICE_TEXT=off`, l'avis ne porte pas la transcription : appelant, heure, durée et lien seulement.

### 7. Le compte Matrix de chacun

- C'est l'attribut d'annuaire `LDAP_ATTR_MATRIX` s'il est donné et renseigné. Sinon, c'est `MATRIX_USER_TEMPLATE` (`@{uid}:example.org`), avec l'identifiant d'annuaire en minuscules. Sans l'un ni l'autre, pas d'avis.
- L'attribut doit n'être modifiable que par les administrateurs de l'annuaire : qui l'écrit reçoit les avis. Deux entrées pour le même identifiant, ou un attribut à plusieurs valeurs, sont refusés (pas d'avis, alerte).

### 8. Effacement et conservation

- Un message supprimé (depuis l'app, un téléphone ou Wazo) emporte sa transcription, et l'avis est retiré par une rédaction Matrix. Un `voicemail.deleted` n'efface que la ligne du titulaire nommé par l'événement. L'effacement d'une personne (`DELETE /me/history`, `POST /admin/voicemail/erase`) emporte toutes ses transcriptions, retire ses avis et oublie sa salle, que le bot quitte. La durée de conservation des messages (`VOICEMAIL_RETENTION_DAYS`) s'applique aussi aux transcriptions et aux avis.
- Tout cela vaut que LinTO et le bot soient configurés ou non : seule la messagerie compte. Sans bot (retiré depuis), les lignes sont effacées quand même ; les avis déjà envoyés restent dans Chat, ce que la réponse dit (`chatNotices: "not-withdrawn"`), avec une ligne au journal et l'alerte `notice-not-withdrawn`.
- Une transcription ou un avis qui ne trouve pas son message dans sa boîte ne l'efface pas : la ligne est gardée et regardée à nouveau 5 minutes plus tard. Seuls un `voicemail.deleted`, une suppression depuis l'app, l'effacement d'une personne, la durée de conservation ou une réconciliation confirmée effacent.
- Le texte est effacé tout de suite. La ligne reste en `erased` seulement le temps de retirer l'avis. Si le bot ne peut plus le retirer (403 ou 404 : il a quitté la salle, l'événement n'existe plus), il y renonce et le note au journal.
- Une rédaction retire le contenu pour tous les membres. Le serveur Matrix garde l'original le temps de `redaction_retention_period` (7 jours par défaut chez Synapse, 5 minutes dans la stack) : un déploiement le règle court. Une notification push ou un courriel déjà partis ne se retirent pas.

### 9. Les webhooks

- `voicemail.created` (appelant, heure, durée) et `voicemail.transcribed` (état et raison) sortent de la liste « plus tard » de l'ADR 0020. Ils ne portent jamais le texte ni l'enregistrement : le texte n'est lu que par son titulaire. Leur identifiant est commun à toutes les passerelles. L'effacement d'une personne retire aussi ses livraisons en attente (`subjectUser`).

### 10. Les journaux

- Ni audio, ni texte, ni identifiant Matrix d'une personne : les comptes, l'organisation, une empreinte quand c'est nécessaire, et les quelques mots de l'erreur (jamais un corps de réponse de LinTO ou du serveur Matrix). Le jeton du bot ne va que dans l'en-tête `Authorization`. Un test le vérifie en niveau `debug`.

## Conséquences

- La démo de l'étape 11 se joue de bout en bout en e2e, avec le vrai LinTO STT et un vrai Synapse.
- Un message laissé pendant qu'aucune passerelle ne tient le bail est rattrapé à la prise suivante du bail s'il a moins de 24 heures. Plus ancien, il reste écoutable, sans texte (`untracked`).
- Le serveur Matrix de l'organisation garde l'historique de la salle. TwakePhone ne retire que ses propres avis, et seulement tant que le bot est dans la salle.
- Pas de chiffrement de bout en bout. Le bot n'est pas un appservice. L'activation par personne et l'annonce à l'appelant (FR-G4) viennent plus tard.

## Alternatives écartées

- Transcrire dans chaque passerelle qui entend l'événement : autant d'appels à LinTO que de passerelles, et des avis en double.
- Mettre le texte dans les webhooks : il sortirait de la plateforme vers un tiers, sans le titulaire.
- Un appservice Matrix (namespace d'utilisateurs, enregistrement sur le serveur) : plus de droits que ce qu'un avis demande, et une configuration côté serveur.
- Le mode tâche de LinTO (Celery et broker) : un broker de plus pour un message à la fois.
- Un faux LinTO en CI : le vrai tient dans le budget de temps d'un runner.
