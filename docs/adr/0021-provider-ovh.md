# ADR 0021 : `provider-ovh`, l'opérateur des trunks par son API : renvoi de repli tenu chez OVH, CDR relevés et rapprochés de l'historique

Date : 2026-10-17. État : proposée. Décidée à la PR de l'étape 10b, dans le fil de discussion du projet (ligne « 10. Webhooks et adaptateur OVH » du plan : « CDR OVH rapprochés, numéro de repli piloté par l'API OVH », détaillée dans `stories/etape-10-webhooks-ovh.md`) ; remplacé par : aucun.

**Rien n'est vérifié contre le vrai OVHcloud.** Aucun accès à son API n'existe pour ce projet : le client et ses tests sont écrits d'après la documentation publique de l'API (`/1.0`, signature, `/auth/time`, droits du jeton consommateur, objets `telephony.LineOptions` et `telephony.ServiceVoiceConsumption`), et joués contre un faux serveur écrit d'après cette même documentation (`packages/provider-ovh/test/fake-ovh.mjs`). Un écart se verra au premier branchement du pilote.

## Contexte

Le trunk SIP vers OVHcloud (ADR 0016) porte les appels, mais deux choses se règlent encore à la main dans le manager d'OVH : le renvoi des appels vers un numéro extérieur quand la plateforme ne répond plus, ou quand personne ne décroche (ADR 0017 : le repli d'un numéro direct sonne d'abord à l'intérieur, 60 s pour la cible puis 60 s pour le repli). Et l'historique ne connaît que ce qu'OpenSIPS a vu : un appel reçu par OVH pendant une panne, renvoyé ou perdu, n'y est pas, et rien ne dit que l'historique est complet (FR-D4 : 99 % des appels rapprochés).

## Décision

**Un contrat d'opérateur** (`OperatorProvider`, `provider-sdk`), à côté de celui du serveur SIP : les lignes d'un compte, le renvoi de repli d'une ligne (lu, écrit), les CDR d'une ligne sur une période. `packages/provider-ovh` l'implémente (`OvhOperator`, `OvhClient`) ; aucune notion d'OVH n'en sort. Un autre opérateur viendra par le même contrat.

**Le client.** Chaque requête est signée comme OVH le documente : `X-Ovh-Application`, `X-Ovh-Consumer`, `X-Ovh-Timestamp` et `X-Ovh-Signature` = `$1$` et le SHA-1 (hexadécimal) de « secret+jeton+MÉTHODE+URL complète+corps+horodatage ». L'horodatage est l'heure d'OVH : l'écart avec la nôtre est lu sur `/auth/time` (non signé), relu toutes les heures et après un refus d'horodatage (une seule nouvelle tentative). 10 s au plus par requête, aucune redirection suivie. Les refus d'OVH sont rangés en six cas (`unauthorized`, `forbidden`, `not-found`, `refused`, `rate`, `unreachable`) que l'écran traduit ; le journal garde la méthode, le chemin, le statut et le code d'OVH, jamais une clé.

**Les clés par l'environnement seulement**, pour l'organisation du pilote (`DEFAULT_TENANT`) : `OVH_APPLICATION_KEY`, `OVH_APPLICATION_SECRET`, `OVH_CONSUMER_KEY`, `OVH_BILLING_ACCOUNT` (les quatre ou aucune ; une partie seulement empêche la passerelle de démarrer en nommant ce qui manque) et `OVH_ENDPOINT` (`ovh-eu` par défaut, `ovh-ca`, `ovh-us`). Jamais en base, jamais dans le dépôt, jamais rendues par l'API. Le jeton consommateur est demandé avec les seuls droits utiles : `GET /telephony`, `GET /telephony/*`, `PUT /telephony/*/line/*/options` (le kit pilote donne la requête).

**Ce qu'un trunk dit de son opérateur** (`Trunk.operator`) : ses lignes chez OVH (leurs noms de service, 16 au plus), et, si l'administrateur le demande, le renvoi de repli que la passerelle tient chez OVH (`fallback` : un numéro E.164, sur indisponibilité, sur non-réponse après plus de 120 s et 600 au plus). Sans `fallback`, la passerelle ne touche à rien chez OVH : ce qui est réglé dans le manager reste. Avec, elle le pose à l'enregistrement du trunk (la réponse attend OVH 8 s au plus ; un échec laisse le trunk enregistré et l'écran le dit), le relit toutes les 10 minutes et le remet s'il a été changé dans le manager (dit dans le journal et à l'écran). Elle n'écrit que les champs de renvoi des options de la ligne (`forwardBackup*`, `forwardNoReply*`). Le numéro de repli n'est jamais un numéro direct de l'organisation (409 `OPERATOR_FALLBACK_LOOP`, dans les deux sens), et un renvoi n'est demandé que là où un opérateur est configuré (409 `OPERATOR_NONE`).

**Pas de bascule pilotée à la panne.** Le renvoi sur indisponibilité d'OVH (`forwardBackup`) renvoie de lui-même quand le trunk ne répond plus, même passerelle arrêtée ; une bascule écrite par la passerelle à la panne resterait posée si elle tombait à son tour. `trunk.degraded` et `trunk.recovered` (ADR 0020) disent donc seulement ce qui est posé chez OVH (`fallback`: `on_unavailable`, `no_answer_after_sec` ; jamais le numéro), relu s'il date de plus d'une minute : l'outil abonné sait si les appelants arrivent au repli pendant la panne.

**Les CDR d'OVH** (`voiceConsumption`) sont relevés toutes les 10 minutes sur les dernières 48 h, ligne par ligne, par la passerelle qui tient le bail des événements (ADR 0020) : chacun est lu une fois (500 au plus par relevé) et gardé (`operator_cdrs`, 90 jours), identifié par sa ligne et son identifiant OVH. Pas d'événements en temps réel (`eventToken` d'OVH : sa forme n'est pas assez documentée pour en écrire un faux fidèle).

**Le rapprochement**, 5 minutes après la lecture d'un CDR (le temps que l'appel soit dans l'historique) : un CDR va à l'appel de l'historique de même sens, de même numéro distant (écrit en E.164 des deux côtés : OVH écrit `0033…`), qu'OVH date de 60 s avant son début à 60 s après sa fin, de durée proche ; un CDR pour un appel et un appel pour un CDR, le plus proche l'emporte (un appel d'un groupe, une entrée par membre, est un appel). Un renvoi placé par OVH (`wayType` `transfer`) est compté à part. Un appel entrant qu'OVH a eu et la plateforme non entre dans l'historique de la personne du numéro direct appelé (sa cible, ou le poste de ses derniers chiffres ; pas un groupe), d'identifiant `ovh:<ligne>:<id>`. `GET /calls/history` dit d'où vient chaque entrée (`sources` : `["opensips"]`, `["opensips", "ovh"]` ou `["ovh"]`). `GET /admin/operator` donne, aux administrateurs, ce qui est posé sur chaque ligne et ce que sont devenus les CDR des 7 derniers jours, sans leurs numéros ; `POST /admin/operator/sync` relève tout de suite (2 par minute, 429 `OPERATOR_RATE`). Effacer son historique (`DELETE /me/history`) efface aussi les numéros des CDR rapprochés de ses appels.

## Conséquences

- Le renvoi de repli ne se règle plus dans le manager d'OVH, mais dans l'écran Trunks ; un trunk sans renvoi demandé laisse le manager maître.
- L'historique dit ce que l'opérateur a vu, et l'administration le taux de rapprochement (rapprochés sur relevés, renvois et CDR pas encore rapprochés à part).
- Une organisation, un compte de facturation OVH, par l'environnement : plusieurs organisations, chacune son compte en base (chiffré par `SECRETS_KEY`), attendent qu'on en ait besoin. Une ligne OVH partagée entre organisations n'est pas prévue.
- L'état des lignes est en mémoire de la passerelle qui relève : une autre passerelle l'apprend à son premier relevé (l'écran peut dire « pas encore lue » juste après un redémarrage).

## Alternatives écartées

- Basculer les numéros vers le repli à la panne par la passerelle : resterait posé si elle tombait, alors que `forwardBackup` le fait déjà chez OVH.
- Rapprocher à la volée dans `GET /calls/history` : une lecture d'historique ferait des requêtes à OVH ; le relevé en base est relu sans lui.
- Les clés en base dès maintenant : l'écran d'un administrateur d'organisation donnerait accès au compte OVH de l'exploitant ; l'environnement suffit au pilote.
- Le SDK `ovh` de npm : une dépendance pour une signature d'une ligne ; le client fait 160 lignes, sans dépendance.
