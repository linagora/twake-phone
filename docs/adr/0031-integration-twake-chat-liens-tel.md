# ADR 0031 : Twake Chat ouvre TwakePhone sur un numéro (`/?dial=`), le reste de l'intégration attend

Date : 2026-10-20. État : proposée. Décidée à l'étape 9 du plan (« Intégration Twake Chat », secondaire), avec la PR jumelle de Twake Chat (`feat/twake-phone-integration`) ; suit l'ADR 0006 ; remplacé par : aucun.

## Contexte

La démo de l'étape 9 est : « un numéro cliqué dans Chat lance l'appel ». Chat est un client Matrix en React qui souligne déjà les numéros de ses messages en liens `tel:`, mais le navigateur les confie à l'application de téléphonie de l'appareil, pas à TwakePhone. L'ADR 0006 prévoit pour Chat la grille d'apps, les liens `tel:`, un widget, une carte d'appel, la présence et un bot. Les leçons du POC (`docs/ARCHITECTURE.md` §7) pèsent sur le widget : hauteur de l'iframe écrasée à 0, toutes les fenêtres d'une extension sonnent, une demande d'appel n'est acceptée que d'une origine de la même instance.

## Scénario de démo (écrit avant le code)

1. Chat est configuré avec `TWAKE_PHONE_URL` (l'adresse de TwakePhone). Alice écrit à Bob « appelle-moi au 06 12 34 56 02 ».
2. Bob clique le numéro dans Chat : TwakePhone s'ouvre dans un nouvel onglet, connecté par son SSO, sur le clavier. Le champ contient `+33612345602`, le bouton « Appeler » prend le focus dès qu'un appel est possible (softphone enregistré, ou appel par la passerelle), une seule fois.
3. Bob appuie sur « Appeler » : l'appel part (softphone du navigateur, ou la passerelle fait sonner son poste).
4. Un texte qui n'est pas un numéro dans le lien (`/?dial=FR123456789`) ne remplit rien et le dit ; sans `TWAKE_PHONE_URL`, Chat garde ses liens `tel:`.

## Décisions

### 1. Le contrat : `GET <TwakePhone>/?dial=<numéro>`

Le numéro est validé et normalisé par TwakePhone seul (`toDialTarget` : un poste interne de 2 à 6 chiffres, ou un numéro en E.164, la France par défaut ; « appelle le 102 » dans Chat vaut un poste, et un numéro tronqué de 2 à 6 chiffres aussi : rien ne part sans le clic) ; Chat ne fait que nettoyer ce qu'il envoie (chiffres et `+`). Un numéro invalide ne compose rien. Le paramètre est retiré de la barre d'adresse (comme `?number=` de l'annuaire) ; un second lien reçu par un clavier déjà affiché le remplace. Le numéro passe dans la requête : le serveur de TwakePhone (`apps/web/server`) ne journalise pas les requêtes, mais un proxy devant lui peut le faire ; c'est une donnée personnelle à traiter comme le reste de ses journaux.

### 2. Le lien ne compose pas à lui seul

TwakePhone met le numéro dans le champ et donne le focus à « Appeler » ; l'appel part au clic ou à Entrée. Une page quelconque peut ouvrir un lien : si le lien lançait l'appel, n'importe quel site ferait composer un numéro surtaxé depuis le poste de la personne (les droits et plafonds de l'ADR 0017 limitent le dégât, ils ne l'empêchent pas). La confirmation coûte un geste de plus à la démo, et c'est voulu.

### 3. Chat ouvre TwakePhone dans son propre onglet, pas dans un widget

L'iframe de TwakePhone dans Chat demanderait : `FRAME_ANCESTORS` des origines de Chat (le serveur le sait déjà faire), `allow="microphone"` posé par l'hôte avant le chargement, la hauteur mesurée par le service, et une seule fenêtre par poste qui sonne sans doublon. C'est du travail pour un gain faible tant que Chat est secondaire : l'onglet de TwakePhone fait déjà tout. `FRAME_ANCESTORS` ne change donc pas.

### 4. Grille d'apps de Chat

Avec `TWAKE_PHONE_URL`, la grille de la barre locale de Chat propose « TwakePhone » (ouvre l'adresse). Quand la barre est celle de la plateforme (`@linagora/twake-bar`), la grille est la sienne : TwakePhone y entre par la liste d'apps de la plateforme, hors de ce dépôt.

## Ce qui reste (étape 9 non terminée)

- Widget et carte d'appel dans Chat (décision 3) : un appel entrant ne se voit dans Chat que si TwakePhone est ouvert.
- Présence des collègues dans Chat (événements `presence.changed` du hub de l'ADR 0020 vers la présence Matrix) : non commencée.
- Bot : déjà fait pour la messagerie (ADR 0023), rien de plus à ce stade.

## Conséquences

- Aucune dépendance de TwakePhone envers Chat, aucune de Chat envers SIP (ADR 0006 tenue).
- Le contrat `?dial=` est testé côté TwakePhone par `yarn e2e:web` (lien à froid, second lien sans rechargement, refus, aucun appel lancé) ; le côté Chat l'est dans son dépôt.

## Alternatives écartées

Composer à l'ouverture du lien (risque ci-dessus). `postMessage` ou intent vers une fenêtre déjà ouverte (la leçon du POC : une seconde origine ne se parle pas sans lien de confiance ; à reprendre avec le widget). Une bibliothèque de validation dans Chat : TwakePhone fait foi, un seul endroit à tenir.
