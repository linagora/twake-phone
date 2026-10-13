# Spike : réception d'appels hors de l'app Phone

Exigence (cahier §85) : recevoir un appel pendant que l'utilisateur est dans Mail, Drive ou Calendar.

## Constat

Avec `subdomains: flat`, chaque app a sa propre origine (`user1-drive.twake.local`, `user1-mail.…`, `user1-phone.…`). Il n'y a donc **aucun contexte JS partagé** : ni SharedWorker, ni BroadcastChannel, ni localStorage entre apps. Un « singleton global » dans le navigateur n'existe pas. De plus, aucun mécanisme de notification inter-apps n'existe aujourd'hui dans Drive, Chat ni Contacts (recherche de `serviceWorker`, `Notification`, `BroadcastChannel` : aucun résultat). L'iframe d'un intent est éphémère et ne convient pas.

## Architecture proposée (contrôle ≠ média)

1. **Signalisation partout, média dans Phone uniquement.**
   Un petit module « call listener » est chargé dans chaque app (idéalement via cozy-bar, présente dans toutes les apps ; une montée de version suffit). Il ouvre le WebSocket du Gateway (`TelephonyClient.connect`), reçoit `call.ringing` et affiche une bannière Répondre / Refuser. Il ne porte aucun média.
2. **Répondre = ouvrir la fenêtre Phone** (`window.open` sur le clic, donc autorisé par le navigateur). Seule cette fenêtre enregistre le softphone WebRTC. Un verrou `navigator.locks` (même origine) garantit une seule instance enregistrée.
3. **Appel déjà en sonnerie quand Phone n'est pas encore enregistré** : le PBX a sonné vers un endpoint non enregistré. Le provider doit donc supporter « répondre avec l'endpoint X » : le Gateway demande au provider d'établir l'appel vers le endpoint navigateur une fois enregistré et de le ponter avec l'appelant (côté Asterisk : ARI). C'est une opération de contrôle, elle reste neutre dans l'API (`POST /calls/{id}/answer { endpointId }`).
4. **Navigateur fermé ou onglet en veille** : Web Push + service worker sur l'origine Phone (VAPID, envoi par le Gateway). Un clic sur la notification ouvre Phone. Complément, pas remplacement.
5. **Plusieurs onglets** : chaque app ouverte reçoit l'événement ; le Gateway reste la source de vérité, la première action (répondre/refuser) gagne et émet `call.connected` / `call.ended`, ce qui ferme les bannières des autres onglets.

## Ce qui est prototypé et testé ici

- `EventBus` du Gateway (diffusion par tenant et utilisateur, remplaçable par Redis pub/sub).
- `GET /api/v1/ws` : diffuse les événements au seul utilisateur concerné.
- `POST /api/v1/dev/incoming-call` (mode dev) : simule `call.ringing`.
- `TelephonyClient.connect` : reconnexion avec backoff exponentiel et jitter, jeton rafraîchi à chaque tentative.
- Masquage du token WebSocket dans les logs.
- Test : l'appel simulé pour `alice` arrive sur sa socket et pas sur celle de `bob`.

## Non vérifié (nécessite la stack complète)

| Point | Risque | Comment trancher |
|---|---|---|
| CSP : `connect-src` doit autoriser `https://gateway.<domaine>` et `wss://…` | Bloquant en prod. Le `csp_allowlist` de `cozy.yaml` montre les clés `script/img/style/font/frame` ; la clé pour `connect` est à confirmer dans la doc cozy-stack | Tester sur la stack avec CSP active ; sinon proxifier le Gateway sous le domaine de l'instance |
| Token pour le WebSocket | Le token est en query string (limite des WebSocket navigateur) | Jeton court à usage unique obtenu via REST juste avant la connexion |
| Charger le listener dans cozy-bar | Dépend du process de release de cozy-bar (autre dépôt Linagora) | Prototyper d'abord dans Drive, puis proposer le changement |
| `answer` avec endpoint (point 3) | Délai de pontage perceptible ? | Mesurer avec Asterisk de dev |
| Popup bloquée | Si l'appel arrive sans geste utilisateur | Le clic sur « Répondre » est le geste ; la notification Push couvre le reste |

## Alternative minimale

Phone épinglé dans un onglet toujours ouvert, comme le font aujourd'hui les webphones : aucun changement dans les autres apps, mais l'exigence §85 n'est alors pas vraiment satisfaite.
