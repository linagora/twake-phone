# ADR 0033 : click-to-call, Wazo fait sonner le téléphone de la personne puis appelle le numéro à son nom

Date : 2026-10-30. État : proposée (en revue, PR #45). Décidée dans le fil de discussion du projet (« faire ce qu'il manque pour arriver au niveau du POC ») ; s'appuie sur l'ADR 0027 (les lignes de Wazo), l'ADR 0029 (le compte AMI réservé à `Originate`) et l'ADR 0018 (les autorisations `dial_out_grants` des salles de Meet) ; remplacé par : aucun.

## Contexte

Le POC savait lancer un appel depuis le serveur (`POST /calls`, Asterisk par ARI) : le téléphone de la personne sonnait, elle décrochait, l'appel partait. C'est ce qu'il faut à qui garde un téléphone de bureau ou Linphone (ADR 0002). Depuis le retrait d'Asterisk (PR 4c), `provider-opensips` répond 501 : OpenSIPS est un proxy, il ne place pas d'appel. Wazo place des appels vers les lignes des personnes (AMI `Originate`, ADR 0027), mais son socket de lignes ne servait qu'à faire sonner les fenêtres d'une extension.

## Scénario de démo (écrit avant le code)

1. Bob a une ligne chez Wazo (son téléphone de bureau, Linphone, ou ses fenêtres). Dans le clavier, il tape 102 et choisit « Appeler depuis mon téléphone » (ou « Appeler » quand le navigateur n'a pas de softphone).
2. Son téléphone sonne : « Twake Phone (102) ». Il décroche.
3. Jean sonne et voit « Bob Durand » ; ils se parlent. Bob raccroche : tout se termine.

## Décisions

### 1. Wazo sonne la ligne, puis appelle le numéro au nom de la personne, à travers OpenSIPS

`POST /calls`, quand le serveur SIP ne place pas d'appel (`calling.outbound` faux) et que la personne a une ligne chez Wazo (`listWazoLines`) :
- la passerelle écrit une autorisation dans `dial_out_grants` (la table des appels des salles de Meet) : `room = 'click-to-call'`, cette extension, ce numéro, une minute, un jeton tiré ;
- puis demande au compte AMI `originate` (ADR 0029) un `Originate` : canal `PJSIP/<extension>`, appelant `"Twake Phone" <cible>`, contexte `twake-click-to-call` (`docker/wazo/asterisk/extensions.conf`, à installer avec Wazo comme `twake-opensips`), variables `TWAKE_LINE`, `TWAKE_TARGET`, `TWAKE_GRANT`.

La ligne décrochée, le contexte vérifie ces trois valeurs, prend l'adresse du socket de lignes d'OpenSIPS dans le contact de la ligne (`PJSIP_DIAL_CONTACTS`), et compose la cible par l'endpoint de la ligne, avec l'extension pour appelant et le jeton dans `X-Twake-Grant` (un pre-dial handler). Asterisk ponte les deux appels : quand l'un raccroche, l'autre finit.

### 2. OpenSIPS prend l'autorisation comme celle d'une salle

Sur le socket de lignes, un INVITE hors dialogue qui porte `X-Twake-Grant` n'est pas un appel vers les fenêtres d'une extension : il suit le chemin des appels d'une personne. L'en-tête est lu puis retiré ; l'autorisation tient lieu de mot de passe et se prend une fois la transaction créée, par `route[meet_source]` (jeton, cette personne en `From`, ce numéro, pas encore prise, pas expirée, un compte existant ; en asynchrone, comme toute requête d'un appel). Ensuite l'appel est celui de la personne : ses droits, ses plafonds, l'anti-fraude, le trunk. Le côté de Wazo de cet appel ne parle que depuis le socket de lignes (`wline`), rien n'y est transféré, et son CDR dit `click-to-call`. Une autorisation de salle ne sert pas à un click-to-call, ni l'inverse : le jeton de l'une n'est jamais donné à l'autre, et la salle `click-to-call` n'ajoute aucun en-tête de Meet.

### 3. Le choix dans le clavier

`/capabilities` dit `clickToCall` (et `calling.outbound`) pour qui a une ligne. Sans softphone dans le navigateur (`off`), « Appeler » passe par là ; sinon, un second bouton « Appeler depuis mon téléphone » le propose, une demande à la fois. Jamais depuis un lien seul (ADR 0031).

## Conséquences

- Le média passe par Asterisk (pont), comme pour une file ou un standard de Wazo.
- Le CDR montre deux appels : celui de Wazo vers la ligne (`via wazo`, l'appelant est la cible) et celui de Wazo vers la cible au nom de la personne (`via click-to-call`).
- La passerelle ne suit pas ces appels (pas de canal à elle) : le 202 dit seulement qu'Asterisk a pris l'appel à placer ; une ligne qui ne répond pas en 30 s ne se voit que sur le téléphone et dans les Récents.
- `wazo_lines` peut avoir un peu de retard sur Wazo : une ligne retirée à l'instant reste proposée, et rien ne sonne.
- La clé d'idempotence de `POST /calls` n'est pas lue pour un click-to-call : le clavier n'envoie qu'une demande à la fois.
- Prouvé : `config.spec.ts` (le chemin du socket de lignes, la prise par `meet_source`, rien sans les lignes), l'autorisation prise contre PostgreSQL avec la requête du gabarit (`dial-out-grants.spec.ts`), `provider-wazo` (l'`Originate` exact, refus de toute valeur qui dirait plus qu'une ligne, un numéro, un jeton), la passerelle (offert à qui a une ligne seulement, autorisation écrite avant la sonnerie et donnée à Wazo, 400, 409, 503), le contexte chargé par l'Asterisk de Wazo 26.10 et le gabarit par l'OpenSIPS de la pile ; l'e2e SIP (Bob, Jean, son, fin, CDR, autorisation prise) en CI.

## Alternatives écartées

- **Le transfert par REFER** (`Transfer()` d'Asterisk sur la ligne décrochée, le téléphone appelant lui-même la cible) : essayé, puis mesuré localement contre l'Asterisk 22 de Wazo 26.10 avec un téléphone de test, sans OpenSIPS. Le canal de Wazo ne se termine jamais : ni le BYE du téléphone, ni `TIMEOUT(absolute)`, ni un `Hangup` de l'AMI ne le libèrent (le même canal sans `Transfer` se termine normalement). Il demandait aussi une exception au refus des REFER dans OpenSIPS.
- **Wazo qui sortirait vers l'opérateur sans OpenSIPS** : hors des droits et plafonds de la personne (ADR 0016, 0017).
- **Un B2BUA dans OpenSIPS** (`b2b_logic`) : un module de plus pour ce que Wazo fait déjà, et plus de routes que le plafond de 99 n'en laisse.
