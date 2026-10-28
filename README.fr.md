<p align="center">
  <img src="frontend/public/favicon.svg" width="64" height="64" alt="">
</p>

<h1 align="center">randl</h1>

<p align="center">
  <b>Suivi d’expériences auto-hébergé pour le SDK Python W&amp;B.</b><br>
  Conservez votre code <code>wandb.init()</code> et <code>wandb.log()</code> ; envoyez les exécutions vers votre propre serveur.<br>
  Explorez-les dans le tableau de bord, automatisez-les avec la CLI <code>randl</code> ou interrogez l’Assistant intégré.
</p>

<p align="center">
  <a href="README.md">English</a> ·
  <a href="README.zh-Hans.md">简体中文</a> ·
  <a href="README.zh-Hant.md">繁體中文</a> ·
  <a href="README.ja.md">日本語</a> ·
  <a href="README.ko.md">한국어</a> ·
  <b>Français</b> ·
  <a href="README.es.md">Español</a>
</p>

![Un espace de travail randl qui compare douze exécutions d’un balayage du taux d’apprentissage](.github/assets/readme/hero.webp)

randl (« rewards and losses », récompenses et pertes) est un outil de suivi d’expériences
que vous hébergez vous-même. Le paquet `wandb` standard y enregistre ses données dès que
vous définissez deux variables d’environnement, et un tableau de bord web rapide affiche
vos métriques, médias et artefacts au fur et à mesure de leur arrivée. Le même espace
de travail répond à la ligne de commande `randl` et à un Assistant IA qui fonctionne avec
le fournisseur de modèle de votre choix. Tout reste sur votre machine ou votre serveur :
un processus Node.js, une base de données SQLite et un dossier de fichiers.

## Pourquoi randl

- **Compatible avec le SDK W&B sans modification.** Faites pointer `WANDB_BASE_URL` vers
  randl et conservez votre code d’entraînement. Les métriques, la configuration, les
  résumés, les images, les vidéos, l’audio, les tableaux, les histogrammes, les fichiers,
  les artefacts, la reprise, la synchronisation hors ligne et les demandes d’arrêt
  fonctionnent avec le vrai SDK.
- **Entièrement à vous.** Aucun compte, aucun service cloud. Par défaut, il écoute sur
  `127.0.0.1` ; avec une clé API et un proxy inverse HTTPS, vous pouvez y accéder de
  partout.
- **Un tableau de bord complet.** Des espaces de travail avec des vues enregistrées, le
  regroupement, le lissage, des métriques calculées, des panneaux de médias, un tableau
  des exécutions, des artefacts et des aperçus de projet. L’interface est disponible en
  sept langues.
- **Un Assistant qui configure l’espace de travail pour vous.** Formulez votre demande en
  langage courant, par exemple « comparez mes trois meilleures exécutions » ou « ajoutez
  un panneau pour la perte de valeur regroupée par taux d’apprentissage », et il lit vos
  exécutions puis construit les vues, les panneaux et les sélections d’exécutions avec
  les mêmes outils que le tableau de bord et la CLI. Utilisez votre propre fournisseur de
  modèle : Anthropic, OpenAI, Google, OpenRouter et bien d’autres. Il ne peut pas
  supprimer un projet sans votre confirmation.
- **Scriptable depuis la ligne de commande.** La CLI `randl` gère les projets, les
  exécutions, les vues, les panneaux, les sélections d’exécutions, les artefacts et les
  plugins sur un serveur local ou distant, et affiche du JSON pour `jq`, les scripts et
  la CI. `randl tools` décrit chaque outil avec un JSON Schema, si bien que des agents de
  programmation comme Claude Code ou Codex peuvent eux aussi piloter randl.
- **Rapide avec des exécutions longues et nombreuses.** Les graphiques se chargent
  lorsqu’ils apparaissent pendant le défilement, récupèrent à peu près autant de points
  que le tracé compte de pixels (minimum et maximum par intervalle, pour que les pics
  restent visibles), et s’affinent lorsque vous zoomez ou les agrandissez.
- **Stockage léger.** L’historique est conservé sans perte dans des blocs compressés.
  Dans notre benchmark synthétique, la base de données entière, index compris, occupait
  environ un cinquième de l’espace de l’historique JSON qu’elle contient.

## Démarrage rapide

Il vous faut [Node.js](https://nodejs.org/) 22.19 ou une version plus récente. Python
n’est nécessaire que pour votre code d’entraînement.

**1. Installez et démarrez randl.** Depuis un clone de ce dépôt :

```sh
npm ci
npm run build
npm start
```

Le serveur écoute sur [http://127.0.0.1:8742](http://127.0.0.1:8742) et conserve ses
données dans `.data/`. Utilisez `npm start -- --port 9000 --data-dir /path/to/data` pour
modifier l’un ou l’autre.

**2. Faites pointer le SDK W&B vers randl.** Dans le shell qui exécute votre code
d’entraînement :

```sh
pip install wandb numpy pillow moviepy
export WANDB_BASE_URL=http://127.0.0.1:8742
export WANDB_API_KEY=0000000000000000000000000000000000000000
```

La clé d’exemple fonctionne avec un serveur local sur lequel aucune clé API n’est
configurée. `moviepy` n’est nécessaire que pour enregistrer des vidéos à partir de
tableaux NumPy.

**3. Enregistrez une exécution** comme vous le faites déjà :

```python
import numpy as np
import wandb

with wandb.init(project="quickstart", config={"lr": 3e-4, "batch_size": 64}) as run:
    for step in range(200):
        loss = 2.0 * np.exp(-step / 60) + 0.05 * np.random.rand()
        metrics = {"train/loss": loss, "train/accuracy": 1 - loss / 2.1}
        if step % 50 == 0:
            image = np.random.randint(0, 255, (64, 64, 3), dtype=np.uint8)
            metrics["samples"] = wandb.Image(image, caption=f"step {step}")
            frames = np.random.randint(0, 255, (16, 3, 64, 64), dtype=np.uint8)  # time, channel, H, W
            metrics["rollout"] = wandb.Video(frames, fps=8, format="mp4")
        run.log(metrics)
```

**4. Ouvrez [http://127.0.0.1:8742](http://127.0.0.1:8742).** L’exécution apparaît sous
l’entité `local` dans le projet **quickstart**, avec un graphique pour chaque métrique
et des panneaux pour les images et la vidéo. **Connecter le SDK**, dans l’en-tête du
projet, affiche ces paramètres avec le projet déjà renseigné.

Autres façons de se connecter :

- `wandb login --relogin --host http://127.0.0.1:8742 KEY` enregistre randl comme hôte
  W&B par défaut pour votre compte utilisateur, au lieu d’utiliser des variables
  d’environnement.
- Les exécutions enregistrées avec `WANDB_MODE=offline` sont envoyées avec
  `wandb sync wandb/offline-run-*` une fois les variables définies.
- Une exécution démarrée sans entité utilise l’entité par défaut du serveur, `local`.
  Démarrez le serveur avec `--entity NAME` (ou `RANDL_ENTITY=NAME`) pour en utiliser une
  autre, comme votre nom d’utilisateur W&B.

## Visite guidée

### Des espaces de travail qui suivent le rythme de vos exécutions

L’espace de travail compare toutes les exécutions visibles dans des sections de panneaux
qui se mettent à jour en direct à l’arrivée des données. Affichez, masquez ou mettez en
**solo** des exécutions d’un clic ou en faisant glisser le pointeur sur la liste des
exécutions (plusieurs exécutions peuvent être en solo à la fois), épinglez jusqu’à
20 exécutions en haut de la liste et attribuez aux exécutions leurs propres couleurs.
Les panneaux, les sélections d’exécutions, les couleurs, les filtres et les paramètres
des graphiques sont enregistrés dans des **vues**, avec annulation et rétablissement.

- Panneaux graphique linéaire, graphique en aires, aires empilées, aires en pourcentage,
  graphique à barres, nuage de points, nuage de points de l’historique, coordonnées
  parallèles, histogramme, tableau, images, audio et vidéo.
- Survolez ou utilisez le clavier pour inspecter les valeurs ; le curseur et l’exécution
  survolée sont liés entre les panneaux et la liste des exécutions.
- Faites glisser sur un graphique pour zoomer ; seuls les points manquants sont
  récupérés.
- Quatre méthodes de lissage (EMA, EMA pondérée par le temps, gaussien et moyenne mobile
  centrée), axes logarithmiques, plages fixes et **Exclure les valeurs aberrantes de la
  plage Y**, à définir par panneau, par section ou pour tout l’espace de travail.
- Exportez un panneau en PNG ou ses données en CSV.

### Regroupement et agrégation

![Retour épisodique regroupé par taux d’apprentissage, avec l’infobulle qui affiche la moyenne de chaque groupe](.github/assets/readme/grouped.webp)

Regroupez les graphiques selon n’importe quelle valeur de configuration, étiquette ou
champ d’exécution pour tracer la moyenne, la médiane, le minimum ou le maximum de chaque
groupe avec une bande de dispersion. Au survol, chaque groupe est nommé avec le nombre
d’exécutions dont il fait la moyenne. La liste des exécutions et le tableau des
exécutions peuvent être regroupés indépendamment des graphiques.

### Un graphique par exécution

![Disposition en grille : un petit graphique par exécution, avec des plages X et Y communes](.github/assets/readme/grid.webp)

**Disposition → Grille** dessine chaque exécution ou groupe dans son propre petit
graphique avec des axes communs, et **Coverflow** les affiche un par un. Le survol, les
curseurs et le zoom restent liés entre les cellules.

### Images, vidéos et audio

<table>
  <tr>
    <td width="50%"><img src=".github/assets/readme/media.webp" alt="Échantillons d’images d’une exécution à chaque étape enregistrée, du bruit aux sprites nets"></td>
    <td width="50%"><img src=".github/assets/readme/coverflow.webp" alt="Cover Flow d’échantillons d’images dans le thème sombre"></td>
  </tr>
</table>

Les panneaux de médias affichent chaque fichier enregistré sous forme de vignette, soit
pour toutes les exécutions à une étape, soit pour une exécution au fil de ses étapes,
avec un curseur d’étape partagé par la section. Les images et les images d’aperçu des
vidéos ne se chargent que pour les vignettes visibles. Les vidéos se lancent
automatiquement sans le son et tournent en boucle tant qu’elles sont à l’écran (les deux
options peuvent être désactivées), et se lisent en streaming avec navigation dans la
vidéo. **Coverflow** présente les fichiers un par un, et Entrée sur une vignette l’ouvre
en plein écran.

### Métriques calculées

![L’éditeur de panneau avec une métrique calculée qui divise deux métriques enregistrées](.github/assets/readme/computed.webp)

Tracez une formule telle que `${rollout/pole_falls} / ${rollout/episodes}` à côté des
métriques enregistrées. Les formules sont évaluées pour chaque enregistrement de
l’historique, avant le regroupement et le lissage, avec coloration syntaxique et
complétion des noms de métriques et des fonctions `Math.`. randl les analyse lui-même ;
aucun code JavaScript n’est exécuté.

### Tableau des exécutions

![Le tableau des exécutions regroupé par taux d’apprentissage, avec trois exécutions sélectionnées](.github/assets/readme/table.webp)

Recherchez, filtrez, triez et regroupez les exécutions, choisissez jusqu’à 32 colonnes
parmi les champs de configuration, de résumé et d’exécution, et sélectionnez des
exécutions pour les étiqueter, les arrêter ou les supprimer. Les exécutions supprimées
peuvent être restaurées depuis les paramètres du projet.

### Aperçu du projet et état du serveur

![Un aperçu de projet avec une exécution en cours, les états des exécutions et l’utilisation du stockage](.github/assets/readme/overview.webp)

L’aperçu de chaque projet liste les exécutions en cours avec leur durée d’exécution en
direct, compte les exécutions par état, totalise le temps de calcul et le stockage, et
renvoie vers les exécutions les plus volumineuses et les plus récentes. La page
**Serveur** présente sous forme de graphiques les requêtes, les temps de réponse, les
octets transférés et les taux d’erreur de la dernière heure, ainsi que la mémoire et la
taille de la base de données.

### Demandez à l’Assistant

![L’Assistant qui crée une vue avec les mêmes outils que la CLI](.github/assets/readme/assistant.webp)

Ouvrez **Assistant** dans l’en-tête et décrivez ce que vous voulez voir. L’Assistant
sait quel projet et quelle vue vous avez ouverts, recherche les exécutions, les
métriques et les vues enregistrées, et effectue lui-même la modification. Par exemple :

- _« Comparez mes trois meilleures exécutions sur le retour épisodique. »_ Il lit les
  résumés des exécutions, crée une vue avec un graphique du retour épisodique et met les
  trois exécutions en solo.
- _« Ajoutez un panneau pour la perte de valeur regroupée par taux d’apprentissage. »_ Il
  ajoute un graphique linéaire à la vue ouverte, regroupé selon la valeur de
  configuration `learning_rate`.
- _« Étiquetez les exécutions plantées comme instables et masquez-les. »_ Il étiquette
  les exécutions et met à jour la sélection d’exécutions de la vue.

Chaque appel d’outil s’affiche dans la conversation pendant son exécution, et le
résultat est une vue enregistrée ordinaire que vous pouvez continuer à modifier à la
main. Les conversations sont conservées dans **Historique des conversations**. Les
exécutions que l’Assistant supprime peuvent être restaurées depuis les paramètres du projet.
La suppression d’un projet est la seule action qui demande votre confirmation : une
carte dans la conversation attend que vous saisissiez le nom du projet, et le modèle ne
peut pas la confirmer.

L’Assistant est construit sur l’agent de programmation Pi et ne charge que les outils
de gestion de randl, sans accès au shell ni aux fichiers. Choisissez un fournisseur et
un modèle dans **Paramètres de l’application → Assistant** : enregistrez une clé API
pour Anthropic, OpenAI, Google, Mistral, OpenRouter ou un autre fournisseur pris en
charge par Pi, connectez-vous avec Pi sur le serveur, ou ajoutez votre propre point de
terminaison au fichier `models.json` de Pi. Les requêtes et les résultats des outils
sont envoyés au fournisseur du modèle.

### Automatisez-le avec la CLI randl

![Une session de terminal qui crée une vue, ajoute un panneau, met des exécutions en solo et interroge l’Assistant](.github/assets/readme/cli.webp)

Tout ce que l’Assistant sait faire existe aussi sous forme de commande `randl`, de même
que les artefacts, les plugins et la gestion des projets. Les commandes affichent du
JSON ; elles se combinent donc avec `jq`, les scripts shell et les tâches de CI, et
fonctionnent de la même façon avec un serveur distant. Cette session construit une vue
à la main :

```sh
alias randl="node $PWD/backend/dist/cli.js"  # once, from the repository root

VIEW=$(randl views create --project demo/cartpole-ppo --name "Best learning rate" | jq -r .id)
randl panels add --view $VIEW --metric charts/episodic_return
randl runs --project demo/cartpole-ppo \
  | jq '[.[] | select(.group_name == "lr=0.0003") | .id]' \
  | randl select --view $VIEW --solo-file -
```

`randl tools` liste chaque outil de gestion avec un JSON Schema de ses arguments, et
`randl tool NAME --json ARGUMENTS` appelle n’importe lequel d’entre eux, y compris avec
les options que les commandes plus courtes omettent :

```sh
randl tools | jq -r '.tools[].name'
randl tool panel_add --json '{"view": "'$VIEW'", "plugin": "line", "metric": "losses/value_loss", "settings": {"groupBy": "config.learning_rate"}}'
```

`randl agent` envoie une requête à l’Assistant et affiche sa réponse, avec chaque appel
d’outil sur la sortie d’erreur standard. Il refuse les suppressions de projet, sauf si
vous en autorisez une avec `--confirm-delete-project entity/project`.

```sh
randl agent 'Compare my three best runs on episodic return'
```

**Avec des agents de programmation.** Les commandes ne demandent jamais de saisie,
affichent du JSON et signalent les erreurs sur la sortie d’erreur standard avec un code
de sortie non nul ; des agents de programmation comme Claude Code ou Codex peuvent donc
utiliser randl directement. Dites à l’agent de lire `randl --help` et `randl tools`,
puis demandez-lui, par exemple, de configurer une vue pour l’expérience qu’il vient de
lancer.

Les captures d’écran utilisent un modèle local de substitution ; les appels d’outils ont
été exécutés sur un vrai serveur.

### Sur tous les écrans, dans votre langue

<table>
  <tr>
    <td width="34%"><img src=".github/assets/readme/mobile.webp" alt="L’espace de travail sur un téléphone"></td>
    <td>
      La disposition s’adapte aux écrans de téléphone, et les graphiques fonctionnent au
      toucher : appuyez longuement, puis faites glisser pour zoomer.<br><br>
      Les thèmes clair et sombre suivent votre système ou votre choix, avec une sélection
      de couleurs d’accentuation. Les couleurs des exécutions utilisent la palette de
      W&amp;B dans les deux thèmes.<br><br>
      L’interface est disponible en anglais, chinois simplifié, chinois traditionnel
      (Taïwan), japonais, coréen, français et espagnol. Les noms des exécutions, les clés
      de métriques et les autres données enregistrées sont toujours affichés tels qu’ils
      ont été enregistrés.
    </td>
  </tr>
</table>

## Compatibilité W&B

randl implémente les parties du protocole W&B que le SDK Python utilise pour le suivi.
Il est testé avec le vrai paquet `wandb` **0.30.0**, avec et sans clé API.

| Fonctionne                                                                                  | Remarques                                                                          |
| ------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| `wandb.init`, `run.log`, configuration, résumé, étiquettes, groupes, notes                  |                                                                                    |
| Images, vidéos, audio, tableaux et histogrammes                                             | Affichés dans les panneaux de médias, de tableau et d’histogramme                  |
| Métriques d’étape et métriques masquées de `define_metric`                                  | L’agrégation du résumé est calculée par le SDK                                     |
| Fin, échec, reprise (`resume="allow"` / `"must"`) et arrêt depuis le tableau de bord        | Les exécutions sans contact pendant 10 minutes sont marquées comme plantées        |
| Fichiers d’exécution, métadonnées d’environnement, métriques système et journaux de console |                                                                                    |
| Artefacts : enregistrement, versions, alias, utilisation et téléchargement                  | Fichiers jusqu’à 10 GiB chacun                                                     |
| `wandb login --host`, `WANDB_MODE=offline` avec `wandb sync`                                |                                                                                    |
| `run.alert()`                                                                               | Affichées sur la page de l’exécution ; pas de notifications par e-mail ni par chat |
| `wandb.Api()` pour lire les exécutions                                                      | `Api().run(...)` et `Api().runs("entity/project")` sans filtres                    |

Non pris en charge : Reports, Sweeps, Registry, Launch, Weave, graphiques personnalisés
Vega ou Plotly, comptes et équipes W&B (randl a un seul propriétaire), références
d’artefacts externes et envois d’artefacts en plusieurs parties, ainsi que les appels à
l’API publique autres que la lecture des exécutions. Les requêtes non prises en charge
renvoient des erreurs au lieu de faire semblant de stocker les données.

## Auto-hébergement

Sur votre propre poste de travail, `npm start` suffit. Pour utiliser randl depuis
d’autres machines, attribuez-lui une clé API de propriétaire et placez-le derrière un
proxy inverse HTTPS :

```sh
export RANDL_API_KEY="$(openssl rand -hex 32)"
export RANDL_PUBLIC_URL=https://randl.example.com
npm start -- --host 127.0.0.1 --data-dir /srv/randl
```

Le navigateur se connecte avec la clé. Sur les machines clientes, exportez la même clé
dans `RANDL_API_KEY` ; la CLI lit `RANDL_URL` et `RANDL_API_KEY`, et le SDK utilise les
mêmes valeurs :

```sh
export RANDL_URL=https://randl.example.com
export WANDB_BASE_URL="$RANDL_URL"
export WANDB_API_KEY="$RANDL_API_KEY"
```

[DEPLOYMENT.md](DEPLOYMENT.md) (en anglais) décrit l’exemple Caddy de
[deploy/Caddyfile](deploy/Caddyfile), les sauvegardes, les limites d’envoi et la
configuration des fournisseurs de l’Assistant.

| Option de `randl serve` | Valeur par défaut | Rôle                                                                               |
| ----------------------- | ----------------- | ---------------------------------------------------------------------------------- |
| `--port`                | `8742`            | Port d’écoute                                                                      |
| `--host`                | `127.0.0.1`       | Adresse d’écoute                                                                   |
| `--data-dir`            | `.data`           | Base de données, fichiers envoyés et plugins installés                             |
| `--public-url`          |                   | Adresse HTTPS publique (ou `RANDL_PUBLIC_URL`)                                     |
| `--entity`              | `local`           | Entité des exécutions qui n’en indiquent aucune (ou `RANDL_ENTITY`)                |
| `--run-timeout`         | `600`             | Secondes sans contact du SDK avant qu’une exécution en cours soit déclarée plantée |
| `--frontend-dir`        | `frontend/dist`   | Servir une copie déployée de l’interface compilée                                  |
| `--pi-agent-dir`        | `<data-dir>/pi`   | Répertoire du profil de l’Assistant (ou `RANDL_PI_AGENT_DIR`)                      |

Si `ffmpeg` est installé, randl l’utilise pour générer les images d’aperçu des vidéos ;
définissez `RANDL_FFMPEG` sur son chemin, ou sur `off`.

## Ligne de commande

Les exemples utilisent l’alias `randl` de la visite guidée ; dans les scripts, appelez
plutôt `node /path/to/randl/backend/dist/cli.js`. Chaque commande affiche du JSON, se
termine avec un code de sortie non nul en cas d’erreur et communique avec `RANDL_URL`
(par défaut `http://127.0.0.1:8742`) en utilisant `RANDL_API_KEY` lorsque le serveur en
a une. `randl --help` les liste toutes.

```sh
randl status
randl projects list
randl projects create --id local/robotics --name Robotics
randl runs --project local/quickstart
randl runs show --id local/quickstart/RUN_ID
randl runs add-tags --ids local/quickstart/RUN_ID --tags baseline
randl views list
randl artifacts list
randl artifacts download --id ARTIFACT_ID --output ./downloads
randl projects delete --id local/robotics --confirm Robotics
```

## Plugins de panneau

Chaque panneau, intégré ou installé, utilise la même interface de plugin : un manifeste
`panel.json` et un module navigateur qui reçoit les données et les affiche. Les plugins
peuvent ajouter des options typées à l’éditeur de panneau et fournir leurs propres
traductions. Installez-en un depuis un répertoire local ou un dépôt GitHub :

```sh
randl plugins install --source ./examples/plugins/stat-card
randl plugins enable --id stat-card
```

Les plugins installés sont désactivés au départ. Une fois activés, ils s’exécutent dans
le tableau de bord avec accès à ses données ; n’installez donc que du code de confiance.
randl copie la source et n’exécute jamais de scripts d’installation ou de compilation.
Consultez [PLUGINS.md](PLUGINS.md) (en anglais) pour écrire les vôtres.

## État du projet

randl est jeune et évolue rapidement ; attendez-vous à des changements incompatibles
entre les versions. Il s’agit d’une implémentation indépendante, sans affiliation avec
Weights & Biases ; le serveur et le tableau de bord W&B n’en font pas partie.
[CONTRIBUTING.md](CONTRIBUTING.md) (en anglais) décrit l’environnement de développement,
les tests et l’architecture.

## Licence

randl est distribué sous la [licence MIT](LICENSE).
