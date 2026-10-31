# ADR 0034 : le widget des autres apps est une télécommande de la fenêtre Twake Phone, pas un téléphone

Date : 2026-10-30. État : proposée (en revue, PR #46), dans le fil de discussion du projet (« fais le reste », après les ADR 0032 et 0033) ; s'appuie sur l'ADR 0032 (la coquille, le relais `CALL`) ; remplacé par : aucun.

**Ce n'est pas le widget du POC.** Celui du POC portait un softphone dans un cadre caché de chaque app : la page d'intent recevait de cozy-stack un jeton (`data-cozy`) qui suffisait à la passerelle (mode `cozy`). Aujourd'hui TwakePhone se connecte en OIDC : sa session vit dans l'onglet (`sessionStorage`), et encadré il ne se connecte que sur un clic, dans une fenêtre (ADR 0032). Un cadre caché de taille zéro dans Drive n'aurait jamais de session.

## Contexte

`@twake/phone-widget` monte dans une app hôte (Drive, Mail…) l'intent `OPEN io.twake.phone.widget` dans un coin, et `@twake/phone-link` lui confie un numéro quand il est là. Depuis le retrait du POC, personne ne sert cet intent.

## Scénario de démo (écrit avant le code)

1. Alice a Twake Phone ouvert dans un onglet (la coquille, son cadre connecté) et travaille dans Drive, qui monte le widget.
2. Bob l'appelle : la fenêtre Twake Phone sonne, et le coin de Drive montre « Bob Durand (102) — Appel entrant », Répondre et Refuser.
3. Alice clique Répondre dans Drive : l'appel est pris par la fenêtre Twake Phone (le son y passe) ; le coin montre « En communication », Raccrocher. Raccroché, le coin se replie.

## Décisions

### 1. Un seul téléphone : la fenêtre Twake Phone

Le cadre de TwakePhone (`apps/web`, `embedded.ts`, `ParentCalls`) dit à son parent ses appels à chaque changement (`twakephone.calls` : id, sens, état, numéro, nom ; rien du média ni du SIP), vers l'origine que le pont de la coquille a donnée (`requestParentOrigin`), et n'exécute que trois ordres, de son parent seul et de cette origine : `answer`, `reject`, `hangup` (`twakephone.command`). La coquille (`callsRelay.js`) les redit sur le `BroadcastChannel` de son origine (`calls`, avec un identifiant de fenêtre ; une fenêtre qui s'en va dit « plus rien ») et porte au cadre les ordres qui la nomment.

### 2. Le widget : l'intent `io.twake.phone.widget` de la coquille

La page `/intents` de la coquille sert ce type sans jamais se terminer (`widget.js`, du DOM sans React) : elle demande les appels des fenêtres ouvertes (`calls-request`), montre l'appel qui sonne d'abord, sinon celui en cours, avec ses boutons, et règle sa taille (`resizeClient` ; 0 sans appel). Les numéros que `phone-link` lui confie (`twake-phone:dial`, par un `MessagePort`) suivent le chemin du relais `CALL` (ADR 0032) : une fenêtre visible les prend, sinon l'app s'ouvre dessus.

## Conséquences

- La confiance s'arrête à l'origine de la coquille : toute page de cette origine (la coquille, ses pages d'intent) peut lire les appels sur le canal et y donner un ordre ; les apps hôtes (autres origines) ne voient ni le canal ni les ordres. Le cadre ne prend d'ordre que de son parent, à l'origine que le pont a donnée ; `FRAME_ANCESTORS` ne doit nommer que les instances (ADR 0032).
- Le cadre qui a des appels les redit toutes les 10 s (la coquille les relaie, datés), et le widget oublie une fenêtre muette depuis 25 s : un onglet tué, un cadre planté ; un cadre qui recharge ou se déconnecte n'a plus d'appel. Les appels que le téléphone se fait (transfert, salle d'une conférence) ne sont pas dits. Une seule carte : un second appel qui sonne attend que le premier soit pris ou refusé. Répondre et Refuser ne valent que pour un appel qui sonne encore.
- Toute app Cozy peut ouvrir l'intent du widget : par la taille de son cadre, elle sait quand la personne est en appel, et pourrait le cacher sous un faux bouton. Accepté : ces apps sont celles de l'instance de la personne.

- Aucune session, aucun micro, aucun contact SIP de plus : la fenêtre Twake Phone reste celle qui sonne et parle ; sans fenêtre Twake Phone ouverte, le widget ne montre rien (les notifications Web Push de l'étape 5 restent le moyen d'être prévenu).
- Les limites du cloisonnement du relais `CALL` (ADR 0032) valent ici : un domaine d'instances dans la liste des suffixes publics sépare Drive de Twake Phone, le widget n'entend alors aucune fenêtre.
- Prouvé : unitaires du protocole du cadre (`embedded.spec.ts` : ce qu'il dit, les ordres qu'il prend, de qui) ; `workplace.e2e.mjs` : un cadre de la coquille annonce un appel, le widget de « Drive » (vrais `phone-widget` et `cozy-interapp`) le montre avec son nom, Répondre et Raccrocher arrivent au cadre, le widget se replie ; un message qui n'est pas du cadre ne montre rien ; `phone-link` passe par le widget. **Non prouvé de bout en bout** : un vrai appel SIP piloté depuis le widget (l'e2e de la coquille n'a pas de serveur SIP ; le côté du cadre est prouvé par ses unitaires).

## Alternatives écartées

Un softphone dans le widget (pas de session possible, et une fenêtre de plus qui sonne pour chaque app ouverte). Garder le jeton de session dans `localStorage` pour que le cadre caché le trouve (un jeton qui survit à l'onglet et s'expose à toute page de l'origine, pour un gain qu'une télécommande donne sans lui).
