# Widget d'appel dans les autres applications

Objectif : être appelé, et décrocher, depuis Drive, Mail, Calendar… sans changer d'application.

*État : les bibliothèques côté hôte (`@twake/phone-widget`, `@twake/phone-link`) restent dans le dépôt pour Twake Workplace (ADR 0006) ; le service côté Phone décrit ci-dessous (l'app Phone du POC et sa cible `/intents`) a été retiré à la PR 3c. L'intégration dans Twake Chat est refaite à l'étape 9.*

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

## Tests

Les deux tests du POC (le widget ajouté au clone de Drive dans la stack de dev, et `yarn e2e:widget`, un hôte simulé avec la vraie `cozy-interapp` et le build de Phone comme service) sont partis avec le POC à la PR 3c : le service côté Phone (`/intents`) n'existe plus, seules les bibliothèques côté hôte restent, avec leurs tests unitaires. Ce que `yarn e2e:widget` avait révélé, et que les tests unitaires ne voyaient pas, reste à retenir pour l'étape 9 : la hauteur de la carte écrasée à 0 par la feuille de style de l'app dans une iframe sans hauteur, l'attribut `allow` posé trop tard (le micro est alors refusé), et l'import de `cozy-interapp` selon le bundler.

## Limites

- Le micro est autorisé **pour l'application hôte** (Drive, etc.) : le navigateur applique à l'iframe l'autorisation de la page qui l'embarque. Si le micro a été refusé pour Drive, il faut le réautoriser dans les réglages du site.

- Aucun appel ne sonne si aucune fenêtre portant le widget n'est ouverte (il faudra Web Push).
- Le navigateur demande l'autorisation du micro pour l'origine de Phone au premier appel pris dans le widget.
- Identité du Gateway : mode dev (flag `phone.dev-user`), comme l'application.
