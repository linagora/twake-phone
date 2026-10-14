# Brancher un PBX Asterisk externe

Twake Phone ne fournit pas de PBX. Il se branche sur un PBX qui vit **à l'extérieur du déploiement Twake** (le vôtre, celui d'un hébergeur, un cluster Asterisk existant). Ce document liste ce que ce PBX doit offrir. Il décrit le contrat du provider `provider-asterisk` ; pour un autre PBX, on écrit un autre provider (voir [§10](#10-un-autre-pbx-que-asterisk)).

> **État de validation.** Tout ce qui suit a été éprouvé avec **Asterisk 20.6 (paquet Debian) dans MiniPBX**, via l'overlay de `docker/minipbx-dev/`. Aucun Asterisk de production, FreePBX ou Issabel n'a été testé. Les extraits ci-dessous sont ceux de l'overlay, à adapter ; la liste de contrôle du [§9](#9-liste-de-contrôle) dit si l'ensemble fonctionne.

## 1. Frontière

| Côté Twake (ce dépôt et la stack) | Côté PBX (extérieur) |
|---|---|
| Application Phone, widget, Gateway, `provider-asterisk` | Asterisk : SIP, médias, plan d'appel |
| Qui est qui (utilisateur Twake ↔ extension) : table `user_mappings` du Gateway | Les extensions elles-mêmes |
| Secrets SIP par utilisateur, générés et conservés chiffrés par le Gateway | Les comptes SIP qui les acceptent |
| LiveKit et LiveKit SIP (Visio) | Un endpoint SIP vers LiveKit SIP, le trunk de l'opérateur |

Le Gateway ne sait pas lire la liste des extensions du PBX : l'association utilisateur ↔ extension est déclarée du côté Twake (`user_mappings`, ou `DEV_USER_MAP` en développement).

## 2. Chemins réseau

| De | Vers | Protocole | Usage |
|---|---|---|---|
| Gateway | PBX | HTTP + WebSocket (ARI, 8088 par défaut) | Contrôle d'appel, événements, présence |
| Gateway | PBX | HTTP (API de provisionnement, optionnelle) | Pousser le secret SIP d'un utilisateur |
| Navigateur | PBX | SIP sur WSS (TLS) | Enregistrement et signalisation du softphone |
| Navigateur | PBX | RTP/SRTP (UDP, plage fixe) | Audio, jamais par le Gateway |
| LiveKit SIP | PBX | SIP/UDP + RTP | Visio : dial-in, dial-out (optionnel) |
| PBX | Opérateur | SIP/UDP + RTP | Appels externes |

Le WSS doit présenter un **certificat valide pour le nom d'hôte** que le navigateur utilise (par exemple `pbx.exemple.org`), signé par une autorité que les navigateurs acceptent. L'ARI ne doit être joignable que par le Gateway (réseau privé), pas depuis Internet.

## 3. Asterisk

Version : 18 ou plus récente recommandée (ARI, PJSIP, WebRTC ; la validation a eu lieu en 20.6).

Modules à charger (liste de l'overlay, qui complète la configuration de MiniPBX) :

```ini
; modules.conf
load => res_http_websocket.so
load => res_pjsip_transport_websocket.so
load => res_srtp.so
load => res_crypto.so
load => codec_opus_open_source.so   ; ou codec_opus (Digium)
load => res_format_attr_opus.so
load => res_stasis.so
load => app_stasis.so
load => res_stasis_answer.so
load => res_stasis_device_state.so
load => res_stasis_playback.so
load => res_stasis_recording.so
load => res_stasis_snoop.so
load => res_ari.so
load => res_ari_model.so
load => res_ari_applications.so
load => res_ari_asterisk.so
load => res_ari_bridges.so
load => res_ari_channels.so
load => res_ari_device_states.so
load => res_ari_endpoints.so
load => res_ari_events.so
load => res_ari_playbacks.so
load => res_ari_recordings.so
load => res_ari_sounds.so
```

## 4. ARI et serveur HTTP

```ini
; http.conf
[general]
enabled=yes
bindaddr=0.0.0.0          ; ou l'adresse privée vue par le Gateway
bindport=8088
tlsenable=yes             ; le WSS du navigateur passe par ce serveur
tlsbindaddr=0.0.0.0:8089
tlscertfile=/etc/asterisk/keys/fullchain.pem
tlsprivatekey=/etc/asterisk/keys/key.pem

; ari.conf
[general]
enabled=yes
allowed_origins=*          ; le Gateway n'est pas un navigateur ; restreignez si le port est exposé

[twake]                    ; utilisateur dont le Gateway reçoit le nom et le mot de passe
type=user
read_only=no
password=<secret>
password_format=plain
```

**Une application ARI par Gateway.** Le provider s'abonne à l'application nommée par `ari.app` (défaut `twake`). Un seul client peut tenir un nom d'application : deux Gateways (ou un Gateway et un test) avec le même nom se désactivent mutuellement. Donnez un nom propre à chaque déploiement.

Ce que le provider utilise de l'ARI : WebSocket d'événements avec `subscribeAll=true`, `POST/DELETE /channels`, hold et DTMF sur les canaux, `POST /bridges` et `addChannel`, `GET /bridges`, `GET/PUT /deviceStates/Stasis:…`. Les droits `read_only=no` sont nécessaires.

## 5. PJSIP : un endpoint navigateur par extension

Chaque extension doit être un **endpoint WebRTC** que SIP.js sait enregistrer :

```ini
[transport-wss]
type=transport
protocol=wss
bind=0.0.0.0

[101]
type=endpoint
context=<votre contexte interne>
webrtc=yes                  ; ICE, DTLS-SRTP, RTCP-mux, avpf
transport=transport-wss
from_domain=pbx.exemple.org ; un nom d'hôte qui ressemble à un domaine : SIP.js refuse un nom de conteneur
dtls_auto_generate_cert=yes
disallow=all
allow=opus,ulaw,alaw
auth=101-auth
aors=101

[101-auth]
type=auth
auth_type=userpass
username=101
password=<secret SIP>

[101]
type=aor
max_contacts=10             ; une personne = Phone + widgets ouverts : plusieurs fenêtres
remove_existing=yes
remove_unavailable=yes      ; libère la place d'une fenêtre fermée sans désinscription
qualify_frequency=20
```

Points qui ont coûté cher en développement :

- **Plusieurs contacts par extension.** Sans `max_contacts` suffisant, une fenêtre de trop reçoit « Audio not connected yet ». Phone et chaque widget sont un contact SIP.
- **ICE derrière un NAT ou un conteneur.** Si Asterisk ne voit pas l'adresse que le navigateur doit viser, mappez-la dans `rtp.conf` :

  ```ini
  [general]
  icesupport=yes
  rtpstart=10000
  rtpend=10100
  [ice_host_candidates]
  <ip du PBX vue d'Asterisk> => <ip que le navigateur doit viser>
  ```

  La plage RTP doit être joignable depuis les navigateurs.
- Si le PBX est joint par un reverse proxy, laissez-le faire du TLS passthrough ou terminer le TLS pour Asterisk avec le bon certificat ; les deux ont fonctionné.

## 6. Plan d'appel

### 6.1 Faire sonner toutes les fenêtres (obligatoire pour le click-to-call)

Un `originate` ARI vers `PJSIP/<ext>` ne joint qu'un contact. Le provider appelle donc `Local/<ext>@<contexte>/n`, avec ce contexte à créer (nom configurable, `originateContext`) :

```ini
[twake-ring]
exten => _X.,1,NoOp(Twake ring ${EXTEN})
 same => n,GotoIf($["${DEVICE_STATE(Stasis:dnd${EXTEN})}"="BUSY"]?busy)
 same => n,Dial(${PJSIP_DIAL_CONTACTS(${EXTEN})},30)
 same => n,Hangup()
 same => n(busy),Busy(5)
```

Sans `originateContext`, le provider retombe sur `PJSIP/<ext>` : une seule fenêtre sonne.

### 6.2 Ne pas déranger et absent

Le Gateway pose l'état d'appareil `Stasis:dnd<ext>` (et `Stasis:away<ext>`) par l'ARI. Pour que les appels composés **depuis un téléphone** le respectent, ajoutez le test dans le plan d'appel de chaque extension :

```ini
exten => 101,1,GotoIf($["${DEVICE_STATE(Stasis:dnd101)}"="BUSY"]?dnd)
 same => n,Dial(${PJSIP_DIAL_CONTACTS(101)},20)
 same => n,Hangup()
 same => n(dnd),Busy(5)
```

Les appels lancés par Twake Phone vérifient déjà ce DND côté provider (l'ARI contourne le plan d'appel) ; sans ce bloc, seuls les appels internes composés au téléphone ignorent le DND.

### 6.3 Appels externes

Deux options dans la configuration du provider :

- `trunkEndpoint` : le provider compose `PJSIP/<numéro>@<trunk>` directement ;
- `externalDial` : les numéros externes passent par **votre plan d'appel** (`Local/<numéro>@<contexte>/n`), donc par vos règles sortantes (blocage de l'international, urgences, contrôle de l'appelant). C'est le chemin recommandé. Le provider convertit un numéro E.164 de votre pays en forme nationale (`+33612345678` devient `0612345678` avec `e164Prefix: "+33"` et `nationalPrefix: "0"`) et les autres numéros internationaux en `00…`. Un numéro sans `+` est transmis tel quel.

## 7. Secrets SIP par utilisateur

Le Gateway génère un secret aléatoire par utilisateur, le conserve chiffré (AES-256-GCM, `SECRETS_KEY`) et le remet au navigateur par l'appel authentifié `media-session`. Le PBX doit donc accepter ce secret pour l'extension. Trois façons :

1. **API de provisionnement** (ce que fait la stack de dev, `docker/minipbx-dev/overlay/provision.py`). Le Gateway appelle :

   ```
   PUT {provisioning.url}/extensions/{extension}/secret
   x-provision-token: <jeton partagé>
   {"secret": "<16 à 64 caractères alphanumériques>"}
   → 204 ; 401 mauvais jeton ; 404 extension inconnue ; 422 secret refusé
   ```

   Exposez cette API sur votre PBX (ou un service à côté) : elle doit écrire le secret dans la configuration PJSIP de l'extension et recharger. Elle ne doit être joignable que par le Gateway. Si le PBX répond autre chose que 2xx, rien n'est enregistré côté Gateway.
2. **Secret statique** (`staticSipSecretRef`) : un secret partagé par toutes les extensions, **réservé au développement**.
3. **Un autre mécanisme** (base de données de provisionnement, AstDB, API de votre PBX) : écrire un `SecretProvisioner` (`{ setSipSecret(extension, secret) }`) et l'installer à la place de `miniPbxProvisioner`.

## 8. Configuration côté Gateway

La configuration d'un provider est stockée par tenant dans `provider_configs` ; elle ne contient que des **références** de secrets (`env:NOM`). Valeurs de la stack de dev, en JSON :

```json
{
  "ari": { "url": "http://pbx.interne:8088", "user": "twake", "passwordRef": "env:ARI_PASSWORD", "app": "twake-prod" },
  "websocketUrl": "wss://pbx.exemple.org:8089/ws",
  "iceServers": [{ "urls": ["stun:stun.exemple.org:3478"] }],
  "originateContext": "twake-ring",
  "externalDial": { "context": "<votre contexte sortant>", "e164Prefix": "+33", "nationalPrefix": "0" },
  "provisioning": { "url": "http://pbx.interne:18081", "tokenRef": "env:TWAKE_PROVISION_TOKEN" }
}
```

Au premier démarrage d'un Gateway sans configuration, des variables d'environnement l'écrivent (`BOOTSTRAP_PROVIDER_URL`, `PBX_WSS_URL`, `ARI_USER`, `ARI_PASSWORD`, `ARI_APP`, `ASTERISK_ORIGINATE_CONTEXT`, `ASTERISK_EXTERNAL_CONTEXT`, `ASTERISK_EXTERNAL_E164_PREFIX`, `ASTERISK_EXTERNAL_NATIONAL_PREFIX`, `ASTERISK_TRUNK_ENDPOINT`, `PBX_PROVISION_URL`, `TWAKE_PROVISION_TOKEN`) ; ensuite la base fait foi. Le Gateway ne démarre aucun appel tant que `GET /ready` n'est pas vert, c'est-à-dire tant que la liaison ARI n'est pas établie.

Associer les personnes aux extensions : table `user_mappings` du Gateway (`tenant`, `user_id`, `extension`).

## 9. Liste de contrôle

Dans l'ordre, chaque point valide le précédent :

```bash
# 1. L'ARI répond avec les identifiants du Gateway
curl -u twake:<secret> http://pbx.interne:8088/ari/asterisk/info

# 2. Les modules sont chargés (res_ari, res_stasis, res_http_websocket, codec opus)
asterisk -rx "module show like ari" ; asterisk -rx "core show codecs" | grep -i opus

# 3. Le WSS est joignable avec un certificat valide pour le nom d'hôte
curl -sI https://pbx.exemple.org:8089/ws

# 4. L'endpoint existe et l'état d'appareil DND se pose
curl -u twake:<secret> -X PUT "http://pbx.interne:8088/ari/deviceStates/Stasis:dnd101?deviceState=BUSY"
asterisk -rx "devstate list" | grep dnd101      # puis NOT_INUSE pour le rétablir

# 5. Le contexte de sonnerie existe
asterisk -rx "dialplan show 101@twake-ring"

# 6. Le provisionnement accepte un secret (si utilisé)
curl -X PUT -H "x-provision-token: <jeton>" -H "content-type: application/json" \
     -d '{"secret":"abcdefghij0123456789"}' http://pbx.interne:18081/extensions/101/secret

# 7. Côté Twake : /ready est vert, puis un appel entre deux extensions
curl https://telephony.exemple.org/ready
```

Le test de bout en bout du dépôt (`yarn e2e:live`) rejoue ces étapes avec deux agents SIP, mais il est écrit pour le PBX de développement (extensions 104 et 105, adresses de la stack) : il sert de modèle, à adapter pour le lancer contre le vôtre.

## 10. Un autre PBX que Asterisk

Le contrat est `packages/provider-sdk` : `TelephonyProvider` (appels, présence, événements, capacités), `MediaProvider` (session média du navigateur) et, pour Meet, `ConferenceBridgeProvider`. Écrire un provider consiste à :

1. implémenter ce contrat dans un nouveau paquet (aucune notion du PBX ne doit en sortir) ;
2. déclarer une `ProviderFactory` avec un `type` et l'ajouter à la liste de `apps/gateway/src/registry.ts` (il n'y a pas encore de chargement dynamique) ;
3. publier ses `Capabilities` honnêtement : l'interface s'adapte (pas de transfert, pas de DND, pas d'audio navigateur…).

`packages/sip-media` fournit la session média `sip-webrtc` à tout provider dont les endpoints sont des clients SIP sur WebSocket ; un provider sans audio navigateur renvoie `{ type: 'external' }` et Phone fonctionne alors en pilotage seul (CTI).

## 11. Visio et opérateur

Les parties **Meet** et **trunk** sont indépendantes du choix d'Asterisk côté Twake :

- **LiveKit SIP** parle SIP standard : le PBX n'a besoin que d'un endpoint vers lui (identifié par adresse IP) et d'un contexte qui renvoie ses appels vers votre plan d'appel (dial-out) ; voir `docker/minipbx-dev/overlay/pjsip_twake.conf` et `extensions_twake.conf`.
- **Opérateur** : voir [ARCHITECTURE.md §13](ARCHITECTURE.md#13-trunk-sip-réel--ce-que-la-ligne-de-développement-a-appris) pour les pièges mesurés derrière un NAT (port source, keepalive par serveur, pas d'adresse externe).
