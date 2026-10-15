# ADR 0017 : droits d'appel, plafonds et seuils de volume dans OpenSIPS (`fraud_detection`, profils de dialogue, CDR de `acc`) ; le numéro de repli renvoie l'appel à l'opérateur (302)

Date : 2026-10-15. État : acceptée. Décidée à la PR de l'étape 6b, dans le fil de discussion du projet (ligne « 6. Trunk OVH et anti-fraude » du plan, partie 6b de `stories/etape-6-trunk-anti-fraude.md` ; FR-C8, C9, D7, H3) ; remplacé par : aucun.

## Contexte

L'étape 6a refuse ce que le trunk n'appelle pas (ADR 0016). Il reste à dire qui, dans l'organisation, peut appeler quoi, combien, et à repérer un compte volé qui appelle en rafale ; et à ne pas perdre un appel entrant que personne ne prend. Tout doit tenir quand la passerelle est arrêtée : OpenSIPS décide seul de chaque appel. Les appels d'urgence restent hors de tout.

## Décision

**Droits (FR-H3).** La passerelle garde des profils (`outbound_policies`, un document par tenant : profils, profil par défaut, qui a lequel, plafonds, seuils), réglés par `/v1/admin/outbound`. Un profil liste des classes de l'ADR 0016 (fixe, mobile, gratuit, 0806 à 0809, outre-mer, étranger) ; aucune : appels internes seulement. Il ne fait que restreindre : ce qui passe est l'intersection du profil et de ce que le trunk appelle. Sans profil (aucun donné, pas de défaut), le trunk seul. Le fournisseur écrit la projection dans `outbound_settings`, `outbound_profiles` et `outbound_users` (par `subscriber.holder`), lue avec le trunk, dans la même requête, à chaque appel extérieur (`twake_outbound()`). Refus : 403, `Twake-Call-Refused: rights`, rien n'est envoyé à l'opérateur.

**Plafonds (FR-D7).** Par personne (son profil) et pour l'organisation : appels extérieurs simultanés (profils de dialogue `trunk_caller` et `trunk_out` ; l'appel s'y inscrit avant de compter, deux appels simultanés ne passent jamais tous les deux), appels et minutes du jour et du mois (les CDR de `acc` marqués `external = 'out'`, les appels décrochés, plus les appels en cours pour le nombre d'appels). Atteint : 403 `limit`, et l'événement `E_TWAKEPHONE_LIMIT`. Des minutes presque atteintes coupent l'appel quand elles le sont (`$DLG_timeout`) ; deux appels en même temps peuvent chacun utiliser ce qui reste. Jour et mois sont ceux de la base (`localtimestamp`), comme `acc.time` : la même heure locale des deux côtés.

**Seuils de volume (FR-D7) : `fraud_detection` d'OpenSIPS.** Par appelant et par règle (numéros en France, `+33`, et tous les autres), avertissement et seuil critique pour les appels de la minute, du jour, simultanés, à la suite vers le même numéro, et la durée d'un appel. Des valeurs par défaut (`FRAUD_DEFAULTS`) sont écrites à la création de la base : la protection existe avant tout réglage. Au seuil critique, l'appel est refusé (403 `fraud`). Le module lit ses règles en base et les recharge sur `fraud_reload`, que le fournisseur demande seulement quand elles changent ; il a besoin de `drouting` chargé, dont les tables restent vides.

**Alertes (FR-D7).** Les événements `E_FRD_WARNING`, `E_FRD_CRITICAL` et `E_TWAKEPHONE_LIMIT` arrivent à la passerelle (`alert.raised`), qui les écrit au journal et dans `telephony_alerts` (90 jours), lisibles par `/v1/admin/alerts`. Elles ne vont jamais aux personnes. Les webhooks viennent à l'étape 10.

**Numéro de repli (FR-C8).** Quand le trunk ou l'accès Internet tombe, OpenSIPS ne reçoit plus rien : seul un renvoi programmé chez l'opérateur (sur indisponibilité de la ligne) peut alors servir, et le kit pilote le demande. Quand la plateforme reçoit l'appel, un appel de l'opérateur vers un numéro direct qui ne trouve personne (aucun compte, personne de joignable, occupé, refusé, sans réponse, groupe sans membre) reçoit un 302 vers le numéro de repli : celui du numéro direct, sinon celui du trunk. Le `Contact` est écrit comme le trunk écrit les numéros. Un appel annulé n'est pas renvoyé. Le numéro doit être un numéro que le trunk appelle, hors des plages de la plateforme (409 `FALLBACK_LOOP`).

**Urgences (FR-C9).** Ni droits, ni plafonds, ni seuils ; leurs CDR sont marqués `emergency` et ne comptent pour rien. Leur localisation reste celle de l'ADR 0016 : l'adresse que l'opérateur associe au numéro présenté, déclarée chez lui pour chaque numéro direct ; aucun `Geolocation` n'est envoyé.

L'app dit pourquoi un appel est refusé (`rights`, `limit`, `fraud`). Une base OpenSIPS sert un seul tenant (409 sinon), comme pour les trunks.

## Conséquences

Tout se décide dans OpenSIPS, même passerelle arrêtée ; la passerelle remet ses règles au démarrage du fournisseur. Les compteurs de `fraud_detection` sont en mémoire : un redémarrage d'OpenSIPS les remet à zéro (pas les plafonds, lus dans les CDR). Prouvé contre le script réel (`apps/web/test/trunk.sip.mjs`) et dans l'e2e des navigateurs ; rien contre un vrai trunk.

## Alternatives écartées

Les droits et plafonds dans la passerelle : un appel ne passe pas par elle, et elle peut être arrêtée. Compter les minutes et les appels dans des compteurs à part (`$stat`, Redis) : les CDR existent déjà et survivent à un redémarrage. Un module de seuils écrit par nous : `fraud_detection` fait exactement cela, avec ses événements. Le repli en « hairpin » (OpenSIPS rappelle lui-même le numéro de repli par le trunk) : il se heurte à la restauration automatique de `uac`, aux en-têtes `From` déjà réécrits et au média DTLS-SRTP de rtpengine ; le 302 laisse l'opérateur faire le renvoi, comme il le fait pour un renvoi configuré chez lui.
