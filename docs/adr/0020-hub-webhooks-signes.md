# ADR 0020 : un hub de webhooks signés dans la passerelle, livrés au moins une fois depuis une file en base, vers les seuls domaines que l'organisation autorise

Date : 2026-10-16. État : proposée. Décidée à la PR de l'étape 10a, dans le fil de discussion du projet (ligne « 10. Webhooks et adaptateur OVH » du plan, découpée en 10a et 10b dans `stories/etape-10-webhooks-ovh.md`) ; remplacé par : aucun.

## Contexte

Le plan veut que les outils d'une organisation (CRM, supervision, ticketing) reçoivent les événements de la téléphonie : un modèle d'événement unique (`call.ringing`, `call.answered`, `call.ended`, `call.missed`, `presence.changed`, `trunk.degraded` ; plus tard `voicemail.*` et `quality.alert`), des abonnements par organisation (`POST /webhooks`), un journal des livraisons (`GET /webhooks/{id}/deliveries`) et un rejeu manuel. Chaque livraison est un POST signé HMAC-SHA256 (`X-TwakePhone-Signature`), au moins une fois, avec 8 relances à attente exponentielle. La clé d'idempotence est l'identifiant de l'événement, et seuls les domaines que l'administrateur autorise peuvent être destinataires. Ce que la passerelle sait vient de ses providers : OpenSIPS lui dit les appels de chaque poste (ADR 0011), et l'état des trunks par son MI (étape 7). Une passerelle qui envoie des requêtes vers des adresses choisies par un administrateur d'organisation est aussi une porte vers le réseau de l'exploitant (SSRF).

## Décision

**Le modèle.** `WebhookEvent` (`telephony-types`) est distinct de `TelephonyEvent`, ce que les providers disent à la passerelle (par poste, interne). Un événement porte `id` (`evt_` et 32 caractères hexadécimaux), `type`, `occurred_at`, `tenant`, et selon son type :

- `call` : l'appel tel qu'une personne l'a vécu. On y trouve l'identifiant SIP de l'appel, le sens, `from` et `to` (un poste ou un numéro E.164 : le seul numéro de téléphone du modèle), `user` et `extension`, les heures connues et, à la fin, `duration_sec` et `outcome` (`answered`, `missed`, `declined`, `failed`, `unanswered`). `conference: true` marque un appel d'une conférence, et `source` vaut `["opensips"]` (puis OVH à l'étape 10b).
- `presence` : `user`, `extension` et `status` seulement, ni message ni échéance.
- `trunk` : `id`, `name`, `state` (`degraded` ou `down`), `previous`, l'état de l'enregistrement, et les serveurs avec leur état.

`call.ringing` vient de la sonnerie chez la personne, `call.answered` de sa réponse et `call.ended` de la fin de l'appel. `call.missed` s'y ajoute pour un appel entrant fini sans réponse de son côté et sans refus, comme ses Récents le comptent. Un réveil, un appel pris par un collègue du groupe et une alerte ne donnent rien. `webhook.test` n'existe que pour le test d'un abonnement. Les types gardés pour plus tard (`voicemail.created`, `voicemail.transcribed`, `quality.alert`) sont nommés dans le modèle ; un abonnement ne peut pas encore les demander (400 `WEBHOOK_EVENTS`).

**Une seule fois quelle que soit la passerelle.** Plusieurs passerelles entendent chacune OpenSIPS. Un événement d'appel a donc un identifiant tiré de l'organisation, du type, de l'appel et de la personne (SHA-256), et la file n'en garde qu'une livraison par abonnement (`UNIQUE (subscription_id, event_id)`). Une présence ou un trunk n'a pas d'identifiant commun : ce qui a été dit d'eux est gardé en base (`webhook_state`, `presence:<personne>` ou `trunk:<id>`). Seule la passerelle qui écrit le changement la première le publie : une présence ne l'est qu'à un changement d'état (un nouveau message seul ne compte pas), et rien n'est écrit quand aucun abonnement ne la demande.

**`trunk.degraded`.** La passerelle relit toutes les 30 s l'état des trunks des organisations qu'elle sert. C'est celui de l'écran d'administration : l'enregistrement et les serveurs sondés, lus dans OpenSIPS. Un trunk est `down` si son enregistrement est refusé, perdu ou sans réponse, ou si aucun de ses serveurs actifs ne répond ; `degraded` si une partie seulement ne répond pas ; `up` sinon. Un trunk qu'un administrateur a désactivé entier n'est pas suivi. Un état pire, vu deux relevés de suite, est publié une fois (de `up` vers `degraded` ou `down`, de `degraded` vers `down`). Le retour à `up` est gardé sans événement.

**La file.** `webhook_deliveries` tient une ligne par événement et par abonnement actif qui le demande, avec le corps tel qu'il sera signé. Chaque passerelle a un travailleur qui prend les livraisons dues (`FOR UPDATE SKIP LOCKED`, 16 à la fois au plus). Il les tient pendant un bail de 60 s, sous un jeton (`claim`), puis écrit leur issue sous ce jeton. Une livraison dont la passerelle est tombée en route redevient due à la fin du bail, et l'issue écrite trop tard par l'ancienne passerelle est ignorée : c'est l'« au moins une fois ». Une réponse 2xx livre l'événement. Une autre réponse, un délai dépassé, une connexion refusée, un nom introuvable ou un refus TLS donnent une nouvelle tentative, après 30 s puis deux fois plus à chaque fois, à 10 % près (30 s, 1 min, … 64 min, environ deux heures en tout). Après la neuvième tentative (la première et 8 relances), la livraison est en échec. Un domaine qui n'est plus autorisé, une adresse refusée ou un secret illisible font échouer la livraison aussitôt, sans requête. Désactiver un abonnement clôt ses livraisons en attente (`disabled`) ; le supprimer les supprime. Le journal est gardé 30 jours. Le rejeu remet une livraison terminée en attente, ses tentatives à zéro, avec le même événement (le même identifiant) ; une livraison encore en attente n'est pas rejouée (409 `WEBHOOK_PENDING`).

**La requête.** C'est un POST `application/json` du corps exact, avec ces en-têtes :

- `X-TwakePhone-Signature: t=<secondes>,v1=<HMAC-SHA256 hexadécimal de « t.corps »>`. L'horodatage est signé avec le corps, et le destinataire refuse ce qui est trop ancien (5 min dans l'exemple du README).
- `X-TwakePhone-Event`, `X-TwakePhone-Event-Id`, `X-TwakePhone-Delivery`, et `Idempotency-Key`, qui vaut l'identifiant de l'événement.

Le secret (`whsec_` et 256 bits) est tiré par la passerelle et gardé chiffré par `SECRETS_KEY`. Il est montré à la création et à chaque renouvellement, jamais relu. Sans `SECRETS_KEY`, les routes répondent 501.

**Contre la SSRF.** L'adresse d'un abonnement est une URL `https` sans identifiants ni fragment, de 2048 caractères au plus. Son hôte doit être l'un des domaines autorisés de l'organisation : un nom exact, `*.domaine` pour ses sous-domaines (pas le domaine lui-même), ou une adresse IPv4. L'organisation en a 50 au plus, et 20 abonnements. À chaque livraison, la passerelle :

- résout le nom elle-même et refuse si l'une de ses adresses est privée, de boucle locale, de lien local, partagée, de documentation, de test, multicast ou réservée (IPv4 et IPv6, IPv4 dans IPv6, NAT64 et 6to4 compris) ;
- se connecte à l'adresse vérifiée, sans seconde résolution, et ne suit aucune redirection (3xx = échec `redirect`) ;
- borne la requête à 10 s et lit au plus 64 Kio de la réponse.

L'exploitant peut ouvrir des réseaux précis (`WEBHOOK_PRIVATE_NETWORKS`, une liste de CIDR : le CRM du réseau du bénéficiaire) et `http` (`WEBHOOK_ALLOW_HTTP=1`, développement et tests seulement, signalé au démarrage).

**Les routes**, sous `/api/v1`, réservées aux administrateurs de l'organisation (403 sinon, 401 sans session) :

- `GET` et `PUT` `/webhooks/domains` ;
- `GET` et `POST` `/webhooks` (201, avec le secret) ;
- `GET`, `PUT` et `DELETE` `/webhooks/:id` ;
- `POST /webhooks/:id/secret` ;
- `POST /webhooks/:id/test` (202) ;
- `GET /webhooks/:id/deliveries` (`status`, `limit`, `before`, la plus récente d'abord) ;
- `POST /webhooks/:id/deliveries/:deliveryId/replay` (202).

Les tests et les rejeux sont limités à 10 par minute et par administrateur (429 `WEBHOOK_RATE`). L'écran Administration > Webhooks fait tout cela, en français et en anglais, avec les règles du RGAA de l'étape 7 : erreurs à côté des champs, focus sur le premier, secret montré une fois avec un bouton pour le copier, journal en tableau.

## Conséquences

Les webhooks ne demandent ni Redis ni courtier de messages : la base de la passerelle est la file, et plusieurs passerelles se la partagent. Le bus d'événements de l'app sur Redis et la passerelle à plusieurs réplicas forment un lot à part (Exploitation) : les appartenances d'appels, les tickets WebSocket et les réveils Web Push sont encore en mémoire. Un événement que la passerelle n'entend pas d'OpenSIPS (datagramme perdu) n'est pas publié. La garde SSRF ne couvre que ce que fait la passerelle : un proxy sortant de l'exploitant, s'il y en a un, n'est pas utilisé (hors périmètre). Un abonnement qui échoue toujours n'est pas désactivé de lui-même ; son journal le montre. Un renouvellement du secret prend effet aussitôt : les livraisons suivantes sont signées avec le nouveau secret, que l'outil doit avoir reçu d'abord.

## Alternatives écartées

- Un courtier de messages (Redis Streams, RabbitMQ) : un service de plus dans le kit pilote, pour une file que PostgreSQL tient déjà. Il viendra avec le lot Exploitation s'il le faut.
- Livrer directement depuis le flux des événements, sans file : une passerelle qui tombe perd ce qu'elle n'a pas envoyé, ce qui n'est pas « au moins une fois ».
- Un proxy de sortie dédié à la place de la garde dans la passerelle : c'est à l'exploitant, plus tard. La garde dans le code protège le kit pilote tel qu'il est.
- Signer le corps seul, sans horodatage : qui a vu une livraison pourrait la rejouer indéfiniment.
