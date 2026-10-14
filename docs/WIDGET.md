# Widget d'appel dans les autres applications

Objectif : être appelé, et décrocher, depuis Drive, Mail, Calendar… sans changer d'application.

## Principe

1. Phone déclare un intent de service dans son manifeste : `OPEN` sur `io.twake.phone.widget`, servi par `/intents`.
2. L'application hôte (Drive, par exemple) appelle `mountPhoneWidget({ client })` (package `@twake/phone-widget`).
   Il crée l'intent via `cozy-interapp`, place une iframe dans un coin fixe de la fenêtre et la laisse en place.
3. Dans l'iframe, Phone lance son softphone (enregistrement SIP) et affiche une carte compacte : appel entrant (Répondre / Refuser), puis appel en cours (minuteur, muet, attente, raccrocher, lien « Ouvrir Phone »).
   La carte demande à l'hôte la place dont elle a besoin (`service.resizeClient`) ; sans appel, elle ne prend aucune place.
4. Le son et le micro passent par l'iframe. L'hôte doit donc autoriser le micro : `cozy-interapp` crée l'iframe sans attribut `allow`, `mountPhoneWidget` le pose avant le chargement (`allow="microphone; autoplay"`).

Le contrôle d'appel reste côté Gateway ; l'iframe ne porte que l'audio et l'affichage.

## Intégrer dans une application

```js
import { mountPhoneWidget } from '@twake/phone-widget'

mountPhoneWidget({ client }) // après la création du CozyClient
```

L'idéal est de le faire une fois pour toutes dans cozy-bar, présente dans toutes les applications.

## Plusieurs fenêtres

Chaque fenêtre qui porte le widget (ou l'application Phone) est un contact SIP de l'extension : toutes sonnent, la première qui décroche prend l'appel. Le premier appel du click-to-call, qui fait sonner son propre poste, n'est décroché que par la fenêtre qui a lancé l'appel.

## Test dans le stack de dev

`scripts/add-phone-widget-to-drive.sh` ajoute le widget au clone de Drive (`references/twake-drive`). Le build de Drive est monté à côté de Phone dans cozy-stack (`COZY_DEV_APP2_*` dans `.env` du stack). Pour revenir au Drive du registre :

```bash
docker exec cozyt cozy-stack apps update drive --domain user1.twake.local
```

## Test sans stack

`yarn e2e:widget` simule une application hôte : la vraie bibliothèque et la vraie `cozy-interapp` créent l'intent et l'iframe, le build de Phone sert de service, seuls le stockage des intents et l'endpoint des flags sont simulés. Un appel entrant arrive par le vrai PBX ; le test vérifie que la carte apparaît dans le coin et que l'appel peut être décroché depuis le widget. Il a révélé trois défauts que les tests unitaires ne voyaient pas : la hauteur de la carte écrasée à 0 par la feuille de style de l'app dans une iframe sans hauteur, l'attribut `allow` posé trop tard (le micro est alors refusé), et l'import de `cozy-interapp` selon le bundler.

## Limites

- Le micro est autorisé **pour l'application hôte** (Drive, etc.) : le navigateur applique à l'iframe l'autorisation de la page qui l'embarque. Si le micro a été refusé pour Drive, il faut le réautoriser dans les réglages du site.

- Aucun appel ne sonne si aucune fenêtre portant le widget n'est ouverte (il faudra Web Push).
- Le navigateur demande l'autorisation du micro pour l'origine de Phone au premier appel pris dans le widget.
- Identité du Gateway : mode dev (flag `phone.dev-user`), comme l'application.
