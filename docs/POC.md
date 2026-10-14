# Twake Phone (README d'origine du POC)

*Le code du POC décrit ici (app Phone Cozy, PBX de dev MiniPBX, `sip-media`, stack de dev et ses scripts) a été retiré du dépôt à la PR 3c ; l'historique Git avant le 14 octobre 2026 le conserve.*

*README du POC <https://ci.linagora.com/tdelobelle/poc-twake-phone>, conservé tel quel sauf les liens, réécrits pour ce dossier. Le README courant du dépôt est [à la racine](../README.md).*

Couche téléphonique native de Twake Workplace : une application **Phone** (clavier, récents, présence, appel en cours), un **widget** d'appel monté dans les autres applications, et la **Twake Telephony Gateway**, qui isole Twake de tout fournisseur de téléphonie. Le premier fournisseur est Asterisk (ARI) ; l'accès téléphonique aux salles **Twake Visio / Meet** passe par LiveKit SIP.

Documentation : [architecture](ARCHITECTURE.md) · [widget](WIDGET.md) · [PBX externe à brancher](PBX-REQUIREMENTS.md) · [PBX et trunk de dev](../docker/README.md) · [analyse des dépôts Twake](REFERENCES-ANALYSIS.md) · [spike appels entrants](SPIKE-INCOMING-CALLS.md)

```
apps/phone                      app Twake/Cozy (React 18, cozy-ui, cozy-client), issue de cozy-app-template
apps/gateway                    Twake Telephony Gateway (Node/TS, Fastify, OpenAPI sur /docs)
packages/telephony-types        modèle neutre (Call, Presence, Capabilities…)
packages/provider-sdk           interfaces TelephonyProvider / MediaProvider / ConferenceBridgeProvider
packages/telephony-client       SDK front (REST, WS, normalisation E.164, conférences)
packages/provider-asterisk      provider de référence (ARI) : appels, présence, DND, événements
packages/softphone              softphone SIP.js (plan média navigateur) + harnais de test
packages/sip-media              plan média SIP/WebRTC partagé
packages/phone-link             <PhoneLink> et requestCall : numéro cliquable (intent CALL)
packages/phone-widget           widget d'appel à monter dans les autres apps (iframe d'intent)
packages/conference-livekit     Meet : API externe de Meet, SIP LiveKit (dial-in PIN, dial-out)
docker/                         stack de dev : PBX (MiniPBX + overlay), LiveKit SIP, correctifs de la stack Twake
scripts/                        mise en place de la stack de dev
```

Règle : aucune notion Asterisk/PJSIP/AMI/ARI en dehors de `provider-asterisk`, aucune notion LiveKit/Meet en dehors de `conference-livekit`.

## Démarrer

Prérequis : Node 22+ (24 pour `apps/phone`, voir `.nvmrc`), Yarn 1, Docker.

```bash
yarn install && yarn build && yarn test      # packages + gateway (aucun service externe)
(cd apps/phone && yarn install && yarn test) # application
```

Stack complète en local (Twake + Phone + Gateway + PBX) :

```bash
scripts/setup-references.sh          # clone la stack Twake, Drive et MiniPBX aux révisions testées, applique nos correctifs
cp docker/.env.example docker/.env   # puis renseigner les secrets (voir le fichier)
scripts/start-twake-stack.sh         # demande votre mot de passe pour 3 réglages de l'hôte, expliqués dans le script
```

Visio (accès téléphonique aux salles Meet) et trunk SIP réel : [docker/README.md](../docker/README.md).

## Tests

| Commande | Vérifie |
|---|---|
| `yarn test` | unitaires de tous les paquets et du Gateway (vitest) |
| `cd apps/phone && yarn test` | application (jest) |
| `yarn e2e:live` | Gateway ↔ PBX de dev, avec de vrais appels SIP |
| `yarn e2e:browser` | deux navigateurs, audio réel simulé (WebRTC) |
| `yarn e2e:widget` | widget dans un hôte cozy-interapp réel |
| `node docker/meet-sip/platform.e2e.mjs` | Visio sur la plateforme : jetons Cozy, Meet, LiveKit, SIP, PBX |

## Licence

AGPL-3.0, voir [LICENSE](../LICENSE).
